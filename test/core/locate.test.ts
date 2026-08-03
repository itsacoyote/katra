import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DB_FILE_NAME, resolveStoreLocation, STORE_DIR_NAME } from "../../src/core/db/locate.js";
import { isKatraException } from "../../src/core/errors.js";
import { createGitRepo, createNonRepoDir, git } from "../helpers/fixture.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const onPosix = process.platform !== "win32";

/** Builds a directory holding a fake `git` that behaves as `body` dictates. */
function fakeGitDir(body: string): string {
  const plain = createNonRepoDir();
  cleanups.push(() => plain.cleanup());
  const script = join(plain.dir, "git");
  writeFileSync(script, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(script, 0o755);
  return plain.dir;
}

describe("resolveStoreLocation", () => {
  it("places the store under the git common dir", () => {
    const repo = createGitRepo();
    cleanups.push(() => repo.cleanup());

    const location = resolveStoreLocation(repo.dir);
    const commonDir = git(repo.dir, "rev-parse", "--path-format=absolute", "--git-common-dir");

    expect(location.commonDir).toBe(commonDir);
    expect(location.storeDir).toBe(join(commonDir, STORE_DIR_NAME));
    expect(location.dbPath).toBe(join(commonDir, STORE_DIR_NAME, DB_FILE_NAME));
    expect(location.warnings).toEqual([]);
  });

  it("resolves the same absolute store path from the repo root, a subdirectory, and a linked worktree", () => {
    // The premise of katra's whole storage model. The bare --git-common-dir
    // flag returns three different strings here (".git", "../.git", and an
    // absolute path), which is why resolution uses --path-format=absolute.
    const repo = createGitRepo();
    cleanups.push(() => repo.cleanup());
    const nested = join(repo.dir, "src", "core");
    mkdirSync(nested, { recursive: true });
    const worktree = repo.addWorktree("feature/probe");

    const fromRoot = resolveStoreLocation(repo.dir).dbPath;
    const fromNested = resolveStoreLocation(nested).dbPath;
    const fromWorktree = resolveStoreLocation(worktree).dbPath;

    expect(fromNested).toBe(fromRoot);
    expect(fromWorktree).toBe(fromRoot);
  });

  it("throws a not-a-repository error outside any git repo", () => {
    const plain = createNonRepoDir();
    cleanups.push(() => plain.cleanup());

    try {
      resolveStoreLocation(plain.dir);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(isKatraException(error)).toBe(true);
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("validation");
      expect(error.message).toMatch(/not (a|inside a) git repository/i);
    }
  });

  it.runIf(onPosix)("throws a distinct error when the git binary is absent from PATH", () => {
    const repo = createGitRepo();
    cleanups.push(() => repo.cleanup());
    const empty = createNonRepoDir();
    cleanups.push(() => empty.cleanup());

    // A missing binary surfaces as a spawn ENOENT, not as captured stderr —
    // a different code path from "git ran and failed".
    expect(() => resolveStoreLocation(repo.dir, { env: { PATH: empty.dir } })).toThrowError(
      /git.*(not found|not installed|could not be run)/i,
    );
  });

  it.runIf(onPosix)("throws a distinct error when git does not support --path-format", () => {
    const repo = createGitRepo();
    cleanups.push(() => repo.cleanup());
    const oldGit = fakeGitDir(
      'echo "fatal: unknown argument to --path-format: absolute" >&2\nexit 128',
    );

    expect(() => resolveStoreLocation(repo.dir, { env: { PATH: oldGit } })).toThrowError(/2\.31/);
  });

  it.runIf(onPosix)("surfaces git's own stderr when a worktree's main repository has moved", () => {
    const repo = createGitRepo();
    cleanups.push(() => repo.cleanup());
    const brokenGit = fakeGitDir(
      'echo "fatal: not a git repository: /gone/.git/worktrees/wt" >&2\nexit 128',
    );

    try {
      resolveStoreLocation(repo.dir, { env: { PATH: brokenGit } });
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      // "no repo" and "broken worktree link" are different problems with
      // different fixes, so the message must not be flattened into one.
      expect(error.message).toContain("worktrees");
      expect(error.message).toMatch(/worktree/i);
    }
  });

  it("warns when GIT_COMMON_DIR points at a repository other than the working one", () => {
    // Verified: this returns exit 0 with a path belonging to an unrelated repo,
    // so exit status alone can never detect it.
    const repo = createGitRepo();
    cleanups.push(() => repo.cleanup());
    const other = createGitRepo();
    cleanups.push(() => other.cleanup());

    const location = resolveStoreLocation(repo.dir, {
      env: { ...process.env, GIT_COMMON_DIR: join(other.dir, ".git") },
    });

    expect(location.warnings).toHaveLength(1);
    expect(location.warnings[0]?.code).toBe("ambient-git-dir");
    expect(location.warnings[0]?.message).toContain("GIT_COMMON_DIR");
  });

  it("does not warn for a legitimate linked worktree", () => {
    // A worktree's common dir legitimately differs from its own toplevel; that
    // must not be mistaken for a redirect.
    const repo = createGitRepo();
    cleanups.push(() => repo.cleanup());
    const worktree = repo.addWorktree("feature/legit");

    expect(resolveStoreLocation(worktree).warnings).toEqual([]);
  });

  it("does not run the ambient check when no git env override is present", () => {
    const repo = createGitRepo();
    cleanups.push(() => repo.cleanup());

    const env = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_COMMON_DIR;

    expect(resolveStoreLocation(repo.dir, { env }).warnings).toEqual([]);
  });
});
