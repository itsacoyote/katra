import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isKatraException } from "../../src/core/errors.js";
import { listEvents } from "../../src/core/events/repo.js";
import { parseRefInput, validateExplicitRef } from "../../src/core/refs/parse.js";
import { gcOrphanRefsWithin, linkRef, listRefs, unlinkRef } from "../../src/core/refs/repo.js";
import { openStore } from "../../src/core/store.js";
import { runConcurrent } from "../helpers/concurrent.js";
import { seedEpic, seedTask } from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture } from "../helpers/store.js";

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

  it("bare-id then URL backfills null url, second URL never overwrites, no second event", () => {
    const task = seedTask(fixture.store);

    const first = linkRef(fixture.store, task, LINEAR_BARE_REF);
    expect(first.ref.url).toBeNull();

    const backfillUrl = "https://linear.app/acme/issue/ENG-451";
    const second = linkRef(fixture.store, task, {
      provider: "linear",
      externalId: "ENG-451",
      url: backfillUrl,
    });
    expect(second.action).toBe("already-linked");
    expect(second.ref.url).toBe(backfillUrl);
    expect(refRows()[0]?.url).toBe(backfillUrl);

    const third = linkRef(fixture.store, task, {
      provider: "linear",
      externalId: "ENG-451",
      url: "https://linear.app/other-workspace/issue/ENG-451",
    });
    expect(third.action).toBe("already-linked");
    expect(third.ref.url).toBe(backfillUrl);
    expect(refRows()[0]?.url).toBe(backfillUrl);

    expect(refRows()).toHaveLength(1);
    expect(eventsOfType("ref-linked")).toHaveLength(1);
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

    // Atomicity: a refusal (unknown task) must leave nothing behind — no
    // half-written refs row, no task_refs row, no event — proving the ref
    // write and the event share one transaction rather than two.
    expect(() => linkRef(fixture.store, "kt-zzzzzz", GITHUB_REF)).toThrowError();
    expect(refRows()).toHaveLength(1); // only the earlier, successful link
    expect(eventsOfType("ref-linked")).toHaveLength(1);
  });

  it("constraint violation never retried as id collision", () => {
    // Simulates a row that another connection already created — the
    // stale-lastInsertRowid trap: if linkRefWithin ever trusted
    // `.lastInsertRowid` after an ignored insert, it would bind whatever
    // leftover rowid the handle carried into `task_refs`, either violating
    // the foreign key or silently pointing at the wrong ref.
    const preExisting = fixture.store.db
      .prepare("INSERT INTO refs (provider, external_id, url) VALUES (?,?,?)")
      .run(GITHUB_REF.provider, GITHUB_REF.externalId, GITHUB_REF.url).lastInsertRowid;

    const task = seedTask(fixture.store);
    const result = linkRef(fixture.store, task, GITHUB_REF);

    expect(refRows()).toHaveLength(1);
    expect(result.action).toBe("linked");

    const taskRef = taskRefRows()[0];
    expect(taskRef?.ref_id).toBe(Number(preExisting));
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
