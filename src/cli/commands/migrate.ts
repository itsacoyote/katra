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
import type {
  CommentRef,
  MigrationEdgeRef,
  MigrationItemRef,
  ReportSection,
} from "../../core/beads/types.js";
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
 * memory (the split line array plus the source string) — measured, a 128 MiB
 * cap would still let that pipeline balloon to roughly 1.3 GB of heap before
 * `planMigration` even starts, dying exactly the way this guard's own message
 * promises to prevent. 32 MiB is ~70x this repository's own real export
 * (`.beads/issues.jsonl`, 145 records) — generous headroom for a real
 * project's history without reopening the same failure mode at a number that
 * merely looks safer.
 */
const MAX_FROM_BYTES = 32 * 1024 * 1024;

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

/**
 * Stats and reads the export, refusing a missing file, a non-regular file
 * (fifo, device, directory — `--from /dev/zero`/a named pipe would otherwise
 * read forever or hang waiting on a writer, and a directory reaches
 * `readFileSync` as an opaque `EISDIR` `internal` fault), or one over
 * {@link MAX_FROM_BYTES}.
 */
function readExportFile(path: string): string {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new KatraException({
        code: "not_found",
        message:
          `no beads export at ${path} — run \`bd export -o ${path}\` to create one, or point ` +
          "--from at an existing export",
        id: path,
      });
    }
    // Anything other than "does not exist" — permission denied, a broken
    // symlink, an I/O error — is a distinct refusal that names the errno
    // rather than being folded into the same "go create one" hint.
    throw new KatraException({
      code: "validation",
      message: `could not stat --from ${path}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
      field: "from",
      value: path,
    });
  }

  if (!stats.isFile()) {
    throw new KatraException({
      code: "validation",
      message: `${path} is not a regular file — --from needs a bd export written to disk`,
      field: "from",
      value: path,
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

  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    // Stat succeeding proves the path exists and is a regular file, but not
    // that this process can read it — a mode-000 file (or a permission
    // change between the stat and this read) would otherwise let an EACCES
    // escape as an unhandled fault (exit 4, "katra broke") for what is really
    // a user-fixable permissions problem.
    throw new KatraException({
      code: "validation",
      message: `could not read --from ${path}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
      field: "from",
      value: path,
    });
  }
}

/** Merges a completed apply's write counts and minted ids into the plan's own report. */
function applyLoadResult(report: MigrationReport, result: LoadResult): MigrationReport {
  return { ...report, imported: result.counts, idMap: result.idMap, applied: true };
}

// ---------------------------------------------------------------------------
// Human rendering — sections-accumulator style, like formatNext (next.ts):
// one block per non-empty category, nothing printed for an empty one.
// ---------------------------------------------------------------------------

// beads ids are export content, not minted ids — a raw oldId/commentId/path
// entry can carry the same hostile bytes (ANSI escapes, embedded newlines) any
// other export field can, and the preview report is what a caller reads
// *before* deciding whether to run --apply at all.
const id = (value: string): string => oneLine(value);

const itemRef = (item: MigrationItemRef): string => `  ${id(item.oldId)}  ${oneLine(item.title)}`;
const edgeRef = (edge: MigrationEdgeRef): string =>
  `  ${id(edge.fromOldId)} -> ${id(edge.toOldId)}  (${oneLine(edge.type)})`;
const commentRef = (comment: CommentRef): string =>
  `  ${id(comment.oldId)}  ${oneLine(comment.title)}  comment ${id(comment.commentId)}`;

/** The six sections whose items are plain {@link MigrationItemRef}s — one bespoke row each would be identical. */
const ITEM_REF_SECTIONS: ReadonlyArray<{
  readonly label: string;
  readonly pick: (report: MigrationReport) => ReportSection<MigrationItemRef>;
}> = [
  { label: "dropped: owner", pick: (report) => report.droppedFields.owner },
  { label: "dropped: created by", pick: (report) => report.droppedFields.createdBy },
  { label: "dropped: estimated minutes", pick: (report) => report.droppedFields.estimatedMinutes },
  { label: "dropped: external ref", pick: (report) => report.droppedFields.externalRef },
  { label: "dropped: started at", pick: (report) => report.droppedFields.startedAt },
  { label: "empty labels dropped", pick: (report) => report.emptyLabels },
];

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

  for (const { label, pick } of ITEM_REF_SECTIONS) {
    const section = pick(report);
    push(label, section.count, section.items.map(itemRef));
  }

  push(
    "dropped: comment author (fell back to the migrating identity)",
    report.droppedFields.commentAuthor.count,
    report.droppedFields.commentAuthor.items.map(commentRef),
  );

  push(
    "reparented onto nearest ancestor epic",
    report.reparented.count,
    report.reparented.items.map(
      (item) => `  ${id(item.oldId)}  ${oneLine(item.title)}  -> ${id(item.newParentOldId)}`,
    ),
  );

  // Called out on its own line: a structural drop, not an ordinary one. Two
  // distinct reasons share this one category — an epic can never keep a
  // beads parent (katra is two levels only), or the chain the item's own
  // parent-child edge belongs to never reaches an epic at all (no
  // epic/milestone anywhere above it) — both leave the edge with nothing in
  // katra to attach to.
  push(
    "parent edges dropped (no katra parent to attach to)",
    report.epicEdgesDropped.count,
    report.epicEdgesDropped.items.map(edgeRef),
  );

  push(
    "comments converted to notes",
    report.commentsConverted.count,
    report.commentsConverted.items.map(commentRef),
  );

  push(
    "unmapped status (defaulted to Defined)",
    report.unmappedStatuses.count,
    report.unmappedStatuses.items.map(
      (unmapped) =>
        `  ${id(unmapped.oldId)}  ${oneLine(unmapped.title)}  status=${oneLine(unmapped.raw)}`,
    ),
  );
  push(
    "unmapped issue_type (defaulted to task/chore)",
    report.unmappedTypes.count,
    report.unmappedTypes.items.map(
      (unmapped) =>
        `  ${id(unmapped.oldId)}  ${oneLine(unmapped.title)}  issue_type=${oneLine(unmapped.raw)}`,
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
      (cycle) =>
        `  ${id(cycle.oldId)}  ${oneLine(cycle.title)}  cycle: ${cycle.path.map(id).join(" -> ")}` +
        (cycle.truncated ? " …" : ""),
    ),
  );
  push(
    "blocks cycles broken",
    report.blocksCycles.count,
    report.blocksCycles.items.map(
      (cycle) =>
        `  ${id(cycle.fromOldId)} -> ${id(cycle.toOldId)}  (${oneLine(cycle.type)})  cycle: ${cycle.path.map(id).join(" -> ")}`,
    ),
  );

  push(
    "invalid timestamps (fell back)",
    report.invalidTimestamps.count,
    report.invalidTimestamps.items.map(
      (ts) =>
        `  ${id(ts.oldId)}  ${oneLine(ts.title)}  ${oneLine(ts.field)}: ${oneLine(ts.raw)} -> ${oneLine(ts.fallback)}`,
    ),
  );
  push(
    "invalid items (skipped)",
    report.invalidItems.count,
    report.invalidItems.items.map(
      (item) => `  ${id(item.oldId)}  "${oneLine(item.rawTitle)}"  (${oneLine(item.reason)})`,
    ),
  );
  push(
    "invalid notes (blank body, skipped)",
    report.invalidNotes.count,
    report.invalidNotes.items.map(
      (note) =>
        `  ${id(note.oldId)}  ${oneLine(note.title)}  ${note.noteKind}` +
        (note.commentId === undefined ? "" : `  comment ${id(note.commentId)}`),
    ),
  );
  push(
    "clamped priorities",
    report.clampedValues.count,
    report.clampedValues.items.map(
      (clamped) =>
        `  ${id(clamped.oldId)}  ${oneLine(clamped.title)}  ${clamped.field}: ${String(clamped.raw)} -> ${String(clamped.clamped)}`,
    ),
  );

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
