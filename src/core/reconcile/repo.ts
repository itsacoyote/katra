/**
 * Candidate gathering (F9 T3): the store-touching counterpart to the pure
 * engine (`reconcile/{types,policy,engine}.ts`) — turns real tasks, refs and
 * claims into `Candidate[]`, the engine's own input.
 *
 * The deliberate exception to "reconcile/ never imports the store": this
 * module legitimately does, the identical split `refs/parse.ts` (pure) and
 * `refs/repo.ts` (store-touching) already draw for F7's ref grammar.
 * `test/core/reconcile.test.ts`'s own structural scan is scoped to the three
 * pure files for exactly this reason — this file is meant to fail it.
 */

import { narrowNullableText, narrowText } from "../narrow.js";
import { listOpenTaskRefs, listOpenTaskRefsFor } from "../refs/repo.js";
import type { Ref } from "../refs/types.js";
import type { OpenStore } from "../store.js";
import { CLAIMS_JOIN } from "../tasks/next.js";
import type { Candidate } from "./types.js";

/** The raw shape SQLite hands back for a candidate task's own metadata + claim. */
interface TaskMetaRow {
  readonly id: unknown;
  readonly title: unknown;
  readonly claim_holder: unknown;
}

/**
 * Every task holding at least one ref, non-terminal, non-epic — reconcile's
 * own scope (epic requirement 4; plan decision 4, plan-review HIGH-3/LOW-2)
 * — as {@link Candidate}s the engine (`reconcile/engine.ts`) can plan
 * verdicts against. Takes already-resolved ids only: `taskIds`, when given,
 * is exactly what `refs/repo.ts`'s own `listOpenTaskRefsFor` expects —
 * resolving a raw CLI argument through the house resolver (`requireId`, the
 * way `refresh.ts`'s own orchestration does before calling
 * `listOpenTaskRefsFor`) is the caller's job, never this function's.
 *
 * **Non-terminal, inherited rather than re-checked.**
 * `listOpenTaskRefs`/`listOpenTaskRefsFor` already filter every ref row to
 * open (non-{@link TERMINAL_LANES}) holders — the one query
 * `refs/repo.ts`'s own `openRefRows` runs for both — so a task that never
 * appears as a holder there never appears here either. Re-filtering by lane
 * in this file's own query would be a second, independently-maintained copy
 * of that same rule, exactly the drift risk `openRefRows`'s own module doc
 * describes for having two.
 *
 * **`level != 'epic'`, applied here — the one filter `refs/repo.ts`
 * deliberately does not.** `listOpenTaskRefs` is level-blind by design (its
 * own docs: "an epic's own lane is exactly as terminal or non-terminal as a
 * task's" — refresh legitimately refreshes a ref an epic holds directly).
 * Reconcile must not inherit that: an epic closing because its own linked PR
 * merged was never the feature this ships, so the exclusion lives in this
 * file's own query, not upstream.
 *
 * **Claims via one batched `LEFT JOIN`, never a per-task lookup.**
 * {@link CLAIMS_JOIN} (`tasks/next.ts`, imported — never
 * `CLAIMED_ELSEWHERE`, plan-review LOW-3) joins `claims` once, for every
 * candidate task in a single query; `claim_holder` comes back raw. The
 * "is this claim mine" comparison happens here in code, against
 * `store.identity().worktree`, rather than by also importing
 * `CLAIMED_ELSEWHERE`'s SQL fragment (and the bind-parameter-ordering care
 * `board.ts`'s own `section` needs for it, since that fragment's `?` has to
 * bind ahead of every other parameter in the query text): a plain equality
 * check on an already-fetched value needs no bind position to get wrong.
 * `Candidate.claimHolder` ends up non-null exactly when a worktree other
 * than the caller's own holds the claim — {@link Candidate}'s own docs, and
 * the contract `reconcile/engine.ts`'s `skip-claimed` override already
 * trusts.
 */
export function gatherCandidates(store: OpenStore, taskIds?: readonly string[]): Candidate[] {
  const openRefs =
    taskIds === undefined ? listOpenTaskRefs(store) : listOpenTaskRefsFor(store, taskIds);

  // Inverts refs/repo.ts's own per-ref holderIds grouping into per-task ref
  // lists — this is also where "holds at least one ref" falls out for free:
  // a task absent from every OpenRef's holderIds simply never becomes a key.
  const refsByTask = new Map<string, Ref[]>();
  for (const openRef of openRefs) {
    for (const holderId of openRef.holderIds) {
      const refs = refsByTask.get(holderId);
      if (refs === undefined) refsByTask.set(holderId, [openRef.ref]);
      else refs.push(openRef.ref);
    }
  }

  const candidateTaskIds = [...refsByTask.keys()];
  // A bare SQL `IN ()` is invalid syntax, not an empty-set match — the same
  // guard `refs/repo.ts`'s own openRefRows applies to its own IN-list.
  if (candidateTaskIds.length === 0) return [];

  const worktree = store.identity().worktree;
  const rows = store.db
    .prepare(
      `SELECT t.id AS id, t.title AS title, c.holder AS claim_holder
         FROM tasks t
         ${CLAIMS_JOIN}
        WHERE t.level != 'epic'
          AND t.id IN (${candidateTaskIds.map(() => "?").join(",")})`,
    )
    .all(...candidateTaskIds) as TaskMetaRow[];

  const metaById = new Map(rows.map((row) => [narrowText(row.id, "id"), row]));

  const candidates: Candidate[] = [];
  for (const taskId of candidateTaskIds) {
    const meta = metaById.get(taskId);
    // Filtered out by the level check above (an epic), or vanished between
    // the ref read and this one — either way, not a candidate.
    if (meta === undefined) continue;

    const rawHolder = narrowNullableText(meta.claim_holder, "claim_holder");
    candidates.push({
      id: taskId,
      title: narrowText(meta.title, "title"),
      claimHolder: rawHolder === null || rawHolder === worktree ? null : rawHolder,
      refs: refsByTask.get(taskId) ?? [],
    });
  }
  return candidates;
}
