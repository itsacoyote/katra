/**
 * `katra reconcile` — advances tasks from cached external ref status under
 * the built-in policy (spec §7 requirement 9). Preview by default; `--apply`
 * commits.
 *
 * **Sync `withStore`, not `withStoreAsync`.** `refresh` (F8 T5) is the one,
 * documented exception that needs the async form — a provider's `resolve` is
 * a real network call. `reconcile` reads only what `refresh` already cached
 * and writes through the ordinary synchronous lifecycle machinery, so it
 * stays on the same synchronous path every other command in this file tree
 * uses (`with-store.ts`'s own module doc).
 *
 * **Orchestration:** gather (`reconcile/repo.ts`'s `gatherCandidates` — no
 * explicit ids means every eligible task; explicit ids are resolved with
 * `requireId` first, the identical house `not_found` refusal every other
 * command taking task ids uses, never re-implemented here), plan
 * (`reconcile/engine.ts`'s `planReconcile` against the compiled-in
 * `DEFAULT_POLICY`), then — only under `--apply` — commit each `advance`
 * verdict.
 *
 * **SECURITY-SENSITIVE (epic label):** this command renders ref fields no
 * earlier command rendered from this exact seam, and it is the first to
 * *construct* a new stored string (a lane-change event's `reason`) from
 * them. Every interpolated ref field in the human renderer — provider,
 * externalId, cachedTitle, a skip's claim-holder path — goes through
 * `oneLine`/`clamp` at the render site (`refresh.ts:264-267`'s own comment
 * is the discipline copied here); `formatRefLine` (now exported from
 * `format.ts`, plan-review HIGH-3) does the identical sanitizing internally
 * for every ref line it renders. The *stored* reason is the deliberate
 * exception: built from raw fields, exactly like every other `events.reason`
 * in katra — the write never sanitizes, the read does (`describeEvent`'s own
 * `oneLine`, already proven), and `ReconcileAdvanceItem.reason`
 * (`contract.ts`) documents the same split.
 *
 * **Apply, one task per `writeTx`.** Each `advance` verdict calls
 * `closeTask` (target `Done`) or `cancelTask` (target `Cancelled`) with T1's
 * `{ actor: "reconcile", refuseIfClaimedElsewhere: true }` overrides —
 * `reconcile` cannot produce a state a manual `close`/`cancel` could not,
 * because it calls the identical function. Two exceptions are caught per
 * task, never left to abort the whole run (F8's per-ref non-aborting
 * precedent): a `claimed_elsewhere` refusal (another worktree claimed the
 * task in the gap between gathering and this write) and an already-terminal
 * `conflict` refusal (some other process finished it first). The first is
 * reported in `skipClaimed` — the identical section and item shape a
 * `Verdict`'s own `skip-claimed` arm produces (plan-review MEDIUM-2): a
 * caller reading the result never has to know which of the two paths found
 * it. The second is reported in `noOp`: a task already terminal needs
 * nothing further from `reconcile`, whatever moved it there.
 *
 * **Exit 0 whenever every task resolved or degraded cleanly** (ADR-006) —
 * an all-blocked, all-conflicted, or all-skipped run is not a failure, the
 * same posture `refresh` and `next` already take. Only a genuinely malformed
 * invocation (a nonexistent explicit id) is a usage-shaped refusal, and that
 * comes from `requireId` the same way it does everywhere else.
 */

import type { Command } from "commander";
import { nowIso } from "../../core/clock.js";
import type {
  ReconcileAdvanceItem,
  ReconcileBlockedItem,
  ReconcileConflictItem,
  ReconcileNoOpItem,
  ReconcileResult,
  ReconcileSkipClaimedItem,
  ReconcileTotals,
} from "../../core/contract.js";
import type { ReconcileVerdictKind, TerminalLane } from "../../core/enums.js";
import { isTerminal } from "../../core/enums.js";
import { isKatraException } from "../../core/errors.js";
import { planReconcile } from "../../core/reconcile/engine.js";
import { DEFAULT_POLICY } from "../../core/reconcile/policy.js";
import { gatherCandidates } from "../../core/reconcile/repo.js";
import type { Candidate, Verdict } from "../../core/reconcile/types.js";
import type { Ref } from "../../core/refs/types.js";
import type { OpenStore } from "../../core/store.js";
import { requireId } from "../../core/tasks/ids.js";
import { cancelTask, closeTask } from "../../core/tasks/lifecycle.js";
import { getTask } from "../../core/tasks/repo.js";
import { formatRefLine, oneLine } from "../format.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStore } from "../with-store.js";
import { buildRefreshSection, pushSection } from "./refresh.js";

/**
 * The status-and-source clause for one triggering ref: `"<status> —
 * <provider>:<externalId>"` — e.g. `"merged — github:owner/repo#12"`. `.cachedStatus`
 * is never `null` here: a triggering ref is one `planReconcile` already
 * matched against the policy table, which requires a non-null status by
 * construction (`engine.ts`'s own `refTarget`) — the `?? ""` fallback is
 * defensive only, never reachable from real data.
 */
function refReasonClause(ref: Ref): string {
  return `${ref.cachedStatus ?? ""} — ${ref.provider}:${ref.externalId}`;
}

/**
 * The reason recorded on the lane-change event — every triggering ref's own
 * clause, joined with `", "` (pinned wording, epic requirement 7). Built
 * from raw fields: `events.reason` is always raw (this module's own doc),
 * sanitized only where it is rendered, never where it is written.
 */
function buildReason(triggeringRefs: readonly Ref[]): string {
  return triggeringRefs.map(refReasonClause).join(", ");
}

/**
 * Applies one `advance` verdict's target through the identical lifecycle seam
 * a manual close/cancel uses.
 *
 * An exhaustive `switch`, not `target === "Done" ? closeTask : cancelTask` —
 * an `else`/ternary fallback reads "anything that isn't Done is Cancelled",
 * which is exactly the wrong default for a `target` that ultimately traces
 * back to attacker-influenced ref data (`engine.ts`'s own `refTarget` guards
 * the *value* at the source; this guards what the CLI *does* with it, so an
 * unrecognized target can never fall through to a real, destructive write).
 */
function applyAdvance(
  store: OpenStore,
  taskId: string,
  target: TerminalLane,
  reason: string,
): void {
  const overrides = { actor: "reconcile", refuseIfClaimedElsewhere: true } as const;
  switch (target) {
    case "Done":
      closeTask(store, taskId, reason, overrides);
      return;
    case "Cancelled":
      cancelTask(store, taskId, reason, overrides);
      return;
    default: {
      const exhaustive: never = target;
      throw new Error(`unreachable reconcile target: ${JSON.stringify(exhaustive)}`);
    }
  }
}

interface Buckets {
  readonly advance: ReconcileAdvanceItem[];
  readonly blockedByRef: ReconcileBlockedItem[];
  readonly conflict: ReconcileConflictItem[];
  readonly skipClaimed: ReconcileSkipClaimedItem[];
  readonly noOp: ReconcileNoOpItem[];
}

/**
 * Reports every explicitly-named id `gatherCandidates` silently dropped —
 * an epic, an already-terminal task, or a task holding no ref
 * (`gatherCandidates`'s own eligibility rule, epic requirement 4) — under
 * `no-op` instead of letting it vanish from the count entirely. Never runs
 * for a bare `reconcile` (`taskIds` `undefined`): scanning every eligible
 * task has no "explicitly asked for and ineligible" case to report.
 *
 * `getTask` rather than a second `requireId`: the id already passed
 * `requireId` once, at the CLI boundary, before `runReconcile` ever saw it —
 * re-resolving it here would re-run the same partial-id search for no
 * reason. `task === undefined` is unreachable in practice for exactly that
 * reason, and skipped rather than thrown on: a task deleted in the gap
 * between resolving the id and this read is `reconcile`'s problem to shrug
 * off, not to crash over.
 */
function reportIneligibleIds(
  store: OpenStore,
  taskIds: readonly string[] | undefined,
  candidates: readonly Candidate[],
  buckets: Buckets,
): void {
  if (taskIds === undefined) return;
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  for (const taskId of taskIds) {
    if (candidateIds.has(taskId)) continue;
    const task = getTask(store, taskId);
    if (task === undefined) continue;
    buckets.noOp.push({ taskId, title: task.title });
  }
}

/**
 * Plans and — under `applyChanges` — commits every candidate's verdict,
 * bucketed by kind. See this module's own doc for the full apply/race
 * discipline.
 */
function runReconcile(
  store: OpenStore,
  taskIds: readonly string[] | undefined,
  applyChanges: boolean,
): ReconcileResult {
  const candidates = gatherCandidates(store, taskIds);
  const verdicts = planReconcile(candidates, DEFAULT_POLICY);

  const buckets: Buckets = {
    advance: [],
    blockedByRef: [],
    conflict: [],
    skipClaimed: [],
    noOp: [],
  };

  for (const { candidate, verdict } of verdicts) {
    handleVerdict(store, candidate, verdict, applyChanges, buckets);
  }
  reportIneligibleIds(store, taskIds, candidates, buckets);

  // The sum of the five buckets, not `verdicts.length`: an explicitly-named
  // ineligible id (reportIneligibleIds, above) lands in `noOp` without ever
  // producing a verdict, and `tasks` has to keep naming "how many ids this
  // run accounted for" rather than "how many the engine actually decided" —
  // otherwise the header's own count would undercount its own sections.
  const totals: ReconcileTotals = {
    tasks:
      buckets.advance.length +
      buckets.blockedByRef.length +
      buckets.conflict.length +
      buckets.skipClaimed.length +
      buckets.noOp.length,
    advance: buckets.advance.length,
    blockedByRef: buckets.blockedByRef.length,
    conflict: buckets.conflict.length,
    skipClaimed: buckets.skipClaimed.length,
    noOp: buckets.noOp.length,
  };

  return {
    applied: applyChanges,
    totals,
    advance: buildRefreshSection(buckets.advance),
    blockedByRef: buildRefreshSection(buckets.blockedByRef),
    conflict: buildRefreshSection(buckets.conflict),
    skipClaimed: buildRefreshSection(buckets.skipClaimed),
    noOp: buildRefreshSection(buckets.noOp),
  };
}

function handleVerdict(
  store: OpenStore,
  candidate: Candidate,
  verdict: Verdict,
  applyChanges: boolean,
  buckets: Buckets,
): void {
  const taskId = candidate.id;
  const title = candidate.title;

  switch (verdict.kind) {
    case "conflict":
      buckets.conflict.push({ taskId, title, targets: verdict.targets });
      return;
    case "blocked-by-ref":
      buckets.blockedByRef.push({ taskId, title, blockingRefs: verdict.blockingRefs });
      return;
    case "skip-claimed":
      buckets.skipClaimed.push({ taskId, title, holder: verdict.holder });
      return;
    case "no-op":
      buckets.noOp.push({ taskId, title });
      return;
    case "advance": {
      const reason = buildReason(verdict.triggeringRefs);
      const item: ReconcileAdvanceItem = {
        taskId,
        title,
        target: verdict.target,
        triggeringRefs: verdict.triggeringRefs,
        reason,
      };
      if (!applyChanges) {
        buckets.advance.push(item);
        return;
      }
      try {
        applyAdvance(store, taskId, verdict.target, reason);
        buckets.advance.push(item);
      } catch (error) {
        if (isKatraException(error) && error.detail.code === "claimed_elsewhere") {
          buckets.skipClaimed.push({ taskId, title, holder: error.detail.holder });
        } else if (isKatraException(error) && error.detail.code === "conflict") {
          // "conflict" alone does not prove this is the already-terminal
          // race this branch means to catch — five different modules throw
          // that same code (claims, dependency cycles, and lifecycle's own
          // terminal-lane guard among them), and the CLI has no way to tell
          // them apart from the code alone. Re-reading the task's current
          // lane verifies the actual cause: only a genuinely terminal task —
          // some other process (another `reconcile`, a manual close/cancel)
          // finished it first — becomes a no-op. Anything else escapes as a
          // real failure rather than being silently swallowed into one.
          const current = getTask(store, taskId);
          if (current !== undefined && isTerminal(current.lane)) {
            buckets.noOp.push({ taskId, title });
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }
      return;
    }
    default: {
      const exhaustive: never = verdict;
      throw new Error(`unreachable verdict kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Human rendering — one block per non-empty section, refresh.ts's own
// sections-accumulator style.
// ---------------------------------------------------------------------------

/**
 * Every {@link ReconcileVerdictKind} rendered as a section label.
 *
 * `satisfies Record<ReconcileVerdictKind, string>` pins label exhaustiveness
 * only — a sixth verdict kind added without an entry here is a compile
 * error, rather than a silently unrendered section. Not the same job as
 * `refresh.ts`'s `REASON_SENTENCES`: that map translates a token into a
 * prose sentence, where most of the labels below are just the kind itself
 * restated as a section heading.
 */
const VERDICT_LABELS = {
  advance: "advance",
  "blocked-by-ref": "blocked",
  conflict: "conflict",
  "skip-claimed": "skip-claimed",
  "no-op": "no-op",
} satisfies Record<ReconcileVerdictKind, string>;

function formatReconcileResult(result: ReconcileResult, now: string): string {
  const blocks: string[] = [];
  const { totals } = result;
  const advanceVerb = result.applied ? "advanced" : "would advance";

  blocks.push(
    `${String(totals.tasks)} task(s) checked — ${String(totals.advance)} ${advanceVerb}, ` +
      `${String(totals.blockedByRef)} blocked, ${String(totals.conflict)} conflicting, ` +
      `${String(totals.skipClaimed)} skip-claimed, ${String(totals.noOp)} no-op`,
  );

  pushSection(
    blocks,
    VERDICT_LABELS.advance,
    result.advance,
    result.advance.items.flatMap((item) => [
      `  ${item.taskId}  ${oneLine(item.title)}  -> ${item.target}`,
      // Every interpolated ref field in `reason` (provider/externalId) goes
      // through `oneLine` here, at the render site — the raw, stored value
      // this previews is never assumed safe just because it will also be
      // written (`refresh.ts:264-267`'s discipline, copied).
      `    reason: ${oneLine(item.reason)}`,
      ...item.triggeringRefs.map((ref) => `    ${formatRefLine(ref, now)}`),
    ]),
  );
  pushSection(
    blocks,
    VERDICT_LABELS["blocked-by-ref"],
    result.blockedByRef,
    result.blockedByRef.items.flatMap((item) => [
      `  ${item.taskId}  ${oneLine(item.title)}`,
      ...item.blockingRefs.map((ref) => `    ${formatRefLine(ref, now)}`),
    ]),
  );
  pushSection(
    blocks,
    VERDICT_LABELS.conflict,
    result.conflict,
    result.conflict.items.flatMap((item) => [
      `  ${item.taskId}  ${oneLine(item.title)}`,
      ...item.targets.flatMap((target) => [
        `    -> ${target.target}`,
        ...target.refs.map((ref) => `      ${formatRefLine(ref, now)}`),
      ]),
    ]),
  );
  pushSection(
    blocks,
    VERDICT_LABELS["skip-claimed"],
    result.skipClaimed,
    result.skipClaimed.items.map(
      (item) => `  ${item.taskId}  ${oneLine(item.title)}  claimed by ${oneLine(item.holder)}`,
    ),
  );
  pushSection(
    blocks,
    VERDICT_LABELS["no-op"],
    result.noOp,
    result.noOp.items.map((item) => `  ${item.taskId}  ${oneLine(item.title)}`),
  );

  return blocks.join("\n\n");
}

export function registerReconcile(program: Command, context: CliContext): void {
  program
    .command("reconcile")
    .argument(
      "[ids...]",
      "task ids to reconcile, full or partial; omit to check every eligible task",
    )
    .description("advance tasks from cached external ref status under the built-in policy")
    .option("--apply", "commit the advances; omit to preview only")
    .option("--json", "emit structured output")
    .action((ids: string[], options: { apply?: boolean; json?: boolean }) => {
      const { result, warnings } = withStore(context, (store) => {
        const resolvedIds = ids.length === 0 ? undefined : ids.map((id) => requireId(store, id));
        return runReconcile(store, resolvedIds, options.apply === true);
      });

      emit(result, { json: options.json === true, warnings, streams: context.streams }, (value) =>
        formatReconcileResult(value, nowIso()),
      );
    });
}
