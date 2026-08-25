/**
 * `katra install-hooks <agent>` — the impure shell over `core/hooks/merge.ts`'s
 * pure merge (F11 T7, `katra-9aw.70.11`). Reads the agent's own settings/hooks
 * file (if any), asks `mergeHooks`/`removeHooks` what the result should be,
 * and — unless nothing changed — writes it back atomically. Never opens the
 * store: this command's only interest in one is whether it exists at all, so
 * a fresh install can warn instead of silently installing hooks that will
 * error at every session boundary.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import type { Command } from "commander";
import type { StoreWarning } from "../../core/contract.js";
import { resolveStoreLocation } from "../../core/db/locate.js";
import { isKatraException, KatraException } from "../../core/errors.js";
import { writeAtomic } from "../../core/fs.js";
import { runGit } from "../../core/git.js";
import { claudeSettingsPath } from "../../core/hooks/adapters/claude.js";
import { codexHooksPath } from "../../core/hooks/adapters/codex.js";
import { mergeHooks, removeHooks } from "../../core/hooks/merge.js";
import { AGENTS, type Agent, type HookSettings } from "../../core/hooks/types.js";
import { narrowAgent } from "../../core/narrow.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";

/**
 * What `install-hooks` reports (F11 spec's own shape: `{agent, target,
 * action, changed}`). The `printed` arm additionally carries the settings
 * object `--print` renders — the exact block a fresh install would write —
 * since nothing else in this result would let `--json` show it.
 */
export type InstallHooksResult =
  | {
      readonly agent: Agent;
      readonly target: string;
      readonly action: "printed";
      readonly changed: false;
      readonly settings: HookSettings;
    }
  | {
      readonly agent: Agent;
      readonly target: string;
      readonly action: "installed" | "unchanged" | "removed";
      readonly changed: boolean;
    };

interface InstallHooksOptions {
  readonly local?: boolean;
  readonly print?: boolean;
  readonly remove?: boolean;
  readonly json?: boolean;
}

/**
 * Recodes a git-resolution failure as a **usage** refusal rather than this
 * file's `validation` (`git.ts`'s own code for "not inside a git repository"):
 * `install-hooks` needs a worktree to have anywhere to write, so running it
 * outside one is a malformed invocation, not a bad value — the same
 * distinction {@link narrowAgent}'s own docs draw for an unrecognized agent.
 * The message itself is kept verbatim; only its code changes.
 */
function toUsageRefusal(error: unknown): never {
  if (isKatraException(error)) {
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

/**
 * Whether a katra store exists for this repository, without ever opening
 * one — `resolveStoreLocation` for the path (its own not-a-git-repository
 * throw recoded the same way {@link resolveTargetRoot}'s is, though by the
 * time this runs `resolveTargetRoot` has already proven the cwd resolves),
 * then a plain `existsSync` on the database file. `withStore` is never
 * called: this command has nothing to read or write in the store itself.
 */
function storeExists(context: CliContext): boolean {
  try {
    const location = resolveStoreLocation(context.cwd, { env: context.env });
    return existsSync(location.dbPath);
  } catch (error) {
    toUsageRefusal(error);
  }
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
 * `hooks.json`) is the committed, team-wide one.
 */
function visibilityNote(target: string): string {
  return basename(target) === "settings.local.json"
    ? "local only — not committed, not shared with your team"
    : `review and commit ${relativeDisplay(target)} — shared with your team`;
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
    case "unchanged":
      return `${result.agent} hooks already up to date in ${rel} — ${visibilityNote(result.target)}`;
    case "removed":
      return `removed katra's ${result.agent} hooks from ${rel} — ${visibilityNote(result.target)}`;
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

      const existingText = existsSync(target) ? readFileSync(target, "utf8") : undefined;
      const merge =
        options.remove === true
          ? removeHooks(existingText, agent)
          : mergeHooks(existingText, agent);

      const warnings: StoreWarning[] = [];
      if (options.remove !== true && !storeExists(context)) {
        warnings.push({
          code: "hooks-no-store",
          message: "hooks installed; run `katra init` before they will do anything",
        });
      }

      let action: "installed" | "unchanged" | "removed";
      if (!merge.changed) {
        action = "unchanged";
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeAtomic(target, serializeSettings(merge.settings));
        action = options.remove === true ? "removed" : "installed";
      }

      const result: InstallHooksResult = { agent, target, action, changed: merge.changed };
      emit(result, { json, warnings, streams: context.streams }, formatInstallHooks);
    });
}
