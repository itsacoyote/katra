import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Identity } from "../../src/core/actor.js";
import { claimFor, claimTask, releaseTask } from "../../src/core/claims/repo.js";
import { isKatraException } from "../../src/core/errors.js";
import { listEvents } from "../../src/core/events/repo.js";
import type { OpenStore } from "../../src/core/store.js";
import { openStore } from "../../src/core/store.js";
import { runConcurrent } from "../helpers/concurrent.js";
import { seedClaim, seedEpic, seedTask } from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture } from "../helpers/store.js";

const HOLDER_IDENTITY: Identity = { worktree: "/repo/wt-holder", branch: () => "feature/holder" };
const OTHER_IDENTITY: Identity = { worktree: "/repo/wt-other", branch: () => "feature/other" };
const HOLDER_ACTOR = `${HOLDER_IDENTITY.branch()} @ ${HOLDER_IDENTITY.worktree}`;

let fixture: StoreFixture;
beforeEach(() => {
  fixture = createStoreFixture({ identity: HOLDER_IDENTITY });
});
afterEach(() => fixture.cleanup());

/** A second, independent connection to the same store, as a different worktree. */
function openAs(identity: Identity): OpenStore {
  return openStore(fixture.repo.dir, { identity: () => identity }).store;
}

describe("claimTask", () => {
  it("claims an unclaimed task and appends claimed in one transaction", () => {
    const id = seedTask(fixture.store, { title: "do the thing" });

    const { task, claim } = claimTask(fixture.store, id);

    expect(task.id).toBe(id);
    expect(claim.holder).toBe(HOLDER_IDENTITY.worktree);
    expect(claim.actor).toBe(HOLDER_ACTOR);
    expect(claim.claimedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(fixture.store.db.prepare("SELECT COUNT(*) c FROM claims").get()).toEqual({ c: 1 });
    const events = listEvents(fixture.store, { entityId: id }).events;
    expect(events.map((e) => e.type)).toEqual(["claimed"]);
    expect(events[0]?.actor).toBe(HOLDER_ACTOR);
  });

  it("re-claims from the same worktree as a no-op with no second event", () => {
    const id = seedTask(fixture.store);
    const first = claimTask(fixture.store, id);

    const second = claimTask(fixture.store, id);

    // Byte-identical: no new claimed_at, no actor change.
    expect(second.claim).toEqual(first.claim);
    const events = listEvents(fixture.store, { entityId: id }).events;
    expect(events.map((e) => e.type)).toEqual(["claimed"]);
  });

  it("refuses a claim held elsewhere with the holder and last-seen age", () => {
    const id = seedTask(fixture.store);
    const held = claimTask(fixture.store, id);

    const other = openAs(OTHER_IDENTITY);
    try {
      try {
        claimTask(other, id);
        expect.unreachable("should have thrown");
      } catch (error) {
        if (!isKatraException(error)) throw error;
        expect(error.detail.code).toBe("conflict");
        expect(error.message).toContain(`held by ${HOLDER_ACTOR}`);
        expect(error.message).toContain("last seen");
        expect(error.message).toContain("release --force to take it over");
        if (error.detail.code === "conflict") {
          expect(error.detail.reason).toBe(`held by ${HOLDER_ACTOR}`);
        }
      }
    } finally {
      other.close();
    }

    // AC2 (amended): the claim and the event stream are unchanged by a
    // refused contender. The refusing worktree's own presence row may move —
    // that is not this assertion's concern.
    expect(claimFor(fixture.store, id)).toEqual(held.claim);
    expect(listEvents(fixture.store, { entityId: id }).events.map((e) => e.type)).toEqual([
      "claimed",
    ]);
  });

  it("refuses claiming an epic and a Done task with a reason", () => {
    const epic = seedEpic(fixture.store, { title: "an epic" });
    const done = seedTask(fixture.store, { title: "already finished", lane: "Done" });

    try {
      claimTask(fixture.store, epic);
      expect.unreachable("claiming an epic should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("validation");
      expect(error.message).toContain("is an epic");
    }

    try {
      claimTask(fixture.store, done);
      expect.unreachable("claiming a Done task should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("validation");
      expect(error.message).toContain("is already Done");
    }

    expect(claimFor(fixture.store, epic)).toBeNull();
    expect(claimFor(fixture.store, done)).toBeNull();
  });
});

describe("releaseTask", () => {
  it("releases a held claim and appends released", () => {
    const id = seedTask(fixture.store);
    claimTask(fixture.store, id);

    const { claim } = releaseTask(fixture.store, id);

    expect(claim.holder).toBe(HOLDER_IDENTITY.worktree);
    expect(claimFor(fixture.store, id)).toBeNull();

    // Newest first: released, then the original claimed.
    const events = listEvents(fixture.store, { entityId: id }).events;
    expect(events.map((e) => e.type)).toEqual(["released", "claimed"]);
    expect(events[0]?.priorActor).toBeNull();
  });

  it("refuses a non-holder release without force, naming the holder", () => {
    const id = seedTask(fixture.store);
    seedClaim(fixture.store, { taskId: id, holder: HOLDER_IDENTITY.worktree, actor: HOLDER_ACTOR });

    const other = openAs(OTHER_IDENTITY);
    try {
      try {
        releaseTask(other, id);
        expect.unreachable("should have thrown");
      } catch (error) {
        if (!isKatraException(error)) throw error;
        expect(error.detail.code).toBe("conflict");
        expect(error.message).toContain(HOLDER_ACTOR);
      }
    } finally {
      other.close();
    }

    expect(claimFor(fixture.store, id)?.holder).toBe(HOLDER_IDENTITY.worktree);
    expect(listEvents(fixture.store, { entityId: id }).events).toEqual([]);
  });

  it("force-releases and records the prior holder on the event", () => {
    const id = seedTask(fixture.store);
    seedClaim(fixture.store, { taskId: id, holder: HOLDER_IDENTITY.worktree, actor: HOLDER_ACTOR });

    const other = openAs(OTHER_IDENTITY);
    let result: ReturnType<typeof releaseTask>;
    try {
      result = releaseTask(other, id, { force: true });
    } finally {
      other.close();
    }

    expect(result.claim.actor).toBe(HOLDER_ACTOR);
    expect(claimFor(fixture.store, id)).toBeNull();

    const event = listEvents(fixture.store, { entityId: id }).events[0];
    expect(event?.type).toBe("released");
    expect(event?.priorActor).toBe(HOLDER_ACTOR);
    expect(event?.actor).toBe(`${OTHER_IDENTITY.branch()} @ ${OTHER_IDENTITY.worktree}`);
  });

  it("refuses releasing an unclaimed task", () => {
    const id = seedTask(fixture.store);

    try {
      releaseTask(fixture.store, id);
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("not_found");
    }
  });
});

describe("identity resolves before the write lock", () => {
  it("never resolves identity inside an open transaction", () => {
    // Mirrors events-emission.test.ts's "the actor is resolved before the
    // write lock": `store.actor()` and `store.identity()` both fuse through
    // the same resolver, so spying on `identity` alone catches both call
    // sites claimTask/releaseTask use.
    //
    // `store` is declared before `openStore` runs, not destructured from its
    // result: `openStore` itself calls `identity()` once, from inside
    // `bumpPresence`, before it has anything to return. Reading a `let`
    // declared earlier is safe there (and correctly reports "no transaction
    // yet" via the fallback) where destructuring the call's own result would
    // not be — that field is still uninitialized at the point this closure
    // first runs.
    let store: OpenStore | undefined;
    const seen: boolean[] = [];
    store = openStore(fixture.repo.dir, {
      identity: () => {
        seen.push(store?.db.inTransaction ?? false);
        return HOLDER_IDENTITY;
      },
    }).store;

    try {
      const id = seedTask(store);
      claimTask(store, id);
      releaseTask(store, id);

      expect(seen.length).toBeGreaterThan(0);
      expect(seen).toEqual(seen.map(() => false));
    } finally {
      store.close();
    }
  });
});

describe("concurrent claims", () => {
  it("lets exactly one of two worktrees win the claim", { timeout: 60_000 }, async () => {
    // Two real linked worktrees of the same repository, sharing one store —
    // same-directory workers would share one identity and be a single
    // holder, proving nothing about the compare-and-set (plan-review HIGH-5).
    const worktreeB = fixture.repo.addWorktree("feature/race");
    const id = seedTask(fixture.store, { title: "contested" });

    const modules = {
      store: new URL("../../src/core/store.ts", import.meta.url).href,
      claims: new URL("../../src/core/claims/repo.ts", import.meta.url).href,
    };

    const outcomes = await runConcurrent<{
      ok: boolean;
      conflict: boolean;
      holder: string | null;
    }>({
      count: 2,
      // runConcurrent's `cwd` option is one string shared by every spawned
      // process, but this race needs each process running from a genuinely
      // different worktree. Each worktree's path rides over `env` instead,
      // keyed by the in-scope `INDEX` binding the worker template exposes.
      env: {
        KATRA_WORKTREE_0: fixture.repo.dir,
        KATRA_WORKTREE_1: worktreeB,
      },
      source: `
        const { openStore } = await import(${JSON.stringify(modules.store)});
        const { claimTask } = await import(${JSON.stringify(modules.claims)});
        const cwd = process.env["KATRA_WORKTREE_" + INDEX];
        const { store } = openStore(cwd, {});
        barrier();
        let ok = false, conflict = false, holder = null;
        try {
          const { claim } = claimTask(store, ${JSON.stringify(id)});
          ok = true;
          holder = claim.holder;
        } catch (e) {
          conflict = /held by/.test(String(e && e.message));
        }
        store.close();
        report({ ok, conflict, holder });
      `,
    });

    expect(
      outcomes.every((o) => o.ok),
      outcomes.map((o) => o.stderr).join("\n"),
    ).toBe(true);

    const results = outcomes.map((o) => o.value).filter((v) => v !== undefined);
    expect(results).toHaveLength(2);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.conflict)).toHaveLength(1);

    // The decisive check: whatever the timing, exactly one claim landed, and
    // it belongs to whoever actually won.
    const winner = results.find((r) => r.ok);
    const claim = claimFor(fixture.store, id);
    expect(claim).not.toBeNull();
    expect(claim?.holder).toBe(winner?.holder);
    expect(fixture.store.db.prepare("SELECT COUNT(*) c FROM claims").get()).toEqual({ c: 1 });
    expect(listEvents(fixture.store, { entityId: id }).events.map((e) => e.type)).toEqual([
      "claimed",
    ]);
  });
});
