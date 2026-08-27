import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Identity } from "../../src/core/actor.js";
import {
  DISPLACEMENT_SCAN_LIMIT,
  GUARD_LIVENESS_DEFAULT_MS,
  guardCheck,
} from "../../src/core/claims/guard.js";
import { claimFor, claimTask, releaseTask } from "../../src/core/claims/repo.js";
import type { OpenStore } from "../../src/core/store.js";
import { seedClaim, seedEvent, seedPresence, seedTask } from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture, openAs } from "../helpers/store.js";

const MINE_IDENTITY: Identity = { worktree: "/repo/wt-mine", branch: () => "feature/mine" };
const RIVAL_A: Identity = { worktree: "/repo/wt-rival-a", branch: () => "feature/rival-a" };
const RIVAL_B: Identity = { worktree: "/repo/wt-rival-b", branch: () => "feature/rival-b" };

let fixture: StoreFixture;
beforeEach(() => {
  fixture = createStoreFixture({ identity: MINE_IDENTITY });
});
afterEach(() => fixture.cleanup());

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/**
 * Directly rewrites a claim's `claimed_at` — there is no application path to
 * backdate a real claim, and `test/helpers/store.ts`'s own `backdate` rewrites
 * `events.created_at`, not `claims.claimed_at`. Mirrors that helper's own
 * direct-SQL approach for the one column it does not cover.
 */
function backdateClaim(store: OpenStore, taskId: string, iso: string): void {
  store.db.prepare("UPDATE claims SET claimed_at = ? WHERE task_id = ?").run(iso, taskId);
}

/** Force-takes `taskId` for `rival`, leaving it live-claimed by that identity. */
function takeOver(repoDir: string, taskId: string, rival: Identity): void {
  const store = openAs(repoDir, rival);
  try {
    releaseTask(store, taskId, { force: true });
    claimTask(store, taskId);
  } finally {
    store.close();
  }
}

describe("guardCheck", () => {
  it("allows when the worktree holds no claim and has no claim history", () => {
    expect(guardCheck(fixture.store)).toEqual({ verdict: "allow" });
  });

  it("allows when the worktree still holds its claimed task", () => {
    const id = seedTask(fixture.store, { title: "still mine" });
    claimTask(fixture.store, id);

    expect(guardCheck(fixture.store)).toEqual({ verdict: "allow" });
  });

  it("allows once the worktree claims different work after being taken over", () => {
    const taken = seedTask(fixture.store, { title: "taken over" });
    claimTask(fixture.store, taken);
    takeOver(fixture.repo.dir, taken, RIVAL_A);

    const different = seedTask(fixture.store, { title: "different work" });
    claimTask(fixture.store, different);

    expect(guardCheck(fixture.store)).toEqual({ verdict: "allow" });
  });

  it("denies when the worktree already held other work before the takeover", () => {
    const heldBefore = seedTask(fixture.store, { title: "unrelated, held before" });
    claimTask(fixture.store, heldBefore);

    const taken = seedTask(fixture.store, { title: "taken over" });
    claimTask(fixture.store, taken);
    takeOver(fixture.repo.dir, taken, RIVAL_A);

    // Holding unrelated work claimed *before* the takeover is exactly the
    // "never notices" collision ADR-019 exists to stop — it must not read as
    // re-coordination.
    const result = guardCheck(fixture.store);
    expect(result.verdict).toBe("deny");
    if (result.verdict === "deny") expect(result.taskId).toBe(taken);
  });

  it("denies when another live worktree force-took the in-progress task", () => {
    const id = seedTask(fixture.store, { title: "taken over" });
    claimTask(fixture.store, id);
    takeOver(fixture.repo.dir, id, RIVAL_A);

    const result = guardCheck(fixture.store);
    expect(result.verdict).toBe("deny");
    if (result.verdict === "deny") {
      expect(result.taskId).toBe(id);
      expect(result.holder).toBe(RIVAL_A.worktree);
    }
  });

  it("carries the rival's actor, claim time, and last-seen in the deny verdict", () => {
    const id = seedTask(fixture.store, { title: "taken over" });
    claimTask(fixture.store, id);
    takeOver(fixture.repo.dir, id, RIVAL_A);

    // The independent source of truth: the same live claim read a completely
    // different way, not a recomputation of what guardCheck itself produced.
    const rivalClaim = claimFor(fixture.store, id);
    const result = guardCheck(fixture.store);

    expect(result.verdict).toBe("deny");
    if (result.verdict !== "deny") return;
    expect(result.taskId).toBe(id);
    expect(result.holder).toBe(rivalClaim?.holder);
    expect(result.actor).toBe(rivalClaim?.actor);
    expect(result.claimedAt).toBe(rivalClaim?.claimedAt);
    expect(result.lastSeen).toBe(rivalClaim?.lastSeen);
  });

  it("allows when the rival's last-seen and claim time are both outside the liveness window", () => {
    const id = seedTask(fixture.store, { title: "taken over" });
    claimTask(fixture.store, id);
    takeOver(fixture.repo.dir, id, RIVAL_A);

    // Well past GUARD_LIVENESS_DEFAULT_MS (60 minutes) on both signals.
    const stale = minutesAgo(GUARD_LIVENESS_DEFAULT_MS / 60_000 + 60);
    backdateClaim(fixture.store, id, stale);
    seedPresence(fixture.store, {
      worktree: RIVAL_A.worktree,
      branch: RIVAL_A.branch(),
      lastSeen: stale,
    });

    expect(guardCheck(fixture.store)).toEqual({ verdict: "allow" });
  });

  it("denies when the rival's claim is old but its presence was just bumped", () => {
    const id = seedTask(fixture.store, { title: "taken over" });
    claimTask(fixture.store, id);
    takeOver(fixture.repo.dir, id, RIVAL_A);

    // Recency is the LATER of the two signals — an old claim must not win
    // over a presence row that was just bumped.
    backdateClaim(fixture.store, id, minutesAgo(90));
    seedPresence(fixture.store, {
      worktree: RIVAL_A.worktree,
      branch: RIVAL_A.branch(),
      lastSeen: minutesAgo(5),
    });

    const result = guardCheck(fixture.store);
    expect(result.verdict).toBe("deny");
    if (result.verdict === "deny") expect(result.taskId).toBe(id);
  });

  it("denies when the rival's presence is stale but its claim is recent", () => {
    const id = seedTask(fixture.store, { title: "taken over" });
    claimTask(fixture.store, id);
    takeOver(fixture.repo.dir, id, RIVAL_A);
    // claimedAt is left fresh, from the real takeover above.

    // Recency is the LATER of the two signals — a stale presence row must not
    // win over a claim that was just made.
    seedPresence(fixture.store, {
      worktree: RIVAL_A.worktree,
      branch: RIVAL_A.branch(),
      lastSeen: minutesAgo(90),
    });

    const result = guardCheck(fixture.store);
    expect(result.verdict).toBe("deny");
    if (result.verdict === "deny") expect(result.taskId).toBe(id);
  });

  it("denies when the rival has no presence row but its claim is recent", () => {
    const id = seedTask(fixture.store, { title: "taken over" });
    claimTask(fixture.store, id);
    takeOver(fixture.repo.dir, id, RIVAL_A);

    // Simulate a rival whose very first heartbeat never landed (bumpPresence
    // is non-fatal — presence.ts): recent claim, no presence row at all.
    fixture.store.db.prepare("DELETE FROM presence WHERE worktree = ?").run(RIVAL_A.worktree);

    const result = guardCheck(fixture.store);
    expect(result.verdict).toBe("deny");
    if (result.verdict === "deny") {
      expect(result.taskId).toBe(id);
      expect(result.lastSeen).toBeNull();
    }
  });

  it("allows when the worktree released the task itself before the rival claimed", () => {
    const id = seedTask(fixture.store, { title: "self released" });
    claimTask(fixture.store, id);
    releaseTask(fixture.store, id);

    const rival = openAs(fixture.repo.dir, RIVAL_A);
    try {
      claimTask(rival, id);
    } finally {
      rival.close();
    }

    expect(guardCheck(fixture.store)).toEqual({ verdict: "allow" });
  });

  it("denies when an older displaced tenure's holder is live even though the most recent one is stale", () => {
    const older = seedTask(fixture.store, { title: "older takeover" });
    claimTask(fixture.store, older);
    takeOver(fixture.repo.dir, older, RIVAL_A);

    const newer = seedTask(fixture.store, { title: "newer takeover" });
    claimTask(fixture.store, newer);
    takeOver(fixture.repo.dir, newer, RIVAL_B);

    // The most recent tenure (newer/RIVAL_B) goes stale; the older one
    // (RIVAL_A) stays live. A stale most-recent tenure must not mask it.
    const stale = minutesAgo(GUARD_LIVENESS_DEFAULT_MS / 60_000 + 60);
    backdateClaim(fixture.store, newer, stale);
    seedPresence(fixture.store, {
      worktree: RIVAL_B.worktree,
      branch: RIVAL_B.branch(),
      lastSeen: stale,
    });

    const result = guardCheck(fixture.store);
    expect(result.verdict).toBe("deny");
    if (result.verdict === "deny") {
      expect(result.taskId).toBe(older);
      expect(result.holder).toBe(RIVAL_A.worktree);
    }
  });

  it("reports the most recent live displaced tenure when several exist", () => {
    const first = seedTask(fixture.store, { title: "first takeover" });
    claimTask(fixture.store, first);
    takeOver(fixture.repo.dir, first, RIVAL_A);

    const second = seedTask(fixture.store, { title: "second takeover" });
    claimTask(fixture.store, second);
    takeOver(fixture.repo.dir, second, RIVAL_B);

    // Both rivals are live (real presence, just bumped) — the second,
    // strictly later takeover must win the report.
    const result = guardCheck(fixture.store);
    expect(result.verdict).toBe("deny");
    if (result.verdict === "deny") {
      expect(result.taskId).toBe(second);
      expect(result.holder).toBe(RIVAL_B.worktree);
    }
  });

  it("detects a takeover recorded under a different branch than the claim's", () => {
    const id = seedTask(fixture.store, { title: "branch changed since claiming" });
    claimTask(fixture.store, id); // frozen actor: "feature/mine @ /repo/wt-mine"
    takeOver(fixture.repo.dir, id, RIVAL_A);

    // Same worktree, a different branch than the one the claim was frozen
    // under — comparing fused actor strings would miss this; comparing
    // worktree halves (worktreeFromActor) must not.
    const rebranched = openAs(fixture.repo.dir, {
      worktree: MINE_IDENTITY.worktree,
      branch: () => "feature/mine-renamed",
    });
    try {
      const result = guardCheck(rebranched);
      expect(result.verdict).toBe("deny");
      if (result.verdict === "deny") expect(result.taskId).toBe(id);
    } finally {
      rebranched.close();
    }
  });

  it("detects a takeover when the displaced claim was made on a detached HEAD", () => {
    const detached = openAs(fixture.repo.dir, {
      worktree: MINE_IDENTITY.worktree,
      branch: () => "a1b2c3d", // a detached-HEAD short sha, per actor.ts's resolveBranch
    });
    const id = seedTask(detached, { title: "claimed on a detached HEAD" });
    claimTask(detached, id);
    detached.close();

    takeOver(fixture.repo.dir, id, RIVAL_A);

    const result = guardCheck(fixture.store);
    expect(result.verdict).toBe("deny");
    if (result.verdict === "deny") expect(result.taskId).toBe(id);
  });

  it("allows again after the rival releases the taken-over task", () => {
    const id = seedTask(fixture.store, { title: "taken then freed" });
    claimTask(fixture.store, id);

    const rival = openAs(fixture.repo.dir, RIVAL_A);
    try {
      releaseTask(rival, id, { force: true });
      claimTask(rival, id);
      releaseTask(rival, id);
    } finally {
      rival.close();
    }

    // Unclaimed again: no longer among "tasks currently held by another
    // worktree" at all, so it is not even a candidate — allow.
    expect(guardCheck(fixture.store)).toEqual({ verdict: "allow" });
  });

  it("returns the correct verdict with 50 foreign-held claims seeded", () => {
    // 49 unrelated foreign claims — noise the K+1 scan must wade through
    // without losing the one real signal.
    for (let i = 0; i < 49; i++) {
      const noise = seedTask(fixture.store, { title: `noise ${i}` });
      seedClaim(fixture.store, { taskId: noise, holder: `/repo/wt-noise-${i}` });
    }

    const id = seedTask(fixture.store, { title: "the real takeover" });
    claimTask(fixture.store, id);
    takeOver(fixture.repo.dir, id, RIVAL_A);

    const result = guardCheck(fixture.store);
    expect(result.verdict).toBe("deny");
    if (result.verdict === "deny") {
      expect(result.taskId).toBe(id);
      expect(result.holder).toBe(RIVAL_A.worktree);
    }
  });

  it("still denies when the displacement is the newest event but the task's own history is far bigger than the scan bound", () => {
    const id = seedTask(fixture.store, { title: "buried under noise" });
    claimTask(fixture.store, id);

    // Pad the task's own history past the LIMIT-bounded scan window — the
    // shape a peer worktree's own cheap `katra update --reason` traffic on a
    // task *it* holds produces. None of this names either worktree in
    // `prior_actor`, so it is noise the scan must wade through, not signal.
    for (let i = 0; i < DISPLACEMENT_SCAN_LIMIT + 50; i++) {
      seedEvent(fixture.store, {
        type: "note-added",
        entityId: id,
        actor: `main @ /repo/wt-noise-${i}`,
      });
    }

    // The takeover lands last — its `released` event is the newest one on
    // the task that actually settles anything — so it sits well inside the
    // scan's bounded window no matter how much older noise precedes it.
    takeOver(fixture.repo.dir, id, RIVAL_A);

    const result = guardCheck(fixture.store);
    expect(result.verdict).toBe("deny");
    if (result.verdict === "deny") {
      expect(result.taskId).toBe(id);
      expect(result.holder).toBe(RIVAL_A.worktree);
    }
  });

  it("allows after the worktree re-takes the task back and releases it voluntarily", () => {
    const id = seedTask(fixture.store, { title: "round trip" });
    claimTask(fixture.store, id); // A claims X

    const rival = openAs(fixture.repo.dir, RIVAL_A);
    try {
      releaseTask(rival, id, { force: true }); // B force-takes X from A
      claimTask(rival, id);
    } finally {
      rival.close();
    }

    releaseTask(fixture.store, id, { force: true }); // A force-takes X back from B
    claimTask(fixture.store, id);
    releaseTask(fixture.store, id); // A releases X voluntarily

    const rival2 = openAs(fixture.repo.dir, RIVAL_A);
    try {
      claimTask(rival2, id); // B claims X, ordinarily — it is unclaimed
    } finally {
      rival2.close();
    }

    // A's own history shows it re-acquired X and gave it up on its own — the
    // old, never-notices displacement by B is settled, not still live.
    expect(guardCheck(fixture.store)).toEqual({ verdict: "allow" });
  });

  it("honors a caller-supplied liveness floor", () => {
    const id = seedTask(fixture.store, { title: "taken over" });
    claimTask(fixture.store, id);
    takeOver(fixture.repo.dir, id, RIVAL_A);

    // 90 minutes stale: outside the default 60-minute window.
    const ninetyMinutesAgo = minutesAgo(90);
    backdateClaim(fixture.store, id, ninetyMinutesAgo);
    seedPresence(fixture.store, {
      worktree: RIVAL_A.worktree,
      branch: RIVAL_A.branch(),
      lastSeen: ninetyMinutesAgo,
    });

    // The default floor reads this rival as stale.
    expect(guardCheck(fixture.store)).toEqual({ verdict: "allow" });

    // A caller-supplied floor reaching back further reads the same rival as
    // live — the option is honored, not merely accepted and ignored.
    const result = guardCheck(fixture.store, { livenessFloor: minutesAgo(120) });
    expect(result.verdict).toBe("deny");
    if (result.verdict === "deny") expect(result.taskId).toBe(id);
  });
});
