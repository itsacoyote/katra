/**
 * Claiming and releasing a task: the compare-and-set at the center of F4.
 *
 * A claim ties one task to one worktree. `claims.task_id` is the primary key
 * (migration 0003), which is what makes "at most one claim per task" a schema
 * guarantee rather than an application-level check a race could slip past —
 * but the schema alone is not enough: **check-then-act must be one
 * transaction**, or two processes can both see "unclaimed" and both insert
 * before either commits. Every function here runs its compare-and-set inside
 * a single `writeTx` (`BEGIN IMMEDIATE`), the same discipline `lifecycle.ts`'s
 * `transition` uses for its terminal-lane guards (spec §11).
 *
 * **Identity resolves before the transaction opens**, exactly like `actor.ts`
 * requires of every write path: `store.actor()` and `store.identity()` spawn
 * git subprocesses the first time a process calls them, and doing that under
 * `BEGIN IMMEDIATE` would widen the write-lock window by a process spawn on
 * every claim and release.
 *
 * **The path-recycling hazard is accepted, not solved.** A worktree deleted
 * and later recreated at the same filesystem path inherits whatever claim
 * that path held — `holder` is the absolute worktree path (ADR-007), and
 * nothing here can distinguish "the same worktree, still working" from "a new
 * worktree that happens to reuse an old path". ADR-007 rejected identifying a
 * worktree any other way for the same reason events do: a path survives a
 * branch rename, which is exactly the property claims need most. The remedy
 * is the one the spec already gives every stale claim — `release --force`,
 * informed by the last-seen age every conflict here reports.
 */

import { timeAgo } from "../clock.js";
import { writeTx } from "../db/connection.js";
import { isTerminal } from "../enums.js";
import { KatraException } from "../errors.js";
import { appendEvent, epicIdFor } from "../events/repo.js";
import { narrowNullableText, narrowText } from "../narrow.js";
import type { OpenStore } from "../store.js";
import { requireId } from "../tasks/ids.js";
import { getTask } from "../tasks/repo.js";
import type { Task } from "../tasks/types.js";
import type { ClaimInfo } from "./types.js";

/** The raw shape SQLite hands back for a claim joined against presence. */
interface ClaimRow {
  readonly holder: unknown;
  readonly actor: unknown;
  readonly claimed_at: unknown;
  readonly branch: unknown;
  readonly last_seen: unknown;
}

/** Maps one row into a domain object, narrowing every column. */
function rowToClaimInfo(row: ClaimRow): ClaimInfo {
  return {
    holder: narrowText(row.holder, "holder"),
    actor: narrowText(row.actor, "actor"),
    claimedAt: narrowText(row.claimed_at, "claimed_at"),
    branch: narrowNullableText(row.branch, "branch"),
    lastSeen: narrowNullableText(row.last_seen, "last_seen"),
  };
}

const SELECT_CLAIM = `
  SELECT c.holder, c.actor, c.claimed_at, p.branch, p.last_seen
    FROM claims c
    LEFT JOIN presence p ON p.worktree = c.holder
   WHERE c.task_id = ?
`;

/**
 * The claim on `taskId`, with `branch`/`lastSeen` joined live off `presence`
 * — or `null` when the task is unclaimed.
 *
 * The join is LEFT, not INNER: a holder with no presence row (one that has
 * never had a command bump its heartbeat) still has a claim, just with a
 * `branch`/`lastSeen` katra cannot report — see `claims/types.ts`.
 *
 * `taskId` is an already-resolved id, like `getTask` — this reads one row and
 * has no business resolving a partial id itself. What `brief`/`show` (T8)
 * call to fill a single task's claim; `board` (T7) joins `claims` directly in
 * its own section queries instead, so this is never called once per board row.
 */
export function claimFor(store: OpenStore, taskId: string): ClaimInfo | null {
  const row = store.db.prepare(SELECT_CLAIM).get(taskId) as ClaimRow | undefined;
  return row === undefined ? null : rowToClaimInfo(row);
}

/**
 * Rejects a task that cannot be claimed: an epic, or a task already in a
 * terminal lane.
 *
 * Both are `validation`/exit 1, not `conflict`/exit 3 — the rule that
 * refuses them is fixed by the task's own shape, not by the state of a
 * competing claim, so there is no contention to report. Runs inside the same
 * transaction as the compare-and-set that follows it, so a task cannot be
 * reopened or reparented into claimability in the window between this check
 * and the insert.
 */
function requireClaimable(store: OpenStore, id: string, idInput: string): Task {
  const task = getTask(store, id);
  if (task === undefined) {
    throw new KatraException({ code: "not_found", message: `no task matches "${idInput}"`, id });
  }
  if (task.level === "epic") {
    throw new KatraException({
      code: "validation",
      message:
        `${id} is an epic — an epic tracks its children's work, so it is not itself ` +
        "claimed. Claim one of its tasks instead.",
      field: "level",
      value: task.level,
    });
  }
  if (isTerminal(task.lane)) {
    throw new KatraException({
      code: "validation",
      message: `${id} is already ${task.lane} — reopen it before claiming it`,
      field: "lane",
      value: task.lane,
    });
  }
  return task;
}

/** What claiming a task hands back. */
export interface ClaimResult {
  readonly task: Task;
  readonly claim: ClaimInfo;
}

/**
 * Claims a task for this invocation's worktree, or no-ops if it already
 * holds it.
 *
 * One `writeTx`: `requireId`, the epic/terminal guard, the holder check, the
 * insert and the `claimed` event all run inside `BEGIN IMMEDIATE`, so no
 * other writer can see "unclaimed" between the check and the insert (spec
 * §11's TOCTOU rule — see the module docs).
 *
 * **Held by another worktree**: refused with `conflict`/exit 3. The message
 * names the holder's actor, its last-seen age (joined live off `presence` via
 * `claimFor`), and the unblock — `release --force to take it over` — because
 * a refusal that only says no forces the reader to guess (spec's
 * rich-blocked-feedback principle). That unblock is carried in the message
 * itself, not a `formatErrorHint` case in `cli/output.ts`: `conflict` is
 * thrown by several unrelated sites across the core, and a code-keyed hint
 * would advertise force-release on every one of them, most of which have
 * nothing to force.
 *
 * **Held by this worktree already**: a no-op success. No second `claimed`
 * event, and the stamped `actor`/`claimedAt` are left exactly as they were —
 * ADR-012 leans on this to make a claim safe to repeat after a session loses
 * its context (`/clear`, crash, restart): resuming an already-claimed task
 * must not look like a fresh claim, or read as one in the event stream.
 */
export function claimTask(store: OpenStore, idInput: string): ClaimResult {
  // Before the transaction: resolving identity spawns git subprocesses, and
  // doing that under BEGIN IMMEDIATE would hold the write lock across them —
  // see the module docs.
  const actor = store.actor();
  const worktree = store.identity().worktree;

  return writeTx(store.db, (now) => {
    const id = requireId(store, idInput);
    const task = requireClaimable(store, id, idInput);

    const existing = claimFor(store, id);
    if (existing !== null) {
      if (existing.holder !== worktree) {
        // `lastSeen` falls back to `claimedAt` when the holder has no
        // presence row (see claimFor): every real claim pays for a heartbeat
        // the moment it is made, since claiming opens a store, but the
        // message must still be honest in the pathological case where that
        // heartbeat never landed.
        const age = timeAgo(existing.lastSeen ?? existing.claimedAt, now);
        throw new KatraException({
          code: "conflict",
          message:
            `${id} is held by ${existing.actor}, last seen ${age} — ` +
            "release --force to take it over",
          reason: `held by ${existing.actor}`,
        });
      }
      // Same worktree: idempotent no-op, no event — see the function docs.
      return { task, claim: existing };
    }

    store.db
      .prepare("INSERT INTO claims (task_id, holder, actor, claimed_at) VALUES (?,?,?,?)")
      .run(id, worktree, actor, now);

    appendEvent(store, { type: "claimed", entityId: id, epicId: epicIdFor(task), actor }, now);

    const claim = claimFor(store, id);
    if (claim === null) {
      throw new KatraException({
        code: "not_found",
        message: `claim on ${id} vanished immediately after being inserted`,
        id,
      });
    }
    return { task, claim };
  });
}

/** What releasing a claim hands back. */
export interface ReleaseResult {
  readonly task: Task;
  /** The claim as it stood immediately before this release. */
  readonly claim: ClaimInfo;
}

export interface ReleaseOptions {
  /** Release even when this worktree is not the holder. */
  readonly force?: boolean;
}

/**
 * Releases a task's claim.
 *
 * One `writeTx`, mirroring `claimTask`'s compare-and-set: `requireId`, the
 * holder check, the delete and the `released` event all run inside `BEGIN
 * IMMEDIATE`.
 *
 * **Held by this worktree**: released, `released` event appended, no
 * `priorActor` — a plain self-release has no one to displace.
 *
 * **Held by another worktree, no `force`**: refused with `conflict`/exit 3,
 * naming the holder — the same message shape `claimTask` throws, and for the
 * same reason (see there): the unblock rides in the message, not a
 * `formatErrorHint` case.
 *
 * **Held by another worktree, `force: true`**: released anyway, and the
 * `released` event's `priorActor` (migration 0003) names the displaced
 * holder's frozen actor string — the takeover is legible from the event
 * alone, with no second query.
 *
 * **No claim at all**: `not_found`/exit 1 — the request is well-formed, there
 * is simply nothing to release, the same shape `removeDependency` uses for
 * "that edge is not there".
 */
export function releaseTask(
  store: OpenStore,
  idInput: string,
  options: ReleaseOptions = {},
): ReleaseResult {
  // Before the transaction, for the same reason as claimTask.
  const actor = store.actor();
  const worktree = store.identity().worktree;
  const force = options.force ?? false;

  return writeTx(store.db, (now) => {
    const id = requireId(store, idInput);
    const task = getTask(store, id);
    if (task === undefined) {
      throw new KatraException({ code: "not_found", message: `no task matches "${idInput}"`, id });
    }

    const claim = claimFor(store, id);
    if (claim === null) {
      throw new KatraException({ code: "not_found", message: `${id} has no claim to release`, id });
    }

    const isHolder = claim.holder === worktree;
    if (!isHolder && !force) {
      throw new KatraException({
        code: "conflict",
        message: `${id} is held by ${claim.actor} — release --force to take it over`,
        reason: `held by ${claim.actor}`,
      });
    }

    store.db.prepare("DELETE FROM claims WHERE task_id = ?").run(id);

    appendEvent(
      store,
      {
        type: "released",
        entityId: id,
        epicId: epicIdFor(task),
        actor,
        // Only set when this release displaces someone else's claim: a plain
        // self-release has no prior holder to name (migration 0003).
        priorActor: isHolder ? null : claim.actor,
      },
      now,
    );

    return { task, claim };
  });
}
