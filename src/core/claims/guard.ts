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
 * instead: one read for every row held by another worktree — `claims` holds
 * only active claims, so this is tiny — then one indexed-by-`entity_id` read
 * per candidate task for its own displacement history. K+1 reads total,
 * whatever the store's total event count.
 *
 * **Never writes.** `guardCheck` only reads `claims`/`events`/`presence`
 * through the store it is handed. The heartbeat every command pays
 * (`bumpPresence`, ADR-011) still rides on `openStore` before this ever runs
 * — that is a property of opening the store, not of this function, and
 * ADR-019's "never writes" is scoped to `claims`/`tasks`/`events` exactly the
 * way that ADR's own amendment states.
 */

import { worktreeFromActor } from "../actor.js";
import type { GuardResult } from "../contract.js";
import { rowToEvent } from "../events/repo.js";
import { narrowText } from "../narrow.js";
import type { OpenStore } from "../store.js";
import { assembleClaimInfo, claimsHeldBy } from "./repo.js";
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

/** The raw shape SQLite hands back for a `claims` row not held by this worktree, joined against `presence`. */
interface ForeignClaimRow {
  readonly task_id: unknown;
  readonly holder: unknown;
  readonly actor: unknown;
  readonly claimed_at: unknown;
  readonly branch: unknown;
  readonly last_seen: unknown;
}

const SELECT_CLAIMS_HELD_ELSEWHERE = `
  SELECT c.task_id, c.holder, c.actor, c.claimed_at, p.branch, p.last_seen
    FROM claims c
    LEFT JOIN presence p ON p.worktree = c.holder
   WHERE c.holder != ?
   ORDER BY c.claimed_at, c.task_id
`;

/**
 * The shape {@link rowToEvent} narrows — extracted from its own signature
 * rather than redeclared, so this file cannot drift from the row shape that
 * function actually expects (`events/repo.ts` does not export its own
 * `EventRow` — the type has no name outside that module, only this shape).
 */
type EventRow = Parameters<typeof rowToEvent>[0];

/**
 * Every `released` event on `taskId` that names a `prior_actor` at all — the
 * only events a displacement could be — newest first via the `entity_id`
 * index.
 */
const SELECT_DISPLACEMENT_EVENTS = `
  SELECT * FROM events
   WHERE entity_id = ? AND type = 'released' AND prior_actor IS NOT NULL
   ORDER BY id DESC
`;

/**
 * The most recent event on `taskId` that displaced `worktree` — a `released`
 * event whose `prior_actor` names `worktree` and whose own `actor` names a
 * different one — or `null` when `worktree` was never displaced from this
 * task.
 *
 * Rows arrive newest-first (`ORDER BY id DESC`), so the first match found is
 * already the most recent — no separate ranking step needed for the
 * single-task case; {@link mostRecentTenure} ranks *across* tasks.
 */
function findDisplacement(
  store: OpenStore,
  taskId: string,
  worktree: string,
): { readonly eventId: number; readonly displacedAt: string } | null {
  const rows = store.db.prepare(SELECT_DISPLACEMENT_EVENTS).all(taskId) as EventRow[];
  for (const row of rows) {
    const event = rowToEvent(row);
    // prior_actor is non-null by the WHERE clause; narrowed again here
    // because rowToEvent's return type still admits null on every other type.
    if (event.priorActor === null) continue;
    if (worktreeFromActor(event.priorActor) !== worktree) continue;
    if (worktreeFromActor(event.actor) === worktree) continue; // self-release: never counts
    return { eventId: event.id, displacedAt: event.createdAt };
  }
  return null;
}

/** The later of a claim's presence `lastSeen` and its own `claimedAt` — "never seen" reads as "as fresh as the claim itself", never as dead. */
function rivalRecency(claim: ClaimInfo): string {
  if (claim.lastSeen === null) return claim.claimedAt;
  return claim.lastSeen > claim.claimedAt ? claim.lastSeen : claim.claimedAt;
}

/** Whether a rival's claim is live against `floor`, per {@link GuardOptions.livenessFloor}'s own docs. */
function isLive(claim: ClaimInfo, floor: string): boolean {
  return rivalRecency(claim) >= floor;
}

/** The candidate with the highest event id — the total order {@link DisplacedTenure.eventId}'s own docs explain. Callers only ever pass a non-empty list. */
function mostRecentTenure(tenures: readonly DisplacedTenure[]): DisplacedTenure {
  return tenures.reduce((latest, candidate) =>
    candidate.eventId > latest.eventId ? candidate : latest,
  );
}

function defaultLivenessFloor(): string {
  return new Date(Date.now() - GUARD_LIVENESS_DEFAULT_MS).toISOString();
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

  const rows = store.db.prepare(SELECT_CLAIMS_HELD_ELSEWHERE).all(worktree) as ForeignClaimRow[];

  const displaced: DisplacedTenure[] = [];
  for (const row of rows) {
    const taskId = narrowText(row.task_id, "task_id");
    const displacement = findDisplacement(store, taskId, worktree);
    if (displacement === null) continue;
    const claim = assembleClaimInfo(
      row.holder,
      row.actor,
      row.claimed_at,
      row.branch,
      row.last_seen,
    );
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
