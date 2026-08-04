import { writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUSY_TIMEOUT_MS, openDatabase, writeTx } from "../../src/core/db/connection.js";
import { isKatraException } from "../../src/core/errors.js";
import { runConcurrent } from "../helpers/concurrent.js";
import { createNonRepoDir } from "../helpers/fixture.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDbPath(): string {
  const dir = createNonRepoDir();
  cleanups.push(() => dir.cleanup());
  return join(dir.dir, "katra.db");
}

describe("openDatabase", () => {
  it("reports wal journal mode on a freshly opened database", () => {
    const db = openDatabase(tempDbPath());
    cleanups.push(() => db.close());

    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("issues the foreign_keys pragma on every new connection", () => {
    // Per-connection, not stored in the file: a second connection that skipped
    // the pragma would silently lose referential integrity.
    //
    // Asserted white-box, on the call rather than the value, because the value
    // cannot distinguish. This better-sqlite3 build compiles with
    // DEFAULT_FOREIGN_KEYS, so `PRAGMA foreign_keys` already reads 1 with no
    // pragma issued at all — deleting the line from openDatabase left the
    // whole file green. That default is a distribution-specific compile flag,
    // not portable, and the dependency floats.
    const spy = vi.spyOn(Database.prototype, "pragma");
    try {
      const path = tempDbPath();
      const first = openDatabase(path);
      const second = openDatabase(path);
      cleanups.push(() => {
        first.close();
        second.close();
      });

      const issued = spy.mock.calls.filter((call) => call[0] === "foreign_keys = ON");
      expect(issued).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("sets katra's own busy_timeout on every new connection", () => {
    const path = tempDbPath();
    const first = openDatabase(path);
    const second = openDatabase(path);
    cleanups.push(() => {
      first.close();
      second.close();
    });

    // BUSY_TIMEOUT_MS differs from better-sqlite3's 5000 default on purpose:
    // while they matched, this assertion held whether or not the pragma ran.
    expect(BUSY_TIMEOUT_MS).not.toBe(5000);
    expect(first.pragma("busy_timeout", { simple: true })).toBe(BUSY_TIMEOUT_MS);
    expect(second.pragma("busy_timeout", { simple: true })).toBe(BUSY_TIMEOUT_MS);
  });

  it("actually enforces foreign keys rather than merely reporting them on", () => {
    const db = openDatabase(tempDbPath());
    cleanups.push(() => db.close());
    db.exec(`
      CREATE TABLE parent (id TEXT PRIMARY KEY);
      CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id));
    `);

    expect(() => db.prepare("INSERT INTO child VALUES ('c', 'nope')").run()).toThrowError(
      /FOREIGN KEY constraint failed/,
    );
  });

  it("reports an unreadable store without a stack trace", () => {
    const path = tempDbPath();
    writeFileSync(path, "this is definitely not a sqlite database", "utf8");

    try {
      openDatabase(path);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(isKatraException(error)).toBe(true);
      if (!isKatraException(error)) throw error;
      // F1 has no restore command, so the message must say so plainly rather
      // than implying recovery is possible.
      expect(error.message).toMatch(/not a readable database/i);
      expect(error.message).toMatch(/re-initialised|reinitialised/i);
    }
  });
});

describe("writeTx", () => {
  it("rolls back every statement in a writeTx when the callback throws", () => {
    const db = openDatabase(tempDbPath());
    cleanups.push(() => db.close());
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const insert = db.prepare("INSERT INTO t (v) VALUES (?)");

    expect(() =>
      writeTx(db, () => {
        insert.run("first");
        insert.run("second");
        throw new Error("abort");
      }),
    ).toThrowError("abort");

    expect(db.prepare("SELECT COUNT(*) c FROM t").get()).toEqual({ c: 0 });
  });

  it("supplies one timestamp so rows written together share it", () => {
    const db = openDatabase(tempDbPath());
    cleanups.push(() => db.close());
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO t (created_at) VALUES (?)");

    const used = writeTx(db, (now) => {
      insert.run(now);
      insert.run(now);
      insert.run(now);
      return now;
    });

    const rows = db.prepare("SELECT DISTINCT created_at FROM t").all();
    expect(rows).toEqual([{ created_at: used }]);
    expect(used).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("returns the callback's value", () => {
    const db = openDatabase(tempDbPath());
    cleanups.push(() => db.close());

    expect(writeTx(db, () => 42)).toBe(42);
  });

  it("completes all writes from six concurrent processes with no SQLITE_BUSY", {
    timeout: 60_000,
  }, async () => {
    // The measurement this whole design rests on. Six real OS processes, each
    // doing a read-then-write transaction — the shape cycle detection needs.
    // With BEGIN DEFERRED this loses roughly a third of its writes despite
    // busy_timeout; with BEGIN IMMEDIATE it loses none.
    const path = tempDbPath();
    const setup = openDatabase(path);
    setup.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, who TEXT NOT NULL)");
    setup.close();

    const outcomes = await runConcurrent<{ ok: number; busy: number; other: string[] }>({
      count: 6,
      source: `
        const { openDatabase, writeTx } = await import(${JSON.stringify(
          new URL("../../src/core/db/connection.ts", import.meta.url).href,
        )});
        barrier();
        const db = openDatabase(${JSON.stringify(path)});
        const read = db.prepare("SELECT COUNT(*) c FROM t");
        const write = db.prepare("INSERT INTO t (who) VALUES (?)");
        let ok = 0, busy = 0; const other = [];
        for (let i = 0; i < 50; i++) {
          try {
            writeTx(db, () => { read.get(); write.run("p" + INDEX); });
            ok++;
          } catch (e) {
            if (String(e.code).startsWith("SQLITE_BUSY")) busy++;
            else other.push(String(e.code ?? e.message));
          }
        }
        db.close();
        report({ ok, busy, other });
      `,
    });

    expect(outcomes.every((o) => o.ok)).toBe(true);
    const results = outcomes.map((o) => o.value).filter((v) => v !== undefined);
    expect(results).toHaveLength(6);

    const totalBusy = results.reduce((sum, r) => sum + r.busy, 0);
    const totalOk = results.reduce((sum, r) => sum + r.ok, 0);
    const otherErrors = results.flatMap((r) => r.other);

    expect(otherErrors).toEqual([]);
    expect(totalBusy).toBe(0);
    expect(totalOk).toBe(300);

    const verify = openDatabase(path);
    expect(verify.prepare("SELECT COUNT(*) c FROM t").get()).toEqual({ c: 300 });
    verify.close();
  });
});
