/**
 * Pure snapshot serialization (F10 T1): `rowToLine`/`lineToRow` and
 * `buildHeader`/`parseHeader` from `src/core/snapshot/serialize.ts`, the
 * structural "no store, no Buffer in types.ts" suite mirroring
 * `test/core/reconcile.test.ts`'s triage-scan pattern, and `restoreSnapshot`
 * (F10 T3) — every test input below is assembled from T1's own
 * `buildHeader`/`rowToLine` directly, never `exportSnapshot` (T2), since this
 * suite depends on T1 only.
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/core/db/connection.js";
import { migrate, targetVersion } from "../../src/core/db/migrate.js";
import { MIGRATIONS } from "../../src/core/db/migrations/index.js";
import type { SnapshotTable } from "../../src/core/enums.js";
import { isKatraException } from "../../src/core/errors.js";
import { restoreSnapshot } from "../../src/core/snapshot/restore.js";
import {
  buildHeader,
  lineToRow,
  parseHeader,
  rowToLine,
} from "../../src/core/snapshot/serialize.js";
import type {
  ClaimRow,
  DepRow,
  EventRow,
  LinkRow,
  NoteRow,
  RefRow,
  TagRow,
  TaskRefRow,
  TaskRow,
} from "../../src/core/snapshot/types.js";
import { SNAPSHOT_FORMAT_VERSION } from "../../src/core/snapshot/types.js";
import { seedTask } from "../helpers/seed.js";
import { createStoreFixture } from "../helpers/store.js";

/** Symlink creation needs elevated privileges on Windows CI runners. */
const onPosix = process.platform !== "win32";

/**
 * A pass-through call counter for `openDatabase` — the only way a database
 * file gets created or opened anywhere in `restoreSnapshot`. "Whole-file
 * validation before any DB work" has to be checked here, not by asserting a
 * temp file's absence afterward: a robust cleanup-on-failure path removes
 * the temp file whether it was created before or after validation ran, so a
 * post-hoc `existsSync` check cannot tell "never created" from "created,
 * then cleaned up" apart. Counting the one call that can create a database
 * file can (`board.test.ts`'s `readTxSpy` pattern).
 */
const openDatabaseSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../src/core/db/connection.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/core/db/connection.js")>();
  const openDatabase: typeof original.openDatabase = (path) => {
    openDatabaseSpy.calls += 1;
    return original.openDatabase(path);
  };
  return { ...original, openDatabase };
});

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

/** A fully-populated deps row. */
function fullDepRow(overrides: Partial<DepRow> = {}): DepRow {
  return {
    task_id: "kt-task1a",
    depends_on_id: "kt-task2a",
    created_at: "2026-08-22T02:00:00.000Z",
    ...overrides,
  };
}

/** A fully-populated links row. */
function fullLinkRow(overrides: Partial<LinkRow> = {}): LinkRow {
  return {
    a_id: "kt-task1a",
    b_id: "kt-task2a",
    created_at: "2026-08-22T02:00:00.000Z",
    ...overrides,
  };
}

/** A fully-populated tags row. */
function fullTagRow(overrides: Partial<TagRow> = {}): TagRow {
  return { task_id: "kt-task1a", tag: "urgent", ...overrides };
}

/** A fully-populated events row. */
function fullEventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: 1,
    type: "created",
    entity_id: "kt-task1a",
    epic_id: "kt-epicaa",
    actor: "main @ /repo/seed",
    from_lane: null,
    to_lane: null,
    ref: null,
    reason: null,
    title: "Example task",
    prior_actor: null,
    created_at: "2026-08-22T02:00:00.000Z",
    ...overrides,
  };
}

/** A fully-populated notes row. */
function fullNoteRow(overrides: Partial<NoteRow> = {}): NoteRow {
  return {
    id: "nt-000001",
    task_id: "kt-task1a",
    kind: "general",
    body: "a note that survives restore",
    actor: "main @ /repo/seed",
    created_at: "2026-08-22T02:00:00.000Z",
    ...overrides,
  };
}

/** A fully-populated claims row. */
function fullClaimRow(overrides: Partial<ClaimRow> = {}): ClaimRow {
  return {
    task_id: "kt-task1a",
    holder: "/repo/wt-a",
    actor: "feature/x @ /repo/wt-a",
    claimed_at: "2026-08-22T02:00:00.000Z",
    ...overrides,
  };
}

/** A fully-populated refs row. */
function fullRefRow(overrides: Partial<RefRow> = {}): RefRow {
  return {
    id: 1,
    provider: "github",
    external_id: "123",
    url: "https://github.com/example/repo/pull/123",
    cached_status: "open",
    cached_title: "Example PR",
    synced_at: "2026-08-22T02:00:00.000Z",
    ...overrides,
  };
}

/** A fully-populated task_refs row. */
function fullTaskRefRow(overrides: Partial<TaskRefRow> = {}): TaskRefRow {
  return { task_id: "kt-task1a", ref_id: 1, ...overrides };
}

/**
 * Assembles a snapshot file's full text from `buildHeader`/`rowToLine`
 * directly (T1) — the ground rule for every restore test below: never
 * `exportSnapshot` (T2), which this suite has no dependency on.
 */
function buildSnapshotFile(
  schemaVersion: number,
  entries: ReadonlyArray<readonly [SnapshotTable, unknown]>,
): string {
  const lines = [buildHeader(schemaVersion)];
  for (const [table, row] of entries) lines.push(rowToLine(table as never, row as never));
  return `${lines.join("\n")}\n`;
}

/** A fresh, empty, fully-migrated store's db path — closed, ready for `restoreSnapshot` to target. */
function emptyLiveDbPath(): { readonly dbPath: string; readonly repoDir: string; cleanup(): void } {
  const fixture = createStoreFixture();
  const dbPath = fixture.store.dbPath;
  const repoDir = fixture.repo.dir;
  fixture.store.close();
  return { dbPath, repoDir, cleanup: () => fixture.repo.cleanup() };
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
   * `export.ts` (T2) and `restore.ts` (T3) — the deliberate store-touching
   * exception: `exportSnapshot` legitimately imports `OpenStore`, `readTx`
   * and `readSchemaVersion` to read a real store, and `restoreSnapshot`
   * imports `openDatabase`/`writeTx`/`migrate` to build one — the identical
   * split `reconcile/repo.ts` (store-touching) vs
   * `reconcile/{types,policy,engine}.ts` (pure) already draws one level up.
   */
  const STORE_TOUCHING_FILES = ["export.ts", "restore.ts"];

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

    // `\bopenDatabase\b` covers restore.ts (T3): it touches a real database
    // through `db/connection.js`'s `openDatabase`, deliberately never
    // `OpenStore` — the ownership contract (`restore.ts`'s own module docs)
    // takes paths only, so it holds no store handle a caller could hand it.
    const storeImport = /\bbetter-sqlite3\b|\bOpenStore\b|\bstore\.js\b|\bopenDatabase\b/;
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

describe("restoreSnapshot", () => {
  it("restores a current-schema snapshot byte-faithfully including event ids and prior_actor", () => {
    const live = emptyLiveDbPath();
    const currentVersion = targetVersion(MIGRATIONS);

    const epic = fullTaskRow({ id: "kt-epicaa", level: "epic", parent_id: null, title: "An epic" });
    const task1 = fullTaskRow({ id: "kt-task1a", parent_id: "kt-epicaa", title: "Task one" });
    const task2 = fullTaskRow({ id: "kt-task2a", parent_id: null, title: "Task two" });
    const dep = fullDepRow();
    const link = fullLinkRow();
    const tag = fullTagRow();
    const event1 = fullEventRow({ id: 7, type: "created" });
    const event2 = fullEventRow({
      id: 12,
      type: "released",
      prior_actor: "old-branch @ /repo/wt-old",
    });
    const note = fullNoteRow();
    const claim = fullClaimRow();
    const ref = fullRefRow({ id: 3 });
    const taskRef = fullTaskRefRow({ ref_id: 3 });

    const content = buildSnapshotFile(currentVersion, [
      ["tasks", epic],
      ["tasks", task1],
      ["tasks", task2],
      ["deps", dep],
      ["links", link],
      ["tags", tag],
      ["events", event1],
      ["events", event2],
      ["notes", note],
      ["claims", claim],
      ["refs", ref],
      ["task_refs", taskRef],
    ]);
    const snapshotPath = join(live.repoDir, "current.jsonl");
    writeFileSync(snapshotPath, content, "utf8");

    const result = restoreSnapshot(snapshotPath, live.dbPath);

    expect(result.fromSchemaVersion).toBe(currentVersion);
    expect(result.toSchemaVersion).toBe(currentVersion);
    expect(result.tables.find((t) => t.table === "tasks")?.count).toBe(3);
    expect(result.tables.find((t) => t.table === "events")?.count).toBe(2);

    const db = openDatabase(live.dbPath);
    try {
      expect(db.prepare("SELECT id, level, parent_id, title FROM tasks ORDER BY id").all()).toEqual(
        [
          { id: "kt-epicaa", level: "epic", parent_id: null, title: "An epic" },
          { id: "kt-task1a", level: "task", parent_id: "kt-epicaa", title: "Task one" },
          { id: "kt-task2a", level: "task", parent_id: null, title: "Task two" },
        ],
      );
      // Event ids and prior_actor carried through literally — never re-minted,
      // never dropped (ADR-018's whole point).
      expect(db.prepare("SELECT id, type, prior_actor FROM events ORDER BY id").all()).toEqual([
        { id: 7, type: "created", prior_actor: null },
        { id: 12, type: "released", prior_actor: "old-branch @ /repo/wt-old" },
      ]);
      expect(db.prepare("SELECT task_id, depends_on_id FROM deps").get()).toEqual({
        task_id: "kt-task1a",
        depends_on_id: "kt-task2a",
      });
      expect(db.prepare("SELECT a_id, b_id FROM links").get()).toEqual({
        a_id: "kt-task1a",
        b_id: "kt-task2a",
      });
      expect(db.prepare("SELECT task_id, tag FROM tags").get()).toEqual({
        task_id: "kt-task1a",
        tag: "urgent",
      });
      expect(db.prepare("SELECT id, task_id, body FROM notes").get()).toEqual({
        id: "nt-000001",
        task_id: "kt-task1a",
        body: "a note that survives restore",
      });
      expect(db.prepare("SELECT task_id, holder FROM claims").get()).toEqual({
        task_id: "kt-task1a",
        holder: "/repo/wt-a",
      });
      expect(db.prepare("SELECT id, provider, external_id FROM refs").get()).toEqual({
        id: 3,
        provider: "github",
        external_id: "123",
      });
      expect(db.prepare("SELECT task_id, ref_id FROM task_refs").get()).toEqual({
        task_id: "kt-task1a",
        ref_id: 3,
      });
    } finally {
      db.close();
    }

    live.cleanup();
  });

  it("builds a v5 snapshot at v5 and migrates it forward to convergence", () => {
    const live = emptyLiveDbPath();

    const epic = fullTaskRow({ id: "kt-epicv5", level: "epic", parent_id: null, title: "v5 epic" });
    const task = fullTaskRow({ id: "kt-taskv5", parent_id: "kt-epicv5", title: "v5 task" });
    const event = fullEventRow({ id: 1, entity_id: "kt-taskv5", epic_id: "kt-epicv5" });
    const ref = fullRefRow({ id: 1 });
    const taskRef = fullTaskRefRow({ task_id: "kt-taskv5", ref_id: 1 });

    const content = buildSnapshotFile(5, [
      ["tasks", epic],
      ["tasks", task],
      ["events", event],
      ["refs", ref],
      ["task_refs", taskRef],
    ]);
    const snapshotPath = join(live.repoDir, "v5.jsonl");
    writeFileSync(snapshotPath, content, "utf8");

    const currentVersion = targetVersion(MIGRATIONS);
    const result = restoreSnapshot(snapshotPath, live.dbPath);

    expect(result.fromSchemaVersion).toBe(5);
    expect(result.toSchemaVersion).toBe(currentVersion);

    // Convergence (schema.test.ts's own pattern): the restored store's full
    // schema must match an ordinarily-migrated fresh store's, byte for byte.
    const restored = openDatabase(live.dbPath);
    const freshPath = join(live.repoDir, "fresh.db");
    const fresh = openDatabase(freshPath);
    try {
      migrate(fresh, MIGRATIONS);
      const schemaOf = (handle: typeof restored): unknown =>
        handle.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
      expect(schemaOf(restored)).toEqual(schemaOf(fresh));
    } finally {
      restored.close();
      fresh.close();
    }

    live.cleanup();
  });

  it("a malformed line aborts before any DB file is created", () => {
    const live = emptyLiveDbPath();
    const currentVersion = targetVersion(MIGRATIONS);

    const content = `${buildHeader(currentVersion)}\n{not valid json\n`;
    const snapshotPath = join(live.repoDir, "malformed.jsonl");
    writeFileSync(snapshotPath, content, "utf8");

    // Reset after emptyLiveDbPath()'s own setup calls — only calls made by
    // restoreSnapshot itself count from here.
    openDatabaseSpy.calls = 0;

    let caught: unknown;
    try {
      restoreSnapshot(snapshotPath, live.dbPath);
      expect.unreachable("should have thrown");
    } catch (err) {
      caught = err;
    }

    expect(isKatraException(caught)).toBe(true);
    if (!isKatraException(caught)) throw new Error("unreachable");
    expect(caught.detail.code).toBe("validation");

    // The real check: no database was ever opened, not merely "no temp file
    // survived" — a cleanup-on-failure path can make the latter true even
    // when a temp file was briefly created before the malformed line was
    // ever noticed.
    expect(openDatabaseSpy.calls).toBe(0);
    expect(existsSync(`${live.dbPath}.tmp-restore`)).toBe(false);
    expect(existsSync(`${live.dbPath}.bak`)).toBe(false);

    // The live store itself is untouched — still openable, still empty.
    const db = openDatabase(live.dbPath);
    try {
      expect(db.prepare("SELECT COUNT(*) c FROM tasks").get()).toEqual({ c: 0 });
    } finally {
      db.close();
    }

    live.cleanup();
  });

  it("a CHECK-violating row aborts the load and cleans up the temp file", () => {
    const live = emptyLiveDbPath();
    const currentVersion = targetVersion(MIGRATIONS);

    // Passes T1's own field-presence validation (every field is there), but
    // "NotARealLane" is not in LANES — the live CHECK constraint's job to
    // catch at insert time, not this format's to duplicate (types.ts's own
    // docstring).
    const badTask = fullTaskRow({
      id: "kt-badln1",
      parent_id: null,
      lane: "NotARealLane",
    });
    const content = buildSnapshotFile(currentVersion, [["tasks", badTask]]);
    const snapshotPath = join(live.repoDir, "bad-lane.jsonl");
    writeFileSync(snapshotPath, content, "utf8");

    let caught: unknown;
    try {
      restoreSnapshot(snapshotPath, live.dbPath);
      expect.unreachable("should have thrown");
    } catch (err) {
      caught = err;
    }

    expect(isKatraException(caught)).toBe(true);
    if (!isKatraException(caught)) throw new Error("unreachable");
    expect(caught.detail.code).toBe("validation");
    expect(caught.message).toContain("tasks");
    // Table and line context only — never the row's own content.
    expect(caught.message).not.toContain("NotARealLane");

    expect(existsSync(`${live.dbPath}.tmp-restore`)).toBe(false);
    expect(existsSync(`${live.dbPath}.bak`)).toBe(false);

    live.cleanup();
  });

  it("refuses a non-scalar column value instead of letting it shift the row's binds", () => {
    const live = emptyLiveDbPath();
    const currentVersion = targetVersion(MIGRATIONS);

    // closed_at:[] contributes zero bind values and close_reason:["a","b"]
    // contributes two — the total still balances against the row's 13
    // placeholders, so there is no arity error, and both columns are
    // unconstrained (nullable, no CHECK) so nothing else would catch the
    // result either: without `bindable`, this insert *succeeds*, silently,
    // with closed_at="a" and close_reason="b" (verified directly against
    // better-sqlite3). Deliberately not description/lane — a shift starting
    // there lands in the CHECK-constrained lane column, which would throw
    // for an unrelated reason and prove nothing about this guard.
    const misalignedTask = {
      ...fullTaskRow({ id: "kt-misal1", parent_id: null }),
      closed_at: [],
      close_reason: ["a", "b"],
    };
    const content = buildSnapshotFile(currentVersion, [["tasks", misalignedTask]]);
    const snapshotPath = join(live.repoDir, "misaligned.jsonl");
    writeFileSync(snapshotPath, content, "utf8");

    let caught: unknown;
    try {
      restoreSnapshot(snapshotPath, live.dbPath);
      expect.unreachable("should have thrown");
    } catch (err) {
      caught = err;
    }

    expect(isKatraException(caught)).toBe(true);
    if (!isKatraException(caught)) throw new Error("unreachable");
    expect(caught.detail.code).toBe("validation");

    // Nothing landed — not even a misaligned version of the row.
    const db = openDatabase(live.dbPath);
    try {
      expect(db.prepare("SELECT COUNT(*) c FROM tasks").get()).toEqual({ c: 0 });
    } finally {
      db.close();
    }

    live.cleanup();
  });

  it("a schemaVersion newer than the chain refuses before touching anything", () => {
    const live = emptyLiveDbPath();
    const currentVersion = targetVersion(MIGRATIONS);

    const content = `${buildHeader(currentVersion + 1)}\n`;
    const snapshotPath = join(live.repoDir, "future.jsonl");
    writeFileSync(snapshotPath, content, "utf8");

    openDatabaseSpy.calls = 0;

    let caught: unknown;
    try {
      restoreSnapshot(snapshotPath, live.dbPath);
      expect.unreachable("should have thrown");
    } catch (err) {
      caught = err;
    }

    expect(isKatraException(caught)).toBe(true);
    if (!isKatraException(caught)) throw new Error("unreachable");
    expect(caught.detail.code).toBe("validation");
    expect(caught.message).toContain(String(currentVersion + 1));

    expect(openDatabaseSpy.calls).toBe(0);
    expect(existsSync(`${live.dbPath}.tmp-restore`)).toBe(false);
    expect(existsSync(`${live.dbPath}.bak`)).toBe(false);

    live.cleanup();
  });

  it("the swap preserves the previous store as .bak and the restored store passes a search probe", () => {
    const fixture = createStoreFixture();
    const dbPath = fixture.store.dbPath;
    const repoDir = fixture.repo.dir;
    // Distinguishing pre-restore content, seeded directly through the real
    // store handle before it is closed.
    seedTask(fixture.store, { id: "kt-orig01", title: "original pre-restore task" });
    fixture.store.close();

    const currentVersion = targetVersion(MIGRATIONS);
    const searchableTask = fullTaskRow({
      id: "kt-quokka",
      parent_id: null,
      title: "the quokka migration plan",
    });
    const content = buildSnapshotFile(currentVersion, [["tasks", searchableTask]]);
    const snapshotPath = join(repoDir, "search.jsonl");
    writeFileSync(snapshotPath, content, "utf8");

    restoreSnapshot(snapshotPath, dbPath);

    const bakPath = `${dbPath}.bak`;
    expect(existsSync(bakPath)).toBe(true);
    const bak = openDatabase(bakPath);
    try {
      expect(bak.prepare("SELECT title FROM tasks WHERE id = 'kt-orig01'").get()).toEqual({
        title: "original pre-restore task",
      });
    } finally {
      bak.close();
    }

    const restored = openDatabase(dbPath);
    try {
      expect(restored.prepare("SELECT title FROM tasks WHERE id = 'kt-quokka'").get()).toEqual({
        title: "the quokka migration plan",
      });
      const hits = restored
        .prepare("SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH 'quokka'")
        .all();
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      restored.close();
    }

    fixture.repo.cleanup();
  });

  it("hostile bytes in titles and note bodies survive restore exactly", () => {
    const live = emptyLiveDbPath();
    const currentVersion = targetVersion(MIGRATIONS);

    // Built via String.fromCharCode only, never a literal control/bidi byte
    // spliced into this file's own source (the migrate.test.ts precedent
    // serialize.test.ts's own hostile round-trip test above already follows).
    const esc = String.fromCharCode(0x1b);
    const bel = String.fromCharCode(0x07);
    const zwsp = String.fromCharCode(0x200b);
    const nul = String.fromCharCode(0x00);
    const rlo = String.fromCharCode(0x202e);
    const alm = String.fromCharCode(0x061c);

    const hostileTitle = ["Evil", esc, "[31mtitle", bel, zwsp].join("");
    const hostileDescription = ["desc", nul, "with", rlo, "override", alm].join("");
    const hostileBody = ["note", zwsp, "body", rlo, "override"].join("");

    const task = fullTaskRow({
      id: "kt-hostl1",
      parent_id: null,
      title: hostileTitle,
      description: hostileDescription,
    });
    const note = fullNoteRow({ task_id: "kt-hostl1", body: hostileBody });
    const content = buildSnapshotFile(currentVersion, [
      ["tasks", task],
      ["notes", note],
    ]);
    const snapshotPath = join(live.repoDir, "hostile.jsonl");
    writeFileSync(snapshotPath, content, "utf8");

    restoreSnapshot(snapshotPath, live.dbPath);

    const db = openDatabase(live.dbPath);
    try {
      expect(db.prepare("SELECT title, description FROM tasks WHERE id='kt-hostl1'").get()).toEqual(
        { title: hostileTitle, description: hostileDescription },
      );
      expect(db.prepare("SELECT body FROM notes WHERE task_id='kt-hostl1'").get()).toEqual({
        body: hostileBody,
      });
    } finally {
      db.close();
    }

    live.cleanup();
  });

  it.runIf(onPosix)("clears a dangling symlink at the temp path", () => {
    const live = emptyLiveDbPath();
    const currentVersion = targetVersion(MIGRATIONS);

    // A dangling symlink sitting exactly where the temp build wants to
    // create its database — the shape a stranded attacker-controlled link
    // (or a genuinely stale one) would take. `existsSync` follows symlinks,
    // so it would report this path as *absent* and skip removing it; left
    // in place, `openDatabase(tempPath)` would build the restore at
    // `dangleTarget` instead (outside this test's own store directory), and
    // the final swap would rename the *link* onto the live path rather than
    // a real database file.
    const dangleTarget = join(tmpdir(), `katra-restore-escape-${String(process.pid)}.db`);
    const tempPath = `${live.dbPath}.tmp-restore`;
    symlinkSync(dangleTarget, tempPath);

    const task = fullTaskRow({ id: "kt-danglk", parent_id: null, title: "not escaped" });
    const content = buildSnapshotFile(currentVersion, [["tasks", task]]);
    const snapshotPath = join(live.repoDir, "dangling.jsonl");
    writeFileSync(snapshotPath, content, "utf8");

    restoreSnapshot(snapshotPath, live.dbPath);

    // The live path is a real database file now, not the symlink that was
    // sitting at the temp path.
    expect(lstatSync(live.dbPath).isSymbolicLink()).toBe(false);
    // Nothing was ever built at the link's target — the escape never
    // happened.
    expect(existsSync(dangleTarget)).toBe(false);
    // The restore itself genuinely succeeded, using a real file.
    const db = openDatabase(live.dbPath);
    try {
      expect(db.prepare("SELECT title FROM tasks WHERE id='kt-danglk'").get()).toEqual({
        title: "not escaped",
      });
    } finally {
      db.close();
    }

    live.cleanup();
  });
});
