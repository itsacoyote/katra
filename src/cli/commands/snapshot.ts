/**
 * `katra snapshot` / `katra restore` — the whole F10 pair. `snapshot` writes
 * the entire store to one deterministic, git-diffable JSONL file (T2);
 * `restore` rebuilds a store from one (T4), preview by default.
 */

import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Command } from "commander";
import { nowIso, timeAgoOrNull } from "../../core/clock.js";
import type {
  RestoreApplyResult,
  RestorePreviewResult,
  RestoreResult,
  SnapshotResult,
} from "../../core/contract.js";
import { targetVersion } from "../../core/db/migrate.js";
import { MIGRATIONS } from "../../core/db/migrations/index.js";
import { readBoundedExportFile } from "../../core/db/read-export.js";
import { SNAPSHOT_TABLES, type SnapshotTable } from "../../core/enums.js";
import { KatraException } from "../../core/errors.js";
import { listOtherWorktreesPresence } from "../../core/presence.js";
import { exportSnapshot } from "../../core/snapshot/export.js";
import {
  parseSnapshotFile,
  restoreSnapshot,
  SNAPSHOT_READ_OPTIONS,
} from "../../core/snapshot/restore.js";
import type { OpenStore } from "../../core/store.js";
import { oneLine } from "../format.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { openContextStore, withStore } from "../with-store.js";
import { resolveFromPath } from "./migrate.js";

/** Relative to the worktree toplevel — joined with `path.join` so the separator is right on every platform. */
const DEFAULT_SNAPSHOT_RELATIVE_PATH = join(".katra", "snapshot.jsonl");

interface SnapshotOptions {
  readonly out?: string;
  readonly json?: boolean;
}

/**
 * The default resolves against `store.identity().worktree` — the worktree
 * TOPLEVEL, resolved by git itself — never bare `context.cwd` (which may be
 * any subdirectory) and never `store.commonDir` (the shared `.git` dir: the
 * wrong root entirely for `.katra/`, a tracked, worktree-local artifact).
 * An explicit `--out` resolves against `context.cwd` instead — the identical
 * split `migrate.ts`'s `resolveFromPath` draws for `--from` (that function's
 * own docs, citing the git-common-dir trap for a relative path inside a
 * linked worktree): a relative `--out` means "relative to where I am running
 * this command", never "relative to the worktree" or "relative to the
 * shared git dir".
 */
function resolveOutPath(context: CliContext, store: OpenStore, out: string | undefined): string {
  if (out === undefined) {
    return join(store.identity().worktree, DEFAULT_SNAPSHOT_RELATIVE_PATH);
  }
  return isAbsolute(out) ? out : resolve(context.cwd, out);
}

// ---------------------------------------------------------------------------
// Human rendering — one totals line, then one unconditional row per table:
// simpler than formatMigrationReport's (migrate.ts) accumulator, since
// nothing here is ever empty or truncated.
// ---------------------------------------------------------------------------

function formatSnapshotResult(result: SnapshotResult): string {
  const total = result.tables.reduce((sum, entry) => sum + entry.count, 0);
  return [
    `wrote ${String(total)} row(s) across ${String(result.tables.length)} table(s) to ` +
      `${result.path} (schema v${String(result.schemaVersion)})`,
    ...result.tables.map((entry) => `  ${entry.table}: ${String(entry.count)}`),
  ].join("\n");
}

export function registerSnapshot(program: Command, context: CliContext): void {
  program
    .command("snapshot")
    .description("write the entire store to a deterministic, git-diffable JSONL file")
    .option(
      "--out <path>",
      "where to write the snapshot, resolved from the current directory " +
        "(default: .katra/snapshot.jsonl at the worktree toplevel)",
    )
    .option("--json", "emit structured output")
    .action((options: SnapshotOptions) => {
      const { result, warnings } = withStore(context, (store) => {
        const outPath = resolveOutPath(context, store, options.out);
        // `.katra/` is created here, not inside exportSnapshot: the same split
        // `store.ts`'s own `openStore` draws between ensuring a directory
        // exists (its job, `store.ts:161`) and writing the file into it.
        mkdirSync(dirname(outPath), { recursive: true });
        return exportSnapshot(store, outPath);
      });

      const document: SnapshotResult = result;
      emit(
        document,
        { json: options.json === true, warnings, streams: context.streams },
        formatSnapshotResult,
      );
    });
}

// ---------------------------------------------------------------------------
// `katra restore` — F10 T4.
// ---------------------------------------------------------------------------

/** Every source-of-truth table's current row count in the live store — feeds both the emptiness guard and preview's comparison. */
function liveTableCounts(store: OpenStore): { readonly [T in SnapshotTable]: number } {
  const counts = {} as { [T in SnapshotTable]: number };
  for (const table of SNAPSHOT_TABLES) {
    const row = store.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number };
    counts[table] = row.c;
  }
  return counts;
}

/**
 * "Empty" for the `--force` guard: zero rows in every source-of-truth table
 * except `presence` (excluded because `openStore` populates it on every
 * open, including this very check's own) — tasks, deps, links, tags, events,
 * notes, claims, refs, and task_refs all count.
 *
 * Deliberately wider than `beads/load.ts`'s tasks-only `hasExistingTask`
 * check: that check's own known gap (katra-9aw.52) is a store with zero
 * tasks but surviving events, and migrate-beads' worst case there is a
 * duplicated backlog. Restore's worst case is a full file swap — a
 * tasks-only check here would silently discard event/note/claim/ref history
 * a wider one catches before it is ever at risk.
 */
function isEmptyStore(counts: { readonly [T in SnapshotTable]: number }): boolean {
  return SNAPSHOT_TABLES.every((table) => counts[table] === 0);
}

// ---------------------------------------------------------------------------
// Human rendering. `oneLine` wraps every snapshot- or presence-derived
// string (the file path, other worktrees' branch/worktree) — table names,
// counts, and version numbers are katra's own and need no guarding.
// ---------------------------------------------------------------------------

function formatRestoreApply(result: RestoreApplyResult): string {
  const total = result.tables.reduce((sum, entry) => sum + entry.count, 0);
  return [
    `applied ${oneLine(result.file)}: loaded ${String(total)} row(s) across ` +
      `${String(result.tables.length)} table(s) (schema v${String(result.fromSchemaVersion)} -> ` +
      `v${String(result.toSchemaVersion)})`,
    ...result.tables.map((entry) => `  ${entry.table}: ${String(entry.count)}`),
    `previous store preserved at ${oneLine(result.bakPath)} (overwritten by the next restore)`,
  ].join("\n");
}

function formatRestorePreview(result: RestorePreviewResult): string {
  const lines = [
    `preview of ${oneLine(result.file)} (schema v${String(result.fromSchemaVersion)} -> ` +
      `v${String(result.toSchemaVersion)}) — snapshot vs live:`,
    ...result.tables.map(
      (entry) =>
        `  ${entry.table}: ${String(entry.snapshot)} (snapshot) vs ${String(entry.live)} (live)`,
    ),
  ];
  if (result.otherWorktrees.length > 0) {
    // `last_seen` renders as a relative age, never raw: it has no CHECK
    // constraint and is written by *other* worktrees' processes, so a
    // co-tenant could otherwise plant terminal-escape bytes in the exact
    // string an operator reads before typing `--apply --force`. `timeAgoOrNull`
    // is the same "presence is a row we don't fully trust" treatment
    // `claimLiveness`/`formatRefLine` already give it; a malformed timestamp
    // shows "unknown", never its stored bytes.
    const now = nowIso();
    lines.push("other worktrees currently present:");
    lines.push(
      ...result.otherWorktrees.map(
        (worktree) =>
          `  ${oneLine(worktree.branch)} @ ${oneLine(worktree.worktree)} — last seen ${
            timeAgoOrNull(worktree.lastSeen, now) ?? "unknown"
          }`,
      ),
    );
  }
  lines.push("preview only — run with --apply to restore");
  return lines.join("\n");
}

function formatRestoreResult(result: RestoreResult): string {
  return result.applied ? formatRestoreApply(result) : formatRestorePreview(result);
}

interface RestoreOptions {
  readonly apply?: boolean;
  readonly force?: boolean;
  readonly json?: boolean;
}

export function registerRestore(program: Command, context: CliContext): void {
  program
    .command("restore")
    .argument("<file>", "the snapshot file to restore from, resolved from the current directory")
    .description("rebuild the store from a snapshot file — preview by default, --apply to execute")
    .option("--apply", "actually perform the restore (default: preview only, nothing is touched)")
    .option("--force", "required to --apply over a non-empty store")
    .option("--json", "emit structured output")
    .action((file: string, options: RestoreOptions) => {
      const filePath = resolveFromPath(context, file);

      if (options.apply !== true) {
        // Preview: validate the whole file first — a bad file refuses before
        // the live store is ever opened — then read the live store's own
        // counts and other worktrees' presence. No temp file, no swap;
        // nothing here writes beyond openStore's own presence heartbeat.
        // The SAME validator `--apply` runs inside `restoreSnapshot` (T3),
        // shared rather than re-implemented: preview and apply must refuse the
        // identical bad file with the identical wording, which two
        // independently-maintained parsers on a destructive path cannot
        // guarantee. Preview needs only per-table counts, so it reads
        // `rowsByTable[table].length` off the shared parse and discards the rows.
        const text = readBoundedExportFile(filePath, SNAPSHOT_READ_OPTIONS);
        const currentVersion = targetVersion(MIGRATIONS);
        const parsed = parseSnapshotFile(text, currentVersion);

        const { store, warnings } = openContextStore(context);
        let result: RestorePreviewResult;
        try {
          const live = liveTableCounts(store);
          result = {
            applied: false,
            file: filePath,
            fromSchemaVersion: parsed.header.schemaVersion,
            toSchemaVersion: currentVersion,
            tables: SNAPSHOT_TABLES.map((table) => ({
              table,
              snapshot: parsed.rowsByTable[table].length,
              live: live[table],
            })),
            otherWorktrees: listOtherWorktreesPresence(store, store.identity().worktree),
          };
        } finally {
          store.close();
        }

        emit(
          result,
          { json: options.json === true, warnings, streams: context.streams },
          formatRestoreResult,
        );
        return;
      }

      // Apply: init.ts's own shape — direct openStore with its own
      // try/finally, never withStore, whose finally would double-close a
      // handle restoreSnapshot also manages on its own paths-only terms.
      const { store, warnings } = openContextStore(context);
      const dbPath = store.dbPath;
      try {
        const counts = liveTableCounts(store);
        if (!isEmptyStore(counts) && options.force !== true) {
          throw new KatraException({
            code: "conflict",
            message:
              "this store already holds data (tasks, deps, links, tags, events, notes, " +
              "claims, refs, or task_refs) — `katra restore --apply` refuses without --force, " +
              "to keep a destructive swap explicit. Run it again with --force to replace the " +
              "store's current contents, or restore into a fresh `katra init`.",
            reason: "store is not empty",
          });
        }
      } finally {
        // Closed explicitly, before restoreSnapshot — which opens and closes
        // every connection it touches itself (its own ownership contract:
        // paths only, never a handle). Holding this one open across that
        // call would leave it stale the instant the swap lands under it.
        store.close();
      }

      const loaded = restoreSnapshot(filePath, dbPath);
      const result: RestoreApplyResult = {
        applied: true,
        file: filePath,
        fromSchemaVersion: loaded.fromSchemaVersion,
        toSchemaVersion: loaded.toSchemaVersion,
        tables: loaded.tables,
        bakPath: `${dbPath}.bak`,
      };

      emit(
        result,
        { json: options.json === true, warnings, streams: context.streams },
        formatRestoreResult,
      );
    });
}
