/**
 * `katra snapshot` — writes the entire store to one deterministic,
 * git-diffable JSONL file (F10 T2). Registers only the `snapshot` command;
 * `restore` is T4's.
 */

import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Command } from "commander";
import type { SnapshotResult } from "../../core/contract.js";
import { exportSnapshot } from "../../core/snapshot/export.js";
import type { OpenStore } from "../../core/store.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStore } from "../with-store.js";

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
// Human rendering — sections-accumulator style, like formatMigrationReport
// (migrate.ts): one line of totals, then one row per table.
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
