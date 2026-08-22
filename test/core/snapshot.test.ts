/**
 * Pure snapshot serialization (F10 T1): `rowToLine`/`lineToRow` and
 * `buildHeader`/`parseHeader` from `src/core/snapshot/serialize.ts`, plus the
 * structural "no store, no Buffer in types.ts" suite mirroring
 * `test/core/reconcile.test.ts`'s triage-scan pattern.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isKatraException } from "../../src/core/errors.js";
import {
  buildHeader,
  lineToRow,
  parseHeader,
  rowToLine,
} from "../../src/core/snapshot/serialize.js";
import type { TaskRow } from "../../src/core/snapshot/types.js";
import { SNAPSHOT_FORMAT_VERSION } from "../../src/core/snapshot/types.js";

/** A fully-populated tasks row — every field set, none left to default. */
function fullTaskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "kt-000001",
    level: "task",
    kind: "feat",
    title: "Example task",
    description: "An example description.",
    lane: "In Progress",
    priority: 2,
    assignee: "alice",
    parent_id: "kt-parent1",
    created_at: "2026-08-22T00:00:00.000Z",
    updated_at: "2026-08-22T01:00:00.000Z",
    closed_at: null,
    close_reason: null,
    ...overrides,
  };
}

describe("rowToLine / lineToRow", () => {
  it("serializes a row with keys in the pinned order, byte-stable across calls", () => {
    const row = fullTaskRow();
    // Hand-written, independent of TASK_ROW_FIELDS — the source of truth a
    // field-order swap in that array must disagree with.
    const golden =
      '{"id":"kt-000001","level":"task","kind":"feat","title":"Example task",' +
      '"description":"An example description.","lane":"In Progress","priority":2,' +
      '"assignee":"alice","parent_id":"kt-parent1",' +
      '"created_at":"2026-08-22T00:00:00.000Z","updated_at":"2026-08-22T01:00:00.000Z",' +
      '"closed_at":null,"close_reason":null}';

    const first = rowToLine("tasks", row);
    const second = rowToLine("tasks", row);

    expect(first).toBe(second);
    expect(first).toBe(golden);
  });

  it("round-trips control, bidi, and zero-width bytes exactly (no sanitization)", () => {
    // Built via String.fromCharCode, never a literal or escape sequence
    // spliced into the string — the migrate.test.ts precedent for keeping a
    // real control/bidi character out of this file's own source.
    const esc = String.fromCharCode(0x1b); // ESC
    const bel = String.fromCharCode(0x07); // BEL
    const nul = String.fromCharCode(0x00); // NUL
    const zwsp = String.fromCharCode(0x200b); // zero-width space
    const rlo = String.fromCharCode(0x202e); // right-to-left override
    const alm = String.fromCharCode(0x061c); // Arabic letter mark

    const hostileTitle = ["Evil", esc, "[31mtitle", bel, zwsp].join("");
    const hostileDescription = ["desc", nul, "with", rlo, "override", alm].join("");
    const row = fullTaskRow({ title: hostileTitle, description: hostileDescription });

    const line = rowToLine("tasks", row);
    const parsed = lineToRow("tasks", line, 1);

    expect(parsed).toEqual(row);
    expect(parsed.title).toBe(hostileTitle);
    expect(parsed.description).toBe(hostileDescription);
  });

  it("refuses a Buffer-valued column as corruption", () => {
    const row = {
      ...fullTaskRow(),
      title: Buffer.from("evil"),
    } as unknown as TaskRow;

    let caught: unknown;
    try {
      rowToLine("tasks", row);
    } catch (err) {
      caught = err;
    }

    expect(isKatraException(caught)).toBe(true);
    if (!isKatraException(caught)) throw new Error("unreachable");
    expect(caught.detail.code).toBe("validation");
  });

  it("refuses a malformed line with its 1-based number and no content echo", () => {
    const brokenLine = "{not valid json";

    let caught: unknown;
    try {
      lineToRow("tasks", brokenLine, 5);
    } catch (err) {
      caught = err;
    }

    expect(isKatraException(caught)).toBe(true);
    if (!isKatraException(caught)) throw new Error("unreachable");
    expect(caught.detail.code).toBe("validation");
    expect(caught.message).toContain("5");
    expect(caught.message).not.toContain(brokenLine);
  });

  it("parses a valid line back to the exact row shape", () => {
    const row = fullTaskRow();

    const line = rowToLine("tasks", row);
    const parsed = lineToRow("tasks", line, 1);

    expect(parsed).toEqual(row);
  });
});

describe("buildHeader / parseHeader", () => {
  it("refuses a header with formatVersion newer than known, naming the version", () => {
    const line = JSON.stringify({
      format: "katra-snapshot",
      formatVersion: SNAPSHOT_FORMAT_VERSION + 1,
      schemaVersion: 1,
    });

    let caught: unknown;
    try {
      parseHeader(line, 6);
    } catch (err) {
      caught = err;
    }

    expect(isKatraException(caught)).toBe(true);
    if (!isKatraException(caught)) throw new Error("unreachable");
    expect(caught.detail.code).toBe("validation");
    expect(caught.message).toContain(String(SNAPSHOT_FORMAT_VERSION + 1));
  });

  it("refuses a header with schemaVersion newer than the migration chain, naming the version", () => {
    const line = JSON.stringify({
      format: "katra-snapshot",
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      schemaVersion: 999,
    });

    let caught: unknown;
    try {
      parseHeader(line, 6);
    } catch (err) {
      caught = err;
    }

    expect(isKatraException(caught)).toBe(true);
    if (!isKatraException(caught)) throw new Error("unreachable");
    expect(caught.detail.code).toBe("validation");
    expect(caught.message).toContain("999");
  });

  it("round-trips a header through buildHeader/parseHeader with the pinned key order", () => {
    const line = buildHeader(6);

    expect(line).toBe('{"format":"katra-snapshot","formatVersion":1,"schemaVersion":6}');
    expect(parseHeader(line, 6)).toEqual({
      format: "katra-snapshot",
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      schemaVersion: 6,
    });
  });
});

describe("structural: no store import, no Buffer in types.ts", () => {
  /**
   * Strips block comments entirely, and strips a `//` line comment only when
   * `//` is the first non-whitespace content on its line — the
   * `test/core/reconcile.test.ts` structural-scan technique, reused here
   * rather than re-derived.
   */
  function stripComments(source: string): string {
    const withoutBlockComments = source.replaceAll(/\/\*[\s\S]*?\*\//g, "");
    return withoutBlockComments
      .split("\n")
      .map((line) => (/^\s*\/\//.test(line) ? "" : line))
      .join("\n");
  }

  /**
   * The two files T1 creates. Hand-triaged rather than a glob, so a third
   * file added later has to be triaged deliberately rather than silently
   * inheriting "pure" by virtue of living in this directory.
   */
  const PURE_FILES = ["types.ts", "serialize.ts"];

  /**
   * `export.ts` (T2) — the deliberate store-touching exception: `exportSnapshot`
   * legitimately imports `OpenStore`, `readTx` and `readSchemaVersion` to read
   * a real store, the identical split `reconcile/repo.ts` (store-touching) vs
   * `reconcile/{types,policy,engine}.ts` (pure) already draws one level up.
   * `restore.ts` (T3) joins this list when it lands.
   */
  const STORE_TOUCHING_FILES = ["export.ts"];

  function snapshotRoot(): string {
    return fileURLToPath(new URL("../../src/core/snapshot", import.meta.url));
  }

  it("the serialize modules import no store (structural)", () => {
    const root = snapshotRoot();

    const onDisk = readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"),
      )
      .map((entry) => entry.name);
    expect([...PURE_FILES, ...STORE_TOUCHING_FILES].sort()).toEqual([...onDisk].sort());

    const storeImport = /\bbetter-sqlite3\b|\bOpenStore\b|\bstore\.js\b/;
    for (const file of PURE_FILES) {
      const source = stripComments(readFileSync(join(root, file), "utf8"));
      expect(source, `${file} must not import a store module`).not.toMatch(storeImport);
    }

    // The probe this loop exists to pass: every file in STORE_TOUCHING_FILES
    // must actually trip storeImport, or the regex could be silently broken
    // (a typo that matches nothing) and the PURE_FILES loop above would pass
    // vacuously — proving nothing, the same trap git.test.ts's own spawning
    // pattern guards against with a matching positive assertion.
    for (const file of STORE_TOUCHING_FILES) {
      const source = stripComments(readFileSync(join(root, file), "utf8"));
      expect(source, `${file} was expected to import a store module`).toMatch(storeImport);
    }

    const bufferWord = /\bBuffer\b/;
    const typesSource = stripComments(readFileSync(join(root, "types.ts"), "utf8"));
    expect(typesSource, "types.ts must never reference Buffer").not.toMatch(bufferWord);
  });
});
