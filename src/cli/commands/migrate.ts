/**
 * `katra migrate beads` — imports a beads (`bd export`) JSONL export.
 *
 * **Real Commander subcommand, not a two-word string** — `program.command("migrate")`
 * parent, `.command("beads")` child. Same trap `note.ts`'s module docs name:
 * against commander 15, `.command("migrate beads")` builds a command literally
 * named "migrate beads", and a plan that assumed otherwise would have shipped
 * broken. `valueTakingFlags` (`program.ts`) already walks child commands, so
 * `--from`/`--apply`/`--json` living on the child costs nothing here.
 *
 * **Preview (no `--apply`) never opens a store.** It reads the export file,
 * runs `extractBeadsExport` + `planMigration` — both pure — and prints the
 * resulting {@link MigrationReport} with `applied: false`. No `withStore`, no
 * `openStore`, no store file created, no presence row bumped: spec AC 1 ("store
 * absent or unchanged") depends on that holding exactly.
 *
 * Only `--apply` touches the store, through the ordinary `withStore` path —
 * which itself refuses with the standard "run katra init" hint when no store
 * exists yet, because this command passes no `createIfMissing` (convention:
 * only `init` ever does).
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Command } from "commander";
import { actorFromIdentity } from "../../core/actor.js";
import { extractBeadsExport } from "../../core/beads/extract.js";
import type { LoadResult } from "../../core/beads/load.js";
import { loadMigration } from "../../core/beads/load.js";
import { planMigration } from "../../core/beads/transform.js";
import type { MigrationEdgeRef, MigrationItemRef } from "../../core/beads/types.js";
import { nowIso } from "../../core/clock.js";
import type { MigrationReport } from "../../core/contract.js";
import { KatraException } from "../../core/errors.js";
import { oneLine } from "../format.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStore } from "../with-store.js";

const DEFAULT_FROM = ".beads/issues.jsonl";

/**
 * Hard ceiling on `--from`'s size, refused before the file is even read.
 *
 * `extract.ts`'s own module docs note it materializes the whole file into
 * memory (the split line array plus the source string) — fine for an ordinary
 * export, but an unbounded read of a hostile or truncated file would otherwise
 * die deep inside V8 as `ERR_STRING_TOO_LONG`, surfacing as an `internal`
 * "katra broke" instead of the "your export is too big" refusal a caller can
 * actually act on (security scan).
 */
const MAX_FROM_BYTES = 128 * 1024 * 1024;

/**
 * Preview's stand-in for "who is running this migration". A preview never
 * opens a store, so there is no `Identity` to derive a real actor from — this
 * placeholder only ever lands in an *un-applied* report's degradation entries
 * (e.g. a comment whose author fell back to the migrating identity).
 */
const PREVIEW_ACTOR = "migration preview";

interface MigrateBeadsOptions {
  readonly from?: string;
  readonly apply?: boolean;
  readonly json?: boolean;
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Resolves `--from` against `context.cwd` — **never** against
 * `resolveStoreLocation`'s git common dir. That resolves to the WRONG root for
 * a relative `--from` inside a linked worktree (iteration-2 finding E), and
 * reaching for it here would mean touching store-resolution machinery from
 * the one path that must not open a store at all.
 */
function resolveFromPath(context: CliContext, from: string | undefined): string {
  const raw = from ?? DEFAULT_FROM;
  return isAbsolute(raw) ? raw : resolve(context.cwd, raw);
}

/** Stats and reads the export, refusing a missing file or one over {@link MAX_FROM_BYTES}. */
function readExportFile(path: string): string {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch {
    throw new KatraException({
      code: "not_found",
      message:
        `no beads export at ${path} — run \`bd export -o ${path}\` to create one, or point ` +
        "--from at an existing export",
      id: path,
    });
  }

  if (stats.size > MAX_FROM_BYTES) {
    throw new KatraException({
      code: "validation",
      message:
        `${path} is ${mib(stats.size)} — over the ${mib(MAX_FROM_BYTES)} limit ` +
        "katra migrate beads reads at once",
      field: "from",
      value: stats.size,
    });
  }

  return readFileSync(path, "utf8");
}

/** Merges a completed apply's write counts and minted ids into the plan's own report. */
function applyLoadResult(report: MigrationReport, result: LoadResult): MigrationReport {
  return { ...report, imported: result.counts, idMap: result.idMap, applied: true };
}

// ---------------------------------------------------------------------------
// Human rendering — sections-accumulator style, like formatNext (next.ts):
// one block per non-empty category, nothing printed for an empty one.
// ---------------------------------------------------------------------------

const itemRef = (item: MigrationItemRef): string => `  ${item.oldId}  ${oneLine(item.title)}`;
const edgeRef = (edge: MigrationEdgeRef): string =>
  `  ${edge.fromOldId} -> ${edge.toOldId}  (${oneLine(edge.type)})`;

function formatMigrationReport(report: MigrationReport): string {
  const blocks: string[] = [];
  const push = (label: string, count: number, lines: readonly string[]): void => {
    if (count === 0) return;
    blocks.push([`${label} (${String(count)})`, ...lines].join("\n"));
  };

  const totalItems = report.imported.byLevel.epic + report.imported.byLevel.task;
  blocks.push(
    `${String(totalItems)} item(s) ${report.applied ? "imported" : "would import"} — ` +
      `${String(report.imported.byLevel.epic)} epic(s), ${String(report.imported.byLevel.task)} task(s)`,
  );

  if (report.skippedRecords.count > 0) {
    const byType = report.skippedRecords.byType
      .map((entry) => `${oneLine(entry.type)}: ${String(entry.count)}`)
      .join(", ");
    blocks.push(
      `skipped ${String(report.skippedRecords.count)} non-issue record(s)` +
        (byType === "" ? "" : ` (${byType})`) +
        (report.skippedRecords.truncated ? " — type list truncated" : ""),
    );
  }

  push(
    "dropped: owner",
    report.droppedFields.owner.count,
    report.droppedFields.owner.items.map(itemRef),
  );
  push(
    "dropped: created by",
    report.droppedFields.createdBy.count,
    report.droppedFields.createdBy.items.map(itemRef),
  );
  push(
    "dropped: estimated minutes",
    report.droppedFields.estimatedMinutes.count,
    report.droppedFields.estimatedMinutes.items.map(itemRef),
  );
  push(
    "dropped: external ref",
    report.droppedFields.externalRef.count,
    report.droppedFields.externalRef.items.map(itemRef),
  );
  push(
    "dropped: started at",
    report.droppedFields.startedAt.count,
    report.droppedFields.startedAt.items.map(itemRef),
  );
  push(
    "dropped: comment author (fell back to the migrating identity)",
    report.droppedFields.commentAuthor.count,
    report.droppedFields.commentAuthor.items.map(
      (comment) => `  ${comment.oldId}  ${oneLine(comment.title)}  comment ${comment.commentId}`,
    ),
  );

  push(
    "reparented onto nearest ancestor epic",
    report.reparented.count,
    report.reparented.items.map(
      (item) => `  ${item.oldId}  ${oneLine(item.title)}  -> ${item.newParentOldId}`,
    ),
  );

  // Called out on its own line: an epic can never keep a beads parent (katra
  // is two levels only), so this is a structural drop, not an ordinary one.
  push(
    "epic edges dropped (an epic cannot keep a beads parent)",
    report.epicEdgesDropped.count,
    report.epicEdgesDropped.items.map(edgeRef),
  );

  push(
    "comments converted to notes",
    report.commentsConverted.count,
    report.commentsConverted.items.map(
      (comment) => `  ${comment.oldId}  ${oneLine(comment.title)}  comment ${comment.commentId}`,
    ),
  );

  push(
    "unmapped status (defaulted to Defined)",
    report.unmappedStatuses.count,
    report.unmappedStatuses.items.map(
      (unmapped) =>
        `  ${unmapped.oldId}  ${oneLine(unmapped.title)}  status=${oneLine(unmapped.raw)}`,
    ),
  );
  push(
    "unmapped issue_type (defaulted to task/chore)",
    report.unmappedTypes.count,
    report.unmappedTypes.items.map(
      (unmapped) =>
        `  ${unmapped.oldId}  ${oneLine(unmapped.title)}  issue_type=${oneLine(unmapped.raw)}`,
    ),
  );

  push(
    "dangling edges (endpoint missing or invalid)",
    report.danglingEdges.count,
    report.danglingEdges.items.map(edgeRef),
  );
  push("duplicate edges", report.duplicateEdges.count, report.duplicateEdges.items.map(edgeRef));

  push(
    "parent cycles broken",
    report.parentCycles.count,
    report.parentCycles.items.map(
      (cycle) => `  ${cycle.oldId}  ${oneLine(cycle.title)}  cycle: ${cycle.path.join(" -> ")}`,
    ),
  );
  push(
    "blocks cycles broken",
    report.blocksCycles.count,
    report.blocksCycles.items.map(
      (cycle) =>
        `  ${cycle.fromOldId} -> ${cycle.toOldId}  (${oneLine(cycle.type)})  cycle: ${cycle.path.join(" -> ")}`,
    ),
  );

  push(
    "invalid timestamps (fell back)",
    report.invalidTimestamps.count,
    report.invalidTimestamps.items.map(
      (ts) =>
        `  ${ts.oldId}  ${oneLine(ts.title)}  ${ts.field}: ${oneLine(ts.raw)} -> ${ts.fallback}`,
    ),
  );
  push(
    "invalid items (empty title, skipped)",
    report.invalidItems.count,
    report.invalidItems.items.map((item) => `  ${item.oldId}  "${oneLine(item.rawTitle)}"`),
  );
  push(
    "invalid notes (blank body, skipped)",
    report.invalidNotes.count,
    report.invalidNotes.items.map(
      (note) =>
        `  ${note.oldId}  ${oneLine(note.title)}  ${note.noteKind}` +
        (note.commentId === undefined ? "" : `  comment ${note.commentId}`),
    ),
  );
  push(
    "clamped priorities",
    report.clampedValues.count,
    report.clampedValues.items.map(
      (clamped) =>
        `  ${clamped.oldId}  ${oneLine(clamped.title)}  ${clamped.field}: ${String(clamped.raw)} -> ${String(clamped.clamped)}`,
    ),
  );
  push("empty labels dropped", report.emptyLabels.count, report.emptyLabels.items.map(itemRef));

  blocks.push(
    report.applied
      ? `applied — ${String(totalItems)} item(s) imported`
      : "preview — nothing written; run with --apply",
  );

  return blocks.join("\n\n");
}

export function registerMigrate(program: Command, context: CliContext): void {
  const migrate = program
    .command("migrate")
    .description("import project history from another tool");

  migrate
    .command("beads")
    .description("import a beads (`bd export`) JSONL export — preview by default, --apply to write")
    .option(
      "--from <file>",
      `the export to read, resolved from the current directory (default: ${DEFAULT_FROM})`,
    )
    .option(
      "--apply",
      "write the migration into an existing store (run `katra init` first if none exists); " +
        "without it, this is a dry run and no store is touched",
    )
    .option("--json", "emit structured output")
    .action((options: MigrateBeadsOptions) => {
      // Captured once, threaded through both branches — the same discipline
      // transform.ts's own module docs state for "now": every row a run
      // produces shares one fallback instant rather than drifting mid-run.
      const fallbackTimestamp = nowIso();
      const fromPath = resolveFromPath(context, options.from);
      const text = readExportFile(fromPath);
      const extract = extractBeadsExport(text);

      if (options.apply !== true) {
        const { report } = planMigration(extract, PREVIEW_ACTOR, fallbackTimestamp);
        const document: MigrationReport = report;
        emit(
          document,
          { json: options.json === true, streams: context.streams },
          formatMigrationReport,
        );
        return;
      }

      const { result, warnings } = withStore(context, (store) => {
        // One identity source (T6 senior INFO): loadMigration's Identity and
        // planMigration's migrating-actor string both derive from the same
        // store.identity() call, so the actor stamped on events can never
        // drift from the one transform used for note-author fallbacks.
        const identity = store.identity();
        const actor = actorFromIdentity(identity);
        const { plan, report } = planMigration(extract, actor, fallbackTimestamp);
        const loadResult = loadMigration(store, plan, identity);
        return applyLoadResult(report, loadResult);
      });

      const document: MigrationReport = result;
      emit(
        document,
        { json: options.json === true, warnings, streams: context.streams },
        formatMigrationReport,
      );
    });
}
