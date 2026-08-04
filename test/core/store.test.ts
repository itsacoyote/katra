import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSchemaVersion } from "../../src/core/db/migrate.js";
import { isKatraException } from "../../src/core/errors.js";
import { openStore } from "../../src/core/store.js";
import { runConcurrent } from "../helpers/concurrent.js";
import { createGitRepo } from "../helpers/fixture.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function repo() {
  const r = createGitRepo();
  cleanups.push(() => r.cleanup());
  return r;
}

describe("openStore", () => {
  it("creates the store under the git common dir and reports it as new", () => {
    const r = repo();

    const { store, created } = openStore(r.dir, { createIfMissing: true });
    cleanups.push(() => store.close());

    expect(created).toBe(true);
    expect(existsSync(store.dbPath)).toBe(true);
    expect(store.dbPath.startsWith(store.commonDir)).toBe(true);
    expect(store.dbPath.endsWith(join("katra", "katra.db"))).toBe(true);
  });

  it("migrates a new store to the current schema version", () => {
    const r = repo();
    const { store } = openStore(r.dir, { createIfMissing: true });
    cleanups.push(() => store.close());

    expect(readSchemaVersion(store.db)).toBe(1);
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(["deps", "links", "tags", "tasks"]);
  });

  it("reports an existing store as not newly created", () => {
    const r = repo();
    const first = openStore(r.dir, { createIfMissing: true });
    first.store.close();

    const second = openStore(r.dir);
    cleanups.push(() => second.store.close());

    expect(second.created).toBe(false);
    expect(second.store.dbPath).toBe(first.store.dbPath);
  });

  it("refuses to open a store that does not exist yet", () => {
    // Silently conjuring an empty backlog would hide a typo'd directory or the
    // wrong repository entirely.
    const r = repo();

    try {
      openStore(r.dir);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(isKatraException(error)).toBe(true);
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("not_found");
      expect(error.message).toMatch(/katra init/);
    }
  });

  it("resolves the same store from the root, a subdirectory and a linked worktree", () => {
    const r = repo();
    const nested = join(r.dir, "src", "core");
    mkdirSync(nested, { recursive: true });
    const worktree = r.addWorktree("feature/store");

    const fromRoot = openStore(r.dir, { createIfMissing: true });
    fromRoot.store.close();
    const fromNested = openStore(nested);
    const fromWorktree = openStore(worktree);
    cleanups.push(() => {
      fromNested.store.close();
      fromWorktree.store.close();
    });

    expect(fromNested.store.dbPath).toBe(fromRoot.store.dbPath);
    expect(fromWorktree.store.dbPath).toBe(fromRoot.store.dbPath);
    expect(fromNested.created).toBe(false);
    expect(fromWorktree.created).toBe(false);
  });

  it("sees a row written from another worktree's handle", () => {
    // The point of the shared common dir: two sessions, one backlog.
    const r = repo();
    const worktree = r.addWorktree("feature/shared");

    const a = openStore(r.dir, { createIfMissing: true });
    const b = openStore(worktree);
    cleanups.push(() => {
      a.store.close();
      b.store.close();
    });

    a.store.db
      .prepare("INSERT INTO tasks (id,level,kind,title,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run(
        "kt-shared",
        "task",
        "feat",
        "written from the root",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

    expect(b.store.db.prepare("SELECT title FROM tasks WHERE id='kt-shared'").get()).toEqual({
      title: "written from the root",
    });
  });

  it("releases the connection on close", () => {
    const r = repo();
    const { store } = openStore(r.dir, { createIfMissing: true });

    expect(store.db.open).toBe(true);
    store.close();
    expect(store.db.open).toBe(false);
  });

  it("carries the ambient GIT_COMMON_DIR warning out of the store layer", () => {
    // Every command opens a store, so a warning dropped here would only ever
    // be reachable from init.
    const r = repo();
    const other = repo();

    const { store, warnings } = openStore(r.dir, {
      createIfMissing: true,
      env: { ...process.env, GIT_COMMON_DIR: join(other.dir, ".git") },
    });
    cleanups.push(() => store.close());

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("ambient-git-dir");
  });

  it("reports no warnings in an ordinary repository", () => {
    const r = repo();
    const { store, warnings } = openStore(r.dir, { createIfMissing: true });
    cleanups.push(() => store.close());

    expect(warnings).toEqual([]);
  });

  it("survives several processes racing to create the same store", {
    timeout: 60_000,
  }, async () => {
    // Acceptance criterion 8, at the layer that owns it. Two worktrees
    // running their first katra command together is the normal case, not an
    // exotic one — and it is genuinely hostile: setting WAL needs a momentary
    // exclusive lock that SQLite's busy handler does not cover, so without an
    // explicit retry one process in six dies with "database is locked".
    //
    // The workers call barrier() AFTER their imports: loading TypeScript
    // modules and the native binding takes a variable few hundred
    // milliseconds, so syncing before that would scatter them and quietly
    // stop reproducing the contention.
    // Sensitivity note: this is a probabilistic test. A single round catches
    // a missing WAL retry roughly one time in three, because the collision
    // window is narrow. Three fresh rounds raise that to roughly seven in
    // ten — measured by deleting the retry and re-running. The retry logic
    // itself is pinned deterministically in test/core/retry.test.ts; this
    // test covers its application at the real call site.
    const storePath = new URL("../../src/core/store.ts", import.meta.url).href;

    for (let round = 0; round < 3; round++) {
      const r = repo();

      const outcomes = await runConcurrent<{ created: boolean }>({
        count: 6,
        source: `
          const { openStore } = await import(${JSON.stringify(storePath)});
          barrier();
          const { store, created } = openStore(${JSON.stringify(r.dir)}, { createIfMissing: true });
          store.close();
          report({ created });
        `,
      });

      const failures = outcomes.filter((o) => !o.ok);
      expect(
        failures.map((f) => `round ${round}: ${f.stderr.split("\n").slice(0, 3).join(" ")}`),
      ).toEqual([]);

      const results = outcomes.map((o) => o.value).filter((v) => v !== undefined);
      expect(results).toHaveLength(6);
      // Exactly one process applies the migration, so exactly one may claim
      // to have created the store. An existsSync check would have all six
      // claim it.
      expect(results.filter((r2) => r2.created)).toHaveLength(1);

      const { store } = openStore(r.dir);
      expect(readSchemaVersion(store.db)).toBe(1);
      store.close();
    }
  });
});
