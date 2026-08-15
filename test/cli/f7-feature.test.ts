/**
 * F7's whole-story proof: `ref add`/`ref remove` through the real CLI against
 * one store, told as a single ordered narrative rather than split across
 * disconnected fixtures — the same reason f6's AC 8 find-it/lose-it cycle
 * lives in one test (`f6-feature.test.ts`'s module docs): these are the same
 * task and the same store carried forward, not several unrelated setups that
 * happen to agree.
 *
 * Every unit-level shape already has a dedicated home in `ref.test.ts`
 * (refusals, hostile-input sanitization, the escape hatch, exit codes) and in
 * `test/core/refs.test.ts`/`refs-parse.test.ts` (idempotence, orphan GC,
 * canonicalization). This file's job is the *story* those cannot tell: two
 * refs accumulating on one task, one ref shared across two tasks, a bare
 * Linear id backfilled by a later URL paste, `show`/`brief` rendering it all,
 * `ref remove` leaving a shared ref's other holder untouched, `delete`'s
 * orphan GC actually collecting the row it should, and an epic's `log`
 * picking up a child's ref events.
 *
 * Direct SQL is used for exactly one assertion — the `refs` table's row count
 * after a delete — because no command surfaces that number; every other step
 * reads back only through `runCli`, per `f6-feature.test.ts`'s own rule for
 * when direct SQL is warranted.
 */

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import type { RefResult } from "../../src/core/contract.js";
import { openDatabase } from "../../src/core/db/connection.js";
import { DB_FILE_NAME, STORE_DIR_NAME } from "../../src/core/db/locate.js";
import { runCli } from "../helpers/cli.js";
import type { GitFixture } from "../helpers/fixture.js";
import { createGitRepo } from "../helpers/fixture.js";

function storeDbPath(dir: string): string {
  return join(dir, ".git", STORE_DIR_NAME, DB_FILE_NAME);
}

/** The `refs` table's row count, read directly — no command exposes this. */
function refRowCount(dir: string): number {
  const db = openDatabase(storeDbPath(dir));
  try {
    return (db.prepare("SELECT COUNT(*) c FROM refs").get() as { c: number }).c;
  } finally {
    db.close();
  }
}

describe("F7 e2e — external refs through the real CLI", () => {
  let repo: GitFixture;
  beforeEach(async () => {
    repo = createGitRepo();
    await runCli(["init"], { cwd: repo.dir });
  });
  afterEach(() => repo.cleanup());

  async function add(args: readonly string[]): Promise<string> {
    const result = await runCli(["add", ...args], { cwd: repo.dir });
    expect(result.exitCode, result.stderr).toBe(EXIT.ok);
    return result.stdout.trim();
  }

  it("accumulates refs on a task, shares one across tasks, backfills a bare id's url, renders through show/brief, survives a partial remove, GCs on delete, and shows up in the epic's own log", async () => {
    const epic = await add(["an epic", "--level", "epic"]);
    const taskA = await add(["task a", "--parent", epic]);
    const taskB = await add(["task b"]);

    // Two refs on one task.
    const prUrl = "https://github.com/acme/widgets/pull/100";
    const issueUrl = "https://github.com/acme/widgets/issues/101";

    const addPr = await runCli(["ref", "add", taskA, prUrl, "--json"], { cwd: repo.dir });
    expect(addPr.exitCode, addPr.stderr).toBe(EXIT.ok);
    expect((addPr.json() as RefResult).action).toBe("linked");

    const addIssue = await runCli(["ref", "add", taskA, issueUrl, "--json"], { cwd: repo.dir });
    expect(addIssue.exitCode, addIssue.stderr).toBe(EXIT.ok);
    expect((addIssue.json() as RefResult).action).toBe("linked");

    const shownAfterTwo = await runCli(["show", taskA], { cwd: repo.dir });
    expect(shownAfterTwo.stdout).toContain("acme/widgets#100");
    expect(shownAfterTwo.stdout).toContain("acme/widgets#101");

    // One ref across two tasks: task B links the same PR task A already
    // holds — one shared refs row, two independent task_refs rows.
    const sharedOnB = await runCli(["ref", "add", taskB, prUrl, "--json"], { cwd: repo.dir });
    expect(sharedOnB.exitCode, sharedOnB.stderr).toBe(EXIT.ok);
    expect((sharedOnB.json() as RefResult).action).toBe("linked");

    // Bare-id-then-URL backfill: a Linear ref pasted bare first (url null),
    // then the same issue's URL — task_refs-wise the link already existed,
    // but the stored url backfills from null, a real mutation of the shared
    // `refs` row that gets its own action and event ("url-backfilled", not
    // "already-linked" — validate round 2, finding M1).
    const bareAdd = await runCli(["ref", "add", taskA, "ENG-500", "--json"], { cwd: repo.dir });
    expect(bareAdd.exitCode, bareAdd.stderr).toBe(EXIT.ok);
    expect((bareAdd.json() as RefResult).ref.url).toBeNull();

    const backfill = await runCli(
      ["ref", "add", taskA, "https://linear.app/acme/issue/ENG-500", "--json"],
      { cwd: repo.dir },
    );
    expect(backfill.exitCode, backfill.stderr).toBe(EXIT.ok);
    expect((backfill.json() as RefResult).action).toBe("url-backfilled");

    const shownAfterBackfill = await runCli(["show", taskA], { cwd: repo.dir });
    expect(shownAfterBackfill.stdout).toContain("ENG-500");
    expect(shownAfterBackfill.stdout).toContain("https://linear.app/acme/issue/ENG-500");

    // show/brief render: task A's brief carries all three refs. Scoped to the
    // entity's own task_refs (BriefResult.refs's docs), never rolled up from
    // an epic to a child or vice versa.
    const briefedA = await runCli(["brief", taskA], { cwd: repo.dir });
    expect(briefedA.exitCode).toBe(EXIT.ok);
    expect(briefedA.stdout).toContain("acme/widgets#100");
    expect(briefedA.stdout).toContain("acme/widgets#101");
    expect(briefedA.stdout).toContain("ENG-500");

    // Remove: dropping the shared PR ref from task A leaves task B's own view
    // of it intact — the row is shared, not the link.
    const removed = await runCli(["ref", "remove", taskA, prUrl, "--json"], { cwd: repo.dir });
    expect(removed.exitCode, removed.stderr).toBe(EXIT.ok);
    expect((removed.json() as RefResult).action).toBe("unlinked");

    // The qualified id alone is not the right negative check here: the
    // `ref-unlinked` event this remove just appended still names
    // "acme/widgets#100" in `show`'s own activity section (correctly — see
    // the log assertions below), and that section renders above the point
    // where a `refs` field would appear. The url is the unambiguous
    // signal: it appears only in a `refs` line, never in `describeEvent`'s
    // rendering of an event's `ref` field.
    const shownAAfterRemove = await runCli(["show", taskA], { cwd: repo.dir });
    expect(shownAAfterRemove.stdout).not.toContain(prUrl);
    expect(shownAAfterRemove.stdout).toContain("acme/widgets#101");

    const shownB = await runCli(["show", taskB], { cwd: repo.dir });
    expect(shownB.stdout).toContain("acme/widgets#100");

    // Delete-task GC: task B is now the PR ref's sole holder. Three refs
    // rows exist at this point (PR#100, issue#101, ENG-500); deleting task B
    // should collect the now-orphaned PR#100 row and leave the other two —
    // both still held by task A — untouched. No command surfaces the row
    // count, so this one check reads it directly.
    expect(refRowCount(repo.dir)).toBe(3);

    const deleted = await runCli(["delete", taskB, "--force"], { cwd: repo.dir });
    expect(deleted.exitCode, deleted.stderr).toBe(EXIT.ok);

    expect(refRowCount(repo.dir)).toBe(2);

    const shownAAfterDelete = await runCli(["show", taskA], { cwd: repo.dir });
    expect(shownAAfterDelete.stdout).toContain("acme/widgets#101");
    expect(shownAAfterDelete.stdout).toContain("ENG-500");

    // Epic-scoped log shows ref events: every ref-linked/ref-unlinked event
    // recorded against task A, a child of `epic`, surfaces under the epic's
    // own log (events/repo.ts's epic_id scoping) — no separate `ref list`
    // or `ref log` needed.
    const epicLog = await runCli(["log", epic, "--json"], { cwd: repo.dir });
    expect(epicLog.exitCode, epicLog.stderr).toBe(EXIT.ok);
    const epicEvents = (epicLog.json() as { events: Array<{ type: string; entityId: string }> })
      .events;
    const taskAEventTypes = epicEvents
      .filter((event) => event.entityId === taskA)
      .map((event) => event.type);

    expect(taskAEventTypes).toContain("ref-linked");
    expect(taskAEventTypes).toContain("ref-unlinked");
  });
});
