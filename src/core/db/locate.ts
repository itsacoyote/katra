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

import { join, normalize } from "node:path";
import type { StoreWarning } from "../contract.js";
import { runGit } from "../git.js";

export type { StoreWarning };

/** Directory katra owns inside the git common dir. */
export const STORE_DIR_NAME = "katra";
/** The database file itself. */
export const DB_FILE_NAME = "katra.db";

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

/**
 * Detects an ambient `GIT_DIR` / `GIT_COMMON_DIR` redirect.
 *
 * These variables silently point resolution at an unrelated repository and git
 * still exits 0, so exit status can never reveal it. Left unchecked, katra
 * would open a store belonging to a different project without a word.
 *
 * The check only runs when one of the variables is actually present, and it
 * asks the question directly: **would git resolve somewhere else without
 * them?** Anything else has to guess at the shape of a git dir, and the shapes
 * are not guessable — a plain clone's is `<toplevel>/.git`, a linked
 * worktree's lives under `worktrees/`, and a submodule's is
 * `<superproject>/.git/modules/<name>`. Comparing against `<toplevel>/.git`,
 * as this used to, reports a correctly-resolved submodule as a foreign repo.
 */
function checkAmbientRedirect(
  cwd: string,
  env: NodeJS.ProcessEnv,
  commonDir: string,
): StoreWarning[] {
  const named = ["GIT_COMMON_DIR", "GIT_DIR"].filter((name) => env[name] !== undefined);
  if (named.length === 0) return [];

  const clean: NodeJS.ProcessEnv = { ...env };
  for (const name of named) delete clean[name];

  let unredirected: string;
  try {
    // Normalised on both sides, or the comparison is separator-sensitive: git
    // reports forward slashes on Windows while `commonDir` was normalised by
    // the caller, so every invocation would look redirected.
    unredirected = normalize(
      runGit(cwd, clean, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    );
  } catch {
    // Without the variables this directory is not a repository at all, so they
    // are not redirecting resolution — they are the only reason it works here.
    // That is deliberate use, not an accident worth warning about.
    return [];
  }

  if (unredirected === commonDir) return [];

  // Only for the message. `--show-toplevel` fails wherever there is no work
  // tree — inside a `.git` directory, or in a bare repo — while
  // `--git-common-dir` succeeds there, so letting this throw would turn a
  // warning into a hard failure on invocations that used to work.
  let toplevel: string;
  try {
    toplevel = runGit(cwd, clean, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
  } catch {
    toplevel = cwd;
  }

  return [
    {
      code: "ambient-git-dir",
      message:
        `${named.join(" and ")} in the environment redirected katra's store to ` +
        `${commonDir}, which does not belong to the repository at ${toplevel} ` +
        `(that one resolves to ${unredirected}). ` +
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
  // Normalised to the platform's own separators. git reports forward slashes
  // even on Windows, while `join` below produces backslashes — so without this
  // `commonDir` and `dbPath` disagree, and `dbPath.startsWith(commonDir)` is
  // false for paths that are in fact nested. Every consumer comparing or
  // re-joining these would inherit that.
  const commonDir = normalize(
    runGit(cwd, env, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  );
  const storeDir = join(commonDir, STORE_DIR_NAME);

  return {
    commonDir,
    storeDir,
    dbPath: join(storeDir, DB_FILE_NAME),
    warnings: checkAmbientRedirect(cwd, env, commonDir),
  };
}
