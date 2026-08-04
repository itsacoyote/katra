/**
 * Throwaway git repositories for tests.
 *
 * katra resolves its store through the git common dir, and several acceptance
 * criteria are about real git behaviour across the repo root, a subdirectory,
 * and a linked worktree. Mocking git would test nothing, so tests run against
 * real repositories in real temp directories.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitFixture {
  /** Absolute, symlink-resolved path to the repository working tree. */
  readonly dir: string;
  /** Adds a linked worktree on a new branch and returns its resolved path. */
  addWorktree(branch: string): string;
  /** Removes the repository and every worktree it created. */
  cleanup(): void;
}

/** Runs a git command in `cwd` and returns its trimmed stdout. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Resolves a path the way git reports it.
 *
 * Two platforms need this, for different reasons:
 *
 * - **macOS**: `mkdtemp` returns `/var/folders/...`, a symlink to
 *   `/private/var/folders/...`, and git always reports the target.
 * - **Windows**: `tmpdir()` returns the 8.3 short form —
 *   `C:\Users\RUNNER~1\...` — while git reports the long form
 *   (`runneradmin`). Plain `realpathSync` does **not** expand a short name;
 *   only the native variant asks the OS, which does.
 *
 * Without this every path-equality assertion in the suite fails on one
 * platform or the other, which is exactly what the CI matrix caught.
 */
function resolvePath(path: string): string {
  return typeof realpathSync.native === "function" ? realpathSync.native(path) : realpathSync(path);
}

function makeTempDir(prefix: string): string {
  return resolvePath(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * Removes a directory tree, retrying briefly.
 *
 * On Windows an open file handle makes removal fail with EBUSY/EPERM. Tests
 * close their database handles first, but the retry absorbs the lag between a
 * handle being closed and the OS releasing it.
 */
function removeTree(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/**
 * Creates an initialised git repository with one empty commit.
 *
 * The commit matters: `git worktree add` needs a HEAD to branch from, so a
 * repository with no commits cannot host a worktree.
 */
export function createGitRepo(): GitFixture {
  const dir = makeTempDir("katra-repo-");
  const worktrees: string[] = [];

  git(dir, "init", "--quiet", "--initial-branch=main");
  // Identity is set locally because CI runners often have no global identity,
  // and a commit without one fails outright.
  git(dir, "config", "user.email", "test@katra.invalid");
  git(dir, "config", "user.name", "katra test");
  git(dir, "commit", "--quiet", "--allow-empty", "-m", "root");

  return {
    dir,
    addWorktree(branch: string): string {
      const path = makeTempDir("katra-worktree-");
      // mkdtemp already created the directory; git requires it to be absent or
      // empty, and an empty existing directory is accepted.
      git(dir, "worktree", "add", "--quiet", "-b", branch, path);
      worktrees.push(path);
      return resolvePath(path);
    },
    cleanup(): void {
      for (const path of worktrees) removeTree(path);
      removeTree(dir);
    },
  };
}

/** Creates a temp directory that is deliberately *not* a git repository. */
export function createNonRepoDir(): { dir: string; cleanup(): void } {
  const dir = makeTempDir("katra-bare-");
  return { dir, cleanup: () => removeTree(dir) };
}
