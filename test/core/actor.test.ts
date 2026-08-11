import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIdentityResolver, resolveActor } from "../../src/core/actor.js";
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

describe("createIdentityResolver", () => {
  it.runIf(onPosix)("does not shell out until identity() is called", () => {
    // createActorResolver's old guarantee, carried over: resolved eagerly,
    // every read-only command would pay for two subprocess spawns to record
    // an identity it never reads.
    const r = repo();
    const counting = countingGit();

    createIdentityResolver({ cwd: r.dir, env: counting.env });

    expect(counting.calls()).toEqual([]);
  });

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
    // The trap this exists to avoid: memoising at module scope. `runCli`
    // builds a fresh context per test inside one worker process, so a
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

  it("reports the branch failure on every call, not only the first", () => {
    // createActorResolver's old guarantee, carried over: caching a thrown
    // error as `undefined` and then returning it would put a literal
    // "undefined" into the actor column of every subsequent write.
    const plain = createNonRepoDir();
    cleanups.push(() => plain.cleanup());
    const identity = createIdentityResolver({ cwd: plain.dir });

    expect(() => identity().branch()).toThrowError(/not (a|inside a) git repository/i);
    expect(() => identity().branch()).toThrowError(/not (a|inside a) git repository/i);
  });
});

describe("composing the actor string from identity", () => {
  it.runIf(onPosix)("composes the actor string from the same resolution", () => {
    const r = repo();
    const counting = countingGit();
    const { store } = openStore(r.dir, { createIfMissing: true, env: counting.env });
    cleanups.push(() => store.close());
    // openStore's own presence bump (F4 T3, ADR-011) already resolves both
    // halves of the identity for a freshly created store: the row is absent,
    // so the bump writes, and writing needs the branch too. The baseline
    // below already carries that cost — one spawn for openStore's own
    // store-location lookup, plus the identity pair's rev-parse and
    // symbolic-ref.
    const baseline = counting.calls().length;

    const actorString = store.actor();
    // actor() and identity() reuse that same resolution with no further
    // spawns — the "no spawn doubling" presence's own docs promise.
    expect(counting.calls()).toHaveLength(baseline);

    const identity = store.identity();
    expect(counting.calls()).toHaveLength(baseline);
    expect(actorString).toBe(`${identity.branch()} @ ${identity.worktree}`);
    expect(counting.calls()).toHaveLength(baseline);
  });

  it("keeps the actor string identical to the fused resolver's output", () => {
    // A literal, not a second call to resolveActor: now that both sides fuse
    // through the same actorFromIdentity, comparing them to each other can no
    // longer disagree — the independent source of truth is ADR-007's format
    // itself, spelled out the way describe("resolveActor") pins it above.
    const r = repo();

    const { store } = openStore(r.dir, { createIfMissing: true });
    cleanups.push(() => store.close());

    expect(store.actor()).toBe(`main @ ${r.dir}`);
  });
});
