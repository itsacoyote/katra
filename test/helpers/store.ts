/**
 * An opened, migrated store in a throwaway repository.
 *
 * Handles are closed before the temp directory is removed — an open SQLite
 * handle makes removal fail on Windows, and a lingering read snapshot stops
 * WAL checkpointing regardless of platform.
 */

import type { Identity } from "../../src/core/actor.js";
import type { OpenStore } from "../../src/core/store.js";
import { openStore } from "../../src/core/store.js";
import type { GitFixture } from "./fixture.js";
import { createGitRepo } from "./fixture.js";

export interface StoreFixture {
  readonly store: OpenStore;
  /** The repository the store belongs to, for worktree and path assertions. */
  readonly repo: GitFixture;
  cleanup(): void;
}

/**
 * The fixture's default identity when a test does not pin its own.
 *
 * Presence (F4 T3) resolves `identity().worktree` eagerly on every
 * `openStore` call, not just the ones a test cares about — so without a fixed
 * default here, every one of the suite's hundreds of fixture opens would
 * spawn `git rev-parse` just to bump a heartbeat nothing is asserting on.
 */
const FIXED_IDENTITY: Identity = {
  worktree: "/repo/fixture",
  branch: () => "main",
};

export interface StoreFixtureOptions {
  /**
   * A fixed actor, for tests that assert on who wrote something.
   *
   * Without it the real resolver runs against the temp repository and produces
   * `main @ /tmp/katra-repo-xxxxx` — correct, but not something an assertion
   * can name.
   */
  readonly actor?: string;
  /**
   * The worktree and branch this fixture's store resolves to.
   *
   * Defaults to {@link FIXED_IDENTITY} — mirrors `actor` above — so opening a
   * fixture store costs no git spawn merely for the presence heartbeat. Pass a
   * real resolver's already-resolved identity (for example
   * `createIdentityResolver({ cwd: repo.dir })()`) for the tests that assert
   * on genuine git resolution; real linked worktrees stay reserved for the
   * process-level race tests, which call `openStore` directly rather than
   * through this fixture.
   */
  readonly identity?: Identity;
}

/** Creates a repository with an initialised, migrated katra store. */
export function createStoreFixture(options: StoreFixtureOptions = {}): StoreFixture {
  const repo = createGitRepo();
  const { actor, identity } = options;
  const resolvedIdentity = identity ?? FIXED_IDENTITY;
  const { store } = openStore(repo.dir, {
    createIfMissing: true,
    ...(actor === undefined ? {} : { actor: () => actor }),
    identity: () => resolvedIdentity,
  });

  return {
    store,
    repo,
    cleanup(): void {
      store.close();
      repo.cleanup();
    },
  };
}

/**
 * A worktree distinct from any fixture's default identity — the "someone
 * else" side of a non-holder/contention test (claims.test.ts, lifecycle.test.ts).
 */
export const OTHER_IDENTITY: Identity = {
  worktree: "/repo/wt-other",
  branch: () => "feature/other",
};

/** A second, independent connection to `repoDir`'s store, as a different worktree. */
export function openAs(repoDir: string, identity: Identity): OpenStore {
  return openStore(repoDir, { identity: () => identity }).store;
}
