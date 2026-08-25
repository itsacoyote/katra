/**
 * `katra install-hooks <agent>` — the impure shell over `core/hooks/merge.ts`'s
 * pure merge (F11 T7, `katra-9aw.70.11`). Reads the agent's own settings/hooks
 * file (if any), asks `mergeHooks`/`removeHooks` what the result should be,
 * and — unless nothing changed — writes it back atomically. Never opens the
 * store: this command's only interest in one is whether it exists at all, so
 * a fresh install can warn instead of silently installing hooks that will
 * error at every session boundary.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, normalize, sep } from "node:path";
import type { Command } from "commander";
import type { InstallHooksResult, StoreWarning } from "../../core/contract.js";
import { resolveStoreLocation } from "../../core/db/locate.js";
import { isKatraException, KatraException } from "../../core/errors.js";
import { writeAtomic } from "../../core/fs.js";
import { runGit } from "../../core/git.js";
import { claudeSettingsPath } from "../../core/hooks/adapters/claude.js";
import { codexHooksPath } from "../../core/hooks/adapters/codex.js";
import { mergeHooks, removeHooks } from "../../core/hooks/merge.js";
import { AGENTS, type HookSettings } from "../../core/hooks/types.js";
import { narrowAgent } from "../../core/narrow.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";

export type { InstallHooksResult };

interface InstallHooksOptions {
  readonly local?: boolean;
  readonly print?: boolean;
  readonly remove?: boolean;
  readonly json?: boolean;
}

/**
 * Recodes a "not inside a git repository" failure as a **usage** refusal
 * rather than `git.ts`'s own `validation`: `install-hooks` needs a worktree
 * to have anywhere to write, so running it outside one is a malformed
 * invocation, not a bad value — the same distinction {@link narrowAgent}'s
 * own docs draw for an unrecognized agent. Narrower than recoding every git
 * failure: git missing from `PATH` and a too-old git both stay `validation`
 * (exit 1, ADR-005) — an agent scripting around katra branches on that
 * number, and neither of those failures is about *this* invocation being
 * malformed. Only `git.ts`'s own `field: "cwd"` case — the one it raises for
 * "not a git repository" specifically — recodes; everything else, including
 * a non-`KatraException` fault, rethrows unchanged.
 */
function toUsageRefusal(error: unknown): never {
  if (
    isKatraException(error) &&
    error.detail.code === "validation" &&
    error.detail.field === "cwd"
  ) {
    throw new KatraException({ code: "usage", message: error.detail.message });
  }
  throw error;
}

/**
 * The caller's worktree toplevel — **not** `store.identity().worktree`
 * (`actor.ts`'s `resolveWorktree`, which swallows a git failure and falls
 * back to `cwd`) and **not** `resolveStoreLocation`'s common dir (the one
 * location shared by every worktree of a repo). Hooks belong to the
 * worktree an agent actually runs in: a linked worktree's own `.claude/`
 * directory is what that agent's tools read, and each worktree carries its
 * own copy of a committed `.claude/settings.json`. Its own `runGit` call
 * (never `resolveWorktree`'s) is what lets "outside a git repository" refuse
 * instead of silently writing into `cwd`.
 */
function resolveTargetRoot(context: CliContext): string {
  try {
    return normalize(
      runGit(context.cwd, context.env, ["rev-parse", "--path-format=absolute", "--show-toplevel"]),
    );
  } catch (error) {
    toUsageRefusal(error);
  }
}

interface StoreCheck {
  readonly exists: boolean;
  readonly warnings: readonly StoreWarning[];
}

/**
 * Whether a katra store exists for this repository, without ever opening
 * one — `resolveStoreLocation` resolved from `root` (the same worktree
 * toplevel {@link resolveTargetRoot} already proved resolves, never
 * `context.cwd` again): with `GIT_DIR`/`GIT_WORK_TREE` set in the
 * environment, a fresh `cwd`-relative resolution can name a *different*
 * repository than `root` does, and this check must agree with the file
 * `install-hooks` is about to write into, not with whatever the ambient
 * environment redirects a second, independent resolution to.
 * `location.warnings` (an ambient-`GIT_DIR` redirect, say) ride back to the
 * caller rather than being silently dropped — the same `warnings` channel
 * every other non-fatal finding in this command uses. `withStore` is never
 * called: this command has nothing to read or write in the store itself.
 */
function checkStore(root: string, context: CliContext): StoreCheck {
  try {
    const location = resolveStoreLocation(root, { env: context.env });
    return { exists: existsSync(location.dbPath), warnings: location.warnings };
  } catch (error) {
    toUsageRefusal(error);
  }
}

function refuseSymlink(path: string): never {
  throw new KatraException({
    code: "validation",
    field: "target",
    value: path,
    message:
      `${path} is a symlink — install-hooks refuses to read or write through it. ` +
      "A git-tracked link here could redirect a write outside this worktree (e.g. a symlinked " +
      ".claude directory pointing at your home directory), or make a read pull in an unrelated " +
      "file's contents that the merge would then fold into what gets written back and reported " +
      "as safe to commit. Remove the link and re-run if it was not deliberate.",
  });
}

/**
 * Refuses when `path` exists and is itself a symlink — checked on both
 * `dirname(target)` and `target` before either is ever read or written
 * (probed real: a git-tracked `.claude` symlink writes outside the
 * worktree, and a git-tracked `.claude/settings.json` symlink has its
 * target's content folded into the merge and then written back as a real
 * file, at which point the install report calls the leak safe to commit). A
 * path that does not exist yet is not a symlink to anything — the ordinary
 * "nothing here yet" case, left for `mkdirSync`/`writeAtomic` to create.
 */
function assertNotSymlink(path: string): void {
  let isSymlink: boolean;
  try {
    isSymlink = lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (isSymlink) refuseSymlink(path);
}

/**
 * Belt-and-braces, run right after `mkdirSync`: confirms `dir`'s real path
 * (symlinks resolved) still sits inside `root`'s real path.
 * {@link assertNotSymlink} above already refuses a symlink found directly at
 * `dirname(target)`; this catches what a single `lstatSync` cannot — a
 * deeper path component resolving somewhere else, or a TOCTOU swap between
 * the two checks — before the write that would land there.
 */
function assertContained(dir: string, root: string): void {
  const realDir = realpathSync(dir);
  const realRoot = realpathSync(root);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
    throw new KatraException({
      code: "validation",
      field: "target",
      value: dir,
      message: `${dir} resolves to ${realDir}, outside the repository root ${realRoot} — refusing to write there`,
    });
  }
}

/**
 * Reads `target`'s existing content, or `undefined` when there is none.
 * `ENOENT` (the ordinary "nothing installed yet" case) is treated as
 * absent; `EACCES`/`EISDIR` refuse with a typed, named refusal instead of
 * surfacing as an unclassified `internal` fault (exit 4) the way an
 * unhandled `readFileSync` throw otherwise would. A leading UTF-8 BOM
 * (U+FEFF — Windows editors routinely add one) is stripped before handing
 * the text to `mergeHooks`/`removeHooks`: `JSON.parse` treats it as a
 * syntax error rather than ignoring it the way most JSON tooling does.
 */
function readExistingSettings(target: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "EACCES" || code === "EISDIR") {
      throw new KatraException({
        code: "validation",
        field: "target",
        value: target,
        message: `${target} could not be read (${code}) — install-hooks refuses to guess at its contents`,
      });
    }
    throw error;
  }
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

/** `.claude/settings.json` from a full path, the way a user thinks of it — reconstructed from `target`'s own last two segments rather than carried as a second field, since the two always agree by construction. */
function relativeDisplay(target: string): string {
  return join(basename(dirname(target)), basename(target));
}

/**
 * Whether `target` is committed/shared with a team, or a local,
 * not-committed override — named in the install report per this task's own
 * decision, so a user doesn't push agent-execution config to teammates
 * without noticing. `settings.local.json` is Claude Code's own
 * trial-before-commit file (`adapters/claude.ts`'s docs); every other target
 * `install-hooks` ever writes (the shared `settings.json`, Codex's single
 * `hooks.json`) is the committed, team-wide one. Says nothing about the path
 * itself — the caller already named it once.
 */
function visibilityNote(target: string): string {
  return basename(target) === "settings.local.json"
    ? "local only — not committed, not shared"
    : "review and commit it — shared with your team";
}

/** Pins one serialization for the whole life of a target file — 2-space JSON plus a trailing newline, the same indent `emit()`'s own `--json` uses — so two independent installs of an unchanged file are byte-identical (spec criterion 3). */
function serializeSettings(settings: HookSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function formatInstallHooks(result: InstallHooksResult): string {
  const rel = relativeDisplay(result.target);
  switch (result.action) {
    case "printed":
      return JSON.stringify(result.settings, null, 2);
    case "installed":
      return `installed ${result.agent} hooks into ${rel} — ${visibilityNote(result.target)}`;
    case "removed":
      return `removed katra's ${result.agent} hooks from ${rel} — ${visibilityNote(result.target)}`;
    case "unchanged":
      // Nothing was written this run, so no "review and commit"/visibility
      // note — that would misdescribe a run that touched no file. `mode`
      // tells install-vs-remove apart: `action` alone cannot, and the two
      // deserve different sentences (an install with nothing new to do
      // still has hooks in place; a remove with nothing to do never did).
      return result.mode === "remove"
        ? `no katra hooks to remove for ${result.agent} in ${rel}`
        : `${result.agent} hooks already up to date in ${rel}`;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

export function registerInstallHooks(program: Command, context: CliContext): void {
  program
    .command("install-hooks")
    .argument("<agent>", `which agent to install katra's hooks for (${AGENTS.join(", ")})`)
    .description(
      "merge katra's session-start/before-edit/session-end hooks into an agent's own settings",
    )
    .option(
      "--local",
      "claude only: target .claude/settings.local.json instead of the shared .claude/settings.json",
    )
    .option("--print", "print the exact hook block that would be installed; touches nothing")
    .option("--remove", "remove katra's hook entries instead of installing them")
    .option("--json", "emit structured output")
    .action((agentArg: string, options: InstallHooksOptions) => {
      const agent = narrowAgent(agentArg);
      const json = options.json === true;
      const removing = options.remove === true;

      if (options.local === true && agent === "codex") {
        throw new KatraException({
          code: "usage",
          message:
            "--local has no target for codex — codex writes a single .codex/hooks.json, " +
            "with no shared/local split like Claude Code's settings files",
        });
      }

      const root = resolveTargetRoot(context);
      const target =
        agent === "claude"
          ? claudeSettingsPath(root, options.local === true)
          : codexHooksPath(root);

      if (options.print === true) {
        const { settings } = mergeHooks(undefined, agent);
        const result: InstallHooksResult = {
          agent,
          target,
          action: "printed",
          changed: false,
          settings,
        };
        emit(result, { json, streams: context.streams }, formatInstallHooks);
        return;
      }

      // Refused before either is ever read or written — see the functions'
      // own docs for the exploit shape this closes.
      assertNotSymlink(dirname(target));
      assertNotSymlink(target);

      const existingText = readExistingSettings(target);
      const merge = removing ? removeHooks(existingText, agent) : mergeHooks(existingText, agent);
      const mode: "install" | "remove" = removing ? "remove" : "install";

      const warnings: StoreWarning[] = [];
      let action: "installed" | "unchanged" | "removed";

      if (!merge.changed) {
        action = "unchanged";
      } else {
        // The store-existence warning only matters when hooks are actually
        // about to start firing at session boundaries — never on a run that
        // writes nothing, and never for --remove (removing hooks needs no
        // store either way).
        if (!removing) {
          const store = checkStore(root, context);
          warnings.push(...store.warnings);
          if (!store.exists) {
            warnings.push({
              code: "hooks-no-store",
              message: "hooks installed; run `katra init` before they will do anything",
            });
          }
        }

        mkdirSync(dirname(target), { recursive: true });
        assertContained(dirname(target), root);
        writeAtomic(target, serializeSettings(merge.settings), { mode: 0o600 });
        action = removing ? "removed" : "installed";
      }

      const result: InstallHooksResult = { agent, target, action, changed: merge.changed, mode };
      emit(result, { json, warnings, streams: context.streams }, formatInstallHooks);
    });
}
