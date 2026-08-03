import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitRepo, createNonRepoDir, git } from "./fixture.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("git fixture", () => {
  it("creates and removes a throwaway git repository cleanly", () => {
    const repo = createGitRepo();

    expect(existsSync(repo.dir)).toBe(true);
    expect(existsSync(join(repo.dir, ".git"))).toBe(true);
    expect(git(repo.dir, "rev-parse", "--is-inside-work-tree")).toBe("true");
    // The empty root commit must exist, or worktrees cannot be added.
    expect(git(repo.dir, "rev-parse", "HEAD")).toMatch(/^[0-9a-f]{40}$/);

    repo.cleanup();
    expect(existsSync(repo.dir)).toBe(false);
  });

  it("creates a linked worktree sharing the parent repository's common dir", () => {
    // This is the property katra's whole storage model rests on: every worktree
    // of a repo must resolve to one shared location.
    const repo = createGitRepo();
    cleanups.push(() => repo.cleanup());

    const worktree = repo.addWorktree("feature/probe");

    const fromRoot = git(repo.dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const fromWorktree = git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir");

    expect(worktree).not.toBe(repo.dir);
    expect(fromWorktree).toBe(fromRoot);
  });

  it("resolves the same common dir from a subdirectory as from the root", () => {
    const repo = createGitRepo();
    cleanups.push(() => repo.cleanup());
    const nested = join(repo.dir, "src", "core");
    mkdirSync(nested, { recursive: true });

    const fromRoot = git(repo.dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const fromNested = git(nested, "rev-parse", "--path-format=absolute", "--git-common-dir");

    expect(fromNested).toBe(fromRoot);
  });

  it("hands back symlink-resolved paths that match what git reports", () => {
    // On macOS mkdtemp returns /var/... while git reports /private/var/...,
    // so an unresolved fixture path would fail every path-equality assertion.
    const repo = createGitRepo();
    cleanups.push(() => repo.cleanup());

    expect(git(repo.dir, "rev-parse", "--show-toplevel")).toBe(repo.dir);
  });

  it("removes a repository whose working tree still has files in it", () => {
    const repo = createGitRepo();
    writeFileSync(join(repo.dir, "leftover.txt"), "content");
    mkdirSync(join(repo.dir, "nested", "deep"), { recursive: true });
    writeFileSync(join(repo.dir, "nested", "deep", "file.txt"), "content");

    repo.cleanup();

    expect(existsSync(repo.dir)).toBe(false);
  });

  it("removes every worktree it created alongside the repository", () => {
    const repo = createGitRepo();
    const first = repo.addWorktree("wt/one");
    const second = repo.addWorktree("wt/two");

    repo.cleanup();

    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
    expect(existsSync(repo.dir)).toBe(false);
  });

  it("creates a directory that is deliberately not a repository", () => {
    const plain = createNonRepoDir();
    cleanups.push(() => plain.cleanup());

    expect(existsSync(plain.dir)).toBe(true);
    expect(() => git(plain.dir, "rev-parse", "--git-common-dir")).toThrow();
  });
});
