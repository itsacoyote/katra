import { describe, expect, it, vi } from "vitest";
import type { Identity } from "../../src/core/actor.js";
import { bumpPresence, readPresence } from "../../src/core/presence.js";
import { openStore } from "../../src/core/store.js";
import { runCli } from "../helpers/cli.js";
import { runConcurrent } from "../helpers/concurrent.js";
import { createGitRepo } from "../helpers/fixture.js";
import { seedPresence, seedTime } from "../helpers/seed.js";
import { createStoreFixture } from "../helpers/store.js";

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
    setup.store.close();

    const started = performance.now();
    const outcomes = await runConcurrent<{ elapsedMs: number }>({
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
    const totalElapsedMs = performance.now() - started;

    const failures = outcomes.filter((o) => !o.ok);
    expect(failures.map((f) => f.stderr.split("\n").slice(0, 3).join(" "))).toEqual([]);

    const values = outcomes.map((o) => o.value).filter((v) => v !== undefined);
    expect(values).toHaveLength(6);

    // Six openers serialised behind the connection's full 7500ms busy
    // timeout would take upward of 45 seconds combined. Presence's own
    // short budget keeps every individual open, and the whole race, well
    // under that.
    for (const { elapsedMs } of values) expect(elapsedMs).toBeLessThan(2000);
    expect(totalElapsedMs).toBeLessThan(5000);

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

    repo.cleanup();
  });
});
