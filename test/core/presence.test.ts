import { describe, expect, it, vi } from "vitest";
import type { Identity } from "../../src/core/actor.js";
import { openDatabase } from "../../src/core/db/connection.js";
import { bumpPresence, readPresence } from "../../src/core/presence.js";
import { openStore } from "../../src/core/store.js";
import { runCli } from "../helpers/cli.js";
import { runConcurrent } from "../helpers/concurrent.js";
import { createGitRepo } from "../helpers/fixture.js";
import { seedPresence, seedTime } from "../helpers/seed.js";
import { createStoreFixture } from "../helpers/store.js";

/** Waits `ms` without blocking the event loop — a spawn is still in flight. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("bumpPresence", () => {
  it("bumps last_seen when the row is absent or stale", () => {
    const worktree = "/repo/presence-absent-or-stale";
    const identity: Identity = { worktree, branch: () => "feature/x" };
    const fixture = createStoreFixture({ identity });

    // Absent: the fixture's own openStore call already bumped it once.
    const afterOpen = readPresence(fixture.store, worktree);
    expect(afterOpen).not.toBeNull();
    expect(afterOpen?.branch).toBe("feature/x");

    // Stale: force an old row in directly, then bump again.
    seedPresence(fixture.store, { worktree, branch: "old-branch", lastSeen: seedTime() });
    bumpPresence(fixture.store);

    const afterBump = readPresence(fixture.store, worktree);
    expect(afterBump?.branch).toBe("feature/x");
    expect(Date.parse(afterBump?.lastSeen ?? "")).toBeGreaterThan(Date.parse(seedTime()));

    fixture.cleanup();
  });

  it("picks up a branch change on the next write after the window", () => {
    // ADR-011's stated consequence, pinned directly rather than left to
    // follow from the skip test's inverse: "a branch change inside the
    // window is picked up by the next write" — proven through `openStore`
    // itself, the same door every real command passes through, not by
    // calling `bumpPresence` a second time by hand.
    const worktree = "/repo/presence-branch-pickup";
    const identity: Identity = { worktree, branch: () => "feature/current" };
    const fixture = createStoreFixture({ identity });

    // A stale row recorded under a different branch — as if this worktree's
    // last heartbeat predated a rename.
    const stale = seedTime();
    seedPresence(fixture.store, { worktree, branch: "old-branch", lastSeen: stale });

    const reopened = openStore(fixture.repo.dir, { identity: () => identity });
    reopened.store.close();

    const after = readPresence(fixture.store, worktree);
    expect(after?.branch).toBe("feature/current");
    expect(Date.parse(after?.lastSeen ?? "")).toBeGreaterThan(Date.parse(stale));

    fixture.cleanup();
  });

  it("skips the write and the branch spawn when the row is fresh", () => {
    const worktree = "/repo/presence-fresh";
    const branch = vi.fn(() => "main");
    const identity: Identity = { worktree, branch };
    const fixture = createStoreFixture({ identity });

    // The fixture's own open already bumped once — the row is fresh now.
    expect(branch).toHaveBeenCalledTimes(1);
    const before = readPresence(fixture.store, worktree);

    bumpPresence(fixture.store);

    const after = readPresence(fixture.store, worktree);
    expect(after).toEqual(before);
    // The freshness check is worktree-keyed only: a second bump inside the
    // window must not resolve the branch at all.
    expect(branch).toHaveBeenCalledTimes(1);

    fixture.cleanup();
  });

  it("opens the store even when the bump cannot write", () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    // Identity resolution itself fails — openStore must still hand back a
    // working store.
    const repo = createGitRepo();
    const openWithBrokenIdentity = () =>
      openStore(repo.dir, {
        createIfMissing: true,
        identity: () => {
          throw new Error("git is unavailable");
        },
      });

    const first = openWithBrokenIdentity();
    expect(first.store.db.open).toBe(true);
    first.store.close();

    // A second failure in the same process must not warn again.
    const second = openWithBrokenIdentity();
    second.store.close();

    // A different failure mode — the write itself — still respects the same
    // once-per-process guard.
    const fixture = createStoreFixture();
    fixture.store.db.exec("DROP TABLE presence");
    expect(() => bumpPresence(fixture.store)).not.toThrow();
    fixture.cleanup();

    expect(emitWarning).toHaveBeenCalledTimes(1);
    // The type string is load-bearing: events.test.ts's contention test
    // filters its stderr assertion on exactly this string.
    expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining("could not update presence"), {
      type: "KatraPresenceWarning",
    });

    repo.cleanup();
    emitWarning.mockRestore();
  });

  it("does not serialize six concurrent readers behind the heartbeat", {
    timeout: 60_000,
  }, async () => {
    const repo = createGitRepo();
    // Bring the store into being first, so every process below measures the
    // heartbeat's own contention rather than the first-migration race
    // `store.test.ts` already covers.
    const setup = openStore(repo.dir, {
      createIfMissing: true,
      identity: () => ({ worktree: "/repo/wt-setup", branch: () => "main" }),
    });
    const dbPath = setup.store.dbPath;
    setup.store.close();

    // Forced, deterministic contention rather than hoping six real
    // processes collide by chance: a 7th connection takes the write lock
    // and sits on it for ~800ms — above PRESENCE_BUSY_TIMEOUT_MS (200) and
    // far below the connection's own BUSY_TIMEOUT_MS (7500) — before the
    // six openers below even start racing for it.
    const HOLD_MS = 800;
    const holder = openDatabase(dbPath);
    holder.exec("BEGIN IMMEDIATE");
    const holdStartedAt = Date.now();

    // `runConcurrent`'s own barrier releases every worker at (call time +
    // 300 + count*40) — 540ms for six — to give six processes room to
    // spawn and import before they race. Waiting here before calling it
    // lands the six openers' arrival about 220ms before the holder
    // releases (measured: t0 ≈ 760ms after holdStartedAt against an
    // 800ms hold), so they find the lock genuinely taken — proving the
    // short budget is exercised, not skipped — with enough margin left in
    // their own 200ms budget to also absorb the six openers then briefly
    // queuing behind *each other* once the lock frees (measured up to
    // ~100ms of that on this machine) — proving the budget is sufficient,
    // not merely non-blocking.
    await sleep(220);

    const started = performance.now();
    const outcomesPromise = runConcurrent<{ elapsedMs: number }>({
      count: 6,
      source: `
          const { openStore } = await import(${JSON.stringify(
            new URL("../../src/core/store.ts", import.meta.url).href,
          )});
          barrier();
          const startedAt = performance.now();
          const { store } = openStore(${JSON.stringify(repo.dir)}, {
            identity: () => ({ worktree: "/repo/wt-" + INDEX, branch: () => "main" }),
          });
          const elapsedMs = performance.now() - startedAt;
          store.close();
          report({ elapsedMs });
        `,
    });

    // Hold for exactly HOLD_MS regardless of how long the setup above
    // (the sleep, runConcurrent's own synchronous spawn bookkeeping) took —
    // measuring the remainder rather than sleeping a second fixed amount
    // keeps the total hold precise.
    const remainingMs = HOLD_MS - (Date.now() - holdStartedAt);
    if (remainingMs > 0) await sleep(remainingMs);
    holder.exec("COMMIT");
    holder.close();

    const outcomes = await outcomesPromise;
    const totalElapsedMs = performance.now() - started;

    const failures = outcomes.filter((o) => !o.ok);
    expect(failures.map((f) => f.stderr.split("\n").slice(0, 3).join(" "))).toEqual([]);

    const values = outcomes.map((o) => o.value).filter((v) => v !== undefined);
    expect(values).toHaveLength(6);

    // Racing into a lock held for ~800ms while serialised behind the
    // connection's full 7500ms busy timeout would take seconds per opener.
    // Presence's own short budget keeps every individual open close to
    // that budget, not the old 2000ms bound.
    for (const { elapsedMs } of values) expect(elapsedMs).toBeLessThan(500);
    expect(totalElapsedMs).toBeLessThan(3000);

    // Post-race row verification: the short budget was sufficient, not
    // merely non-blocking — every opener actually got its row written,
    // despite racing into a genuinely held lock.
    const verify = openDatabase(dbPath);
    const rows = verify.prepare("SELECT worktree FROM presence ORDER BY worktree").all() as Array<{
      worktree: string;
    }>;
    verify.close();

    const expectedWorktrees = [
      "/repo/wt-setup",
      ...Array.from({ length: 6 }, (_unused, i) => `/repo/wt-${i}`),
    ].sort();
    expect(rows.map((r) => r.worktree)).toEqual(expectedWorktrees);

    // The six openers above prove the short budget is *sufficient*, not
    // that it is short: they were deliberately timed to need less than
    // PRESENCE_BUSY_TIMEOUT_MS, so they would still all succeed even
    // riding on the connection's full 7500ms budget — that comparison
    // alone cannot tell the two apart. This probe can: a second holder is
    // released only once the probe's own process has exited, so from the
    // probe's side the lock is held indefinitely — nothing frees it until
    // the probe itself gives up. A lone opener, in its own process (a
    // synchronous `openStore` in *this* process would deadlock against a
    // lock only this same single thread could release), races that hold
    // with nothing but its own busy_timeout to say when to stop. On
    // PRESENCE_BUSY_TIMEOUT_MS it must give up near 200ms, never writing;
    // on the connection's full budget it would sit for seconds instead —
    // which is exactly the distinction the six openers above cannot make.
    const secondHold = openDatabase(dbPath);
    secondHold.exec("BEGIN IMMEDIATE");

    const probeOutcomes = await runConcurrent<{ elapsedMs: number }>({
      count: 1,
      source: `
          const { openStore } = await import(${JSON.stringify(
            new URL("../../src/core/store.ts", import.meta.url).href,
          )});
          barrier();
          const startedAt = performance.now();
          const { store } = openStore(${JSON.stringify(repo.dir)}, {
            identity: () => ({ worktree: "/repo/wt-probe", branch: () => "main" }),
          });
          const elapsedMs = performance.now() - startedAt;
          store.close();
          report({ elapsedMs });
        `,
    });
    secondHold.exec("COMMIT");
    secondHold.close();

    expect(probeOutcomes[0]?.ok).toBe(true);
    const probeElapsedMs = probeOutcomes[0]?.value?.elapsedMs;
    // The bound discriminates the short budget (200ms) from the connection's
    // 7500ms — the mutation this test exists to catch measures ~7500ms. It is
    // NOT a perf assertion: a loaded CI runner can deschedule the probe after
    // the timeout expires (macOS measured 692ms on a healthy mechanism), so
    // the margin is generous. Anything under 2000ms can only mean the short
    // budget was in effect; tightening this bound buys nothing but flakes.
    expect(probeElapsedMs).toBeLessThan(2000);

    const probeVerify = openDatabase(dbPath);
    const probeRow = probeVerify
      .prepare("SELECT worktree FROM presence WHERE worktree = ?")
      .get("/repo/wt-probe");
    probeVerify.close();
    expect(probeRow).toBeUndefined();

    repo.cleanup();
  });

  it("keeps a read command's wall time bounded with the heartbeat on", async () => {
    const repo = createGitRepo();
    const init = await runCli(["init"], { cwd: repo.dir });
    expect(init.exitCode).toBe(0);

    const started = performance.now();
    const board = await runCli(["board"], { cwd: repo.dir });
    const elapsedMs = performance.now() - started;

    expect(board.exitCode).toBe(0);
    // Generous on purpose: this is not a perf test — `board.perf.test.ts` owns
    // that budget. It exists to catch presence's bump regressing into
    // something that actually blocks a read, e.g. falling back to the
    // connection's full busy timeout instead of its own short one.
    expect(elapsedMs).toBeLessThan(3000);

    // AC1: the row exists after any command, board included — a read, not
    // just a write. `repo.dir` is already the resolved worktree path
    // (`createGitRepo` resolves it the same way `resolveWorktree` reports
    // it), so it is the exact key both `init` and `board` bumped.
    const verify = openStore(repo.dir);
    const row = readPresence(verify.store, repo.dir);
    verify.store.close();

    expect(row).not.toBeNull();
    expect(Date.now() - Date.parse(row?.lastSeen ?? "")).toBeLessThan(10_000);

    repo.cleanup();
  });
});
