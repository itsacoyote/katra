/**
 * Where katra's store lives.
 *
 * The database sits under the repository's **git common dir** — the one
 * location every worktree of a repo resolves to identically. That is the whole
 * basis of cross-worktree coordination: two sessions in two worktrees must see
 * one backlog.
 *
 * Resolution always asks for the absolute path form. The bare
 * `--git-common-dir` flag returns three *different* strings for the same
 * location — `.git` from the repo root, `../.git` from a subdirectory, and an
 * absolute path from a linked worktree — so anything comparing or caching the
 * bare output would be wrong in two of the three cases.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { KatraException } from "../errors.js";

/** Directory katra owns inside the git common dir. */
export const STORE_DIR_NAME = "katra";
/** The database file itself. */
export const DB_FILE_NAME = "katra.db";
/** `--path-format` landed in git 2.31; nothing older can resolve the store. */
export const MINIMUM_GIT_VERSION = "2.31";

/** Something worth telling the user that is not fatal. */
export interface StoreWarning {
  readonly code: "ambient-git-dir";
  readonly message: string;
}

export interface StoreLocation {
  /** Absolute path to the git common dir shared by every worktree. */
  readonly commonDir: string;
  /** Absolute path to katra's directory inside it. */
  readonly storeDir: string;
  /** Absolute path to the database file. */
  readonly dbPath: string;
  /**
   * Non-fatal findings. Returned rather than printed: the core must not write
   * to a stream, both because that breaks its purity and because stray output
   * on stdout would corrupt `--json`. The CLI decides where these go.
   */
  readonly warnings: readonly StoreWarning[];
}

export interface LocateOptions {
  /** Environment for the git invocations. Defaults to the current process's. */
  readonly env?: NodeJS.ProcessEnv;
}

interface GitFailure {
  readonly stderr: string;
  readonly spawnFailed: boolean;
}

/** Runs `git` in `cwd`, returning stdout or a classified failure. */
function runGit(cwd: string, env: NodeJS.ProcessEnv, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw explainGitFailure(readFailure(error));
  }
}

function readFailure(error: unknown): GitFailure {
  const err = error as { stderr?: unknown; code?: unknown };
  const stderr = typeof err.stderr === "string" ? err.stderr : String(err.stderr ?? "");
  // A missing binary never reaches git, so there is no stderr to read — the
  // spawn itself fails. Distinguishing this keeps the user from seeing a Node
  // internals dump where a one-line "install git" belongs.
  const spawnFailed = err.code === "ENOENT";
  return { stderr, spawnFailed };
}

/** Turns a git failure into the most specific error we can justify. */
function explainGitFailure(failure: GitFailure): KatraException {
  const { stderr, spawnFailed } = failure;

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

  return new KatraException({
    code: "validation",
    message: `git failed while resolving the store location\n${stderr.trim()}`,
    field: "git",
    value: stderr.trim(),
  });
}

/**
 * Detects an ambient `GIT_DIR` / `GIT_COMMON_DIR` redirect.
 *
 * These variables silently point resolution at an unrelated repository and git
 * still exits 0, so exit status can never reveal it. Left unchecked, katra
 * would open a store belonging to a different project without a word.
 *
 * The check only runs when one of the variables is actually present, and it
 * must not fire for a linked worktree, whose common dir legitimately differs
 * from its own toplevel.
 */
function checkAmbientRedirect(
  cwd: string,
  env: NodeJS.ProcessEnv,
  commonDir: string,
): StoreWarning[] {
  const named = ["GIT_COMMON_DIR", "GIT_DIR"].filter((name) => env[name] !== undefined);
  if (named.length === 0) return [];

  const toplevel = runGit(cwd, env, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
  const gitDir = runGit(cwd, env, ["rev-parse", "--path-format=absolute", "--git-dir"]);

  const isOwnRepo = commonDir === join(toplevel, ".git");
  const isLinkedWorktree = gitDir.startsWith(join(commonDir, "worktrees"));
  if (isOwnRepo || isLinkedWorktree) return [];

  return [
    {
      code: "ambient-git-dir",
      message:
        `${named.join(" and ")} in the environment redirected katra's store to ` +
        `${commonDir}, which does not belong to the repository at ${toplevel}. ` +
        "Unset it if that was not deliberate — katra is reading a different project's tasks.",
    },
  ];
}

/**
 * Resolves where the store for the repository containing `cwd` lives.
 *
 * Works from the repo root, any subdirectory, and any linked worktree. Throws
 * a {@link KatraException} when the location cannot be determined, naming which
 * of the several possible causes applies.
 */
export function resolveStoreLocation(cwd: string, options: LocateOptions = {}): StoreLocation {
  const env = options.env ?? process.env;
  const commonDir = runGit(cwd, env, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const storeDir = join(commonDir, STORE_DIR_NAME);

  return {
    commonDir,
    storeDir,
    dbPath: join(storeDir, DB_FILE_NAME),
    warnings: checkAmbientRedirect(cwd, env, commonDir),
  };
}
