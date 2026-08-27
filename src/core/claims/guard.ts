/**
 * The before-edit takeover check (F11 T1, ADR-019).
 *
 * `guardCheck` answers one question: has a **different, live** worktree taken
 * over work this worktree used to hold? It denies iff the answer is yes and
 * allows in every other case — holding nothing, holding what it always held,
 * having re-coordinated since the last takeover, or the rival being stale.
 *
 * **Tenure rule, three steps:**
 *
 * 1. **Displaced tenures.** Among tasks `claims` currently shows held by some
 *    *other* worktree, find every one whose event history records this
 *    worktree being displaced from it — a `released` event whose `prior_actor`
 *    (parsed with {@link worktreeFromActor}, never compared as a fused
 *    string — see that function's docs for why) names this worktree, and
 *    whose own `actor` names a *different* one. A self-release is voluntary
 *    and never counts, whatever displaced this worktree from other tasks.
 *    The scan walks this worktree's **full** event history on the task, not
 *    only its displacements: a `claimed` or a self-`released` event this
 *    worktree authored *after* a displacement settles that tenure — it took
 *    the task back and gave it up on its own — so a still-older displacement
 *    is what counts, or none at all if nothing displaced it since. See
 *    {@link findDisplacement}'s own docs for the scan and the bug this fixed.
 * 2. **Re-coordination gate.** If this worktree currently holds *any* claim
 *    ({@link claimsHeldBy}) whose `claimedAt` is at or after the most recent
 *    displaced tenure's event time, it has re-coordinated since — allow. A
 *    claim held *before* that takeover does not count: holding unrelated work
 *    while oblivious to a takeover elsewhere is exactly the collision ADR-019
 *    exists to catch, not an excuse to skip catching it.
 * 3. **Liveness.** Otherwise deny iff any displaced tenure's current holder is
 *    live (see below), reporting the most recent tenure **among the live
 *    ones** — a stale most-recent tenure must never mask an older one whose
 *    rival is still live.
 *
 * **Query shape: K+1 bounded, indexed reads, never a scan by actor.** `events`
 * has no index on `actor` (only `entity_id`/`epic_id`), so a "did I ever get
 * displaced" search cannot start from the event log. It starts from `claims`
 * instead: one read for every row held by another worktree
 * ({@link claimsHeldElsewhere} — `claims` holds only active claims, so this
 * is tiny) — then one indexed-by-`entity_id` read per candidate task for its
 * own displacement history. K+1 reads total, whatever the store's total
 * event count — and each of those K reads is itself bounded by
 * {@link DISPLACEMENT_SCAN_LIMIT} (see {@link SELECT_TASK_EVENTS}), so a
 * single candidate task's own history no longer sizes the read either. Before
 * that bound existed, a task with a long history — a peer worktree's own
 * cheap `katra update --reason` traffic on a task it holds is enough —
 * inflated this call's cost on *every other* worktree's `guardCheck`, on
 * every Edit/Write/NotebookEdit, in proportion to that task's total event
 * count rather than the actual size of the answer.
 *
 * **Deliberately not wrapped in one `readTx` snapshot.** The K+1 statements
 * above are independent reads, not one consistent view: a release landing
 * between two of them can make this call read stale state and return a
 * spurious deny. Accepted for the hook's own sake — the <1s latency budget
 * (spec §9) is the thing a held read snapshot would spend on the wrong side
 * of, and a spurious deny is self-correcting, unlike a spurious allow: the
 * very next `katra guard` re-reads current state and clears it.
 *
 * **Never writes.** `guardCheck` only reads `claims`/`events`/`presence`
 * through the store it is handed. The heartbeat every command pays
 * (`bumpPresence`, ADR-011) still rides on `openStore` before this ever runs
 * — that is a property of opening the store, not of this function, and
 * ADR-019's "never writes" is scoped to `claims`/`tasks`/`events` exactly the
 * way that ADR's own amendment states.
 */

import { worktreeFromActor } from "../actor.js";
import { toIso } from "../clock.js";
import type { GuardResult } from "../contract.js";
import type { EventType } from "../enums.js";
import { KatraException } from "../errors.js";
import { narrowEventType, narrowNullableText, narrowText } from "../narrow.js";
import type { OpenStore } from "../store.js";
import { claimsHeldBy, claimsHeldElsewhere } from "./repo.js";
import type { ClaimInfo } from "./types.js";

export type { GuardResult };

/**
 * How far back a rival's last observed activity may sit and still count as
 * live — 60 minutes.
 *
 * There is no existing liveness threshold to reuse: {@link
 * ../presence.js!PRESENCE_FRESH_MS} is a *write-skip* window (should this
 * command's own heartbeat bother writing again?), not a judgment about
 * whether some other worktree is still around, and reusing it here would be
 * wrong by two orders of magnitude.
 *
 * A Tier-0 rival heartbeats only when it runs a katra command — there is no
 * daemon, no idle ping — so a short window reads a genuinely live rival as
 * dead and **allows the exact collision guard exists to stop**. Too long
 * merely extends a lockout the displaced worktree can clear itself, either by
 * re-claiming after the takeover (the re-coordination gate) or by
 * `release --force`ing the stale-looking rival — both already the agent's own
 * tools. The asymmetry is why this leans long rather than short.
 */
export const GUARD_LIVENESS_DEFAULT_MS = 60 * 60_000;

/** What {@link guardCheck} accepts. */
export interface GuardOptions {
  /**
   * A rival is live iff its recency (the later of its presence `lastSeen`
   * and its claim's `claimedAt`) is at or after this ISO instant — the same
   * shape `describeLiveness(claim, now)` already takes its `now` in.
   *
   * **Must be katra's canonical, fixed-width UTC timestamp form**
   * ({@link ../clock.js!toIso}, 24 characters, per `clock.ts`'s own
   * `ISO_TIMESTAMP_LENGTH`) — the comparison against `lastSeen`/`claimedAt`
   * is a plain lexical `>=`, which agrees with chronological order only for
   * that exact width. A caller turning a user-facing duration or date into
   * this value should produce it with {@link ../clock.js!parseWhen}, the one
   * place katra already parses "how far back" into that form.
   *
   * Defaults to `now - `{@link GUARD_LIVENESS_DEFAULT_MS}, computed inside
   * this call rather than by the caller, so a caller with no opinion on
   * staleness never has to compute one.
   */
  readonly livenessFloor?: string;
}

/** One task this worktree was displaced from, still held by someone else. */
interface DisplacedTenure {
  readonly taskId: string;
  /** The task's current claim — who holds it now, and how fresh they look. */
  readonly claim: ClaimInfo;
  /**
   * The displacing `released` event's id — the total order `listEvents`'s own
   * docs lean on (assigned inside the write transaction, so it never ties
   * even when two events share a millisecond), used to rank tenures instead
   * of comparing `displacedAt` strings that a fast test or a busy store could
   * collide on.
   */
  readonly eventId: number;
  /** The displacing event's timestamp — the gate's own threshold. */
  readonly displacedAt: string;
}

/**
 * How many of `taskId`'s newest events {@link findDisplacement} ever looks
 * at — the load-bearing bound on `SELECT_TASK_EVENTS`. 200 is chosen
 * generously: large enough that a genuine displacement being buried under
 * this many *more* events on the very same task before this worktree's next
 * edit is essentially never the shape a real collision takes, small enough
 * to keep the scan cheap regardless of how much history that task has
 * accumulated in total.
 *
 * **The bound's own bias, spelled out.** A displacement older than this many
 * events reads as "no displacement" — allow. That is guard's own documented
 * bias, the same shape as the liveness floor and the deliberately-unsnapshotted
 * K+1 reads (this module's own docs, above): a spurious allow here costs
 * nothing more than what an unbounded scan already risked in the rare case
 * a real displacement sits that far back, while an unbounded scan risked it
 * on *every* call, for *every* task, no matter how inactive the collision
 * that mattered actually was.
 */
export const DISPLACEMENT_SCAN_LIMIT = 200;

/**
 * The row shape {@link findDisplacement} actually reads — 5 of the table's
 * 12 columns. **Deliberately not `events/repo.ts`'s `rowToEvent`**: that
 * narrow validates and returns all 12, including
 * `reason`/`title`, which carry unbounded stored text this scan never looks
 * at — paying to narrow them on every one of up to
 * {@link DISPLACEMENT_SCAN_LIMIT} rows, on the hot before-edit path, for
 * columns `SELECT_TASK_EVENTS` no longer even selects.
 */
interface DisplacementRow {
  readonly id: unknown;
  readonly type: unknown;
  readonly actor: unknown;
  readonly prior_actor: unknown;
  readonly created_at: unknown;
}

/** One event, narrowed to only the fields {@link findDisplacement} reads. */
interface DisplacementEvent {
  readonly id: number;
  readonly type: EventType;
  readonly actor: string;
  readonly priorActor: string | null;
  readonly createdAt: string;
}

/**
 * Narrows a {@link DisplacementRow} — the same "id must be an integer, or
 * this row is malformed" guard `events/repo.ts`'s `rowToEvent` applies,
 * scoped to the five columns this scan reads instead of all twelve.
 */
function narrowDisplacementRow(row: DisplacementRow): DisplacementEvent {
  if (typeof row.id !== "number" || !Number.isInteger(row.id)) {
    throw new KatraException({
      code: "validation",
      message: `event id must be an integer — the stored value is ${typeof row.id}, so this row is malformed`,
      field: "id",
      value: row.id,
    });
  }
  return {
    id: row.id,
    type: narrowEventType(row.type),
    actor: narrowText(row.actor, "actor"),
    priorActor: narrowNullableText(row.prior_actor, "prior_actor"),
    createdAt: narrowText(row.created_at, "created_at"),
  };
}

/**
 * The newest {@link DISPLACEMENT_SCAN_LIMIT} events recorded against
 * `taskId`, newest first via the `entity_id` index — narrowed to only the
 * columns {@link findDisplacement} reads, never `SELECT *`.
 *
 * **Widened from a `prior_actor IS NOT NULL` filter (fixed: an earlier
 * revision missed the caller's own later events).** That filter finds only
 * events naming a displaced actor, so it never sees this worktree's own
 * *later* `claimed`/self-`released` events on the same task — a real
 * sequence this missed: A claims X, B force-takes X, A force-takes X back,
 * A releases X voluntarily, B claims X. A's own history shows it re-acquired
 * X and gave it up on its own, but the filtered query only ever found the
 * old B-took-X-from-A displacement and reported A as still displaced.
 * {@link findDisplacement} needs the full history to tell "displaced and
 * never returned" apart from "took it back and gave it up voluntarily."
 *
 * **Bounded by `LIMIT` (fixed: that widening had no bound at all).** Without
 * `prior_actor IS NOT NULL` to narrow the row count, and without a `LIMIT` to
 * cap it, the common case — this worktree never touched `taskId` — walked
 * and materialized that task's *entire* event history on every call: 3s and
 * 408MB measured at 50k events on one task, reachable by any worktree simply
 * by holding a task and writing to it (`katra update --reason` is cheap and
 * ordinary). See {@link DISPLACEMENT_SCAN_LIMIT}'s own docs for the bound and
 * the bias it trades for that.
 */
const SELECT_TASK_EVENTS = `
  SELECT id, type, actor, prior_actor, created_at
    FROM events
   WHERE entity_id = ?
   ORDER BY id DESC
   LIMIT ?
`;

/**
 * The most recent event on `taskId` that settles `worktree`'s tenure one way
 * or the other, or `null` when neither ever happened:
 *
 * - a **displacement** — a `released` event whose `prior_actor` names
 *   `worktree` and whose own `actor` names someone else — reported back so
 *   the caller can weigh its rival's liveness; or
 * - a **settlement** — a `claimed` event, or a self-`released` event (one
 *   with no `prior_actor` — {@link ../claims/repo.js!settleClaim} only ever
 *   omits it on a self-release), authored by `worktree` itself — which
 *   means `worktree` re-acquired the task after being displaced and then
 *   gave it up on its own; it is not currently a displaced tenant of it even
 *   though `claims` now shows someone else holding it.
 *
 * Rows arrive newest-first (`ORDER BY id DESC`), bounded to the newest
 * {@link DISPLACEMENT_SCAN_LIMIT}; this walks them and stops at the first
 * match of *either* kind, which is equivalent to computing "the newest
 * displacement naming `worktree`" and "the newest settlement authored by
 * `worktree`" separately and taking whichever is more recent — the scan
 * meets the more recent one first, by construction. No separate ranking step
 * needed for the single-task case; {@link mostRecentTenure} ranks *across*
 * tasks, over whatever this returns.
 */
function findDisplacement(
  store: OpenStore,
  taskId: string,
  worktree: string,
): { readonly eventId: number; readonly displacedAt: string } | null {
  const rows = store.db
    .prepare(SELECT_TASK_EVENTS)
    .all(taskId, DISPLACEMENT_SCAN_LIMIT) as DisplacementRow[];
  for (const row of rows) {
    const event = narrowDisplacementRow(row);

    if (worktreeFromActor(event.actor) === worktree) {
      // An event this worktree authored itself: a claim, or a voluntary
      // release of its own claim, settles its tenure on this task — see
      // this function's own docs.
      if (event.type === "claimed" || (event.type === "released" && event.priorActor === null)) {
        return null;
      }
      continue;
    }

    // Someone else's event: only a `released` event that displaced
    // `worktree` is relevant. A non-null `prior_actor` already implies
    // `type = 'released'` (settleClaim is the only place that ever writes
    // it, and only on a `released` event), so pinning both would filter on
    // the same fact twice.
    if (event.priorActor === null) continue;
    if (worktreeFromActor(event.priorActor) !== worktree) continue;
    return { eventId: event.id, displacedAt: event.createdAt };
  }
  return null;
}

/**
 * Whether a rival's claim is live against `floor`, per
 * {@link GuardOptions.livenessFloor}'s own docs.
 *
 * Recency is the later of the claim's presence `lastSeen` and its own
 * `claimedAt` — "never seen" (`lastSeen === null`) reads as "as fresh as the
 * claim itself," never as dead.
 */
function isLive(claim: ClaimInfo, floor: string): boolean {
  const recency =
    claim.lastSeen !== null && claim.lastSeen > claim.claimedAt ? claim.lastSeen : claim.claimedAt;
  return recency >= floor;
}

/** The candidate with the highest event id — the total order {@link DisplacedTenure.eventId}'s own docs explain. Callers only ever pass a non-empty list. */
function mostRecentTenure(tenures: readonly DisplacedTenure[]): DisplacedTenure {
  return tenures.reduce((latest, candidate) =>
    candidate.eventId > latest.eventId ? candidate : latest,
  );
}

function defaultLivenessFloor(): string {
  return toIso(new Date(Date.now() - GUARD_LIVENESS_DEFAULT_MS));
}

/**
 * ADR-019's takeover verdict for the caller's worktree — see the module docs
 * for the full tenure rule this implements.
 *
 * Read-only: opens no transaction, writes nothing. The store's own
 * `openStore` heartbeat (ADR-011) has already run by the time a caller has an
 * `OpenStore` to pass in.
 */
export function guardCheck(store: OpenStore, options: GuardOptions = {}): GuardResult {
  const worktree = store.identity().worktree;
  const floor = options.livenessFloor ?? defaultLivenessFloor();

  const displaced: DisplacedTenure[] = [];
  for (const { taskId, claim } of claimsHeldElsewhere(store, worktree)) {
    const displacement = findDisplacement(store, taskId, worktree);
    if (displacement === null) continue;
    displaced.push({
      taskId,
      claim,
      eventId: displacement.eventId,
      displacedAt: displacement.displacedAt,
    });
  }

  // No displaced tenure at all: nothing to re-coordinate against, nothing to
  // deny — the common case (never claimed, still holds what it claimed, or
  // was only ever self-released).
  if (displaced.length === 0) return { verdict: "allow" };

  // The gate compares against the most recent displacement *overall* —
  // whether or not that rival is still live — because re-coordination is
  // about this worktree's own awareness, not the rival's current state.
  const latestOverall = mostRecentTenure(displaced);
  const myClaims = claimsHeldBy(store, worktree);
  const reCoordinated = myClaims.some((claim) => claim.claimedAt >= latestOverall.displacedAt);
  if (reCoordinated) return { verdict: "allow" };

  const live = displaced.filter((tenure) => isLive(tenure.claim, floor));
  if (live.length === 0) return { verdict: "allow" };

  const latestLive = mostRecentTenure(live);
  return {
    verdict: "deny",
    taskId: latestLive.taskId,
    holder: latestLive.claim.holder,
    actor: latestLive.claim.actor,
    claimedAt: latestLive.claim.claimedAt,
    lastSeen: latestLive.claim.lastSeen,
  };
}
