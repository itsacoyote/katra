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
 *
 * F4 splits the same two git calls into their own laziness. Presence's
 * heartbeat is worktree-keyed and must never pay for the branch's spawn just
 * to bump `last_seen`, so {@link createIdentityResolver} exposes `Identity` —
 * the worktree resolved eagerly, the branch behind its own thunk.
 * {@link resolveActor} and {@link ./store.js OpenStore}'s default `actor` both
 * fuse the same resolution through {@link actorFromIdentity} rather than
 * resolving the pair a second time, so nothing here spawns git twice for one
 * invocation or re-parses the fused string back into its parts.
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
 * The worktree and the branch as two independently-resolvable parts of one
 * identity, rather than the single fused string {@link resolveActor} produces.
 *
 * `worktree` is a plain, already-resolved string, not a getter — presence
 * (F4 T3) keys its heartbeat on it directly, and a getter that spawns git
 * would trip a plain object spread or `JSON.stringify` the moment presence
 * tried to log or compare one. `branch` stays a thunk, matching the
 * `actor: () => string` convention already in this file: the heartbeat's
 * freshness check is worktree-keyed and never touches the branch, so a
 * command that only bumps presence must not pay for a `symbolic-ref` it never
 * reads.
 */
export interface Identity {
  readonly worktree: string;
  branch(): string;
}

/**
 * A resolver that splits the same two git calls {@link resolveActor} makes
 * into their own laziness.
 *
 * The worktree resolves the moment `identity()` is called at all — every
 * consumer needs it, presence chiefly, whether or not it ever needs the
 * branch. The branch resolves (and memoises) only when a consumer calls
 * `identity().branch()` — the claim/release CAS, chiefly, which needs it only
 * to write.
 *
 * Memoised per instance — one per `CliContext`, one per `OpenStore` that
 * builds its own — never at module scope: `runCli` builds a fresh context per
 * test inside one worker process, so a module-level cache would leak one
 * test's identity into the next one's assertions.
 *
 * Neither half caches a failure: `worktree ??=` and `branch ??=` only commit
 * the assignment once the git call actually returns, so a throw leaves the
 * slot empty and the next call retries rather than handing back a cached
 * `undefined`.
 */
export function createIdentityResolver(options: ActorOptions): () => Identity {
  const env = options.env ?? process.env;
  let worktree: string | undefined;
  let branch: string | undefined;

  return () => {
    worktree ??= resolveWorktree(options.cwd, env);
    return {
      worktree,
      branch: () => {
        branch ??= resolveBranch(options.cwd, env);
        return branch;
      },
    };
  };
}

/**
 * Fuses an already-resolved {@link Identity} into ADR-007's actor string.
 *
 * Takes the resolved parts rather than an `ActorOptions`/`cwd`, so a caller
 * that already has an identity — {@link ./store.js OpenStore}'s default
 * `actor`, chiefly — never spawns git a second time for the same pair and
 * never re-parses the fused string back into the parts it started from.
 */
export function actorFromIdentity(identity: Identity): string {
  return `${identity.branch()}${ACTOR_SEPARATOR}${identity.worktree}`;
}

/**
 * Resolves the actor for `cwd` in one call.
 *
 * Costs one `rev-parse` plus one `symbolic-ref` — and a second `rev-parse` only
 * when HEAD is detached. Throws katra's own "not a git repository" error
 * outside a repo rather than inventing an identity.
 *
 * Composed from {@link createIdentityResolver} rather than calling
 * `resolveBranch`/`resolveWorktree` directly, so this and every other caller
 * of an `Identity` are one code path. The consequence: the worktree resolves
 * first now, the branch second — the reverse of the order before the F4
 * split. It no longer matters which one fails first outside a repository,
 * because `resolveWorktree` swallows its own failure and falls back to `cwd`;
 * only the branch's own fallback (`rev-parse --short HEAD`) can throw, and it
 * still does, wherever in the sequence it runs.
 */
export function resolveActor(options: ActorOptions): string {
  return actorFromIdentity(createIdentityResolver(options)());
}
