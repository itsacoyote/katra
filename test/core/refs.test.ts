import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readTx } from "../../src/core/db/connection.js";
import { isKatraException } from "../../src/core/errors.js";
import { listEvents } from "../../src/core/events/repo.js";
import { parseRefInput, validateExplicitRef } from "../../src/core/refs/parse.js";
import {
  gcOrphanRefsWithin,
  linkRef,
  linkRefWithin,
  listRefs,
  unlinkRef,
  unlinkRefWithin,
} from "../../src/core/refs/repo.js";
import { openStore } from "../../src/core/store.js";
import { MAX_CANDIDATES } from "../../src/core/tasks/ids.js";
import { runConcurrent } from "../helpers/concurrent.js";
import { seedEpic, seedTask } from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture } from "../helpers/store.js";

/**
 * A pass-through count of `writeTx` calls, for the atomicity-pin tests below
 * — the `board.test.ts`/`readTxSpy` pattern, mirrored for writes. The wrapper
 * delegates to the real implementation, so every other test in this file
 * still runs against genuine transactions.
 */
const writeTxSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../src/core/db/connection.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/core/db/connection.js")>();
  const writeTx: typeof original.writeTx = (db, fn) => {
    writeTxSpy.calls += 1;
    return original.writeTx(db, fn);
  };
  return { ...original, writeTx };
});

const ACTOR = "feature/f7 @ /repo/wt-f7";

let fixture: StoreFixture;
beforeEach(() => {
  fixture = createStoreFixture({ actor: ACTOR });
});
afterEach(() => fixture.cleanup());

/** Every row in `refs`, for direct-DB assertions the spec calls for by name. */
function refRows(): Array<Record<string, unknown>> {
  return fixture.store.db.prepare("SELECT * FROM refs ORDER BY id").all() as Array<
    Record<string, unknown>
  >;
}

function taskRefRows(): Array<{ task_id: string; ref_id: number }> {
  return fixture.store.db
    .prepare("SELECT * FROM task_refs ORDER BY task_id, ref_id")
    .all() as Array<{
    task_id: string;
    ref_id: number;
  }>;
}

function eventsOfType(type: string): Array<Record<string, unknown>> {
  return fixture.store.db
    .prepare("SELECT * FROM events WHERE type = ? ORDER BY id")
    .all(type) as Array<Record<string, unknown>>;
}

const GITHUB_REF = {
  provider: "github",
  externalId: "owner/repo#12",
  url: "https://github.com/owner/repo/pull/12",
};
const LINEAR_BARE_REF = { provider: "linear", externalId: "ENG-451", url: null };

describe("linkRef", () => {
  it("link stores one refs row + one task_refs row + one ref-linked event", () => {
    const task = seedTask(fixture.store);

    const result = linkRef(fixture.store, task, GITHUB_REF);

    expect(result.action).toBe("linked");
    expect(result.taskId).toBe(task);
    expect(result.ref).toEqual({
      provider: "github",
      externalId: "owner/repo#12",
      url: "https://github.com/owner/repo/pull/12",
      cachedStatus: null,
      cachedTitle: null,
      syncedAt: null,
    });

    expect(refRows()).toHaveLength(1);
    expect(taskRefRows()).toHaveLength(1);

    const events = eventsOfType("ref-linked");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entity_id: task,
      ref: "owner/repo#12",
      actor: ACTOR,
    });
  });

  it("re-link returns already-linked, zero new rows/events", () => {
    const task = seedTask(fixture.store);

    linkRef(fixture.store, task, GITHUB_REF);
    const second = linkRef(fixture.store, task, GITHUB_REF);

    expect(second.action).toBe("already-linked");
    expect(refRows()).toHaveLength(1);
    expect(taskRefRows()).toHaveLength(1);
    expect(eventsOfType("ref-linked")).toHaveLength(1);
  });

  it("bare-id then URL backfills null url, second URL never overwrites, url-backfilled events once", () => {
    // Validate round 2, finding M1: a url backfill is a real mutation of a
    // row every task holding it shares, so it now reports its own action
    // and events exactly once — never silently as "already-linked" (this
    // module's own signal for "nothing changed").
    const task = seedTask(fixture.store);

    const first = linkRef(fixture.store, task, LINEAR_BARE_REF);
    expect(first.ref.url).toBeNull();
    expect(first.action).toBe("linked");
    expect(eventsOfType("ref-linked")).toHaveLength(1);

    const backfillUrl = "https://linear.app/acme/issue/ENG-451";
    const backfillInput = { provider: "linear", externalId: "ENG-451", url: backfillUrl };

    const second = linkRef(fixture.store, task, backfillInput);
    expect(second.action).toBe("url-backfilled");
    expect(second.ref.url).toBe(backfillUrl);
    expect(refRows()[0]?.url).toBe(backfillUrl);
    // Exactly one new event for the backfill — two total now, not zero.
    expect(eventsOfType("ref-linked")).toHaveLength(2);

    // A byte-identical re-add (same triple, url already stored) is the true
    // no-op AC 1 promises: still already-linked, still no new event.
    const identicalReAdd = linkRef(fixture.store, task, backfillInput);
    expect(identicalReAdd.action).toBe("already-linked");
    expect(eventsOfType("ref-linked")).toHaveLength(2);

    // A different url, once one is already stored, never overwrites it —
    // and is reported as the ordinary no-op, not a second backfill.
    const third = linkRef(fixture.store, task, {
      provider: "linear",
      externalId: "ENG-451",
      url: "https://linear.app/other-workspace/issue/ENG-451",
    });
    expect(third.action).toBe("already-linked");
    expect(third.ref.url).toBe(backfillUrl);
    expect(refRows()[0]?.url).toBe(backfillUrl);

    expect(refRows()).toHaveLength(1);
    expect(eventsOfType("ref-linked")).toHaveLength(2);
  });

  it("cross-task backfill events under the task that issued the command, not the task whose view changed", () => {
    // The probe M1 names: task A links a bare Linear id (url null); task B
    // then links the *same* ref with a url, backfilling the shared row.
    // task_refs is brand new for B, so this is an ordinary "linked" event
    // for B — a fresh link already carries its own event, taking precedence
    // over the backfill signal (linkRefWithin's docs). Task A's rendered
    // url changes too, but no event is stamped on A: nothing happened to
    // A's own link, only to a column the two rows both read from, and A's
    // history stays exactly as it was — traceable through the shared
    // `ref.externalId`, not through a phantom event on a task the command
    // never named.
    const taskA = seedTask(fixture.store);
    const taskB = seedTask(fixture.store);

    linkRef(fixture.store, taskA, LINEAR_BARE_REF);
    expect(eventsOfType("ref-linked").filter((e) => e.entity_id === taskA)).toHaveLength(1);

    const backfillUrl = "https://linear.app/acme/issue/ENG-451";
    const resultB = linkRef(fixture.store, taskB, {
      provider: "linear",
      externalId: "ENG-451",
      url: backfillUrl,
    });

    expect(resultB.action).toBe("linked");
    expect(eventsOfType("ref-linked").filter((e) => e.entity_id === taskB)).toHaveLength(1);
    // A's own event count is unchanged by B's command.
    expect(eventsOfType("ref-linked").filter((e) => e.entity_id === taskA)).toHaveLength(1);

    // A's *view* did change — traceable through the shared row, not an event.
    expect(listRefs(fixture.store, taskA)[0]?.url).toBe(backfillUrl);
  });

  it("same ref on two tasks shares one row", () => {
    const taskA = seedTask(fixture.store);
    const taskB = seedTask(fixture.store);

    const resultA = linkRef(fixture.store, taskA, GITHUB_REF);
    const resultB = linkRef(fixture.store, taskB, GITHUB_REF);

    expect(resultA.action).toBe("linked");
    expect(resultB.action).toBe("linked");
    expect(refRows()).toHaveLength(1);
    expect(taskRefRows()).toHaveLength(2);
    expect(eventsOfType("ref-linked")).toHaveLength(2);
  });

  it("epic takes a ref and lists it", () => {
    const epic = seedEpic(fixture.store, { title: "an epic" });

    const result = linkRef(fixture.store, epic, GITHUB_REF);

    expect(result.action).toBe("linked");
    expect(listRefs(fixture.store, epic)).toEqual([result.ref]);
  });

  it("events carry actor, same transaction", () => {
    const task = seedTask(fixture.store);

    const result = linkRef(fixture.store, task, GITHUB_REF);

    const events = eventsOfType("ref-linked");
    expect(events[0]?.actor).toBe(ACTOR);
    expect(result.ref.provider).toBe("github");
    // "same transaction" is proven by the two rollback tests below — this
    // one is scoped to the actor assertion only.
  });

  it("rolls back the ref row, task_refs row and event together when the enclosing transaction fails", () => {
    // better-sqlite3 nests `db.transaction(...)` as a SAVEPOINT when one is
    // already open — so wrapping `linkRef` in an outer transaction that
    // throws *after* `linkRef` has already returned proves every write it
    // made (the refs row, the task_refs row, the ref-linked event) lives in
    // one rollback-able unit, not two or three separately committed ones.
    const task = seedTask(fixture.store);

    // Captured inside the transaction, before the rollback: proves the writes
    // actually landed, so the empty state below is a rollback and not a
    // linkRef that never wrote at all (the vacuity delete.test.ts's own
    // atomicity test had before its fix).
    let midTx: { refs: number; taskRefs: number; events: number } | undefined;
    expect(() =>
      fixture.store.db.transaction(() => {
        linkRef(fixture.store, task, GITHUB_REF);
        midTx = {
          refs: refRows().length,
          taskRefs: taskRefRows().length,
          events: eventsOfType("ref-linked").length,
        };
        throw new Error("boom, after linkRef already returned");
      })(),
    ).toThrowError("boom, after linkRef already returned");

    expect(midTx).toEqual({ refs: 1, taskRefs: 1, events: 1 });
    expect(refRows()).toHaveLength(0);
    expect(taskRefRows()).toHaveLength(0);
    expect(eventsOfType("ref-linked")).toHaveLength(0);
  });

  it("rolls back an unlink, its event and its orphan GC together when the enclosing transaction fails", () => {
    const task = seedTask(fixture.store);
    linkRef(fixture.store, task, GITHUB_REF);

    // Same mid-transaction capture as the link test: the unlink, its event
    // and the GC must all have happened before the rollback undoes them.
    let midTx: { refs: number; taskRefs: number; events: number } | undefined;
    expect(() =>
      fixture.store.db.transaction(() => {
        unlinkRef(fixture.store, task, "owner/repo#12");
        midTx = {
          refs: refRows().length,
          taskRefs: taskRefRows().length,
          events: eventsOfType("ref-unlinked").length,
        };
        throw new Error("boom, after unlinkRef already returned");
      })(),
    ).toThrowError("boom, after unlinkRef already returned");

    expect(midTx).toEqual({ refs: 0, taskRefs: 0, events: 1 });
    // Still linked, the ref row was not GC'd, and no ref-unlinked event
    // survives — the delete, the event, and the GC rolled back as one unit.
    expect(listRefs(fixture.store, task)).toHaveLength(1);
    expect(refRows()).toHaveLength(1);
    expect(eventsOfType("ref-unlinked")).toHaveLength(0);
  });

  it("linkRef opens exactly one write transaction — insert and event share it", () => {
    // A caller-observable atomicity pin, distinct from the rollback tests
    // above: those prove writes made *inside whatever transaction is
    // currently open* roll back together; this proves `linkRef` itself never
    // opens a second, separately-committed one — the shape a bug like "the
    // event moves to its own writeTx" would take in ordinary (unwrapped)
    // use, where the rollback tests' nesting trick cannot observe it.
    const task = seedTask(fixture.store);

    writeTxSpy.calls = 0;
    linkRef(fixture.store, task, GITHUB_REF);

    expect(writeTxSpy.calls).toBe(1);
  });

  it("a CHECK violation surfaces as itself, not as a swallowed no-op", () => {
    // If either insert ever reverted to `INSERT OR IGNORE`, this would be
    // silently swallowed and read back as "already exists" (or crash trying
    // to re-SELECT a row that was never written) instead of the real
    // constraint failure.
    const task = seedTask(fixture.store);
    const tooLongProvider = "x".repeat(65); // refs.provider: CHECK (length BETWEEN 1 AND 64)

    expect(() =>
      linkRef(fixture.store, task, { provider: tooLongProvider, externalId: "o/r#1", url: null }),
    ).toThrowError(/CHECK constraint failed: length\(provider\)/);

    expect(listRefs(fixture.store, task)).toEqual([]);
  });

  it("constraint violation never retried as id collision", () => {
    // Two rows, so the target's real id (2) cannot coincidentally match
    // whatever `sqlite3_last_insert_rowid()` happens to hold on this
    // connection — the flaw a single-row setup has: seed a throwaway first
    // row (id 1), the real target second (id 2), then delete the throwaway.
    // Linking the task itself is the intervening insert that moves the
    // connection's last-insert-rowid off of 2 and onto the task's own,
    // unrelated rowid (empirically 1) — the exact stale value
    // `linkRefWithin` must NOT trust after its own insert is ignored.
    fixture.store.db
      .prepare("INSERT INTO refs (provider, external_id, url) VALUES (?,?,?)")
      .run("github", "throwaway/first#1", null);
    const targetInsert = fixture.store.db
      .prepare("INSERT INTO refs (provider, external_id, url) VALUES (?,?,?)")
      .run(GITHUB_REF.provider, GITHUB_REF.externalId, GITHUB_REF.url);
    const targetId = Number(targetInsert.lastInsertRowid);
    expect(targetId).toBe(2);
    fixture.store.db
      .prepare("DELETE FROM refs WHERE provider = ? AND external_id = ?")
      .run("github", "throwaway/first#1");

    const task = seedTask(fixture.store);
    const result = linkRef(fixture.store, task, GITHUB_REF);

    expect(result.action).toBe("linked");
    expect(refRows()).toHaveLength(1);

    const taskRef = taskRefRows()[0];
    expect(taskRef?.ref_id).toBe(targetId);
  });
});

describe("unlinkRef", () => {
  it("unlink from one keeps the other", () => {
    const taskA = seedTask(fixture.store);
    const taskB = seedTask(fixture.store);
    linkRef(fixture.store, taskA, GITHUB_REF);
    linkRef(fixture.store, taskB, GITHUB_REF);

    const result = unlinkRef(fixture.store, taskA, "owner/repo#12");

    expect(result.action).toBe("unlinked");
    expect(listRefs(fixture.store, taskA)).toEqual([]);
    expect(listRefs(fixture.store, taskB)).toHaveLength(1);
    expect(refRows()).toHaveLength(1);
  });

  it("last unlink deletes the refs row (direct DB read)", () => {
    const taskA = seedTask(fixture.store);
    const taskB = seedTask(fixture.store);
    linkRef(fixture.store, taskA, GITHUB_REF);
    linkRef(fixture.store, taskB, GITHUB_REF);

    unlinkRef(fixture.store, taskA, "owner/repo#12");
    expect(refRows()).toHaveLength(1);

    unlinkRef(fixture.store, taskB, "owner/repo#12");
    expect(refRows()).toHaveLength(0);
  });

  it("unlink by url and by external_id resolve", () => {
    const taskA = seedTask(fixture.store);
    const taskB = seedTask(fixture.store);
    linkRef(fixture.store, taskA, GITHUB_REF);
    linkRef(fixture.store, taskB, GITHUB_REF);

    const byUrl = unlinkRef(fixture.store, taskA, GITHUB_REF.url);
    expect(byUrl.action).toBe("unlinked");
    expect(listRefs(fixture.store, taskA)).toEqual([]);

    const byExternalId = unlinkRef(fixture.store, taskB, GITHUB_REF.externalId);
    expect(byExternalId.action).toBe("unlinked");
    expect(listRefs(fixture.store, taskB)).toEqual([]);
    expect(refRows()).toHaveLength(0);
  });

  it("remove resolves the same mixed-case string add accepted (Owner/Repo#12 removes owner/repo#12)", () => {
    const task = seedTask(fixture.store);
    const parsed = parseRefInput("Owner/Repo#12");
    if (!parsed.recognized) throw new Error("expected parseRefInput to recognize Owner/Repo#12");
    expect(parsed.ref.externalId).toBe("owner/repo#12");

    linkRef(fixture.store, task, parsed.ref);

    const result = unlinkRef(fixture.store, task, "Owner/Repo#12");

    expect(result.action).toBe("unlinked");
    expect(listRefs(fixture.store, task)).toEqual([]);
  });

  it("a ref stored via the explicit escape hatch with null url removes by its id", () => {
    const task = seedTask(fixture.store);
    const validated = validateExplicitRef({ provider: "gitlab", id: "myorg/myrepo!5" });
    if (!validated.valid)
      throw new Error("expected validateExplicitRef to accept the escape hatch");
    expect(validated.ref.url).toBeNull();

    linkRef(fixture.store, task, validated.ref);

    const result = unlinkRef(fixture.store, task, "myorg/myrepo!5");

    expect(result.action).toBe("unlinked");
    expect(listRefs(fixture.store, task)).toEqual([]);
  });

  it("two providers with case-insensitively equal external_id on one task -> refusal naming both, url disambiguates", () => {
    const task = seedTask(fixture.store);
    linkRef(fixture.store, task, {
      provider: "foo",
      externalId: "ABC-123",
      url: "https://foo.example/ABC-123",
    });
    linkRef(fixture.store, task, {
      provider: "bar",
      externalId: "abc-123",
      url: "https://bar.example/abc-123",
    });

    try {
      unlinkRef(fixture.store, task, "abc-123");
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("ambiguous_id");
      if (error.detail.code !== "ambiguous_id") throw error;
      expect(error.detail.candidates).toHaveLength(2);
      expect(error.detail.candidates.join("\n")).toContain("foo");
      expect(error.detail.candidates.join("\n")).toContain("bar");
      expect(error.message).toMatch(/disambiguate/);
    }

    // The url disambiguates: removing by it takes only the matching row.
    const result = unlinkRef(fixture.store, task, "https://bar.example/abc-123");
    expect(result.action).toBe("unlinked");
    expect(listRefs(fixture.store, task)).toEqual([
      expect.objectContaining({ provider: "foo", externalId: "ABC-123" }),
    ]);
  });

  it("two refs sharing both external_id and url on one task remove via provider:id", () => {
    // Validate round 2, finding M2: two providers can share external_id
    // (e.g. a Jira-style "SHARED-1") and, via the escape hatch, the exact
    // same url too — a case neither existing form can tell apart, since
    // both rows match either one. The old ambiguity hint ("disambiguate
    // with the url") is provably false here.
    const task = seedTask(fixture.store);
    const sharedUrl = "https://x.example/shared";
    linkRef(fixture.store, task, { provider: "alpha", externalId: "SHARED-1", url: sharedUrl });
    linkRef(fixture.store, task, { provider: "beta", externalId: "SHARED-1", url: sharedUrl });

    expect(() => unlinkRef(fixture.store, task, sharedUrl)).toThrowError(/matches 2 refs/);
    expect(() => unlinkRef(fixture.store, task, "SHARED-1")).toThrowError(/matches 2 refs/);

    const result = unlinkRef(fixture.store, task, "alpha:SHARED-1");

    expect(result.action).toBe("unlinked");
    expect(result.ref.provider).toBe("alpha");
    expect(listRefs(fixture.store, task)).toEqual([
      expect.objectContaining({ provider: "beta", externalId: "SHARED-1" }),
    ]);
  });

  it("an input matching a stored url never splits on its own colon", () => {
    // The precedence guard behind the provider:id form (validate round 2,
    // M2 verification INFO-2): a stored url used as the remove argument must
    // resolve as a url, even when another ref on the task could parse the
    // same string as provider "https" + a slashed id. Without the
    // urlMatches-empty gate, reordering the union re-introduces the
    // mis-split silently.
    const task = seedTask(fixture.store);
    const url = "https://example.com/a";
    linkRef(fixture.store, task, { provider: "github", externalId: "acme/w#1", url });
    linkRef(fixture.store, task, { provider: "https", externalId: "//example.com/a", url: null });

    const result = unlinkRef(fixture.store, task, url);

    expect(result.action).toBe("unlinked");
    expect(result.ref.provider).toBe("github");
    expect(listRefs(fixture.store, task)).toEqual([
      expect.objectContaining({ provider: "https", externalId: "//example.com/a" }),
    ]);
  });

  it("ambiguity refusal names the provider:id form", () => {
    const task = seedTask(fixture.store);
    linkRef(fixture.store, task, { provider: "alpha", externalId: "SHARED-1", url: null });
    linkRef(fixture.store, task, { provider: "beta", externalId: "SHARED-1", url: null });

    try {
      unlinkRef(fixture.store, task, "SHARED-1");
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.message).toMatch(/provider:id/);
    }
  });

  it("many-match refusal caps candidates at MAX_CANDIDATES and sets truncated", () => {
    const task = seedTask(fixture.store);
    for (let i = 0; i < MAX_CANDIDATES + 1; i++) {
      linkRef(fixture.store, task, { provider: `provider-${i}`, externalId: "DUP-1", url: null });
    }

    try {
      unlinkRef(fixture.store, task, "DUP-1");
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("ambiguous_id");
      if (error.detail.code !== "ambiguous_id") throw error;
      expect(error.detail.candidates).toHaveLength(MAX_CANDIDATES);
      expect(error.detail.truncated).toBe(true);
    }
  });

  it("numeric input refuses naming accepted forms", () => {
    const task = seedTask(fixture.store);
    linkRef(fixture.store, task, GITHUB_REF);

    try {
      unlinkRef(fixture.store, task, "42");
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("validation");
      expect(error.message).toMatch(/url/);
      expect(error.message).toMatch(/qualified id/);
    }
    // Nothing was removed.
    expect(listRefs(fixture.store, task)).toHaveLength(1);
  });

  it("a numeric external_id from the escape hatch still resolves and removes", () => {
    // The numeric refusal only fires when nothing on the task matches — a
    // Jira/Bugzilla-style provider whose qualified id is itself all digits
    // (stored via the escape hatch, no derivable url) must still be
    // removable by that same digit string, not shadowed by the "looks like
    // an internal row id" refusal.
    const task = seedTask(fixture.store);
    const validated = validateExplicitRef({ provider: "bugzilla", id: "12345" });
    if (!validated.valid) throw new Error("expected validateExplicitRef to accept a numeric id");
    expect(validated.ref.url).toBeNull();

    linkRef(fixture.store, task, validated.ref);

    const result = unlinkRef(fixture.store, task, "12345");

    expect(result.action).toBe("unlinked");
    expect(listRefs(fixture.store, task)).toEqual([]);
  });

  it("linking or unlinking against a nonexistent task refuses with the create-it-first hint", () => {
    // requireRefTarget's friendlier not_found (the requireNoteTarget
    // precedent) — hand-verified during QA, pinned here: the message must
    // name the recovery command, not just say nothing matched.
    expect(() => linkRef(fixture.store, "kt-zzzzzz", GITHUB_REF)).toThrowError(
      /no task matches "kt-zzzzzz" — create it with `katra add` first/,
    );
    expect(() => unlinkRef(fixture.store, "kt-zzzzzz", "owner/repo#12")).toThrowError(
      /no task matches "kt-zzzzzz"/,
    );
    expect(refRows()).toHaveLength(0);
    expect(eventsOfType("ref-linked")).toHaveLength(0);
  });

  it("unlink of never-linked ref refuses", () => {
    const task = seedTask(fixture.store);

    try {
      unlinkRef(fixture.store, task, "owner/repo#12");
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("not_found");
    }
  });

  it("unlinkRef opens exactly one write transaction — delete, event and orphan GC share it", () => {
    const task = seedTask(fixture.store);
    linkRef(fixture.store, task, GITHUB_REF);

    writeTxSpy.calls = 0;
    unlinkRef(fixture.store, task, "owner/repo#12");

    expect(writeTxSpy.calls).toBe(1);
  });

  it("ref events carry owning epic id (epic-scoped log shows them)", () => {
    const epic = seedEpic(fixture.store, { title: "an epic" });
    const child = seedTask(fixture.store, { parentId: epic });

    linkRef(fixture.store, child, GITHUB_REF);
    unlinkRef(fixture.store, child, "owner/repo#12");

    const linkedEvent = eventsOfType("ref-linked")[0];
    const unlinkedEvent = eventsOfType("ref-unlinked")[0];
    expect(linkedEvent).toMatchObject({ entity_id: child, epic_id: epic });
    expect(unlinkedEvent).toMatchObject({ entity_id: child, epic_id: epic });

    const page = listEvents(fixture.store, { entityId: epic });
    const types = page.events.map((event) => event.type);
    expect(types).toContain("ref-linked");
    expect(types).toContain("ref-unlinked");
  });
});

describe("linkRefWithin", () => {
  it("throws when called outside any transaction", () => {
    // The other half of the transaction-required guard, mirrored from
    // `addLinkWithin`'s own tests (`links.test.ts`): no transaction at all,
    // not just the read-only one below.
    const task = seedTask(fixture.store);

    expect(() => linkRefWithin(fixture.store, task, GITHUB_REF)).toThrowError(/open transaction/);
  });

  it("throws when called inside a read transaction", () => {
    // `db.inTransaction` is also true inside a deferred read, so only
    // `assertNotReadOnly` catches this — see its own docs (`db/connection.ts`)
    // for why the plain `inTransaction` check alone cannot.
    const task = seedTask(fixture.store);

    expect(() =>
      readTx(fixture.store.db, () => linkRefWithin(fixture.store, task, GITHUB_REF)),
    ).toThrowError(/read transaction/);
  });
});

describe("unlinkRefWithin", () => {
  it("throws when called outside any transaction", () => {
    const task = seedTask(fixture.store);
    linkRef(fixture.store, task, GITHUB_REF);

    expect(() => unlinkRefWithin(fixture.store, task, "owner/repo#12")).toThrowError(
      /open transaction/,
    );
  });

  it("throws when called inside a read transaction", () => {
    const task = seedTask(fixture.store);
    linkRef(fixture.store, task, GITHUB_REF);

    expect(() =>
      readTx(fixture.store.db, () => unlinkRefWithin(fixture.store, task, "owner/repo#12")),
    ).toThrowError(/read transaction/);
  });
});

describe("listRefs", () => {
  it("orders by link order, not by when the underlying refs row was created", () => {
    // `older`/`newer` are created via `other` first — older gets refs.id 1,
    // newer gets refs.id 2. The task under test then links them in the
    // OPPOSITE order (newer first, older second), so task_refs' own rowid
    // (link order) and refs.id (creation order) actively disagree: ordering
    // by refs.id would report [older, newer] regardless of what `task` did,
    // while link order must report [newer, older]. A version of this test
    // that links in the same relative order both times cannot tell the two
    // orderings apart — this one can.
    const other = seedTask(fixture.store);
    const older = { provider: "github", externalId: "owner/repo#1", url: null };
    const newer = { provider: "github", externalId: "owner/repo#2", url: null };
    linkRef(fixture.store, other, older); // refs.id 1 — created first
    linkRef(fixture.store, other, newer); // refs.id 2 — created second

    const task = seedTask(fixture.store);
    linkRef(fixture.store, task, newer); // linked to `task` first
    linkRef(fixture.store, task, older); // linked to `task` second

    expect(listRefs(fixture.store, task).map((ref) => ref.externalId)).toEqual([
      "owner/repo#2",
      "owner/repo#1",
    ]);
  });
});

describe("gcOrphanRefsWithin", () => {
  it("does nothing when a ref still has a holder", () => {
    const taskA = seedTask(fixture.store);
    const taskB = seedTask(fixture.store);
    linkRef(fixture.store, taskA, GITHUB_REF);
    linkRef(fixture.store, taskB, GITHUB_REF);

    const refId = (fixture.store.db.prepare("SELECT id FROM refs").get() as { id: number }).id;

    fixture.store.db.transaction(() => {
      gcOrphanRefsWithin(fixture.store, [refId]);
    })();

    expect(refRows()).toHaveLength(1);
  });

  it("refuses to run outside an open transaction", () => {
    expect(() => gcOrphanRefsWithin(fixture.store, [1])).toThrowError(/open transaction/);
  });
});

describe("concurrent writers", () => {
  it("concurrent two-process link yields one row", { timeout: 60_000 }, async () => {
    const task = seedTask(fixture.store, { id: "kt-aaaaaa" });
    const modules = {
      store: new URL("../../src/core/store.ts", import.meta.url).href,
      repo: new URL("../../src/core/refs/repo.ts", import.meta.url).href,
    };

    const outcomes = await runConcurrent<{ ok: boolean; action: string }>({
      count: 2,
      source: `
        const { openStore } = await import(${JSON.stringify(modules.store)});
        const { linkRef } = await import(${JSON.stringify(modules.repo)});
        const { store } = openStore(${JSON.stringify(fixture.repo.dir)}, {});
        barrier();
        let ok = false, action = "";
        try {
          const result = linkRef(store, ${JSON.stringify(task)}, {
            provider: "github",
            externalId: "owner/repo#1",
            url: "https://github.com/owner/repo/pull/1",
          });
          ok = true;
          action = result.action;
        } catch (e) {
          action = String(e && e.message);
        }
        store.close();
        report({ ok, action });
      `,
    });

    for (const outcome of outcomes) {
      expect(outcome.exitCode, outcome.stderr).toBe(0);
    }
    const results = outcomes.map((o) => o.value).filter((v) => v !== undefined);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.action).sort()).toEqual(["already-linked", "linked"]);

    const { store: verify } = openStore(fixture.repo.dir, {});
    try {
      expect((verify.db.prepare("SELECT COUNT(*) c FROM refs").get() as { c: number }).c).toBe(1);
      expect((verify.db.prepare("SELECT COUNT(*) c FROM task_refs").get() as { c: number }).c).toBe(
        1,
      );
      expect(
        (
          verify.db.prepare("SELECT COUNT(*) c FROM events WHERE type='ref-linked'").get() as {
            c: number;
          }
        ).c,
      ).toBe(1);
    } finally {
      verify.close();
    }
  });
});
