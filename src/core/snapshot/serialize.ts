/**
 * Pure snapshot serialization (F10, `katra-9aw.67`, T1): rows and the header
 * both ways — `rowToLine`/`lineToRow`, `buildHeader`/`parseHeader`. No file
 * I/O, no store: `export.ts` (T2) and `restore.ts` (T3) are the only modules
 * that touch a real database or the filesystem; everything here takes and
 * returns plain values, which is what makes it trivially testable.
 *
 * **No sanitizers, and that is deliberate, not an oversight.** `oneLine`/
 * `sanitizeBody` (`cli/format.ts`) exist to make stored text safe for a
 * *terminal* — this is the one text-producing path in katra that must not
 * touch either: a snapshot is a backup, not a render, and its whole job is
 * reproducing exactly what the store holds, hostile control/bidi/zero-width
 * bytes included (epic requirement 4). `test/core/snapshot.test.ts`'s hostile
 * round-trip test exists specifically to fail loudly if a sanitizer call is
 * ever added here by someone reaching for the codebase's usual reflex on
 * stored text (plan MED-5).
 *
 * Every value is copied through a fixed field-order whitelist
 * (`snapshot/types.ts`'s `SNAPSHOT_ROW_FIELDS`/`SNAPSHOT_HEADER_FIELDS`),
 * built with `Object.defineProperty` rather than `{...row}`/`{...parsed}` —
 * `beads/extract.ts`'s `toBeadsIssue` docstring has the full reasoning
 * (`JSON.parse`/spread both use `CreateDataProperty` semantics, so a hostile
 * `"__proto__"`/`"constructor"` own-key on a parsed line would otherwise ride
 * through to whatever reads a returned row downstream). `rowToLine`'s input
 * is a typed row rather than untrusted JSON, so the same hazard is less
 * live there than on `lineToRow`'s read side — the whitelist is applied
 * uniformly anyway, for the same reason `toBeadsIssue`'s docstring gives:
 * safety that does not depend on every future edit keeping a field list
 * free of those names.
 */

import type { SnapshotTable } from "../enums.js";
import { KatraException } from "../errors.js";
import type { SnapshotHeader, SnapshotRowByTable } from "./types.js";
import { SNAPSHOT_FORMAT_VERSION, SNAPSHOT_HEADER_FIELDS, SNAPSHOT_ROW_FIELDS } from "./types.js";

/**
 * `line`/the parsed value are never part of the message — only the line
 * number is, per `beads/extract.ts`'s `malformedLine` precedent (task body:
 * prefer line numbers over content echoes when a refusal must reference
 * untrusted input). `reason` is always one of this module's own fixed
 * strings, or a known-safe schema token (a table or field name), never
 * anything read from the line itself.
 *
 * Exported for `restore.ts` (F10 T3), which needs the identical malformed-
 * line wording for the rows it validates before this module's own
 * `lineToRow` ever sees them (routing a line to its table first) — a second,
 * hand-copied definition would drift from this one silently.
 */
export function malformedLine(lineNo: number, reason: string): never {
  throw new KatraException({
    code: "validation",
    field: "line",
    value: lineNo,
    message: `snapshot line ${lineNo} is malformed (${reason}) — the file may be corrupt or hand-edited`,
  });
}

/** Whitelist-copies `fields` off `source` onto a fresh object — see the module docs for why `Object.defineProperty`, not `{...source}`. */
function pickFields(
  source: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    Object.defineProperty(result, field, {
      value: source[field],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return result;
}

/**
 * A JSON object — the shape basics every parsed line or header must clear
 * before anything reads a field off it.
 *
 * Exported for `restore.ts` (F10 T3), which needs the same shape check
 * before it can determine which table a line belongs to, ahead of handing
 * it to this module's own `lineToRow`.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * Serializes one row to a single JSON line, keys in {@link
 * SNAPSHOT_ROW_FIELDS}'s pinned order for `table` — never `Object.keys`, never
 * a spread. The same row always produces the same bytes (determinism, epic
 * AC1): `JSON.stringify` preserves the insertion order of an object's own
 * string-keyed properties, and every key here is inserted in exactly the
 * array's order, so the array *is* the byte order.
 *
 * Refuses a driver-artifact value (impossible in a healthy store — the
 * schema is TEXT/INTEGER only, epic requirement 8) as corruption rather than
 * letting `JSON.stringify` serialize it as `{"type":"Buffer","data":[…]}`, a
 * shape nothing downstream understands (`narrow.ts`'s `narrowText` docstring
 * has the same finding for a live read path).
 */
export function rowToLine<T extends SnapshotTable>(table: T, row: SnapshotRowByTable[T]): string {
  const fields = SNAPSHOT_ROW_FIELDS[table] as readonly string[];
  const source = row as unknown as Record<string, unknown>;

  for (const field of fields) {
    const value = source[field];
    if (Buffer.isBuffer(value)) {
      throw new KatraException({
        code: "validation",
        field: `${table}.${field}`,
        value: "Buffer",
        message:
          `${table}.${field} holds a driver-artifact binary value, not TEXT/INTEGER — ` +
          "this is corruption, not data to serialize",
      });
    }
  }

  return JSON.stringify(pickFields(source, fields));
}

/**
 * Parses one JSON line back into a row for `table`. Shape basics only,
 * mirroring `beads/extract.ts`'s "JSON → typed records, not field-by-field
 * validation" scope line: every field {@link SNAPSHOT_ROW_FIELDS} pins for
 * `table` must be present as an own key (even when its value is `null` —
 * `rowToLine` never omits a key), or the line refuses as malformed rather
 * than silently producing a row with an `undefined` field that would only
 * surface later as a confusing `CHECK`-constraint failure at restore's
 * insert (T3). A field's *value* is not otherwise type-checked here — that
 * is the live schema's job once T3 attempts the insert, not this format's to
 * duplicate.
 */
export function lineToRow<T extends SnapshotTable>(
  table: T,
  line: string,
  lineNo: number,
): SnapshotRowByTable[T] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    malformedLine(lineNo, "invalid JSON");
  }

  if (!isPlainObject(parsed)) {
    malformedLine(lineNo, `not a JSON object (expected a "${table}" row)`);
  }

  const fields = SNAPSHOT_ROW_FIELDS[table] as readonly string[];
  for (const field of fields) {
    if (!(field in parsed)) {
      malformedLine(lineNo, `missing field "${field}" (expected a "${table}" row)`);
    }
  }

  return pickFields(parsed, fields) as unknown as SnapshotRowByTable[T];
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/**
 * Builds line 1 of a snapshot file. Only `schemaVersion` is a parameter —
 * `format`/`formatVersion` are fixed by the format itself (`types.ts`), so a
 * caller cannot accidentally write a header claiming the wrong one.
 */
export function buildHeader(schemaVersion: number): string {
  const header: SnapshotHeader = {
    format: "katra-snapshot",
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    schemaVersion,
  };
  return JSON.stringify(
    pickFields(header as unknown as Record<string, unknown>, SNAPSHOT_HEADER_FIELDS),
  );
}

/** Shape basics for a parsed header: the three fields present, `format` exactly right, both versions non-negative integers. */
function isHeaderShape(
  value: unknown,
): value is { format: "katra-snapshot"; formatVersion: number; schemaVersion: number } {
  if (!isPlainObject(value)) return false;
  if (value.format !== "katra-snapshot") return false;
  return (
    typeof value.formatVersion === "number" &&
    Number.isInteger(value.formatVersion) &&
    value.formatVersion >= 0 &&
    typeof value.schemaVersion === "number" &&
    Number.isInteger(value.schemaVersion) &&
    value.schemaVersion >= 0
  );
}

/**
 * Parses and validates a snapshot's header line (always physical line 1).
 * `knownSchemaVersion` is the caller's own ceiling — the highest version this
 * build's migration chain understands (`db/migrate.ts`'s `targetVersion`,
 * exported for exactly this call) — never read from anywhere inside this
 * store-free module, the same reason `formatVersion`'s ceiling is the
 * `SNAPSHOT_FORMAT_VERSION` constant declared beside the type it describes
 * rather than a second parameter.
 *
 * A version newer than either ceiling refuses with wording mirroring
 * `db/migrate.ts:58-67`'s future-store refusal — the same shape of mistake
 * (a build too old for what it is being asked to open), so it reads as the
 * same class of refusal rather than a third, unrelated wording for it.
 */
export function parseHeader(line: string, knownSchemaVersion: number): SnapshotHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    malformedLine(1, "invalid JSON");
  }

  if (!isHeaderShape(parsed)) {
    malformedLine(1, "does not match the snapshot header shape");
  }

  if (parsed.formatVersion > SNAPSHOT_FORMAT_VERSION) {
    throw new KatraException({
      code: "validation",
      field: "formatVersion",
      value: parsed.formatVersion,
      message:
        `this snapshot was written by a newer katra (format v${parsed.formatVersion}; ` +
        `this build understands v${SNAPSHOT_FORMAT_VERSION}). Upgrade katra to restore it.`,
    });
  }

  if (parsed.schemaVersion > knownSchemaVersion) {
    throw new KatraException({
      code: "validation",
      field: "schemaVersion",
      value: parsed.schemaVersion,
      message:
        `this snapshot was written by a newer katra (schema v${parsed.schemaVersion}; ` +
        `this build understands v${knownSchemaVersion}). Upgrade katra to restore it.`,
    });
  }

  return {
    format: "katra-snapshot",
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    schemaVersion: parsed.schemaVersion,
  };
}
