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
 * informed by the liveness every conflict here reports.
 *
 * **A related, smaller hazard**: where there is no work tree for git to
 * report — a bare repository, or a command run from inside `.git` itself —
 * `resolveWorktree` (`actor.ts`) falls back to `cwd` verbatim rather than a
 * resolved root. A holder that claims from one subdirectory of such a
 * repository and later releases from another is, as far as `holder` is
 * concerned, a different worktree — its own claim refuses it, and it must
 * `--force` to take over from itself. Also documented rather than hardened:
 * `resolveWorktree` already accepts this trade-off, and claims only inherits it.
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
 * `iso`'s age relative to `now`, or `null` when `iso` cannot be parsed.
 *
 * `timeAgo` itself stays strict — refusing an unparseable timestamp is the
 * right behaviour for every other caller, which hands it a value katra just
 * wrote. `lastSeen` is different: it is read back out of `presence`, a row
 * this module does not control and does not fully trust — the same posture
 * `tasks/repo.ts` takes toward every column, since the store is written by
 * concurrent processes and, for the migration story, older builds. Letting
 * `timeAgo`'s exception escape a conflict message would turn a malformed
 * `last_seen` into a `validation`/exit 1 refusal in the middle of building a
 * `conflict`/exit 3 one — inverting the exact signal ADR-005 exists to keep
 * distinct: "your request was malformed" instead of "this claim is genuinely
 * contended, try something else."
 */
function ageOrUnknown(iso: string, now: string): string | null {
  try {
    return timeAgo(iso, now);
  } catch {
    return null;
  }
}

/**
 * The liveness half of a conflict message: `last seen <age>` when a usable
 * observation exists, `never seen (claimed <age> ago)` when it does not.
 *
 * **`lastSeen === null` is a real, reachable state, not a theoretical one.**
 * `bumpPresence` is deliberately non-fatal (`presence.ts`), so a holder whose
 * very first heartbeat failed — or a session that crashed before finishing
 * its first `openStore` — has a claim with no presence row behind it.
 * Rendering "last seen `<claimed-at age>` ago" for that holder would
 * fabricate an observation katra never made: claiming is not a heartbeat, and
 * conflating the two is exactly wrong at the one moment it matters most — a
 * crashed session is precisely the case `release --force` exists to answer,
 * and it deserves an honest "never seen", not a borrowed timestamp dressed up
 * as one.
 *
 * A presence row that exists but fails to parse ({@link ageOrUnknown})
 * folds into the same `never seen` arm: an unreadable observation is not a
 * usable one either.
 */
function describeLiveness(claim: ClaimInfo, now: string): string {
  const lastSeenAge = claim.lastSeen === null ? null : ageOrUnknown(claim.lastSeen, now);
  if (lastSeenAge !== null) return `last seen ${lastSeenAge}`;

  const claimedAge = ageOrUnknown(claim.claimedAt, now) ?? "an unknown time";
  return `never seen (claimed ${claimedAge} ago)`;
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
 * names the holder's actor, its liveness (`describeLiveness` — "last seen
 * `<age>`" when `presence` backs it, "never seen" when it does not, see
 * there), and the unblock — `release --force to take it over` — because a
 * refusal that only says no forces the reader to guess (spec's
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
        throw new KatraException({
          code: "conflict",
          message:
            `${id} is held by ${existing.actor}, ${describeLiveness(existing, now)} — ` +
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
      // Unreachable in practice: the insert above and this read share the
      // same IMMEDIATE transaction, so nothing else could have removed the
      // row in between. `internal`, not `not_found` — the request was fine,
      // the machine broke — matching the impossible-state guards
      // `appendEvent`/`assertNotReadOnly` already throw this way.
      throw new KatraException({
        code: "internal",
        message: "claims row disappeared inside its own transaction — this is a katra bug",
      });
    }
    return { task, claim };
  });
}

/**
 * Releases `task`'s claim if one exists, and appends `released` — the shared
 * core of `releaseTask` and every lifecycle path that settles a claim as a
 * side effect (`transition`'s close/cancel move, `deleteTask`).
 *
 * **Must run inside the caller's own open `writeTx`, never its own.**
 * `releaseTask` proves why: it resolves `actor`/`worktree` before opening its
 * transaction (the module docs' rule), so a second, independent `writeTx`
 * here would either fail to nest cleanly or, worse, commit its own claim
 * deletion and `released` event as a transaction separate from whatever
 * caused the release — the exact atomicity the F4 spec requires close/cancel
 * to have with their lifecycle event (spec req 5). `now`/`actor`/`worktree`
 * therefore arrive as parameters, the same shape `appendEvent` already takes
 * `now` in, rather than being resolved here.
 *
 * **Takes the loaded `task`, not an id.** Every caller already has one —
 * `releaseTask` and `deleteTask` load it for their own guards, `transition`
 * for its plan — so this never re-reads it, and `epicIdFor(task)` runs
 * unconditionally: an orphan claim (a `claims` row whose task no longer
 * exists) cannot happen while `claims.task_id` carries its own foreign key
 * with `ON DELETE CASCADE` and every connection runs with `foreign_keys =
 * ON` (`db/connection.ts`).
 *
 * **`priorActor`** follows `releaseTask`'s own rule, restated once so no
 * caller re-derives it: `null` when `worktree` is the claim's own holder (a
 * plain release, nothing displaced), the holder's frozen actor string
 * otherwise — which covers both an explicit force-release and a non-holder
 * settling the claim as a side effect of closing the task (a takeover in
 * every way that matters to the event stream).
 *
 * Returns the claim as it stood immediately before release, or `null` when
 * the task was never claimed — in which case nothing is written at all: no
 * delete, no event. That `null` arm is what keeps close/cancel/delete
 * byte-identical to today's behaviour on an unclaimed task.
 */
export function settleClaim(
  store: OpenStore,
  task: Task,
  actor: string,
  worktree: string,
  now: string,
): ClaimInfo | null {
  const claim = claimFor(store, task.id);
  if (claim === null) return null;

  store.db.prepare("DELETE FROM claims WHERE task_id = ?").run(task.id);

  appendEvent(
    store,
    {
      type: "released",
      entityId: task.id,
      epicId: epicIdFor(task),
      actor,
      priorActor: worktree === claim.holder ? null : claim.actor,
    },
    now,
  );

  return claim;
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
 * naming the holder and its liveness (`describeLiveness`, the same helper
 * and the same "never seen" honesty `claimTask`'s conflict uses) — the same
 * message shape `claimTask` throws, and for the same reason (see there): the
 * unblock rides in the message, not a `formatErrorHint` case.
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
        message:
          `${id} is held by ${claim.actor}, ${describeLiveness(claim, now)} — ` +
          "release --force to take it over",
        reason: `held by ${claim.actor}`,
      });
    }

    // `claim` above already proved a claim exists inside this same
    // transaction, so `settleClaim`'s own return is redundant here — the
    // already-loaded `claim` is byte-identical to it.
    settleClaim(store, task, actor, worktree, now);

    return { task, claim };
  });
}
