import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createActorResolver, createIdentityResolver, resolveActor } from "../../src/core/actor.js";
import { isKatraException } from "../../src/core/errors.js";
import { findGit } from "../../src/core/git.js";
import { openStore } from "../../src/core/store.js";
import { createGitRepo, createNonRepoDir, git } from "../helpers/fixture.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const onPosix = process.platform !== "win32";

function repo() {
  const r = createGitRepo();
  cleanups.push(() => r.cleanup());
  return r;
}

/**
 * A `git` that logs every invocation's arguments before delegating to the real
 * one.
 *
 * Counting spawns is the only way to observe laziness and memoisation — both
 * are properties of *how often* git is asked, and the answer is identical
 * either way.
 */
function countingGit(): { env: NodeJS.ProcessEnv; calls: () => string[] } {
  const dir = createNonRepoDir();
  cleanups.push(() => dir.cleanup());
  const log = join(dir.dir, "calls.log");
  const bin = join(dir.dir, "bin");
  mkdirSync(bin, { recursive: true });

  const real = findGit(process.env);
  if (real === undefined) throw new Error("no git on PATH to wrap");
  const script = join(bin, "git");
  writeFileSync(
    script,
    `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(real)} "$@"\n`,
    "utf8",
  );
  chmodSync(script, 0o755);

  return {
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
    calls: () => {
      try {
        return readFileSync(log, "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

describe("resolveActor", () => {
  it("names the branch and the worktree path", () => {
    const r = repo();

    expect(resolveActor({ cwd: r.dir })).toBe(`main @ ${r.dir}`);
  });

  it("reports the same actor from a subdirectory of the worktree", () => {
    // The identity is the worktree, not the directory the command ran in.
    const r = repo();
    const nested = join(r.dir, "src", "core");
    mkdirSync(nested, { recursive: true });

    expect(resolveActor({ cwd: nested })).toBe(`main @ ${r.dir}`);
  });

  it("resolves a branch in a repository with no commits", () => {
    // `rev-parse --abbrev-ref HEAD` exits 128 here — "ambiguous argument
    // 'HEAD'" — so every write command would die in a freshly `git init`ed
    // repo, which is exactly the cold-start path katra's story is about.
    // `symbolic-ref` returns the branch name instead. Verified against real
    // git, not assumed.
    const dir = createNonRepoDir();
    cleanups.push(() => dir.cleanup());
    git(dir.dir, "init", "--quiet", "--initial-branch=main");

    expect(resolveActor({ cwd: dir.dir })).toBe(`main @ ${dir.dir}`);
  });

  it("uses the short sha when HEAD is detached", () => {
    const r = repo();
    git(r.dir, "commit", "--quiet", "--allow-empty", "-m", "second");
    git(r.dir, "checkout", "--quiet", "HEAD~1");
    const sha = git(r.dir, "rev-parse", "--short", "HEAD");

    // Not the literal string "HEAD", which is what `rev-parse --abbrev-ref`
    // and `rev-parse --symbolic-full-name` both return here — either would
    // stamp an identical actor for every detached worktree in existence.
    expect(resolveActor({ cwd: r.dir })).toBe(`${sha} @ ${r.dir}`);
    expect(resolveActor({ cwd: r.dir })).not.toContain("HEAD");
  });

  it("distinguishes two detached worktrees at different commits", () => {
    const r = repo();
    git(r.dir, "commit", "--quiet", "--allow-empty", "-m", "second");
    const first = r.addWorktree("probe-a");
    const second = r.addWorktree("probe-b");
    git(first, "checkout", "--quiet", "HEAD~1");
    git(second, "checkout", "--quiet", "HEAD");

    const a = resolveActor({ cwd: first });
    const b = resolveActor({ cwd: second });

    expect(a).not.toBe(b);
    expect(a).not.toContain("HEAD");
    expect(b).not.toContain("HEAD");
  });

  it("gives two linked worktrees distinguishable actors", () => {
    // The whole point of ADR-007. The worktree path alone would also
    // distinguish these, but the branch is what survives the worktree being
    // removed and the path being recycled.
    const r = repo();
    const one = r.addWorktree("feature/one");
    const two = r.addWorktree("feature/two");

    const a = resolveActor({ cwd: one });
    const b = resolveActor({ cwd: two });

    expect(a).toBe(`feature/one @ ${one}`);
    expect(b).toBe(`feature/two @ ${two}`);
    expect(a).not.toBe(b);
  });

  it("keeps the branch and the path distinguishable in one string", () => {
    // One column, but the pair must still be readable as two parts — the
    // separator is the only thing making that true.
    const r = repo();
    const [branch, path] = resolveActor({ cwd: r.dir }).split(" @ ");

    expect(branch).toBe("main");
    expect(path).toBe(r.dir);
  });

  it("falls back to the current directory where there is no work tree", () => {
    // `rev-parse --show-toplevel` exits 128 inside a .git directory while
    // --git-common-dir succeeds there, so the store resolves and the write
    // proceeds. Letting this throw would turn a working invocation into a
    // failure at the moment it tried to record who did it.
    const r = repo();
    const insideGitDir = join(r.dir, ".git");

    expect(resolveActor({ cwd: insideGitDir })).toBe(`main @ ${insideGitDir}`);
  });

  it("refuses outside a git repository rather than inventing an actor", () => {
    const plain = createNonRepoDir();
    cleanups.push(() => plain.cleanup());

    try {
      resolveActor({ cwd: plain.dir });
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("validation");
      expect(error.message).toMatch(/not (a|inside a) git repository/i);
    }
  });
});

describe("createActorResolver", () => {
  it.runIf(onPosix)("does not shell out until it is called", () => {
    // Resolved eagerly, every read-only command would pay for two subprocess
    // spawns to record an actor it never writes.
    const r = repo();
    const counting = countingGit();

    const actor = createActorResolver({ cwd: r.dir, env: counting.env });
    expect(counting.calls()).toEqual([]);

    actor();
    expect(counting.calls().length).toBeGreaterThan(0);
  });

  it.runIf(onPosix)("resolves at most once however many times it is called", () => {
    const r = repo();
    const counting = countingGit();
    const actor = createActorResolver({ cwd: r.dir, env: counting.env });

    const results = [actor(), actor(), actor(), actor()];

    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe(`main @ ${r.dir}`);
    // One resolution, not four. The count itself is the assertion: the
    // returned value is identical either way.
    expect(counting.calls()).toHaveLength(2);
  });

  it.runIf(onPosix)("costs one rev-parse and one symbolic-ref on a normal branch", () => {
    // ADR-007's stated cost. A third call would mean the detached-HEAD
    // fallback is running when it should not.
    const r = repo();
    const counting = countingGit();

    createActorResolver({ cwd: r.dir, env: counting.env })();

    const calls = counting.calls();
    expect(calls.filter((c) => c.includes("symbolic-ref"))).toHaveLength(1);
    expect(calls.filter((c) => c.includes("rev-parse"))).toHaveLength(1);
  });

  it("gives two resolvers independent caches", () => {
    // The trap this exists to avoid: memoising at module scope. `runCli`
    // builds a fresh context per test inside one worker process, so a
    // module-level cache would leak one test's branch into the next one's
    // assertions — and the failure would look like a flaky test rather than a
    // cache bug.
    const r = repo();
    const other = r.addWorktree("feature/separate");

    const first = createActorResolver({ cwd: r.dir });
    const second = createActorResolver({ cwd: other });

    expect(second()).toBe(`feature/separate @ ${other}`);
    expect(first()).toBe(`main @ ${r.dir}`);
    expect(first()).not.toBe(second());
  });

  it("reports the failure on every call, not only the first", () => {
    // Caching a thrown error as `undefined` and then returning it would put a
    // literal "undefined" into the actor column of every subsequent write.
    const plain = createNonRepoDir();
    cleanups.push(() => plain.cleanup());
    const actor = createActorResolver({ cwd: plain.dir });

    expect(() => actor()).toThrowError(/not (a|inside a) git repository/i);
    expect(() => actor()).toThrowError(/not (a|inside a) git repository/i);
  });
});

describe("createIdentityResolver", () => {
  it.runIf(onPosix)("resolves worktree and branch once each and reuses the pair", () => {
    const r = repo();
    const counting = countingGit();
    const identity = createIdentityResolver({ cwd: r.dir, env: counting.env });

    const first = identity();
    const second = identity();

    expect(first.worktree).toBe(r.dir);
    expect(second.worktree).toBe(r.dir);
    expect(first.branch()).toBe("main");
    expect(second.branch()).toBe("main");
    // One rev-parse for the worktree, one symbolic-ref for the branch — not
    // four, however many times identity() and branch() are each called.
    expect(counting.calls()).toHaveLength(2);
  });

  it.runIf(onPosix)("does not spawn for the branch until something reads it", () => {
    // The split this task exists for: asking for the worktree alone — the
    // presence key — must not cost the branch's spawn too.
    const r = repo();
    const counting = countingGit();
    const identity = createIdentityResolver({ cwd: r.dir, env: counting.env });

    const resolved = identity();
    expect(resolved.worktree).toBe(r.dir);
    expect(counting.calls()).toHaveLength(1);
    expect(counting.calls()[0]).toContain("rev-parse");

    expect(resolved.branch()).toBe("main");
    expect(counting.calls()).toHaveLength(2);
    expect(counting.calls().some((call) => call.includes("symbolic-ref"))).toBe(true);
  });

  it("keeps two store contexts' identities independent", () => {
    // The same trap createActorResolver's own test guards against: a
    // module-level cache would leak one context's identity into another's
    // assertions. Exercised through openStore, since that is where each
    // context's resolver is actually born.
    const r = repo();
    const other = r.addWorktree("feature/separate");

    const a = openStore(r.dir, { createIfMissing: true });
    const b = openStore(other);
    cleanups.push(() => {
      a.store.close();
      b.store.close();
    });

    expect(a.store.identity().worktree).toBe(r.dir);
    expect(b.store.identity().worktree).toBe(other);
    expect(a.store.identity().branch()).toBe("main");
    expect(b.store.identity().branch()).toBe("feature/separate");
    expect(a.store.actor()).toBe(`main @ ${r.dir}`);
    expect(b.store.actor()).toBe(`feature/separate @ ${other}`);
  });
});

describe("composing the actor string from identity", () => {
  it.runIf(onPosix)("composes the actor string from the same resolution", () => {
    const r = repo();
    const counting = countingGit();
    const { store } = openStore(r.dir, { createIfMissing: true, env: counting.env });
    cleanups.push(() => store.close());
    // openStore already spent one spawn locating the store itself; the
    // baseline isolates identity's own two from that unrelated cost.
    const baseline = counting.calls().length;

    const actorString = store.actor();
    expect(counting.calls()).toHaveLength(baseline + 2);

    const identity = store.identity();
    // identity() shares actor()'s own resolution — asking again must not
    // spawn again.
    expect(counting.calls()).toHaveLength(baseline + 2);
    expect(actorString).toBe(`${identity.branch()} @ ${identity.worktree}`);
    expect(counting.calls()).toHaveLength(baseline + 2);
  });

  it("keeps the actor string identical to the fused resolver's output", () => {
    const r = repo();
    const fused = resolveActor({ cwd: r.dir });

    const { store } = openStore(r.dir, { createIfMissing: true });
    cleanups.push(() => store.close());

    expect(store.actor()).toBe(fused);
  });
});
