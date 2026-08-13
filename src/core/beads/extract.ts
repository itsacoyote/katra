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
import { capText } from "../text.js";
import type { BeadsIssue, SkippedRecordType } from "./types.js";

/**
 * How many distinct non-`issue` `_type` values `skippedRecords.byType` names
 * before folding the rest into the running total — the same "a bounded read
 * reports itself" doctrine `MAX_CANDIDATES` follows in `tasks/ids.ts`. A
 * hostile export could otherwise carry an unbounded number of distinct
 * garbage `_type` strings, each minting its own report row forever.
 */
export const MAX_SKIPPED_TYPES = 20;

/**
 * How long a `_type` string may be before it enters `skippedRecords.byType`.
 * Real values are short identifiers (`wisp`, `gate`, …); this only bounds
 * what a hostile export can inflate the report with.
 */
export const MAX_SKIPPED_TYPE_CHARS = 100;

/**
 * What `extractBeadsExport` returns: the typed issues, plus the same
 * `{count, byType, truncated}` shape `MigrationReport.skippedRecords` uses
 * (`beads/types.ts`). `transform.ts` (T5) forwards this object into the
 * report as-is rather than re-aggregating it, so the two shapes are pinned to
 * agree here rather than by convention at the call site.
 */
export interface BeadsExtract {
  readonly issues: readonly BeadsIssue[];
  readonly skippedRecords: {
    /** Total non-`issue` records skipped, summed across every type — exact, unaffected by `truncated`. */
    readonly count: number;
    /** The first {@link MAX_SKIPPED_TYPES} distinct types seen, each capped to {@link MAX_SKIPPED_TYPE_CHARS}. */
    readonly byType: readonly SkippedRecordType[];
    /** True when a distinct type past the cap was folded into `count` without its own `byType` entry. */
    readonly truncated: boolean;
  };
}

/** A parsed JSON object carrying bd export's own `_type` record discriminator. */
type ExportRecord = Record<string, unknown> & { readonly _type: string };

/**
 * Structural shape floor: a JSON object with a string `_type`, and — when
 * `_type` is `"issue"` — a string `id` and `title` too. That second half is
 * belt-and-braces, not a validation creep: `MigrationItemRef` (`beads/types.ts`,
 * built from `id`/`title` on nearly every `MigrationReport` category) is
 * constructed all over `transform.ts`, and this is the one place that can
 * turn a missing/wrong-typed pair into a single named-line refusal instead of
 * a `string` field silently holding `undefined` through the rest of the
 * pipeline. Nothing else about an issue's shape is checked here — see the
 * module docs.
 */
function isExportRecord(value: unknown): value is ExportRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as {
    readonly _type?: unknown;
    readonly id?: unknown;
    readonly title?: unknown;
  };
  if (typeof candidate._type !== "string") return false;
  if (candidate._type === "issue") {
    return typeof candidate.id === "string" && typeof candidate.title === "string";
  }
  return true;
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
 * Every {@link BeadsIssue} field name, in the interface's own order — the
 * whitelist `toBeadsIssue` copies through. `satisfies` pins every entry to a
 * real key of the interface, so a field renamed there without a matching
 * edit here is a compile error, not a silent drop.
 */
const ISSUE_FIELDS = [
  "id",
  "title",
  "description",
  "status",
  "priority",
  "issue_type",
  "owner",
  "created_at",
  "created_by",
  "updated_at",
  "dependencies",
  "dependency_count",
  "dependent_count",
  "comment_count",
  "design",
  "acceptance_criteria",
  "notes",
  "assignee",
  "estimated_minutes",
  "started_at",
  "closed_at",
  "close_reason",
  "external_ref",
  "labels",
  "comments",
] as const satisfies readonly (keyof BeadsIssue)[];

/**
 * Copies exactly the {@link ISSUE_FIELDS} whitelist from an untrusted record
 * onto a fresh object — never `{...record}`. `JSON.parse` and object spread
 * both use `CreateDataProperty` semantics, so a hostile export line like
 * `{"_type":"issue","__proto__":{"polluted":1},...}` leaves `record` (and a
 * naive spread copy of it) carrying an own data property literally named
 * `__proto__` — inert on its own, but a loaded gun for whatever reads this
 * `BeadsIssue` downstream: `Object.assign(target, issue)` or a `for...in`
 * assignment loop uses `[[Set]]` semantics per key, which *does* walk the
 * prototype chain to `Object.prototype`'s `__proto__` accessor and mutates
 * `target`'s real prototype. `constructor`/`hasOwnProperty` are the same
 * class of hazard (the latter breaks `issue.hasOwnProperty(...)` outright).
 *
 * The whitelist alone already closes this — none of {@link ISSUE_FIELDS} is
 * one of those names, so a hostile key is never read, let alone copied.
 * `Object.defineProperty` on top is defense in depth: it defines a plain own
 * data property unconditionally, so even if this loop's key list were ever
 * widened to something dynamic, it could not reach the `__proto__` setter
 * the way `result[key] = value` can for a runtime-supplied "__proto__" key.
 *
 * Everything else here is the same deliberate scope line as before: T3's job
 * is JSON → typed records, not field-by-field validation (module docs
 * above), so a field's *value* is copied as-is, never checked.
 */
function toBeadsIssue(record: ExportRecord): BeadsIssue {
  const result: Record<string, unknown> = {};
  for (const field of ISSUE_FIELDS) {
    if (field in record) {
      Object.defineProperty(result, field, {
        value: record[field],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  return result as unknown as BeadsIssue;
}

/**
 * Parses a bd export's JSONL content into typed issues, tolerating blank
 * lines and a trailing newline. One pass over the lines, no quadratic string
 * work — each line is parsed once.
 *
 * Not streaming: `text.split("\n")` materializes the whole line array before
 * the loop starts, so peak memory is the input string plus one array entry
 * per line — linear in the input size, not independent of it (measured ~9x
 * peak memory on a pathological newline-only input). Acceptable for a local
 * CLI reading one file at a time; a file-size guard, if one is ever needed,
 * belongs in the CLI layer (T7) that reads the file, not here.
 */
export function extractBeadsExport(text: string): BeadsExtract {
  const issues: BeadsIssue[] = [];
  // Insertion-ordered, capped at MAX_SKIPPED_TYPES distinct keys — see the
  // truncation handling below.
  const skippedByType = new Map<string, number>();
  let skippedCount = 0;
  let truncated = false;

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
      malformedLine(
        lineNumber,
        'does not match the bd export record shape (string _type; string id/title when _type is "issue")',
      );
    }

    if (parsed._type === "issue") {
      issues.push(toBeadsIssue(parsed));
      continue;
    }

    skippedCount++;
    const type = capText(parsed._type, MAX_SKIPPED_TYPE_CHARS).text;
    if (skippedByType.has(type)) {
      skippedByType.set(type, (skippedByType.get(type) ?? 0) + 1);
    } else if (skippedByType.size < MAX_SKIPPED_TYPES) {
      skippedByType.set(type, 1);
    } else {
      // A 21st+ distinct type: no row of its own, but it still counts toward
      // the exact total above — `count` never lies, only `byType` narrows.
      truncated = true;
    }
  }

  const byType: SkippedRecordType[] = [...skippedByType].map(([type, count]) => ({ type, count }));

  return {
    issues,
    skippedRecords: {
      count: skippedCount,
      byType,
      truncated,
    },
  };
}
