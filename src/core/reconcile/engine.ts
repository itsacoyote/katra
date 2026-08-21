/**
 * The pure reconcile policy engine (epic requirement 9): `planReconcile`
 * maps each {@link Candidate}'s linked refs through a {@link PolicyTable} to
 * one {@link Verdict}, with no store import and no network — see `types.ts`'s
 * module doc for the full "pure module" discipline this file shares with it.
 *
 * **Precedence, pinned (plan decision 3), checked in this exact order:**
 *
 * 1. **`conflict`** — the refs that *do* map disagree on the target lane
 *    (one -> Done, another -> Cancelled). Checked first because it is the
 *    most actionable signal, and it must win even when the same task would
 *    also qualify as `blocked-by-ref` (a third, unmapped ref present
 *    alongside the disagreement) — {@link planReconcile}'s own tests pin
 *    that overlap case directly.
 * 2. **`blocked-by-ref`** — at least one ref maps to a target and at least
 *    one other does not. "Does not map" covers two distinct causes the
 *    engine treats identically: a status this policy has no entry for, and
 *    "unresolved" — `cachedStatus === null`, a ref `refresh` has never
 *    successfully written a status for (epic requirement 5 / plan-review
 *    HIGH-4: a failed resolve writes nothing, so this is the only
 *    unresolved state the cache can actually distinguish; a *stale* cached
 *    status is indistinguishable from a fresh one here by design — see the
 *    epic's Non-goals).
 * 3. **`advance`** — every ref maps, and (having already failed the conflict
 *    check above) they all map to the identical target.
 * 4. **`no-op`** — zero refs map to anything. Distinct from `blocked-by-ref`,
 *    which needs at least one mapped ref to contrast against — the epic's
 *    own vocabulary note: "prevents advancement" is the safety property
 *    both verdicts share, `blocked-by-ref` vs `no-op` differ only in what
 *    the user is told.
 *
 * **`skip-claimed` overrides `advance` only.** Applied as a final step,
 * after the four rules above have already produced a verdict: a would-be
 * `advance` becomes `skip-claimed` when {@link Candidate.claimHolder} is set
 * (non-null, which — per that field's own docs — only happens for a claim
 * belonging to a worktree other than the one invoking `reconcile`).
 * `conflict`/`blocked-by-ref`/`no-op` are returned exactly as decided,
 * whatever `claimHolder` holds: a blocked or conflicted task reports its ref
 * verdict even when claimed (epic requirement 6, restated in the vocabulary
 * note) — only a move that was actually about to happen gets masked.
 */

import type { TerminalLane } from "../enums.js";
import { isTerminal } from "../enums.js";
import type { Ref } from "../refs/types.js";
import type { Candidate, CandidateVerdict, ConflictTarget, PolicyTable, Verdict } from "./types.js";

/**
 * The target `ref` maps to under `policy`, or `undefined` when it does not —
 * whether because its `cachedStatus` is `null` (unresolved) or because
 * `policy` simply has no entry for its `(provider, status)` pair (mapped to
 * nothing). Both are "this ref does not map" from the engine's point of
 * view; nothing downstream of this function ever needs to tell them apart.
 *
 * **Own-property lookups only.** `ref.provider` is attacker-influenced (F7's
 * `ref add --provider/--id` escape hatch places no restriction on the string
 * stored there), and a plain `policy[ref.provider]` indexes the object's
 * prototype chain along with its own keys — `"__proto__"`, `"toString"`,
 * `"constructor"`, and every other `Object.prototype` member resolve to
 * *something* rather than `undefined`. `Object.hasOwn` is checked at both
 * levels — provider, then status — before either index runs, and the final
 * `isTerminal` guard is a second, independent check that whatever survives
 * both `hasOwn` calls is actually `"Done"`/`"Cancelled"` and not some other
 * value a non-default, caller-supplied `PolicyTable` happened to store.
 */
function refTarget(ref: Ref, policy: PolicyTable): TerminalLane | undefined {
  if (ref.cachedStatus === null) return undefined;
  if (!Object.hasOwn(policy, ref.provider)) return undefined;
  const statuses = policy[ref.provider];
  if (statuses === undefined || !Object.hasOwn(statuses, ref.cachedStatus)) return undefined;
  const target = statuses[ref.cachedStatus];
  return isTerminal(target) ? target : undefined;
}

/** The base verdict — precedence rules 1 through 4, before the claim override. */
function baseVerdict(candidate: Candidate, policy: PolicyTable): Verdict {
  const mapped: Array<{ readonly ref: Ref; readonly target: TerminalLane }> = [];
  const unmapped: Ref[] = [];

  for (const ref of candidate.refs) {
    const target = refTarget(ref, policy);
    if (target === undefined) unmapped.push(ref);
    else mapped.push({ ref, target });
  }

  // Rule 1: conflict. A Map preserves insertion order, so the report names
  // disagreeing targets in the order the refs themselves were linked, not an
  // arbitrary one — the same guarantee the previous find()-then-push version
  // gave, without a readonly-array cast to get there.
  const byTarget = new Map<TerminalLane, Ref[]>();
  for (const { ref, target } of mapped) {
    const refs = byTarget.get(target);
    if (refs === undefined) byTarget.set(target, [ref]);
    else refs.push(ref);
  }
  if (byTarget.size >= 2) {
    const targets: ConflictTarget[] = Array.from(byTarget, ([target, refs]) => ({ target, refs }));
    return { kind: "conflict", targets };
  }

  // Rule 2: blocked-by-ref.
  if (mapped.length > 0 && unmapped.length > 0) {
    return { kind: "blocked-by-ref", blockingRefs: unmapped };
  }

  // Rule 3: advance. Every ref mapped (unmapped.length === 0) and, having
  // already failed the conflict check, every one of them agrees.
  const [firstMapped] = mapped;
  if (firstMapped !== undefined) {
    return {
      kind: "advance",
      target: firstMapped.target,
      triggeringRefs: mapped.map((entry) => entry.ref),
    };
  }

  // Rule 4: no-op. Zero refs mapped to anything.
  return { kind: "no-op" };
}

/**
 * Plans a verdict for every `candidate`, against `policy` — never the
 * store, never the network. See this module's own doc for the full
 * precedence and the `skip-claimed` override.
 */
export function planReconcile(
  candidates: readonly Candidate[],
  policy: PolicyTable,
): readonly CandidateVerdict[] {
  return candidates.map((candidate) => {
    const verdict = baseVerdict(candidate, policy);
    if (verdict.kind === "advance" && candidate.claimHolder !== null) {
      return { candidate, verdict: { kind: "skip-claimed", holder: candidate.claimHolder } };
    }
    return { candidate, verdict };
  });
}
