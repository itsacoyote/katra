/**
 * The shared git subprocess layer.
 *
 * Most of what this module does is already exercised through
 * `resolveStoreLocation` in `locate.test.ts` — the error taxonomy, the
 * too-old-git message, the broken-worktree passthrough. What is tested here is
 * the part no behavioural test can reach: that this stays the *only* place
 * katra spawns anything.
 */

import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findGh, findGit, runGh, runGit } from "../../src/core/git.js";
import { createGitRepo, createNonRepoDir } from "../helpers/fixture.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const onPosix = process.platform !== "win32";

/** A raw carriage return — built via `fromCharCode`, never typed literally. */
const CR = String.fromCharCode(13);

/** Writes an executable `#!/bin/sh name` stub into `dir` and returns its path. */
function writeExecutableStub(dir: string, name: string, body: string): string {
  const script = join(dir, name);
  writeFileSync(script, `#!/bin/sh\n${body}`, "utf8");
  chmodSync(script, 0o755);
  return script;
}

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
    const script = writeExecutableStub(dir.dir, "git", "echo fake\n");

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
  const root = fileURLToPath(new URL("../../src", import.meta.url));
  const allowedSpawn = "core/git.ts";
  // createRequire (`node:module`) synthesizes a CommonJS `require()` inside
  // ESM — a known way to obtain a module without a static `import` a naive
  // scanner might rely on. This scanner reads raw text rather than parsing
  // imports, so it is not actually blind to that: a `require("child_process")`
  // argument still trips the `child_process` alternative in `spawning` below
  // regardless of how `require` was obtained. What is worth keeping to
  // exactly one, audited, unrelated file is the *capability* itself —
  // `version.ts`'s read of package.json's own version at load time, nothing
  // to do with spawning.
  const allowedCreateRequire = "version.ts";

  // Comments stripped: several modules *explain* the rule, and matching
  // their prose would fail on the documentation rather than the code.
  const code = (source: string): string =>
    source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/[^\n]*/g, "");

  // `child_process` (bare — `\b` already sits at the ":" boundary, so this
  // matches both "node:child_process" and a prefix-less "child_process")
  // covers every function this module could call by simply requiring the
  // module at all. `execFile`/`fork(` have no colliding name elsewhere in
  // this codebase and are matched as bare words/calls; `spawn`/`spawnSync`
  // are call-anchored for symmetry. `exec(` is deliberately NOT a bare
  // `\bexec\(`: `RegExp.prototype.exec` and better-sqlite3's
  // `Database.prototype.exec` are both named `exec` and are called all over
  // this codebase (`core/clock.ts`, `core/refs/parse.ts`,
  // `core/beads/mapping.ts`, `core/db/migrate.ts`) — a bare pattern would
  // flag every one of them. The negative lookbehind for `.` excludes exactly
  // those method calls while still catching child_process's own bare,
  // unqualified `exec(cmd, cb)`.
  const spawning =
    /\bchild_process\b|\bexecFileSync\b|\bexecFile\b|\bexecSync\b|(?<!\.)\bexec\(|\bspawn(?:Sync)?\(|\bfork\(/;
  const dynamicRequire = /\bcreateRequire\b/;
  // Wrapper libraries that shell out under a friendlier API — execa/zx/
  // shelljs/node-pty all spawn processes internally, cross-spawn is the
  // Windows-shim `spawn` itself ships on top of, and simple-git shells out
  // to git the same way this module does deliberately in exactly one place.
  // Reaching for any of these reopens the door findGit/findGh close, one
  // layer removed — checked against source text below AND against
  // package.json's own dependency names, so *adding* one is caught even
  // before anything imports it.
  const thirdPartySpawner = /\b(execa|zx|shelljs|cross-spawn|node-pty|simple-git)\b/;
  // .ts/.tsx/.cts/.mts — every TypeScript source extension the compiler
  // recognizes, not just the plain ".ts" the original sweep checked.
  const sourceExtension = /\.[cm]?tsx?$/;

  it("declares no third-party process-spawning wrapper as a dependency", () => {
    const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    // devDependencies too: a test file can spawn a process exactly as easily
    // as source can, and this module's own tests are the proof — they shell
    // out to real git/gh stubs constantly.
    const declared = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];

    expect(declared.filter((name) => thirdPartySpawner.test(name))).toEqual([]);
  });

  it("its spawning pattern catches a bare exec( call without flagging RegExp/Database .exec(", () => {
    // The probe this widening exists to pass: child_process's own async,
    // shell-string `exec(cmd, cb)` has no Sync suffix and no distinguishing
    // prefix, so a pattern that only matched execFileSync/execSync/spawn
    // would miss it entirely.
    expect(spawning.test('exec("rm -rf /", cb);')).toBe(true);
    // And the reason it cannot be a bare `\bexec\(`: these are the real,
    // legitimate calls already living in this codebase.
    expect(spawning.test("PATTERN.exec(input)")).toBe(false);
    expect(spawning.test("db.exec(sql)")).toBe(false);
  });

  it("is the only module under src that spawns, dynamically requires, or reaches for a third-party spawner", () => {
    // Structural, because review vigilance already failed once: `findGit`'s
    // absolute-path lookup is F1's fix for a real Windows PATH-shadowing
    // finding, and a second `execFileSync("git", …)` written for the actor
    // would silently reopen it on every event write.
    //
    // A behavioural test cannot catch that — the copy would work perfectly on
    // the CI matrix and be wrong only in the repository of whoever gets
    // attacked. So this asserts the shape instead: one door, and everything
    // else goes through it.
    const spawnOffenders: string[] = [];
    const createRequireOffenders: string[] = [];
    const thirdPartyOffenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!sourceExtension.test(entry.name)) continue;
        const rel = relative(root, full).replaceAll("\\", "/");
        const stripped = code(readFileSync(full, "utf8"));
        if (rel !== allowedSpawn && spawning.test(stripped)) spawnOffenders.push(rel);
        if (rel !== allowedCreateRequire && dynamicRequire.test(stripped)) {
          createRequireOffenders.push(rel);
        }
        if (thirdPartySpawner.test(stripped)) thirdPartyOffenders.push(rel);
      }
    };
    walk(root);

    expect(spawnOffenders).toEqual([]);
    expect(createRequireOffenders).toEqual([]);
    expect(thirdPartyOffenders).toEqual([]);

    // A guard on the guard: if a regex broke, the sweep above would pass by
    // finding nothing anywhere. Both allowed modules must still match theirs.
    expect(spawning.test(code(readFileSync(join(root, allowedSpawn), "utf8")))).toBe(true);
    expect(dynamicRequire.test(code(readFileSync(join(root, allowedCreateRequire), "utf8")))).toBe(
      true,
    );
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
    //
    // Without the chdir below, `join("tools", "git")` resolves against
    // whatever directory the test runner happens to be in — which has no
    // "tools/git" either way, so the assertion would pass even with the
    // `!isAbsolute` guard deleted. Changing into the fixture directory makes
    // the relative path resolve to a real, existing file the guard has to
    // actively refuse — provable by mutation, not just by construction.
    const dir = createNonRepoDir();
    cleanups.push(() => dir.cleanup());
    const bin = join(dir.dir, "tools");
    mkdirSync(bin, { recursive: true });
    const planted = writeExecutableStub(bin, "git", "echo hijacked\n");

    const previousCwd = process.cwd();
    process.chdir(dir.dir);
    // LIFO: this must pop — and restore cwd — before dir.cleanup() removes
    // the directory this process is sitting in.
    cleanups.push(() => process.chdir(previousCwd));

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

describe("findGh", () => {
  it.runIf(onPosix)("finds gh in a directory it was given, absolute, and not elsewhere", () => {
    const dir = createNonRepoDir();
    cleanups.push(() => dir.cleanup());
    const script = writeExecutableStub(dir.dir, "gh", "echo fake\n");

    const found = findGh({ PATH: dir.dir });

    expect(found).toBe(script);
    expect(isAbsolute(found ?? "")).toBe(true);
  });

  it("returns undefined when PATH holds no gh rather than guessing", () => {
    const empty = createNonRepoDir();
    cleanups.push(() => empty.cleanup());

    expect(findGh({ PATH: empty.dir })).toBeUndefined();
    expect(findGh({})).toBeUndefined();
  });

  it.runIf(onPosix)("skips a relative PATH entry rather than resolving it", () => {
    // Same discipline — and same chdir requirement — as findGit's own
    // relative-entry test above: a bare `"gh"` resolved from a relative PATH
    // entry is the Windows PATH-shadowing finding all over again, just for
    // the second binary, and without the chdir the relative path never
    // resolves to anything real regardless of the guard.
    const dir = createNonRepoDir();
    cleanups.push(() => dir.cleanup());
    const bin = join(dir.dir, "tools");
    mkdirSync(bin, { recursive: true });
    const planted = writeExecutableStub(bin, "gh", "echo hijacked\n");

    const previousCwd = process.cwd();
    process.chdir(dir.dir);
    cleanups.push(() => process.chdir(previousCwd));

    expect(findGh({ PATH: "tools" })).toBeUndefined();
    expect(findGh({ PATH: "." })).toBeUndefined();
    expect(findGh({ PATH: bin })).toBe(planted);
  });

  it.runIf(onPosix)(
    "skips an unexecutable candidate and keeps walking to a later PATH entry",
    () => {
      // A mode-000 file at the right name is not a "found" — resolveOnPath
      // keeps walking past it, the same way a shell's own PATH lookup would,
      // so a decoy earlier on PATH cannot shadow the real binary later on it.
      const blockedDir = createNonRepoDir();
      cleanups.push(() => blockedDir.cleanup());
      const blocked = writeExecutableStub(blockedDir.dir, "gh", "echo should-not-run\n");
      chmodSync(blocked, 0o000);

      const realDir = createNonRepoDir();
      cleanups.push(() => realDir.cleanup());
      const real = writeExecutableStub(realDir.dir, "gh", "echo real\n");

      const found = findGh({ PATH: `${blockedDir.dir}${delimiter}${realDir.dir}` });

      expect(found).toBe(real);
    },
  );
});

describe("runGh", () => {
  it("reports gh-not-available without throwing when gh is absent from PATH", () => {
    const empty = createNonRepoDir();
    cleanups.push(() => empty.cleanup());

    const result = runGh({ PATH: empty.dir }, ["api", "repos/x/y/issues/1"]);

    expect(result).toEqual({ ok: false, reason: "gh-not-available" });
  });

  it.runIf(onPosix)("classifies exit 4 as gh-unauthenticated", () => {
    // Probed against the real `gh` CLI (GH_TOKEN='' + an empty GH_CONFIG_DIR):
    // exit 4 is the one unambiguous code — no credentials presented at all.
    const dir = createNonRepoDir();
    cleanups.push(() => dir.cleanup());
    writeExecutableStub(dir.dir, "gh", "exit 4\n");

    const result = runGh({ PATH: dir.dir }, ["api", "repos/x/y/issues/1"]);

    expect(result).toEqual({ ok: false, reason: "gh-unauthenticated" });
  });

  it.runIf(onPosix)("classifies exit 1 with a 404 stdout body as not-found", () => {
    // Probed real: `gh api` on a nonexistent repo exits 1 with the GitHub API's
    // own JSON error body on stdout, `"status":"404"` included.
    const dir = createNonRepoDir();
    cleanups.push(() => dir.cleanup());
    writeExecutableStub(
      dir.dir,
      "gh",
      'echo \'{"message":"Not Found","documentation_url":"https://docs.github.com/rest","status":"404"}\'\nexit 1\n',
    );

    const result = runGh({ PATH: dir.dir }, ["api", "repos/x/y/issues/1"]);

    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  it.runIf(onPosix)(
    "classifies exit 1 with a pretty-printed CRLF 401 body as bad-credentials",
    () => {
      // Probed real: gh's pretty-printed error body for a rejected token uses
      // CRLF line endings, not bare LF. JSON.parse tolerates that as ordinary
      // whitespace — this pins that readJsonHttpStatus actually does, rather
      // than something that only happens to work on the compact 404 shape.
      const dir = createNonRepoDir();
      cleanups.push(() => dir.cleanup());
      const jsonBody =
        `{${CR}\n` +
        `  "message": "Bad credentials",${CR}\n` +
        `  "documentation_url": "https://docs.github.com/rest",${CR}\n` +
        `  "status": "401"${CR}\n` +
        `}`;
      // `printf %s` never interprets its argument — the CRLF bytes above are
      // already real, so nothing here depends on the stub shell's own
      // backslash-escape handling.
      writeExecutableStub(dir.dir, "gh", `printf %s '${jsonBody}'\nexit 1\n`);

      const result = runGh({ PATH: dir.dir }, ["api", "repos/x/y"]);

      expect(result).toEqual({ ok: false, reason: "bad-credentials" });
    },
  );

  it.runIf(onPosix)("classifies exit 1 with an 'error connecting' stderr as network", () => {
    // Probed real: pointing gh at an unreachable host exits 1 with
    // "error connecting to <host>" on stderr and nothing on stdout.
    const dir = createNonRepoDir();
    cleanups.push(() => dir.cleanup());
    writeExecutableStub(
      dir.dir,
      "gh",
      "echo 'error connecting to api.github.invalid' 1>&2\n" +
        "echo 'check your internet connection or https://githubstatus.com' 1>&2\n" +
        "exit 1\n",
    );

    const result = runGh({ PATH: dir.dir }, ["api", "repos/x/y/issues/1"]);

    expect(result).toEqual({ ok: false, reason: "network" });
  });

  it.runIf(onPosix)("classifies an unrecognized exit 1 shape as malformed-response", () => {
    // A shape none of the probed branches match — gh itself rejecting a bad
    // invocation before ever reaching the API, for instance — must still
    // resolve to a fixed reason rather than falling through unhandled.
    const dir = createNonRepoDir();
    cleanups.push(() => dir.cleanup());
    writeExecutableStub(dir.dir, "gh", "echo 'unknown flag: --bogus' 1>&2\nexit 1\n");

    const result = runGh({ PATH: dir.dir }, ["api", "--bogus"]);

    expect(result).toEqual({ ok: false, reason: "malformed-response" });
  });

  it.runIf(onPosix)("classifies an exceeded maxBuffer as malformed-response, fast", () => {
    const dir = createNonRepoDir();
    cleanups.push(() => dir.cleanup());
    // 2 MB, comfortably over the 1 MiB maxBuffer. `yes`/`head` are external
    // binaries, so the real PATH is appended after the stub directory the
    // same way the timeout test below resolves `sleep`.
    writeExecutableStub(dir.dir, "gh", "yes x | head -c 2000000\n");
    const env = { PATH: `${dir.dir}${delimiter}${process.env.PATH ?? ""}` };

    const start = Date.now();
    const result = runGh(env, ["api", "repos/x/y"]);
    const elapsed = Date.now() - start;

    expect(result).toEqual({ ok: false, reason: "malformed-response" });
    // "Fast" pins that this is maxBuffer firing immediately, not the 5s
    // execFileSync timeout also happening to classify the same way.
    expect(elapsed).toBeLessThan(2000);
  });

  it.runIf(onPosix)("classifies a self-signaled crash as malformed-response, not timeout", () => {
    // `signal !== null` used to be the entire timeout check — a crash also
    // sets `signal` (SIGSEGV) without `code` ever being `ETIMEDOUT`, which
    // the old check would have misread as a timeout.
    const dir = createNonRepoDir();
    cleanups.push(() => dir.cleanup());
    writeExecutableStub(dir.dir, "gh", "kill -SEGV $$\n");

    const result = runGh({ PATH: dir.dir }, ["api", "repos/x/y"]);

    expect(result).toEqual({ ok: false, reason: "malformed-response" });
  });

  it.runIf(onPosix)(
    "SIGKILLs a stub that outlives the timeout and reports timeout, in bounded time",
    () => {
      const dir = createNonRepoDir();
      cleanups.push(() => dir.cleanup());
      writeExecutableStub(dir.dir, "gh", "sleep 30\n");
      // `sleep` is an external binary, not a shell builtin, so the stub's own
      // PATH must still resolve it — the real PATH is appended after the stub
      // directory so `gh` itself keeps resolving to the fake ahead of any real
      // one that might also be installed.
      const env = { PATH: `${dir.dir}${delimiter}${process.env.PATH ?? ""}` };

      const start = Date.now();
      const result = runGh(env, ["api", "repos/x/y/issues/1"]);
      const elapsed = Date.now() - start;

      expect(result).toEqual({ ok: false, reason: "timeout" });
      // Bounded, not merely "eventually returned": proves the process was
      // actually killed at the ~5s configured timeout rather than left to run
      // out its full 30s sleep in the background.
      expect(elapsed).toBeGreaterThanOrEqual(4500);
      expect(elapsed).toBeLessThan(20_000);
    },
  );

  it.runIf(onPosix)(
    "classifies ETIMEDOUT with a null signal as timeout (grandchild holds stdout open)",
    () => {
      const dir = createNonRepoDir();
      cleanups.push(() => dir.cleanup());
      const pidFile = join(dir.dir, "grandchild.pid");
      // The immediate child backgrounds a grandchild that inherits the stdout
      // pipe and holds it open well past the timeout, then exits cleanly
      // itself — nothing left for SIGKILL to actually terminate. execFileSync
      // still reports ETIMEDOUT (the wall clock fired waiting for stdout to
      // close) but signal comes back null — probed real, and exactly why
      // classification keys off `code`, never `signal`.
      writeExecutableStub(dir.dir, "gh", `(sleep 6 & echo $! > ${pidFile})\nexit 0\n`);
      cleanups.push(() => {
        try {
          const pid = Number(readFileSync(pidFile, "utf8").trim());
          if (Number.isInteger(pid)) process.kill(pid, "SIGKILL");
        } catch {
          // Already gone, or the file was never written — nothing to clean up.
        }
      });
      // `sleep` is an external binary the grandchild needs to actually resolve
      // and run for the full 6s — without the real PATH appended, the shell
      // fails to find it, the grandchild exits immediately, and the pipe
      // closes right away instead of staying open past the timeout.
      const env = { PATH: `${dir.dir}${delimiter}${process.env.PATH ?? ""}` };

      const result = runGh(env, ["api", "repos/x/y/issues/1"]);

      expect(result).toEqual({ ok: false, reason: "timeout" });
    },
  );

  it.runIf(onPosix)(
    "forces both GH_ overrides to 1 and pins cwd to tmpdir(), even when the caller's env/cwd differ",
    () => {
      // GH_PROMPT_DISABLED and GH_NO_UPDATE_NOTIFIER are runGh's own
      // hardening — always forced, not merely defaulted, so a caller-supplied
      // "0" must still lose. cwd is pinned the same way: an ambient
      // directory is never something this call should depend on.
      const dir = createNonRepoDir();
      cleanups.push(() => dir.cleanup());
      writeExecutableStub(
        dir.dir,
        "gh",
        'echo "GH_PROMPT_DISABLED=$GH_PROMPT_DISABLED"\n' +
          'echo "GH_NO_UPDATE_NOTIFIER=$GH_NO_UPDATE_NOTIFIER"\n' +
          'echo "PWD=$(pwd)"\n',
      );
      // chdir into the fixture first so the cwd pin is discriminating: without
      // this, the test runner's own ambient cwd could coincidentally already
      // be outside tmpdir() (or, on a system where it happens to sit under
      // tmpdir(), inside it) and the assertion would not actually prove
      // runGh set cwd at all — provable by mutation, the same discipline the
      // relative-PATH tests above use.
      const previousCwd = process.cwd();
      process.chdir(dir.dir);
      cleanups.push(() => process.chdir(previousCwd));

      const result = runGh(
        { PATH: dir.dir, GH_PROMPT_DISABLED: "0", GH_NO_UPDATE_NOTIFIER: "0" },
        [],
      );

      expect(result).toEqual({
        ok: true,
        stdout: `GH_PROMPT_DISABLED=1\nGH_NO_UPDATE_NOTIFIER=1\nPWD=${realpathSync.native(tmpdir())}`,
      });
    },
  );

  it.runIf(onPosix)(
    "never forwards a caller env var outside the allowlist to the spawned process",
    () => {
      // The allowlist, not a full `{ ...env }` spread, is what keeps a
      // secret like LINEAR_API_KEY (F8's other provider's own credential)
      // away from a `gh` invocation entirely.
      const dir = createNonRepoDir();
      cleanups.push(() => dir.cleanup());
      writeExecutableStub(dir.dir, "gh", 'echo "LINEAR_API_KEY=[$LINEAR_API_KEY]"\n');

      const result = runGh({ PATH: dir.dir, LINEAR_API_KEY: "sentinel-should-not-leak" }, []);

      expect(result).toEqual({ ok: true, stdout: "LINEAR_API_KEY=[]" });
    },
  );

  it.runIf(onPosix)("does not mutate the env object it was given", () => {
    const dir = createNonRepoDir();
    cleanups.push(() => dir.cleanup());
    writeExecutableStub(dir.dir, "gh", "exit 0\n");
    const env = { PATH: dir.dir };
    const original = { ...env };

    runGh(env, []);

    expect(env).toEqual(original);
  });
});
