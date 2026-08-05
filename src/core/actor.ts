/**
 * Who wrote an event or a note.
 *
 * ADR-007: an actor is `<branch> @ <absolute worktree path>`, stamped together
 * in one column. The branch answers "which piece of work did this?" where a
 * recycled or removed path cannot; the path distinguishes two worktrees on the
 * same branch. Neither alone is enough, and `user.name` is identical across
 * every parallel agent, which defeats the distinction events exist to draw.
 *
 * Two things here are timing, not formatting, and both matter more than they
 * look:
 *
 * - **Resolution happens outside `writeTx`.** Resolved inside, every write
 *   would hold the exclusive write lock across two subprocess spawns. The actor
 *   is threaded into a transaction the same way `now` is.
 * - **The memoised resolver is per-context, never module scope.** `runCli`
 *   builds a fresh context per test inside one worker process, so a
 *   module-level cache leaks one test's branch into the next one's assertions.
 *
 * A consequence worth stating: because every write path resolves before its
 * guards run, a command that is then *refused* — closing an already-closed
 * task, deleting an epic with children — still pays the two spawns. That is
 * the right trade, since the alternative is holding the write lock across
 * them on every command that succeeds. If it ever matters, hoist the guards
 * above the resolution rather than pushing the resolution back down.
 */

import { normalize } from "node:path";
import { runGit } from "./git.js";

export interface ActorOptions {
  /** Where the command is running. Any directory inside the worktree. */
  readonly cwd: string;
  /** Environment for the git invocations. Defaults to the current process's. */
  readonly env?: NodeJS.ProcessEnv;
}

/** Separates the two halves. One column, still readable as a pair. */
export const ACTOR_SEPARATOR = " @ ";

/**
 * The branch, or the short SHA when HEAD is detached.
 *
 * `symbolic-ref --quiet --short HEAD`, **not** `rev-parse --abbrev-ref HEAD`,
 * which is wrong twice over and was what an earlier draft of ADR-007
 * specified:
 *
 * - In a repository with no commits `--abbrev-ref` exits 128 (`ambiguous
 *   argument 'HEAD'`), so every write command would die in a freshly
 *   `git init`ed repo — exactly the cold-start path katra is for.
 *   `symbolic-ref` returns the branch name there.
 * - On a detached HEAD `--abbrev-ref` returns the literal string `HEAD`, so
 *   every detached worktree would stamp an identical actor. `symbolic-ref`
 *   exits 1 instead, which is a cleaner signal than matching a magic string.
 *
 * Both verified against real git rather than assumed.
 */
function resolveBranch(cwd: string, env: NodeJS.ProcessEnv): string {
  try {
    return runGit(cwd, env, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  } catch {
    // Detached. The short SHA is what git itself reports and stays truthful.
    return runGit(cwd, env, ["rev-parse", "--short", "HEAD"]);
  }
}

/**
 * The worktree root, or `cwd` where there is no work tree.
 *
 * Its own `rev-parse` rather than a flag added to the one that resolves the
 * store, despite what ADR-007's cost note suggests: `--show-toplevel` exits 128
 * inside a `.git` directory and in a bare repo, while `--git-common-dir`
 * succeeds in both. Merging them would turn a working invocation — the store
 * resolves fine from there — into a hard failure at the moment it tried to
 * record who did it.
 *
 * Normalised for the same reason `commonDir` is: git reports forward slashes on
 * Windows while the rest of katra produces the platform's own separators, and
 * an actor that spells its path differently per invocation is two identities.
 */
function resolveWorktree(cwd: string, env: NodeJS.ProcessEnv): string {
  try {
    return normalize(runGit(cwd, env, ["rev-parse", "--path-format=absolute", "--show-toplevel"]));
  } catch {
    return normalize(cwd);
  }
}

/**
 * Resolves the actor for `cwd`.
 *
 * Costs one `rev-parse` plus one `symbolic-ref` — and a second `rev-parse` only
 * when HEAD is detached. Throws katra's own "not a git repository" error
 * outside a repo rather than inventing an identity.
 */
export function resolveActor(options: ActorOptions): string {
  const env = options.env ?? process.env;
  // The branch first: outside a repository it is the call that fails, and
  // failing before asking for a path keeps the error the one about the repo.
  const branch = resolveBranch(options.cwd, env);
  return `${branch}${ACTOR_SEPARATOR}${resolveWorktree(options.cwd, env)}`;
}

/**
 * A resolver that runs at most once and only when asked.
 *
 * Lazy because a read-only command must not pay two subprocess spawns to
 * record an actor it never writes. One per `CliContext`; see the module note
 * above for why never at module scope.
 *
 * A failure is deliberately **not** cached: caching it as `undefined` and
 * returning that would put the literal string "undefined" into the actor column
 * of every subsequent write.
 */
export function createActorResolver(options: ActorOptions): () => string {
  let resolved: string | undefined;
  return () => {
    resolved ??= resolveActor(options);
    return resolved;
  };
}
