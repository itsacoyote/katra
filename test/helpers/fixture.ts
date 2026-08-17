/**
 * Throwaway git repositories for tests.
 *
 * katra resolves its store through the git common dir, and several acceptance
 * criteria are about real git behaviour across the repo root, a subdirectory,
 * and a linked worktree. Mocking git would test nothing, so tests run against
 * real repositories in real temp directories.
 *
 * `writeGitWrapper`/`isolatedNoGhEnv` (F8 T5) live here rather than in each
 * consuming test file: `feature.test.ts`'s `--json` sweep and
 * `refresh.test.ts`'s whole suite both need an environment with a real,
 * working `git` but no resolvable `gh` and no `LINEAR_API_KEY` — a single
 * copy is what keeps the two from drifting into two different definitions of
 * "isolated".
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findGit } from "../../src/core/git.js";

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

/**
 * Writes a `git` executable into `binDir` that `exec`s the real one — the
 * `with-store.test.ts` `countingGit` technique, extracted: every fixture in
 * this module that needs a working `git` on a deliberately narrowed `PATH`
 * (so some *other* binary, `gh` chief among them, is guaranteed absent)
 * shares this one wrapper rather than each writing its own copy of the same
 * three lines.
 *
 * `exec "$realGitPath" "$@"` needs no `PATH` lookup of its own — `$0`'s
 * shebang (`/bin/sh`, itself an absolute path the kernel resolves directly)
 * and `$realGitPath` (already absolute, from `findGit`) are both resolved
 * without consulting `PATH` at all, which is what lets this keep working
 * under a `PATH` containing nothing but `binDir` itself.
 */
export function writeGitWrapper(binDir: string): void {
  const real = findGit(process.env);
  if (real === undefined) throw new Error("no git on PATH to wrap");
  const script = join(binDir, "git");
  writeFileSync(script, `#!/bin/sh\nexec ${JSON.stringify(real)} "$@"\n`, "utf8");
  chmodSync(script, 0o755);
}

/**
 * An environment with a real, working `git` (via {@link writeGitWrapper})
 * but no resolvable `gh` and no `LINEAR_API_KEY` — what F8's `refresh`
 * sweep/suite entries run under, so a `--json` invocation can never reach a
 * real network call regardless of fixture ordering or what the machine
 * running the suite happens to have installed.
 *
 * `PATH` is **replaced**, not prefixed — unlike `countingGit`, which only
 * needs to intercept `git` and is happy to leave the rest of the real `PATH`
 * behind it. Prefixing here would still leave a real `gh`, if this machine
 * has one, reachable further down the same list; only a `PATH` containing
 * exactly one directory, holding nothing but a `git` wrapper, guarantees
 * `findGh` finds nothing no matter what else is installed.
 */
export function isolatedNoGhEnv(): { readonly env: NodeJS.ProcessEnv; cleanup(): void } {
  const bin = createNonRepoDir();
  writeGitWrapper(bin.dir);

  const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin.dir };
  delete env.LINEAR_API_KEY;

  return { env, cleanup: bin.cleanup };
}

/**
 * A PATH env whose `gh` is a stub answering every invocation with
 * `responseBody` — shared by refresh.test.ts and f8-feature.test.ts, the
 * same consolidation writeGitWrapper got one commit earlier.
 */
export /**
 * `isolatedNoGhEnv`, plus a `gh` on that same isolated `PATH` that always
 * answers `responseBody` verbatim, whatever it is asked — a fake CLI, not a
 * mock of `runGh`: this suite runs `refresh` through the real, in-process
 * CLI end to end, so the double has to be a real, spawnable executable, the
 * same technique `with-store.test.ts`'s `countingGit` uses for `git`.
 *
 * **A Node script, not a shell one.** A first version shelled out to `cat`/
 * `dirname` to read the response back from a sibling file — both external
 * commands, resolved via the child's own `PATH` at run time, which is
 * exactly the narrow, `gh`-excluding `PATH` this environment hands it. That
 * `PATH` has no `cat`/`dirname` on it either, so the script itself failed
 * to run and `refresh` read the empty/garbled result as `malformed-response`
 * — a real failure this exact suite hit once. The shebang points at
 * `process.execPath` (an absolute path, resolved by the kernel directly,
 * never by `PATH`), and the script body writes the response with nothing
 * but Node's own `process.stdout`, so no external command is on the
 * critical path at all.
 */
function stubbedGhEnv(responseBody: string): { readonly env: NodeJS.ProcessEnv; cleanup(): void } {
  const bin = createNonRepoDir();
  writeGitWrapper(bin.dir);

  const ghScript = join(bin.dir, "gh");
  writeFileSync(
    ghScript,
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(responseBody)});\n`,
    "utf8",
  );
  chmodSync(ghScript, 0o755);

  const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin.dir };
  delete env.LINEAR_API_KEY;

  return { env, cleanup: bin.cleanup };
}
