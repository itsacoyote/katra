/**
 * The reconcile policy engine's own shapes (F9 T2, spec §7 requirement 9): a
 * `Candidate` in, a `Verdict` out, a `PolicyTable` deciding between them.
 *
 * Pure module — no `better-sqlite3`, no store import, the same discipline
 * `core/providers/types.ts` documents for its own shapes and
 * `test/core/reconcile.test.ts` pins structurally: `engine.ts`/`policy.ts`
 * import only from here and from `core/enums.ts`. Gathering the real
 * `Candidate` rows from the store is a separate, store-touching module
 * (`reconcile/repo.ts`, F9 T3) — the identical split `refs/parse.ts` (pure)
 * and `refs/repo.ts` (store-touching) already draw for F7's ref grammar.
 *
 * `refs: readonly Ref[]` reuses F7/F8's own {@link Ref} wholesale rather than
 * a parallel near-duplicate shape — `core/providers/types.ts`'s `Provider`
 * is the precedent: `Ref` is already pure, already carries
 * `cachedStatus`/`cachedTitle`/`syncedAt`, and a second, engine-local ref
 * shape would be exactly the kind of copy that drifts from the original.
 */

import type { Lane, Level, ReconcileVerdictKind, TerminalLane } from "../enums.js";
import type { Ref } from "../refs/types.js";

/**
 * One task eligible for reconciliation, as gathered by `reconcile/repo.ts`
 * (F9 T3) — non-terminal, non-epic, holding at least one ref (epic
 * requirement 4). The engine itself enforces neither constraint; it trusts
 * the gatherer's scope and would treat an epic or a terminal task exactly
 * like any other `Candidate` if handed one.
 */
export interface Candidate {
  readonly id: string;
  readonly title: string;
  readonly lane: Lane;
  readonly level: Level;
  /**
   * The claiming worktree, or `null`. Set **only** when the claim belongs to
   * a worktree other than the one invoking `reconcile` — the caller resolves
   * "is this mine" before a `Candidate` is ever built (epic requirement 6: a
   * claim held by the invoking worktree does not block). The engine never
   * receives, and does not need, an "invoking worktree" parameter of its
   * own: a non-null value here always means someone else's claim.
   */
  readonly claimHolder: string | null;
  /** Every ref currently linked to this task — reconcile's own ALL rule (epic requirement 2) reads every one, never a sample. */
  readonly refs: readonly Ref[];
}

/**
 * What one status maps to, keyed `provider -> status -> target lane`
 * (epic requirement 1). A provider or status absent from this table is
 * unmapped — the same "no entry means no move" reading
 * {@link ../providers/registry.js providerFor} gives an unregistered
 * `ref.provider`.
 *
 * Every value is a {@link TerminalLane}, not the wider {@link Lane}: the
 * whole feature's forward-only guarantee rests on this being structurally
 * true, not merely convention (`reconcile/engine.ts`'s module doc, and the
 * epic's own Constraints: "every policy target is a terminal lane"). Passed
 * as data, never branched on in code (ADR-016) — {@link ../reconcile/policy.js
 * DEFAULT_POLICY} is the compiled-in default; a caller may inject any other
 * table shaped like this one.
 */
export type PolicyTable = Readonly<Record<string, Readonly<Record<string, TerminalLane>>>>;

/** One target a conflicted task's mapped refs disagree on, and which refs mapped to it. */
export interface ConflictTarget {
  readonly target: TerminalLane;
  readonly refs: readonly Ref[];
}

/**
 * What `planReconcile` (`reconcile/engine.ts`) decided for one
 * {@link Candidate} — kind-tagged, the same discriminated-union shape
 * family as `core/providers/types.ts`'s `ProviderResult` (`resolved`) and
 * `core/refs/parse.ts`'s `ParseRefResult` (`recognized`) — a consumer
 * narrows on `kind` without a cast, and cannot read `target` on the
 * `no-op` arm or `holder` on the `advance` arm by mistake.
 *
 * The five `kind` literals below are the same five tokens `enums.ts`'s
 * `RECONCILE_VERDICT_KINDS` declares — not imported from there: a
 * discriminated union needs each arm typed to its own specific literal, and
 * `kind: ReconcileVerdictKind` on every arm would type every arm as the
 * *whole* union instead, losing the narrowing this shape exists for. Each
 * arm keeps its own literal untouched; {@link _VerdictKindsMatchEnum} below
 * is a separate, compile-time-only proof that the two lists still agree,
 * catching the drift a hand-kept-in-sync pair invites — a typo'd arm, or a
 * vocabulary token with no arm — as a type error instead of a silent gap a
 * test would have to happen to cover. `RECONCILE_VERDICT_KINDS` is what
 * `reconcile`'s CLI (F9 T4) and `reconcile/repo.ts` (F9 T3) import — the
 * closed vocabulary shared *across* files; this file's own literals are what
 * a caller narrows *within* one.
 *
 * Deliberately **not** `RefResult`'s flat, always-present-fields shape: each
 * arm below answers a structurally different question (which lane, which
 * refs disagreed, which ref blocked, who claimed it), so a flat shape would
 * carry three or four fields that are meaningless outside their own arm.
 *
 * See `reconcile/engine.ts`'s module doc for the pinned precedence between
 * these five and the reasoning behind it.
 */
export type Verdict =
  | { readonly kind: "conflict"; readonly targets: readonly ConflictTarget[] }
  | { readonly kind: "blocked-by-ref"; readonly blockingRefs: readonly Ref[] }
  | {
      readonly kind: "advance";
      readonly target: TerminalLane;
      readonly triggeringRefs: readonly Ref[];
    }
  | { readonly kind: "skip-claimed"; readonly holder: string }
  | { readonly kind: "no-op" };

/**
 * Compile-time-only proof that {@link Verdict}'s five `kind` literals are
 * exactly `enums.ts`'s `RECONCILE_VERDICT_KINDS` — bidirectional, so it
 * catches drift in either direction: a `Verdict` arm renamed to a literal
 * outside the vocabulary, or a vocabulary token with no arm to produce it.
 * `Verdict["kind"]` never touches how each arm narrows (every arm still
 * carries its own individual literal, per the doc above) — this type is
 * never referenced by anything that runs, only by the `const` immediately
 * below it, whose sole job is forcing TypeScript to actually evaluate the
 * conditional: a conditional type nothing is assigned to is checked by
 * nothing.
 */
type _VerdictKindsMatchEnum = Verdict["kind"] extends ReconcileVerdictKind
  ? ReconcileVerdictKind extends Verdict["kind"]
    ? true
    : never
  : never;
const _verdictKindsMatchEnum: _VerdictKindsMatchEnum = true;
void _verdictKindsMatchEnum;

/** One candidate paired with the verdict `planReconcile` reached for it. */
export interface CandidateVerdict {
  readonly candidate: Candidate;
  readonly verdict: Verdict;
}
