/**
 * F2's whole-feature gates.
 *
 * `feature.test.ts` already iterates the program for command registration and
 * `--json` coverage, and it grew to cover `log` and `note` as those landed —
 * so this file holds only what has no home yet: the end-to-end history a
 * finished feature can finally produce, and the concurrency widening research
 * asked for.
 *
 * Duplicating the registration gate here would double a test without doubling
 * what it can catch.
 */

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import type { EventLog } from "../../src/core/contract.js";
import { openDatabase } from "../../src/core/db/connection.js";
import { DB_FILE_NAME, STORE_DIR_NAME } from "../../src/core/db/locate.js";
import { readSchemaVersion } from "../../src/core/db/migrate.js";
import { migration0001 } from "../../src/core/db/migrations/0001-init.js";
import { MIGRATIONS } from "../../src/core/db/migrations/index.js";
import { runCli } from "../helpers/cli.js";
import { runConcurrent } from "../helpers/concurrent.js";
import type { GitFixture } from "../helpers/fixture.js";
import { createGitRepo, git } from "../helpers/fixture.js";

let repo: GitFixture;
beforeEach(() => {
  repo = createGitRepo();
});
afterEach(() => repo.cleanup());

async function add(args: readonly string[]): Promise<string> {
  return (await runCli(["add", ...args], { cwd: repo.dir })).stdout.trim();
}

describe("a task's whole life, as history", () => {
  beforeEach(async () => {
    await runCli(["init"], { cwd: repo.dir });
  });

  it("records a full task lifecycle as a readable history", async () => {
    // Every event type katra emits, produced by real commands in the order a
    // task actually experiences them, then read back through `log`. Each piece
    // is tested in isolation elsewhere; what only exists here is that the
    // pieces compose into one legible account.
    const epic = await add(["ship the feature", "--level", "epic"]);
    const task = await add(["wire it up", "--parent", epic]);

    await runCli(["update", task, "--lane", "In Progress"], { cwd: repo.dir });
    await runCli(["note", "add", task, "--kind", "handoff", "--body-file", "-"], {
      cwd: repo.dir,
      stdin: "picked this up, half done",
    });
    await runCli(["close", task, "--reason", "shipped"], { cwd: repo.dir });
    await runCli(["reopen", task], { cwd: repo.dir });
    await runCli(["cancel", task, "--reason", "changed our minds"], { cwd: repo.dir });

    const doomed = await add(["a typo"]);
    await runCli(["delete", doomed, "--force"], { cwd: repo.dir });

    const history = ((await runCli(["log", task, "--json"], { cwd: repo.dir })).json() as EventLog)
      .events;

    expect(history.map((event) => event.type)).toEqual([
      "cancelled",
      "reopened",
      "closed",
      "note-added",
      "status-changed",
      "created",
    ]);

    // Every row names the task it is about and who wrote it, so the account
    // stands on its own without a second lookup.
    expect(history.every((event) => event.entityTitle === "wire it up")).toBe(true);
    expect(history.every((event) => event.actor.includes(" @ "))).toBe(true);
    expect(history.every((event) => event.epicId === epic)).toBe(true);

    // The whole-store read still holds the deleted task, title and all.
    const all = ((await runCli(["log", "--json"], { cwd: repo.dir })).json() as EventLog).events;
    const removed = all.filter((event) => event.entityId === doomed);
    expect(removed.map((event) => event.type)).toEqual(["deleted", "created"]);
    expect(removed.every((event) => event.entityTitle === "a typo")).toBe(true);
  });

  it("leaves the working tree untouched through a full lifecycle", async () => {
    // katra's store lives inside `.git`, so nothing it does may show up as a
    // change to the repository it is tracking work for.
    const task = await add(["a task"]);
    await runCli(["update", task, "--lane", "Planned"], { cwd: repo.dir });
    await runCli(["note", "add", task, "--body-file", "-"], {
      cwd: repo.dir,
      stdin: "a note",
    });
    await runCli(["close", task], { cwd: repo.dir });

    expect(git(repo.dir, "status", "--porcelain")).toBe("");
  });
});

describe("migrating a v1 store under contention", () => {
  it("survives eight processes migrating a v1 store at once", { timeout: 90_000 }, async () => {
    // F1 measured six against an empty file. This is the harder case research
    // flagged: a store that already exists at v1, so every process finds work
    // to do rather than a fresh file, and the losers queue on BUSY_TIMEOUT_MS
    // with no retry wrapped around `migrate`'s own transaction.
    const storeDir = join(repo.dir, ".git", STORE_DIR_NAME);
    const dbPath = join(storeDir, DB_FILE_NAME);

    const setup = await runCli(["init"], { cwd: repo.dir });
    expect(setup.exitCode).toBe(EXIT.ok);

    // Rewind to v1: drop what 0002 and 0003 added and reset the version, so
    // the store is exactly what an installation from before this feature has.
    const rewind = openDatabase(dbPath);
    rewind.exec(
      "DROP TABLE IF EXISTS notes; DROP TABLE IF EXISTS claims; " +
        "DROP TABLE IF EXISTS presence; DROP TABLE IF EXISTS events;",
    );
    rewind.pragma("user_version = 1");
    expect(readSchemaVersion(rewind)).toBe(1);
    rewind.exec(
      `INSERT INTO tasks (id, level, kind, title, created_at, updated_at)
       VALUES ('kt-v1keep', 'task', 'feat', 'written before the migration',
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    // The rewind has to have actually happened, or every assertion below holds
    // against a store that was already at v2 and this measures nothing.
    const tables = rewind
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).not.toContain("events");
    expect(tables).not.toContain("notes");
    rewind.close();

    const outcomes = await runConcurrent<{ version: number; created: boolean }>({
      count: 8,
      source: `
        const { openStore } = await import(${JSON.stringify(
          new URL("../../src/core/store.ts", import.meta.url).href,
        )});
        const { readSchemaVersion } = await import(${JSON.stringify(
          new URL("../../src/core/db/migrate.ts", import.meta.url).href,
        )});
        barrier();
        const opened = openStore(${JSON.stringify(repo.dir)});
        const version = readSchemaVersion(opened.store.db);
        opened.store.close();
        report({ version, created: opened.created });
      `,
    });

    const failures = outcomes.filter((outcome) => !outcome.ok);
    expect(failures.map((f) => f.stderr.split("\n").slice(0, 3).join(" "))).toEqual([]);

    const target = Math.max(...MIGRATIONS.map((migration) => migration.version));
    expect(outcomes.map((outcome) => outcome.value?.version)).toEqual(
      Array.from({ length: 8 }, () => target),
    );

    // Exactly one process applied the migration. Without contention every one
    // of them would find work to do, so this is what says they actually raced
    // rather than running one after another.
    expect(outcomes.filter((outcome) => outcome.value?.created === true)).toHaveLength(1);

    // The v1 row survived, and the v2 tables exist for every one of them.
    const verify = openDatabase(dbPath);
    expect(verify.prepare("SELECT title FROM tasks WHERE id='kt-v1keep'").get()).toEqual({
      title: "written before the migration",
    });
    expect(verify.prepare("SELECT COUNT(*) c FROM events").get()).toEqual({ c: 0 });
    verify.close();
  });

  it("still ships migration 1 unchanged, so an installed store replays nothing", () => {
    // Forward-only: an installation that already ran step 1 will never run it
    // again, so editing it would leave two stores with different schemas at
    // the same version number.
    expect(MIGRATIONS[0]?.sql).toBe(migration0001.sql);
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3]);
  });
});
