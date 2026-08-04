/**
 * The one place katra runs git.
 *
 * Two callers need git: {@link ../db/locate.js resolveStoreLocation}, which
 * asks where the store lives, and actor resolution, which asks which branch and
 * worktree is writing. Both need the same thing from the subprocess layer — an
 * absolutely-resolved binary and katra's own error taxonomy — and the second
 * one arrived after the first, which is exactly when a codebase grows a
 * near-identical copy.
 *
 * That copy would be a security regression, not a style problem: see
 * {@link findGit} for what a bare `"git"` does on Windows. The guard test in
 * `test/core/git.test.ts` asserts no other module under `src/` spawns a
 * process, so the copy cannot be written without failing the suite.
 *
 * Not re-exported from `src/index.ts`. It takes no store, but it names
 * `NodeJS.ProcessEnv`, and declarations are emitted per file — publishing it
 * would drag `@types/node` into `dist/index.d.ts` and break any consumer
 * compiling without `skipLibCheck`.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { KatraException } from "./errors.js";

/** `--path-format` landed in git 2.31; nothing older can resolve the store. */
export const MINIMUM_GIT_VERSION = "2.31";

interface GitFailure {
  readonly stderr: string;
  readonly spawnFailed: boolean;
  /** The invocation that failed, so an unclassified failure can name itself. */
  readonly args: readonly string[];
}

/**
 * Locates the `git` binary on `PATH`, as an absolute path.
 *
 * **Not just `"git"`.** On Windows, libuv resolves a bare program name by
 * looking in the *current directory first*, then `PATH` — POSIX `execvp` does
 * not. katra's whole premise is running inside arbitrary repositories, so a
 * repo containing `git.exe`, `git.cmd` or `git.bat` would have that file
 * executed with the user's privileges by every katra command. Passing a path
 * containing a separator makes libuv skip the cwd probe entirely.
 *
 * Returns undefined when nothing matches, so the caller raises katra's own
 * "git is not installed" error rather than a Node internals dump.
 */
export function findGit(env: NodeJS.ProcessEnv): string | undefined {
  const path = env.PATH ?? env.Path ?? "";
  if (path === "") return undefined;

  // PATHEXT is Windows' list of extensions an extensionless name can take.
  const suffixes =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext !== "")
      : [""];

  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    for (const suffix of suffixes) {
      const candidate = join(dir, `git${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Runs `git` in `cwd`, returning stdout or a classified failure. */
export function runGit(cwd: string, env: NodeJS.ProcessEnv, args: string[]): string {
  const git = findGit(env);
  if (git === undefined) {
    throw explainGitFailure({ stderr: "", spawnFailed: true, args });
  }

  try {
    return execFileSync(git, args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw explainGitFailure(readFailure(error, args));
  }
}

function readFailure(error: unknown, args: readonly string[]): GitFailure {
  const err = error as { stderr?: unknown; code?: unknown };
  const stderr = typeof err.stderr === "string" ? err.stderr : String(err.stderr ?? "");
  // A missing binary never reaches git, so there is no stderr to read — the
  // spawn itself fails. Distinguishing this keeps the user from seeing a Node
  // internals dump where a one-line "install git" belongs.
  const spawnFailed = err.code === "ENOENT";
  return { stderr, spawnFailed, args };
}

/** Turns a git failure into the most specific error we can justify. */
function explainGitFailure(failure: GitFailure): KatraException {
  const { stderr, spawnFailed, args } = failure;

  if (spawnFailed) {
    return new KatraException({
      code: "validation",
      message: "git could not be run: no `git` executable was found on PATH",
      field: "git",
      value: "ENOENT",
    });
  }

  if (/unknown (argument to )?--path-format|unknown option.*path-format/i.test(stderr)) {
    return new KatraException({
      code: "validation",
      message:
        `this git is too old: katra needs git ${MINIMUM_GIT_VERSION} or newer for ` +
        `\`rev-parse --path-format\`\n${stderr.trim()}`,
      field: "git",
      value: "path-format",
    });
  }

  // A broken worktree link and "no repository here" both say "not a git
  // repository", but they are different problems with different fixes, so the
  // more specific one is matched first and git's own text is passed through.
  if (/not a git repository:.*[/\\]worktrees[/\\]/i.test(stderr)) {
    return new KatraException({
      code: "validation",
      message:
        "this worktree's main repository is missing or has moved, so git cannot " +
        `resolve it\n${stderr.trim()}`,
      field: "worktree",
      value: stderr.trim(),
    });
  }

  if (/not a git repository/i.test(stderr)) {
    return new KatraException({
      code: "validation",
      message: `not inside a git repository\n${stderr.trim()}`,
      field: "cwd",
      value: stderr.trim(),
    });
  }

  // Names the invocation rather than guessing at its purpose. This module now
  // serves both store location and actor resolution, so a message asserting
  // either one would be wrong half the time.
  return new KatraException({
    code: "validation",
    message: `\`git ${args.join(" ")}\` failed\n${stderr.trim()}`,
    field: "git",
    value: stderr.trim(),
  });
}
