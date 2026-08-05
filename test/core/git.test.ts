/**
 * The shared git subprocess layer.
 *
 * Most of what this module does is already exercised through
 * `resolveStoreLocation` in `locate.test.ts` — the error taxonomy, the
 * too-old-git message, the broken-worktree passthrough. What is tested here is
 * the part no behavioural test can reach: that this stays the *only* place
 * katra spawns anything.
 */

import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findGit, runGit } from "../../src/core/git.js";
import { createGitRepo, createNonRepoDir } from "../helpers/fixture.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const onPosix = process.platform !== "win32";

describe("findGit", () => {
  it("returns a path with a directory separator, never the bare name", () => {
    // The whole point. On Windows libuv resolves a bare program name from the
    // current directory before PATH, so a repository shipping `git.exe` gets
    // it executed; a path containing a separator skips that probe.
    const found = findGit(process.env);

    expect(found).toBeDefined();
    expect(found).toMatch(/[/\\]/);
    expect(found).not.toBe("git");
  });

  it("returns undefined when PATH holds no git rather than guessing", () => {
    const empty = createNonRepoDir();
    cleanups.push(() => empty.cleanup());

    expect(findGit({ PATH: empty.dir })).toBeUndefined();
    expect(findGit({})).toBeUndefined();
  });

  it.runIf(onPosix)("finds git in a directory it was given and not elsewhere", () => {
    const dir = createNonRepoDir();
    cleanups.push(() => dir.cleanup());
    const script = join(dir.dir, "git");
    writeFileSync(script, "#!/bin/sh\necho fake\n", "utf8");
    chmodSync(script, 0o755);

    expect(findGit({ PATH: dir.dir })).toBe(script);
  });
});

describe("runGit", () => {
  it("returns trimmed stdout", () => {
    const repo = createGitRepo();
    cleanups.push(() => repo.cleanup());

    const out = runGit(repo.dir, process.env, ["rev-parse", "--is-inside-work-tree"]);

    expect(out).toBe("true");
  });

  it("names the invocation in an otherwise unclassified failure", () => {
    // This module serves both store location and actor resolution, so the
    // fallback message must not claim either purpose. It used to read "git
    // failed while resolving the store location", which would be a lie on
    // every actor stamp.
    const repo = createGitRepo();
    cleanups.push(() => repo.cleanup());

    expect(() =>
      runGit(repo.dir, process.env, ["rev-parse", "--verify", "refs/heads/nope"]),
    ).toThrowError(/`git rev-parse --verify refs\/heads\/nope` failed/);
  });
});

describe("the process-spawning boundary", () => {
  it("is the only module under src that spawns a subprocess", () => {
    // Structural, because review vigilance already failed once: `findGit`'s
    // absolute-path lookup is F1's fix for a real Windows PATH-shadowing
    // finding, and a second `execFileSync("git", …)` written for the actor
    // would silently reopen it on every event write.
    //
    // A behavioural test cannot catch that — the copy would work perfectly on
    // the CI matrix and be wrong only in the repository of whoever gets
    // attacked. So this asserts the shape instead: one door, and everything
    // else goes through it.
    const root = fileURLToPath(new URL("../../src", import.meta.url));
    const allowed = "core/git.ts";

    // Comments stripped: several modules *explain* the rule, and matching
    // their prose would fail on the documentation rather than the code.
    const code = (source: string): string =>
      source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/[^\n]*/g, "");
    const spawning = /node:child_process|\bexecFileSync\b|\bexecSync\b|\bspawnSync\b|\bspawn\(/;

    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const rel = relative(root, full).replaceAll("\\", "/");
        if (rel === allowed) continue;
        if (spawning.test(code(readFileSync(full, "utf8")))) offenders.push(rel);
      }
    };
    walk(root);

    expect(offenders).toEqual([]);

    // A guard on the guard: if the regex broke, the sweep above would pass by
    // finding nothing anywhere. The allowed module must still match it.
    expect(spawning.test(code(readFileSync(join(root, allowed), "utf8")))).toBe(true);
  });
});

describe("relative PATH entries", () => {
  it.runIf(onPosix)("skips a relative PATH entry rather than resolving it", () => {
    // The docstring promises an absolute path, and `join("tools", "git")` is
    // not one. `execFileSync` resolves a relative `file` against the `cwd` it
    // is handed — which `runGit` sets to the repository — so a repo shipping
    // `tools/git` would be executed. On Windows `join(".", "git.exe")`
    // collapses to a bare name, which is the exact input that makes libuv
    // probe the current directory first: F1's finding, reintroduced.
    const dir = createNonRepoDir();
    cleanups.push(() => dir.cleanup());
    const bin = join(dir.dir, "tools");
    mkdirSync(bin, { recursive: true });
    const planted = join(bin, "git");
    writeFileSync(planted, "#!/bin/sh\necho hijacked\n", "utf8");
    chmodSync(planted, 0o755);

    // Relative entries — including "." — must be ignored entirely.
    expect(findGit({ PATH: "tools" })).toBeUndefined();
    expect(findGit({ PATH: "." })).toBeUndefined();
    // The same directory given absolutely is honoured, so this is a rule about
    // relativity and not about the directory.
    expect(findGit({ PATH: bin })).toBe(planted);
  });

  it("returns an absolute path, not merely one containing a separator", () => {
    // The previous assertion was `toMatch(/[/\\]/)`, which `tools/git`
    // satisfies — so the guard could not catch the case above.
    const found = findGit(process.env);

    expect(found).toBeDefined();
    expect(isAbsolute(found ?? "")).toBe(true);
  });
});
