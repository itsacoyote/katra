import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Identity } from "../../src/core/actor.js";
import { claimFor, claimTask, releaseTask } from "../../src/core/claims/repo.js";
import { isKatraException } from "../../src/core/errors.js";
import { listEvents } from "../../src/core/events/repo.js";
import type { OpenStore } from "../../src/core/store.js";
import { openStore } from "../../src/core/store.js";
import { deleteTask } from "../../src/core/tasks/delete.js";
import { cancelTask, closeTask, reopenTask } from "../../src/core/tasks/lifecycle.js";
import { runConcurrent } from "../helpers/concurrent.js";
import { seedClaim, seedEpic, seedPresence, seedTask } from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture, OTHER_IDENTITY, openAs } from "../helpers/store.js";

const HOLDER_IDENTITY: Identity = { worktree: "/repo/wt-holder", branch: () => "feature/holder" };
const HOLDER_ACTOR = `${HOLDER_IDENTITY.branch()} @ ${HOLDER_IDENTITY.worktree}`;

let fixture: StoreFixture;
beforeEach(() => {
  fixture = createStoreFixture({ identity: HOLDER_IDENTITY });
});
afterEach(() => fixture.cleanup());

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

    const other = openAs(fixture.repo.dir, OTHER_IDENTITY);
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
    const cancelled = seedTask(fixture.store, { title: "abandoned", lane: "Cancelled" });

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

    // AC6 names both terminal lanes; Done and Cancelled share one code path
    // (`isTerminal`), but the refusal message must still name this lane.
    try {
      claimTask(fixture.store, cancelled);
      expect.unreachable("claiming a Cancelled task should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("validation");
      expect(error.message).toContain("is already Cancelled");
    }

    expect(claimFor(fixture.store, epic)).toBeNull();
    expect(claimFor(fixture.store, done)).toBeNull();
    expect(claimFor(fixture.store, cancelled)).toBeNull();
  });

  it("names a holder that has never heartbeat as never seen", () => {
    // `bumpPresence` is non-fatal, so a claim with no presence row behind it
    // is reachable in real use, not just a seeded fixture — see
    // claims/repo.ts's `describeLiveness`. Seeded directly, since claiming
    // through `claimTask` would itself have a presence row by construction
    // (claiming opens a store, and `createStoreFixture` already bumped one
    // for `HOLDER_IDENTITY`).
    const id = seedTask(fixture.store);
    const ghostActor = "feature/ghost @ /repo/wt-ghost";
    seedClaim(fixture.store, { taskId: id, holder: "/repo/wt-ghost", actor: ghostActor });

    try {
      claimTask(fixture.store, id);
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("conflict");
      expect(error.message).toContain(`held by ${ghostActor}`);
      expect(error.message).toContain("never seen");
      expect(error.message).not.toContain("last seen");
    }
  });

  it("treats an unparseable last_seen as never seen rather than failing the refusal itself", () => {
    // A malformed presence.last_seen — an older build, a corrupt row —
    // reaching `timeAgo` directly would throw `validation`/exit 1 in the
    // middle of building a `conflict`/exit 3 refusal, inverting the retry
    // signal a contended claim promises (ADR-005). `describeLiveness` must
    // fold that failure into the same honest "never seen" arm instead.
    const id = seedTask(fixture.store);
    const ghostActor = "feature/ghost @ /repo/wt-ghost";
    seedClaim(fixture.store, { taskId: id, holder: "/repo/wt-ghost", actor: ghostActor });
    seedPresence(fixture.store, {
      worktree: "/repo/wt-ghost",
      branch: "feature/ghost",
      lastSeen: "not-a-timestamp",
    });

    try {
      claimTask(fixture.store, id);
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("conflict");
      expect(error.message).toContain("never seen");
    }
  });

  it("falls back to 'an unknown time' when both last_seen and claimed_at are unusable", () => {
    // `describeLiveness`'s deepest fallback: no presence row at all (so
    // `lastSeen` is null) *and* a `claimed_at` that cannot parse either —
    // `timeAgoOrNull(claim.claimedAt, now) ?? "an unknown time"` is the one
    // line standing between this and a `validation` exception escaping mid
    // conflict-message, same as the `last_seen` case above.
    const id = seedTask(fixture.store);
    const ghostActor = "feature/ghost @ /repo/wt-ghost";
    seedClaim(fixture.store, {
      taskId: id,
      holder: "/repo/wt-ghost",
      actor: ghostActor,
      claimedAt: "not-a-timestamp",
    });

    try {
      claimTask(fixture.store, id);
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("conflict");
      expect(error.message).toContain("never seen (claimed an unknown time ago)");
    }
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

    const other = openAs(fixture.repo.dir, OTHER_IDENTITY);
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

    const other = openAs(fixture.repo.dir, OTHER_IDENTITY);
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
    // the same resolver, so spying on `identity` alone catches every call
    // site that resolves it — claimTask/releaseTask directly, and (T5)
    // `transition` (close/cancel/reopen all funnel through it) and
    // `deleteTask`, each of which now resolves `worktree` before opening its
    // own `writeTx` the same way. This is the exact drift a future change
    // could reintroduce by having one of those reach for `releaseTask`
    // instead of `settleClaim` — see the atomicity test in lifecycle.test.ts.
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

      const closed = seedTask(store);
      claimTask(store, closed);
      closeTask(store, closed);

      const cancelled = seedTask(store);
      claimTask(store, cancelled);
      cancelTask(store, cancelled, "dropped");

      reopenTask(store, cancelled);

      const deleted = seedTask(store);
      claimTask(store, deleted);
      deleteTask(store, deleted);

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
