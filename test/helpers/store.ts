/**
 * An opened, migrated store in a throwaway repository.
 *
 * Handles are closed before the temp directory is removed — an open SQLite
 * handle makes removal fail on Windows, and a lingering read snapshot stops
 * WAL checkpointing regardless of platform.
 */

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

/** Creates a repository with an initialised, migrated katra store. */
export function createStoreFixture(): StoreFixture {
  const repo = createGitRepo();
  const { store } = openStore(repo.dir, { createIfMissing: true });

  return {
    store,
    repo,
    cleanup(): void {
      store.close();
      repo.cleanup();
    },
  };
}
