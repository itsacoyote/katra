/**
 * F6's whole-story proof: `search`, `recent` and `stale` through the real
 * CLI against a store seeded with real commands (`add`/`note add`/`claim`/
 * `close`/`update`/`delete`) — f4/f5's register (`f4-feature.test.ts`,
 * `f5-feature.test.ts`). Every unit-level shape — hostile-character
 * sanitization, the exact usage refusal, snippet clamping, the negative
 * `--limit` refusal — already has a dedicated home in `search.test.ts`,
 * `recent.test.ts` and `stale.test.ts`; this file's job is the *story* those
 * unit tests cannot tell: several commands, several writes, one store, read
 * back only through `runCli`. Direct SQL is reserved for what no command can
 * do — backdating history (`backdate`, `test/helpers/store.ts`) and building
 * a pre-migration store (the second describe block below).
 *
 * AC 8's find-it/lose-it cycle lives in exactly one test, not four, because
 * it is one task's lifecycle told in order: retitling moves what `search`
 * finds, closing does not, deleting removes it everywhere. Splitting it
 * across separate tests would silently drop the ordering guarantee the AC
 * actually asks for — that these are the *same* task, walked through in
 * sequence, not four unrelated fixtures that happen to agree.
 *
 * The migration story (AC 9) is deliberately outside this file's shared
 * per-test `katra init` fixture: it needs a store built by hand at schema
 * v3, and `katra init` would carry a fresh store straight to v4 before the
 * point being proved — that opening a v3 store *normally* is what upgrades
 * and backfills it, no separate step — ever gets a chance to run.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import type { RecentResult, SearchResult, StaleResult } from "../../src/core/contract.js";
import type { DatabaseHandle } from "../../src/core/db/connection.js";
import { openDatabase } from "../../src/core/db/connection.js";
import { DB_FILE_NAME, STORE_DIR_NAME } from "../../src/core/db/locate.js";
import { migrate, readSchemaVersion } from "../../src/core/db/migrate.js";
import { MIGRATIONS } from "../../src/core/db/migrations/index.js";
import { runCli } from "../helpers/cli.js";
import type { GitFixture } from "../helpers/fixture.js";
import { createGitRepo } from "../helpers/fixture.js";
import { backdate } from "../helpers/store.js";

describe("F6 e2e — search, recent and stale through the real CLI", () => {
  let repo: GitFixture;
  beforeEach(async () => {
    repo = createGitRepo();
    await runCli(["init"], { cwd: repo.dir });
  });
  afterEach(() => repo.cleanup());

  async function add(args: readonly string[], stdin?: string): Promise<string> {
    const result = await runCli(["add", ...args], {
      cwd: repo.dir,
      ...(stdin === undefined ? {} : { stdin }),
    });
    expect(result.exitCode, result.stderr).toBe(EXIT.ok);
    return result.stdout.trim();
  }

  async function note(id: string, body: string): Promise<void> {
    const result = await runCli(["note", "add", id, "--body-file", "-"], {
      cwd: repo.dir,
      stdin: body,
    });
    expect(result.exitCode, result.stderr).toBe(EXIT.ok);
  }

  it("finds a task by a description-only word, and rolls up two matching notes on another task to one marked row", async () => {
    const byDescription = await add(
      ["an unrelated title carrying no shared words", "--body-file", "-"],
      "mentions zephyrion only in the description",
    );

    const byNotes = await add(["another unrelated title, also no shared words"]);
    await note(byNotes, "first handoff note mentioning velociraptor");
    await note(byNotes, "second note mentioning velociraptor again");

    const descHit = await runCli(["search", "zephyrion", "--json"], { cwd: repo.dir });
    expect(descHit.exitCode).toBe(EXIT.ok);
    const descDoc = descHit.json() as SearchResult;
    expect(descDoc.hits.map((hit) => hit.id)).toEqual([byDescription]);
    expect(descDoc.hits[0]?.matchedIn).toBe("task");
    expect(descDoc.hits[0]?.snippet).toContain("zephyrion");

    const noteHit = await runCli(["search", "velociraptor", "--json"], { cwd: repo.dir });
    expect(noteHit.exitCode).toBe(EXIT.ok);
    const noteDoc = noteHit.json() as SearchResult;
    // Two matching notes on the same task still roll up to exactly one row.
    expect(noteDoc.hits.map((hit) => hit.id)).toEqual([byNotes]);
    expect(noteDoc.hits[0]?.matchedIn).toBe("note");

    const text = await runCli(["search", "velociraptor"], { cwd: repo.dir });
    expect(text.stdout).toContain("note match —");
  });

  it('AND-combines "auth mig" and prefix-matches the final term, finding "auth migration" but neither "auth" nor "migration" alone', async () => {
    const target = await add(["revisit auth migration plan"]);
    await add(["auth review scheduled for next week"]);
    await add(["migration checklist for the other project"]);

    const result = await runCli(["search", "auth mig", "--json"], { cwd: repo.dir });
    expect(result.exitCode).toBe(EXIT.ok);
    const doc = result.json() as SearchResult;
    expect(doc.hits.map((hit) => hit.id)).toEqual([target]);
  });

  it("ranks an id-fragment match above a same-query text match", async () => {
    const idTarget = await add(["an ordinary task with no special words"]);
    // A prefix of idTarget's own generated suffix (MIN_PREFIX_LENGTH is 2;
    // four characters keeps this comfortably clear of a coincidental match).
    const fragment = idTarget.slice(3, 7);

    const textTarget = await add([`mentions ${fragment} explicitly in its own title`]);

    const result = await runCli(["search", fragment, "--json"], { cwd: repo.dir });
    expect(result.exitCode).toBe(EXIT.ok);
    const doc = result.json() as SearchResult;

    // The id match sorts first regardless of tier (search.ts's docs), ahead
    // of the plain text match on the other task.
    expect(doc.hits.map((hit) => hit.id)).toEqual([idTarget, textTarget]);
    expect(doc.hits[0]?.idMatch).toBe(true);
    expect(doc.hits[0]?.matchedIn).toBe("task");
    expect(doc.hits[0]?.snippet).toBeNull();
    expect(doc.hits[1]?.idMatch).toBe(false);
  });

  it("narrows to a lane both with query text and without any text at all", async () => {
    const inDefined = await add(["alpha shared roadmap task"]);
    const inPlanned = await add(["beta shared roadmap task", "--lane", "Planned"]);

    const filterOnly = await runCli(["search", "--lane", "Planned", "--json"], { cwd: repo.dir });
    expect(filterOnly.exitCode).toBe(EXIT.ok);
    const filterDoc = filterOnly.json() as SearchResult;
    expect(filterDoc.hits.map((hit) => hit.id)).toEqual([inPlanned]);

    const textPlusFilter = await runCli(["search", "roadmap", "--lane", "Defined", "--json"], {
      cwd: repo.dir,
    });
    expect(textPlusFilter.exitCode).toBe(EXIT.ok);
    const combinedDoc = textPlusFilter.json() as SearchResult;
    expect(combinedDoc.hits.map((hit) => hit.id)).toEqual([inDefined]);
  });

  it("treats an operator-laden hostile query as inert literal text end to end", async () => {
    await add(["first ordinary task"]);
    await add(["second ordinary task"]);

    const hostileQueries = ['" OR 1=1 --', "term NEAR(other) *", "'; DROP TABLE tasks; --"];
    for (const query of hostileQueries) {
      const result = await runCli(["search", query, "--json"], { cwd: repo.dir });
      expect(result.exitCode, query).toBe(EXIT.ok);
      expect(result.stderr, query).toBe("");
      const doc = result.json() as SearchResult;
      // Neither seeded title contains any of these literal tokens, so an
      // interpreted operator (matching everything) is the only way this
      // comes back non-empty.
      expect(doc.hits, query).toEqual([]);
    }
  });

  it("reflects freshly performed activity in recent, newest first", async () => {
    const oldest = await add(["never touched again"]);
    const first = await add(["touched, then claimed"]);
    const second = await add(["touched twice, most recently just now"]);

    await note(first, "a handoff that touches it again");
    const claimed = await runCli(["claim", first], { cwd: repo.dir });
    expect(claimed.exitCode).toBe(EXIT.ok);
    const closed = await runCli(["close", second, "--reason", "wrapping up"], { cwd: repo.dir });
    expect(closed.exitCode).toBe(EXIT.ok);

    const result = await runCli(["recent", "--json"], { cwd: repo.dir });
    expect(result.exitCode).toBe(EXIT.ok);
    const doc = result.json() as RecentResult;
    expect(doc.hits.map((hit) => hit.id)).toEqual([second, first, oldest]);
  });

  it("returns only open items older than a tight --older-than window, using real historical timestamps", async () => {
    const forgotten = await add(["forgotten a couple hours back"]);
    backdate(repo.dir, forgotten, 2 * 60 * 60 * 1000);

    const fresh = await add(["touched moments ago"]);

    const closedButOld = await add(["finished a while back"]);
    const closeResult = await runCli(["close", closedButOld, "--reason", "done"], {
      cwd: repo.dir,
    });
    expect(closeResult.exitCode).toBe(EXIT.ok);
    backdate(repo.dir, closedButOld, 2 * 60 * 60 * 1000);

    const result = await runCli(["stale", "--older-than", "1h", "--json"], { cwd: repo.dir });
    expect(result.exitCode).toBe(EXIT.ok);
    const doc = result.json() as StaleResult;
    expect(doc.hits.map((hit) => hit.id)).toEqual([forgotten]);
    expect(doc.hits.map((hit) => hit.id)).not.toContain(fresh);
    // Terminal lanes are excluded even when old enough to otherwise qualify
    // (readStale's docs: open, non-terminal items only).
    expect(doc.hits.map((hit) => hit.id)).not.toContain(closedButOld);
  });

  it("the find-it/lose-it cycle: retitling moves what search finds, closing keeps it findable, deleting removes it from search, recent and stale (AC 8)", async () => {
    const id = await add(["aardvark project kickoff"]);

    const foundOriginal = await runCli(["search", "aardvark", "--json"], { cwd: repo.dir });
    expect((foundOriginal.json() as SearchResult).hits.map((hit) => hit.id)).toEqual([id]);

    const retitled = await runCli(["update", id, "--title", "bumblebee project kickoff"], {
      cwd: repo.dir,
    });
    expect(retitled.exitCode).toBe(EXIT.ok);

    const foundNew = await runCli(["search", "bumblebee", "--json"], { cwd: repo.dir });
    expect((foundNew.json() as SearchResult).hits.map((hit) => hit.id)).toEqual([id]);
    const lostOld = await runCli(["search", "aardvark", "--json"], { cwd: repo.dir });
    expect((lostOld.json() as SearchResult).hits).toEqual([]);

    // Closing writes only lane/closed_at. Migration 0004's `tasks_fts_au`
    // trigger is scoped `AFTER UPDATE OF title, description` (T1,
    // 0004-search-index.ts), so a close never fires it — the already-indexed
    // title stays exactly as matchable as it was the instant before the
    // close, no reindex involved.
    const closed = await runCli(["close", id, "--reason", "shipped"], { cwd: repo.dir });
    expect(closed.exitCode).toBe(EXIT.ok);
    const foundClosed = await runCli(["search", "bumblebee", "--json"], { cwd: repo.dir });
    expect((foundClosed.json() as SearchResult).hits.map((hit) => hit.id)).toEqual([id]);

    // Present in recent right after the close — the delta this cycle's
    // final step depends on to mean anything.
    const recentBeforeDelete = await runCli(["recent", "--json"], { cwd: repo.dir });
    expect((recentBeforeDelete.json() as RecentResult).hits.map((hit) => hit.id)).toContain(id);

    const deleted = await runCli(["delete", id, "--force"], { cwd: repo.dir });
    expect(deleted.exitCode).toBe(EXIT.ok);

    const searchAfterDelete = await runCli(["search", "bumblebee", "--json"], { cwd: repo.dir });
    expect((searchAfterDelete.json() as SearchResult).hits).toEqual([]);

    const recentAfterDelete = await runCli(["recent", "--json"], { cwd: repo.dir });
    expect((recentAfterDelete.json() as RecentResult).hits.map((hit) => hit.id)).not.toContain(id);

    const staleAfterDelete = await runCli(["stale", "--json"], { cwd: repo.dir });
    expect((staleAfterDelete.json() as StaleResult).hits.map((hit) => hit.id)).not.toContain(id);
  });

  it("emits the documented --json shapes on search, recent and stale", async () => {
    const task = await add(["a task with modest text for the json shape check"]);
    await note(task, "a note attached for the json shape check");

    const searchDoc = (
      await runCli(["search", "shape", "--json"], { cwd: repo.dir })
    ).json() as SearchResult;
    expect(typeof searchDoc.query).toBe("string");
    expect(typeof searchDoc.truncated).toBe("boolean");
    expect(Array.isArray(searchDoc.hits)).toBe(true);
    const searchHit = searchDoc.hits[0];
    expect(searchHit).toBeDefined();
    expect(searchHit?.id).toBe(task);
    expect(["task", "note"]).toContain(searchHit?.matchedIn);
    expect(typeof searchHit?.idMatch).toBe("boolean");
    expect(searchHit?.snippet === null || typeof searchHit?.snippet === "string").toBe(true);
    expect(searchHit?.score === null || typeof searchHit?.score === "number").toBe(true);

    const recentDoc = (
      await runCli(["recent", "--json"], { cwd: repo.dir })
    ).json() as RecentResult;
    expect(Array.isArray(recentDoc.hits)).toBe(true);
    expect(typeof recentDoc.truncated).toBe("boolean");
    expect(recentDoc.hits[0]?.id).toBe(task);
    expect(typeof recentDoc.hits[0]?.lastActivity).toBe("string");

    const staleDoc = (await runCli(["stale", "--json"], { cwd: repo.dir })).json() as StaleResult;
    expect(Array.isArray(staleDoc.hits)).toBe(true);
    expect(typeof staleDoc.truncated).toBe("boolean");
    expect(staleDoc.olderThan).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("F6 migration story — search survives the v3 -> v4 upgrade (AC 9)", () => {
  const HISTORICAL_TS = "2024-01-01T00:00:00.000Z";

  /** Inserts a task with raw SQL against a store that has no application code for this schema version. */
  function rawTask(db: DatabaseHandle, row: Record<string, unknown>): void {
    const full = {
      id: "kt-legacy",
      level: "task",
      kind: "feat",
      title: "a legacy task",
      lane: "Defined",
      priority: 2,
      created_at: HISTORICAL_TS,
      updated_at: HISTORICAL_TS,
      ...row,
    };
    const cols = Object.keys(full);
    db.prepare(
      `INSERT INTO tasks (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
    ).run(...Object.values(full));
  }

  /** The note-side twin of {@link rawTask}. */
  function rawNote(db: DatabaseHandle, row: Record<string, unknown>): void {
    const full = {
      id: "nt-legacy",
      task_id: "kt-legacy",
      body: "a legacy note",
      actor: "main @ /repo",
      created_at: HISTORICAL_TS,
      ...row,
    };
    const cols = Object.keys(full);
    db.prepare(
      `INSERT INTO notes (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
    ).run(...Object.values(full));
  }

  it("finds pre-existing v3 task and note content through the real search command the moment the store opens at the current version, with no manual step", async () => {
    const repo = createGitRepo();
    try {
      // Built by hand, deliberately never through `katra init`: init would
      // bring a fresh store straight to MIGRATIONS' latest (6, now that
      // migration 0006 exists), and this test's whole point is what happens
      // when a v3 store is opened *normally* afterwards, not what a fresh
      // store looks like.
      const storeDir = join(repo.dir, ".git", STORE_DIR_NAME);
      const dbPath = join(storeDir, DB_FILE_NAME);
      mkdirSync(storeDir, { recursive: true });

      const db = openDatabase(dbPath);
      migrate(db, MIGRATIONS.slice(0, 3));
      expect(readSchemaVersion(db)).toBe(3);

      rawTask(db, {
        title: "coelacanth survey",
        description: "predates the search index entirely",
      });
      rawNote(db, { body: "handoff note: pangolin sightings logged" });
      db.close();

      // No `migrate`/`--apply` step, no rebuild command — just an ordinary
      // read command opening the store the way any command would.
      const foundByTitle = await runCli(["search", "coelacanth", "--json"], { cwd: repo.dir });
      expect(foundByTitle.exitCode).toBe(EXIT.ok);
      const titleDoc = foundByTitle.json() as SearchResult;
      expect(titleDoc.hits.map((hit) => hit.id)).toContain("kt-legacy");
      expect(titleDoc.hits.find((hit) => hit.id === "kt-legacy")?.matchedIn).toBe("task");

      const foundByNote = await runCli(["search", "pangolin", "--json"], { cwd: repo.dir });
      expect(foundByNote.exitCode).toBe(EXIT.ok);
      const noteDoc = foundByNote.json() as SearchResult;
      expect(noteDoc.hits.map((hit) => hit.id)).toEqual(["kt-legacy"]);
      expect(noteDoc.hits[0]?.matchedIn).toBe("note");

      // The upgrade actually happened, not merely "search worked anyway".
      // This store was built by hand at v3 above and opened through an
      // ordinary `search` command, which migrates it to whatever this
      // build's newest step is — 6 now that migration 0006 exists, not the
      // 5 this asserted before it landed.
      const rawAfter = openDatabase(dbPath);
      expect(readSchemaVersion(rawAfter)).toBe(6);
      rawAfter.close();
    } finally {
      repo.cleanup();
    }
  });
});
