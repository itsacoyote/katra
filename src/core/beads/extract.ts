/**
 * Turns an untrusted bd export (JSONL) into typed records — F5's first
 * pipeline stage (`katra-9aw.49.3`, T3).
 *
 * `extractBeadsExport` takes the export's **content**, not a path: no file
 * I/O happens here, so the module stays store-free and trivially testable,
 * and the CLI (T7) alone decides where the bytes come from. Parsing is
 * line-by-line `JSON.parse`, never `JSON.parse` over the whole string — a
 * multi-megabyte `bd export` should not have to be entirely well-formed for
 * one field on one line to be readable, and a line-oriented failure can name
 * the exact line that broke rather than an opaque "unexpected token"
 * somewhere in the file.
 *
 * Two kinds of untrusted line, two different responses:
 *
 * - A line that is not valid JSON, or parses to something other than a JSON
 *   object carrying a string `_type` (the bd export's own per-record
 *   discriminator — verified present on every record in this repo's own
 *   `.beads/issues.jsonl`) — **refuses**. `KatraException` code
 *   `validation`, naming the 1-based line number. Per the task body: "a
 *   corrupt export should stop the migration, not half-load."
 * - A well-formed record whose `_type` is not `"issue"` (beads machinery
 *   with no katra equivalent — wisps, gates, molecules, … — AGENTS.md's
 *   non-goals list) — **skipped**, counted per type, never thrown.
 *   `mapping.ts`/`transform.ts` (T4/T5) are where a bad *field on an issue*
 *   gets this same non-throwing, reported treatment (`unmappedStatuses`,
 *   `invalidItems`, …); extract's only refusal is structural, on the record
 *   as a whole.
 *
 * Beyond that structural check, this module does not validate an issue's
 * fields — it casts the record straight to {@link BeadsIssue} rather than
 * confirming each field is present and of the expected type. That is a
 * deliberate scope line drawn by the task body ("Field presence is NOT
 * validated here beyond shape basics ... that classification belongs to
 * transform"): transform's report categories (`unmappedStatuses`,
 * `invalidTimestamps`, `clampedValues`, `invalidItems`, …) would be
 * unreachable if extract already threw on the values that feed them.
 */

import { KatraException } from "../errors.js";
import type { BeadsIssue, SkippedRecordType } from "./types.js";

/**
 * What `extractBeadsExport` returns: the typed issues, plus the same
 * `{count, byType}` shape `MigrationReport.skippedRecords` uses
 * (`beads/types.ts`). `transform.ts` (T5) forwards this object into the
 * report as-is rather than re-aggregating it, so the two shapes are pinned to
 * agree here rather than by convention at the call site.
 */
export interface BeadsExtract {
  readonly issues: readonly BeadsIssue[];
  readonly skippedRecords: {
    /** Total non-`issue` records skipped, summed across every type below. */
    readonly count: number;
    readonly byType: readonly SkippedRecordType[];
  };
}

/** A parsed JSON object carrying bd export's own `_type` record discriminator. */
type ExportRecord = Record<string, unknown> & { readonly _type: string };

function isExportRecord(value: unknown): value is ExportRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { readonly _type?: unknown })._type === "string"
  );
}

/**
 * `line` is never part of the message — only the line number is, per the
 * task body's instruction to prefer line numbers over content echoes when a
 * refusal must reference untrusted input. `reason` is always one of this
 * module's own fixed strings, never anything read from the line itself.
 */
function malformedLine(lineNumber: number, reason: string): never {
  throw new KatraException({
    code: "validation",
    field: "line",
    value: lineNumber,
    message: `bd export line ${lineNumber} is malformed (${reason}) — the export may be corrupt or truncated`,
  });
}

/**
 * `_type` is bd export's own record discriminator, not a {@link BeadsIssue}
 * field (see `beads/types.ts`) — dropped here so it never leaks downstream
 * into a stored tag or a report as unexplained JSON. Everything past that is
 * a deliberate, documented cast (module docs above), not an oversight: T3's
 * job is JSON → typed records, not field-by-field validation.
 */
function toBeadsIssue(record: ExportRecord): BeadsIssue {
  const rest: Record<string, unknown> = { ...record };
  delete rest._type;
  return rest as unknown as BeadsIssue;
}

/**
 * Parses a bd export's JSONL content into typed issues, tolerating blank
 * lines and a trailing newline. Bounded memory: one pass over the lines, no
 * quadratic string work — `text.split("\n")` is linear in the input size,
 * and each line is parsed once.
 */
export function extractBeadsExport(text: string): BeadsExtract {
  const issues: BeadsIssue[] = [];
  const skippedByType = new Map<string, number>();

  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    const lineNumber = index + 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLine(lineNumber, "invalid JSON");
    }

    if (!isExportRecord(parsed)) {
      malformedLine(lineNumber, "not a JSON object with a string _type field");
    }

    if (parsed._type === "issue") {
      issues.push(toBeadsIssue(parsed));
    } else {
      skippedByType.set(parsed._type, (skippedByType.get(parsed._type) ?? 0) + 1);
    }
  }

  const byType: SkippedRecordType[] = [...skippedByType].map(([type, count]) => ({ type, count }));

  return {
    issues,
    skippedRecords: {
      count: byType.reduce((sum, entry) => sum + entry.count, 0),
      byType,
    },
  };
}
