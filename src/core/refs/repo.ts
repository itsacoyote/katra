/**
 * Storing and linking external references.
 *
 * A ref is the row-level half of F7: `parseRefInput`/`validateExplicitRef`
 * (`parse.ts`) turn user input into a `{provider, externalId, url}` triple —
 * this module is the only thing that ever writes or reads `refs`/`task_refs`.
 * One `refs` row per unique `(provider, external_id)` pair, shared by every
 * task that links it; `task_refs` is the many-to-many join, at most one row
 * per pair.
 *
 * `Within`/public-wrapper split follows `graph/links.ts` and `notes/repo.ts`
 * exactly: a `*Within` function is the row-mutation core — asserts it is
 * running inside an already-open write transaction, appends **no** event —
 * and the public function (`linkRef`, `unlinkRef`) opens `writeTx`, calls the
 * `Within` seam, appends the event, and returns. `gcOrphanRefsWithin` is the
 * third `Within` seam here, exported so `deleteTask` (T4) can GC a task's refs
 * in the same transaction as its cascading delete — `unlinkRef` is not its
 * only caller.
 *
 * Idempotence runs on `INSERT ... ON CONFLICT (...) DO NOTHING`, targeted
 * explicitly at each table's own unique key — **not** `INSERT OR IGNORE`,
 * which would swallow every constraint violation on the statement (a `CHECK`
 * failure, a `NOT NULL` failure) as silently as the one conflict it is
 * actually meant to absorb. A targeted conflict clause suppresses only that
 * one unique-key collision; anything else — a bad `provider`/`external_id`
 * length, for one — surfaces as the real `SQLITE_CONSTRAINT_CHECK` it is,
 * not a false "already exists" read.
 *
 * The trap that comes with the idempotent insert either way: once
 * `.changes === 0`, `.lastInsertRowid` is **stale** — better-sqlite3 does not
 * reset it on a no-op insert, so it can read back a leftover value from any
 * earlier successful insert on the connection, not "no row" or "this row".
 * The only sound reading is `.changes === 1` means trust it, anything else
 * means re-`SELECT` by the unique key. This is not the app-generated-id
 * collision `insertWithRetry` (`tasks/ids.ts`) handles — `refs.id` is an
 * internal, reusable rowid (no `AUTOINCREMENT`; migration 0005), nobody ever
 * picks one, so a unique-key conflict here is never a signal to try again
 * with a different value, only a signal that the row already exists.
 *
 * `RefInput` is declared here rather than in `refs/types.ts` or `contract.ts`:
 * it is this module's own internal input shape for `linkRef`/`linkRefWithin`,
 * never published — `contract.ts` re-exports only what a `--json` document
 * carries. `RefResult` **is** published, so it lives in `contract.ts`
 * alongside `LinkResult` (F7 T5) and is imported back from there — `action:
 * "linked" | "already-linked" | "url-backfilled" | "unlinked"`, `taskId`,
 * `ref: Ref`.
 *
 * **`"url-backfilled"` is not part of the original design** (validate round
 * 2, finding M1): the plan-era shape had only three actions, on the reasoning
 * that filling in a bare ref's `url` from `NULL` was an idempotence detail —
 * the same "nothing new happened" case as `"already-linked"`. That reasoning
 * missed that `refs.url` is a column **every task linking that row shares**,
 * so the fill-in is a real, visible mutation of shared state, not a no-op —
 * and it was landing with no event and no distinguishable `action`, an
 * audited-writes module with one silent write. `linkRefWithin` now reports it
 * as its own action, and `linkRef` events it exactly like a fresh link (see
 * both functions' docs for the full reasoning and the entity-scoping this
 * implies for a *different* task sharing the same row).
 *
 * **F8 T4 adds this module's fourth `Within` seam and its own public
 * wrapper**: `listOpenTaskRefs`/`listOpenTaskRefsFor` are the read side —
 * every ref linked to at least one open task, the scope `refresh` (T5)
 * resolves against a provider — and `applyRefreshWithin`/`applyRefresh` are
 * the write side, filling `cached_status`/`cached_title`/`synced_at` once a
 * provider has answered and fanning `ref-status-changed` out to every current
 * holder when something actually moved. `core/refs` **never imports
 * `core/providers`**: T3's GitHub provider imports `MAX_CACHED_TITLE_LENGTH`
 * from this package's `parse.ts` instead (the T3 -> T4 edge), which is what
 * makes the reverse direction here a cycle rather than a convenience.
 */

import type { RefResult } from "../contract.js";
import { assertNotReadOnly, writeTx } from "../db/connection.js";
import { sqlEnum, TERMINAL_LANES } from "../enums.js";
import { KatraException } from "../errors.js";
import { appendEvent, epicIdFor } from "../events/repo.js";
import { narrowNullableText, narrowText } from "../narrow.js";
import type { OpenStore } from "../store.js";
import { MAX_CANDIDATES, requireResolved, resolveId } from "../tasks/ids.js";
import { getTask } from "../tasks/repo.js";
import { CONTROL_CHARS_SOURCE, capText } from "../text.js";
import { MAX_CACHED_TITLE_LENGTH } from "./parse.js";
import type { Ref, RefreshOutcome } from "./types.js";

/**
 * What `linkRef`/`linkRefWithin` accept.
 *
 * A reference already recognized or validated upstream — `parseRefInput`'s
 * `ParsedRef` or `validateExplicitRef`'s `ExplicitRef` (both `types.ts`) —
 * this module does no parsing or shape-checking of its own, only storage.
 * Declared structurally rather than as a union of the two so a future third
 * source (a provider plugin, eventually) needs no change here.
 */
export interface RefInput {
  readonly provider: string;
  readonly externalId: string;
  readonly url: string | null;
}

/** The raw shape SQLite hands back for a `refs` row. */
interface RefRow {
  readonly id: unknown;
  readonly provider: unknown;
  readonly external_id: unknown;
  readonly url: unknown;
  readonly cached_status: unknown;
  readonly cached_title: unknown;
  readonly synced_at: unknown;
}

/** A `refs` row, narrowed: the internal rowid alongside the published shape. */
interface RefRecord {
  readonly id: number;
  readonly ref: Ref;
}

/** Maps one row into a domain object, narrowing every column. */
function rowToRef(row: RefRow): Ref {
  return {
    provider: narrowText(row.provider, "provider"),
    externalId: narrowText(row.external_id, "external_id"),
    url: narrowNullableText(row.url, "url"),
    cachedStatus: narrowNullableText(row.cached_status, "cached_status"),
    cachedTitle: narrowNullableText(row.cached_title, "cached_title"),
    syncedAt: narrowNullableText(row.synced_at, "synced_at"),
  };
}

/** Maps one row into `{id, ref}`, narrowing `id` the same way `events/repo.ts` narrows its rowid. */
function rowToRefRecord(row: RefRow): RefRecord {
  if (typeof row.id !== "number" || !Number.isInteger(row.id)) {
    throw new KatraException({
      code: "validation",
      message: `ref id must be an integer — the stored value is ${typeof row.id}, so this row is malformed`,
      field: "id",
      value: row.id,
    });
  }
  return { id: row.id, ref: rowToRef(row) };
}

/**
 * Resolves the task a ref is being linked to or removed from.
 *
 * `requireId` alone would say only that nothing matched. Mirrors
 * `notes/repo.ts`'s `requireNoteTarget` — same reasoning, different verb.
 */
function requireRefTarget(store: OpenStore, input: string): string {
  const resolution = resolveId(store, input);
  if (resolution.kind === "not_found") {
    throw new KatraException({
      code: "not_found",
      message:
        `no task matches "${resolution.input}" — create it with \`katra add\` first, ` +
        "then link a ref to it",
      id: resolution.input,
    });
  }
  return requireResolved(resolution, "task", "tasks");
}

/**
 * Links a reference to a task — the row-mutation core.
 *
 * **Must be called inside an open transaction**; see `addLinkWithin`'s guard,
 * which this mirrors. Writes no event: `linkRef` is the only caller during
 * ordinary use, and appends `ref-linked` itself only when this reports
 * `action: "linked"` or `"url-backfilled"`.
 *
 * Takes no `createdAt` context, unlike `addLinkWithin`/`createNoteWithin`:
 * neither `refs` nor `task_refs` (migration 0005) has a timestamp column to
 * stamp, so there is nothing here for one to do.
 *
 * Two inserts, each `ON CONFLICT` targeted at its own table's unique key:
 *
 * 1. `refs`, keyed on `(provider, external_id)`. `.changes === 1` means this
 *    call created the row and its `lastInsertRowid` is trustworthy; anything
 *    else means the row already existed and must be re-`SELECT`ed — see the
 *    module doc for why `.lastInsertRowid` cannot be trusted in that branch.
 *    When the existing row's `url` is `NULL` and this call's `input.url` is
 *    not, the url is backfilled in the same transaction — a bare Linear id
 *    linked before a URL-bearing paste of the same issue completes the row
 *    rather than losing the URL. The reverse never happens: once a `url` is
 *    stored, no later call — with a null url or a different one — ever
 *    overwrites it. A provider's first-recorded canonical url is not
 *    something a possibly-stale second caller gets to rewrite.
 *
 *    **The backfill is a real mutation of a row every task holding it
 *    shares** (validate round 2, finding M1) — `refs.url` is not scoped to
 *    the task that happens to be calling. `linkRef` treats it accordingly:
 *    when the fill-in is the only thing this call did (`task_refs` already
 *    held the link — see point 2), the action is `"url-backfilled"`, not
 *    `"already-linked"`, precisely because something *did* change and
 *    `"already-linked"` is this module's signal that nothing did. See
 *    `linkRef`'s docs for why that also means an event.
 * 2. `task_refs`, the join row. `.changes === 1` here is a fresh link for
 *    *this task*, regardless of whether the `refs` row itself was just
 *    created or already existed for some other task — and takes precedence
 *    over the backfill signal above: a brand-new link already gets its own
 *    `ref-linked` event (point 1's mutation rides along on it, evented once,
 *    not twice), so `action` is `"linked"` even when this same call also
 *    backfilled the shared row's url.
 */
export function linkRefWithin(
  store: OpenStore,
  taskIdInput: string,
  input: RefInput,
): {
  readonly taskId: string;
  readonly refId: number;
  readonly ref: Ref;
  readonly action: "linked" | "already-linked" | "url-backfilled";
} {
  if (!store.db.inTransaction) {
    throw new KatraException({
      code: "internal",
      message:
        "linkRefWithin must be called inside an open transaction — a ref row " +
        "that commits on its own can outlive the change it's part of",
    });
  }
  assertNotReadOnly(store.db, "linkRefWithin");

  const taskId = requireRefTarget(store, taskIdInput);

  const insertInfo = store.db
    .prepare(
      `INSERT INTO refs (provider, external_id, url) VALUES (?,?,?)
       ON CONFLICT (provider, external_id) DO NOTHING`,
    )
    .run(input.provider, input.externalId, input.url);

  let record: RefRecord;
  // Set only in the "row already existed" branch below, and only when this
  // call actually changed `url` — never for a row this call itself created,
  // which stores `input.url` as an ordinary part of the insert, not a fill-in.
  let urlBackfilled = false;
  if (insertInfo.changes === 1) {
    record = {
      id: Number(insertInfo.lastInsertRowid),
      ref: {
        provider: input.provider,
        externalId: input.externalId,
        url: input.url,
        cachedStatus: null,
        cachedTitle: null,
        syncedAt: null,
      },
    };
  } else {
    // The unique-key conflict was suppressed and the row already exists.
    // `.lastInsertRowid` is stale here (see module doc) — re-SELECT by the
    // unique key rather than trust it.
    const existingRow = store.db
      .prepare("SELECT * FROM refs WHERE provider = ? AND external_id = ?")
      .get(input.provider, input.externalId) as RefRow | undefined;
    if (existingRow === undefined) {
      throw new KatraException({
        code: "internal",
        message:
          `refs (${input.provider}, ${input.externalId}) hit its own unique-key ` +
          "conflict on insert but is not findable by that same key — the write " +
          "lock should make this impossible",
      });
    }
    record = rowToRefRecord(existingRow);

    if (record.ref.url === null && input.url !== null) {
      store.db.prepare("UPDATE refs SET url = ? WHERE id = ?").run(input.url, record.id);
      record = { id: record.id, ref: { ...record.ref, url: input.url } };
      urlBackfilled = true;
    }
  }

  const taskRefInfo = store.db
    .prepare(
      `INSERT INTO task_refs (task_id, ref_id) VALUES (?,?)
       ON CONFLICT (task_id, ref_id) DO NOTHING`,
    )
    .run(taskId, record.id);

  const linkedFresh = taskRefInfo.changes === 1;

  return {
    taskId,
    refId: record.id,
    ref: record.ref,
    action: linkedFresh ? "linked" : urlBackfilled ? "url-backfilled" : "already-linked",
  };
}

/**
 * Links a reference to a task and records that it happened.
 *
 * Idempotent: re-linking the same `(task, provider, externalId)` with nothing
 * new to say is a no-op that reports `already-linked` rather than a duplicate
 * row or a second event.
 *
 * **A url backfill is not that.** `refs.url` is a column every task linking
 * that row shares, so filling it in from `NULL` on a re-add is a real,
 * store-wide mutation — an unaudited one before this fix (validate round 2,
 * finding M1): the row visibly changed for every task holding it, `linkRef`
 * reported `already-linked` (this module's own definition of "nothing
 * changed"), and no event recorded that anything happened. A `ref-linked`
 * event now fires whenever `linkRefWithin` reports `"linked"` **or**
 * `"url-backfilled"` — the same event type either way, since both mean this
 * task's own link now points at a ref with a url it did not have a moment
 * ago, which is exactly what a reader of this task's history needs to know.
 * The event's `entityId` is the task that issued *this* command, per ADR-008 —
 * a different task sharing the same `refs` row sees its own rendered url
 * change with no event of its own, which is correct: nothing happened to
 * *that* task's link, only to a column the two rows both read from, and its
 * own history is unchanged (see `linkRefWithin`'s docs for the audit trail
 * that does exist: `ref.externalId` names one row across every task's log).
 *
 * The ref, the `task_refs` row and the event — when one is written at all —
 * share one transaction and one timestamp.
 */
export function linkRef(
  store: OpenStore,
  taskIdInput: string,
  input: RefInput,
): RefResult & { readonly action: "linked" | "already-linked" | "url-backfilled" } {
  // Before the transaction: resolving the actor spawns git subprocesses, and
  // under `BEGIN IMMEDIATE` that holds the write lock across both.
  const actor = store.actor();

  return writeTx(store.db, (now) => {
    const { taskId, ref, action } = linkRefWithin(store, taskIdInput, input);

    if (action === "linked" || action === "url-backfilled") {
      const task = getTask(store, taskId);
      if (task === undefined) {
        throw new KatraException({
          code: "internal",
          message: `task ${taskId} disappeared between being linked and being read`,
        });
      }

      appendEvent(
        store,
        {
          type: "ref-linked",
          entityId: taskId,
          epicId: epicIdFor(task),
          actor,
          // The qualified external id (spec §4) — already the canonical,
          // provider-scoped identity (`owner/repo#12`, `ENG-451`), not the
          // internal rowid.
          ref: ref.externalId,
        },
        now,
      );
    }

    return { action, taskId, ref };
  });
}

const NUMERIC_INPUT_PATTERN = /^[0-9]+$/;

/** One line describing a ref candidate, for an ambiguous-remove refusal. */
function describeRefCandidate(ref: Ref): string {
  return ref.url === null
    ? `${ref.provider}: ${ref.externalId}`
    : `${ref.provider}: ${ref.externalId} (${ref.url})`;
}

/**
 * `taskId`'s own linked refs, in **link order** — `task_refs`'s own rowid
 * (an ordinary rowid table; no `WITHOUT ROWID` on it, migration 0005), not
 * `refs.id`. The two diverge whenever a ref that already existed for some
 * other task is linked to this one after a ref that was created fresh: link
 * order is what `requireLinkedRef`'s candidate list and `listRefs`/`show`/
 * `brief` should render, not "whichever `refs` row happened to be created
 * first, elsewhere." Shared by both — the only two readers of `task_refs`
 * joined to `refs`.
 */
function linkedRefRows(store: OpenStore, taskId: string): RefRow[] {
  return store.db
    .prepare(
      `SELECT r.* FROM refs r
         JOIN task_refs tr ON tr.ref_id = r.id
        WHERE tr.task_id = ?
        ORDER BY tr.rowid`,
    )
    .all(taskId) as RefRow[];
}

/**
 * Splits `input` into a `{provider, id}` guess on its **first** `:` — the
 * `provider:externalId` resolution form, `describeRefCandidate`'s own shape
 * (modulo the space its rendering adds after the colon, which this trims
 * away so a copy-pasted candidate line still resolves). `undefined` when
 * `input` has no colon at all, so a bare `owner/repo#12` or `ENG-451` never
 * reaches this tier with a nonsensical split.
 *
 * Splitting on the *first* colon, not looking for a unique one, is
 * deliberate: `externalId` itself may contain one (a Jira-style
 * `PROJECT:123`, hypothetically), and `provider` never legitimately does —
 * `validateExplicitRef` accepts an arbitrary provider string, but every real
 * one, GitHub/Linear included, is a short bare word.
 */
function splitProviderId(
  input: string,
): { readonly provider: string; readonly id: string } | undefined {
  const colonIndex = input.indexOf(":");
  if (colonIndex === -1) return undefined;
  return { provider: input.slice(0, colonIndex).trim(), id: input.slice(colonIndex + 1).trim() };
}

/**
 * Resolves `refInput` against `taskId`'s **own** linked refs — never the
 * whole `refs` table, and never `resolveId`/`requireId` (risk note 17: those
 * range-scan `kt-`-prefixed ids against `tasks`, the wrong table entirely).
 *
 * Three resolution forms, every comparison case-insensitive
 * (`toLowerCase()`, locale-independent) and never through `parseRefInput`
 * (this lets an escape-hatch ref with a `NULL` url be removed by its id, and
 * a differently-cased re-typing of an accepted input resolve back to the row
 * it named — spec amendment, epic comment 2): exact **url** match, exact
 * **`provider:externalId`** match (split on the input's first colon,
 * {@link splitProviderId} — added by validate round 2's finding M2: two refs
 * can share both `external_id`, e.g. a Jira-style `SHARED-1` reused across
 * providers, *and*, via the explicit escape hatch, `url` — a case neither of
 * the other two forms can tell apart no matter which one a caller tries,
 * since both rows match either one identically; `provider:externalId` is the
 * only input shape guaranteed unique per row, `refs`'s own
 * `UNIQUE (provider, external_id)` constraint, migration 0005), and bare
 * **`external_id`**, regardless of provider — the original, provider-blind
 * form.
 *
 * **Every row matching *any* of the three counts once**, unioned rather than
 * tried as exclusive alternatives — a task can hold two entirely different
 * refs where one's url and the other's external_id both happen to equal the
 * input string (a real, tested case: an explicit ref stored with its id set
 * to another ref's url, verbatim), and both are genuinely what the input
 * could mean. Silently keeping only the first criterion's hit would resolve
 * the "wrong" one without ever telling the caller the other existed. The one
 * exception is the `provider:externalId` split itself: it is **not**
 * attempted when the input already matched by url, because a url routinely
 * contains a `:` of its own (`https:`) that would otherwise feed the split
 * nonsense — a candidate that can never legitimately match a stored
 * `provider` and so costs a query for nothing. A row satisfying more than
 * one criterion at once (theoretically possible, never seen in practice)
 * counts once, not twice — matches are deduplicated by `refs.id`.
 *
 * Only once the union comes back empty does a purely numeric input get its
 * own refusal, naming the two accepted forms — the internal rowid is never
 * published and never a valid input (spec amendment), but a provider whose
 * own qualified id happens to be all digits (a Jira/Bugzilla-style numeric
 * id via the escape hatch) is a real, removable external_id and must resolve
 * like any other, which the bare-`external_id` criterion above already gave
 * it the chance to do. Two or more matches refuse, naming every match
 * (capped at {@link MAX_CANDIDATES}, `tasks/ids.ts`'s own bound, the same
 * reason a partial-id match caps there) so a url or a `provider:id` pair can
 * disambiguate them.
 */
function requireLinkedRef(store: OpenStore, taskId: string, refInput: string): RefRecord {
  const trimmed = refInput.trim();
  const lower = trimmed.toLowerCase();

  const records = linkedRefRows(store, taskId).map(rowToRefRecord);

  const urlMatches = records.filter(
    (record) => record.ref.url !== null && record.ref.url.toLowerCase() === lower,
  );

  const providerIdMatches: RefRecord[] = [];
  if (urlMatches.length === 0) {
    const split = splitProviderId(trimmed);
    if (split !== undefined && split.provider !== "" && split.id !== "") {
      const providerLower = split.provider.toLowerCase();
      const idLower = split.id.toLowerCase();
      providerIdMatches.push(
        ...records.filter(
          (record) =>
            record.ref.provider.toLowerCase() === providerLower &&
            record.ref.externalId.toLowerCase() === idLower,
        ),
      );
    }
  }

  const bareIdMatches = records.filter((record) => record.ref.externalId.toLowerCase() === lower);

  const seenIds = new Set<number>();
  const matches: RefRecord[] = [];
  for (const candidate of [...urlMatches, ...providerIdMatches, ...bareIdMatches]) {
    if (seenIds.has(candidate.id)) continue;
    seenIds.add(candidate.id);
    matches.push(candidate);
  }

  if (matches.length === 0) {
    if (NUMERIC_INPUT_PATTERN.test(trimmed)) {
      throw new KatraException({
        code: "validation",
        message:
          `"${trimmed}" looks like a ref's internal row id, which is never a valid input — ` +
          "remove a ref by its url or its qualified id (for example owner/repo#12, ENG-451)",
        field: "ref",
        value: trimmed,
      });
    }
    // The likeliest real miss is a URL variant `add` canonicalized away
    // (`.../pull/5/files` was stored as `.../pull/5`) — this resolver matches
    // stored values literally, so point at where the stored forms are listed.
    throw new KatraException({
      code: "not_found",
      message:
        `no ref matching "${trimmed}" is linked to ${taskId} — ` +
        `use the url or qualified id exactly as \`katra show ${taskId}\` lists them`,
      id: trimmed,
    });
  }

  if (matches.length > 1) {
    const truncated = matches.length > MAX_CANDIDATES;
    throw new KatraException({
      code: "ambiguous_id",
      message:
        (truncated
          ? `"${trimmed}" matches more than ${MAX_CANDIDATES} refs linked to ${taskId} — here are the first ${MAX_CANDIDATES}`
          : `"${trimmed}" matches ${matches.length} refs linked to ${taskId}`) +
        " — disambiguate with the url, or with the provider:id form " +
        "(for example, github:owner/repo#12)",
      input: trimmed,
      candidates: matches.slice(0, MAX_CANDIDATES).map((match) => describeRefCandidate(match.ref)),
      truncated,
    });
  }

  const [match] = matches;
  if (match === undefined) {
    // Unreachable: the length checks above leave exactly one element.
    throw new KatraException({
      code: "internal",
      message: "requireLinkedRef found exactly one match and then lost it",
    });
  }
  return match;
}

/**
 * Removes a ref from a task — the row-mutation core.
 *
 * **Must be called inside an open transaction**, same guard as
 * `linkRefWithin`. Writes no event and does no orphan GC — `unlinkRef` does
 * both after this returns, inside the same transaction.
 */
export function unlinkRefWithin(
  store: OpenStore,
  taskIdInput: string,
  refInput: string,
): { readonly taskId: string; readonly refId: number; readonly ref: Ref } {
  if (!store.db.inTransaction) {
    throw new KatraException({
      code: "internal",
      message:
        "unlinkRefWithin must be called inside an open transaction — a task_refs " +
        "row deleted on its own can outlive the change it's part of",
    });
  }
  assertNotReadOnly(store.db, "unlinkRefWithin");

  const taskId = requireRefTarget(store, taskIdInput);
  const match = requireLinkedRef(store, taskId, refInput);

  const changes = store.db
    .prepare("DELETE FROM task_refs WHERE task_id = ? AND ref_id = ?")
    .run(taskId, match.id).changes;

  if (changes === 0) {
    // Unreachable under the write lock: `requireLinkedRef` and this DELETE
    // run inside the same `BEGIN IMMEDIATE` transaction, so nothing else can
    // remove the row in between. Defensive only — refuse cleanly rather than
    // silently report success if this is ever somehow reached.
    throw new KatraException({
      code: "not_found",
      message: `no ref matching "${refInput}" is linked to ${taskId}`,
      id: refInput,
    });
  }

  return { taskId, refId: match.id, ref: match.ref };
}

/**
 * Removes a ref from a task and records that it happened.
 *
 * Resolution, deletion, the `ref-unlinked` event and orphan GC all share one
 * transaction: a ref that no longer has any holder is deleted in the same
 * commit as the removal that orphaned it (spec requirement 6).
 */
export function unlinkRef(
  store: OpenStore,
  taskIdInput: string,
  refInput: string,
): RefResult & { readonly action: "unlinked" } {
  const actor = store.actor();

  return writeTx(store.db, (now) => {
    const { taskId, refId, ref } = unlinkRefWithin(store, taskIdInput, refInput);

    const task = getTask(store, taskId);
    if (task === undefined) {
      throw new KatraException({
        code: "internal",
        message: `task ${taskId} disappeared between being unlinked and being read`,
      });
    }

    appendEvent(
      store,
      {
        type: "ref-unlinked",
        entityId: taskId,
        epicId: epicIdFor(task),
        actor,
        ref: ref.externalId,
      },
      now,
    );

    gcOrphanRefsWithin(store, [refId]);

    return { action: "unlinked", taskId, ref };
  });
}

/**
 * Deletes any of `refIds` that no longer have a `task_refs` holder.
 *
 * **Must be called inside an open transaction** — the same guard every other
 * seam in this module carries. Exported so `deleteTask` (T4) can call it in
 * the same transaction as its cascading delete: `task_refs` cascades away
 * with the task (migration 0005's `ON DELETE CASCADE`), so a task's ref ids
 * must be read out **before** that delete runs — this function only ever
 * sees the aftermath, never triggers it.
 *
 * One `DELETE ... WHERE NOT EXISTS` per id rather than a read-then-write pair:
 * inside a single write transaction there is no race between the two steps
 * to protect against, so a combined statement is just less to run twice.
 */
export function gcOrphanRefsWithin(store: OpenStore, refIds: readonly number[]): void {
  if (!store.db.inTransaction) {
    throw new KatraException({
      code: "internal",
      message:
        "gcOrphanRefsWithin must be called inside an open transaction — deleting " +
        "an orphaned refs row outside the transaction that dropped its last " +
        "holder could race a concurrent link that just gave it a new one",
    });
  }
  assertNotReadOnly(store.db, "gcOrphanRefsWithin");

  const stmt = store.db.prepare(
    "DELETE FROM refs WHERE id = ? AND NOT EXISTS (SELECT 1 FROM task_refs WHERE ref_id = ?)",
  );
  for (const refId of refIds) {
    stmt.run(refId, refId);
  }
}

/**
 * Lists a task's own linked refs, oldest link first — see {@link linkedRefRows}
 * for why that is `task_refs`'s own rowid and not `refs.id`. The resolving
 * entry point core keeps for a future `ref list`/library surface; in-tree,
 * composition goes through {@link listRefsFor} and no production caller
 * remains here today.
 */
export function listRefs(store: OpenStore, taskIdInput: string): Ref[] {
  const taskId = requireRefTarget(store, taskIdInput);
  return listRefsFor(store, taskId);
}

/**
 * {@link listRefs} minus the id resolution, for callers holding an
 * already-resolved id — `viewTask` and `briefEntity` resolve before composing,
 * so routing them through `listRefs` would re-scan `tasks` for an id that
 * cannot miss and dead-end its friendlier refusal.
 */
export function listRefsFor(store: OpenStore, taskId: string): Ref[] {
  return linkedRefRows(store, taskId).map(rowToRef);
}

/**
 * One `refs` row {@link listOpenTaskRefs}/{@link listOpenTaskRefsFor} found
 * linked to at least one open task, with every one of *those* open holders —
 * never a terminal-lane one, and never {@link applyRefresh}'s own later,
 * fresher holder read (see that function's docs for why the two deliberately
 * do not share one query: a scoping read taken before a network round trip
 * and a fan-out read taken at write time cannot promise to agree).
 */
export interface OpenRef {
  readonly refId: number;
  readonly ref: Ref;
  readonly holderIds: readonly string[];
}

/**
 * Groups the flat ref+holder rows {@link listOpenTaskRefs}/
 * {@link listOpenTaskRefsFor} share into one {@link OpenRef} per unique
 * `refs.id`, holder ids in the query's own order (`task_refs`'s rowid — link
 * order, the same convention {@link linkedRefRows} documents).
 */
function groupOpenRefRows(
  rows: ReadonlyArray<RefRow & { readonly holder_id: unknown }>,
): OpenRef[] {
  const order: number[] = [];
  const byId = new Map<number, { readonly ref: Ref; readonly holderIds: string[] }>();

  for (const row of rows) {
    const record = rowToRefRecord(row);
    const holderId = narrowText(row.holder_id, "task_id");

    let entry = byId.get(record.id);
    if (entry === undefined) {
      entry = { ref: record.ref, holderIds: [] };
      byId.set(record.id, entry);
      order.push(record.id);
    }
    entry.holderIds.push(holderId);
  }

  return order.map((refId) => {
    const entry = byId.get(refId);
    if (entry === undefined) {
      // Unreachable: every id in `order` was inserted into `byId` in the same
      // loop iteration, immediately above.
      throw new KatraException({
        code: "internal",
        message: "groupOpenRefRows lost a ref id it just grouped",
      });
    }
    return { refId, ref: entry.ref, holderIds: entry.holderIds };
  });
}

/**
 * Every ref currently linked to at least one **open** task — any lane except
 * {@link TERMINAL_LANES} — deduped to one entry per `refs.id`. `refresh` (T5)
 * runs this with no explicit ids: "every ref linked to open tasks" (spec req
 * 5).
 *
 * **No `level` filter — epic-held refs are refreshed too.** `linkRefWithin`
 * places no restriction on which level can hold a ref (the existing "epic
 * takes a ref and lists it" test in this suite proves it), and an epic's own
 * lane is exactly as terminal or non-terminal as a task's. Filtering
 * `task_refs` by level here would silently stop refreshing every ref an epic
 * holds the moment this query started existing — nothing about `refresh`'s
 * job cares which level a holder is, only whether it is still open.
 */
export function listOpenTaskRefs(store: OpenStore): OpenRef[] {
  const rows = store.db
    .prepare(
      `SELECT r.*, tr.task_id AS holder_id
         FROM refs r
         JOIN task_refs tr ON tr.ref_id = r.id
         JOIN tasks t ON t.id = tr.task_id
        WHERE t.lane NOT IN (${sqlEnum(TERMINAL_LANES)})
        ORDER BY r.id, tr.rowid`,
    )
    .all() as Array<RefRow & { readonly holder_id: unknown }>;

  return groupOpenRefRows(rows);
}

/**
 * {@link listOpenTaskRefs}, scoped to `taskIds` — `refresh <ids...>`'s own
 * query (spec req 5: "with ids, just those tasks' refs"). Takes
 * already-resolved task ids, exactly as {@link listRefsFor} does relative to
 * {@link listRefs}: resolving a raw CLI argument, and refusing a nonexistent
 * one with the house `not_found` shape, is `refresh`'s own job — this
 * function only joins and filters what it is handed.
 *
 * Still lane-filtered, same as the unscoped form: a task named explicitly
 * that is not open contributes no rows, exactly as if it held no refs at
 * all — the "open task" invariant this function's name promises does not
 * bend just because a caller named the task directly instead of this
 * function finding it on its own.
 *
 * Empty input returns no rows without ever reaching the database: a bare SQL
 * `IN ()` is invalid syntax, not an empty-set match.
 */
export function listOpenTaskRefsFor(store: OpenStore, taskIds: readonly string[]): OpenRef[] {
  if (taskIds.length === 0) return [];

  const placeholders = taskIds.map(() => "?").join(",");
  const rows = store.db
    .prepare(
      `SELECT r.*, tr.task_id AS holder_id
         FROM refs r
         JOIN task_refs tr ON tr.ref_id = r.id
         JOIN tasks t ON t.id = tr.task_id
        WHERE t.lane NOT IN (${sqlEnum(TERMINAL_LANES)})
          AND t.id IN (${placeholders})
        ORDER BY r.id, tr.rowid`,
    )
    .all(...taskIds) as Array<RefRow & { readonly holder_id: unknown }>;

  return groupOpenRefRows(rows);
}

/**
 * The control-character vocabulary {@link applyRefreshWithin}'s write-seam
 * backstop screens out of `cached_title` — {@link CONTROL_CHARS_SOURCE}
 * (`text.ts`, imported, never copied), flagged `/g` here rather than left
 * unflagged like `refs/parse.ts`'s own `CONTROL_CHARS_PATTERN`: this seam
 * *caps*, it does not refuse (see that function's docs for the iter-2
 * decision), and `.replaceAll` is what needs the global flag.
 */
const CACHED_TITLE_CONTROL_CHARS_PATTERN = new RegExp(`[${CONTROL_CHARS_SOURCE}]`, "g");

/**
 * `applyRefreshWithin`'s write-seam backstop for `cached_title`: screens out
 * every control character, then caps to {@link MAX_CACHED_TITLE_LENGTH} code
 * points with `capText` (never splits a surrogate pair) — never refuses,
 * never throws, for any input. `null` passes straight through: "no title" is
 * an ordinary outcome (a provider that has a status but nothing to call the
 * thing), not a value this exists to sanitize.
 */
function sanitizeCachedTitle(title: string | null): string | null {
  if (title === null) return null;
  return capText(title.replaceAll(CACHED_TITLE_CONTROL_CHARS_PATTERN, ""), MAX_CACHED_TITLE_LENGTH)
    .text;
}

/**
 * What {@link applyRefreshWithin} (and its public wrapper,
 * {@link applyRefresh}) hands back. Never a thrown exception for any of the
 * three cases — a ref that vanished out from under a refresh is exactly as
 * ordinary an outcome as one whose cached fields did not move (epic risk
 * note 8: "never a thrown internal that aborts the run").
 */
export type ApplyRefreshResult =
  | { readonly kind: "gone" }
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "changed";
      /** The qualified external id — `applyRefresh`'s event needs it, this row's own `SELECT` already has it. */
      readonly externalId: string;
      /** The status before this write, or `null` when the ref had never synced. */
      readonly from: string | null;
      readonly to: string;
    };

/**
 * Applies one resolved provider outcome to a ref — the row-mutation core of
 * `refresh` (T5)'s per-ref write, called once network resolution has already
 * happened with **no transaction open** (epic risk note 5: `writeTx` is
 * sync, and a provider's `resolve` is not — the two must never overlap).
 *
 * **Must be called inside an open transaction**, same guard as this module's
 * other three `Within` seams. Writes no event: {@link applyRefresh} does,
 * after this returns `"changed"`.
 *
 * **Re-`SELECT`s the ref inside the transaction** and diffs against *that*
 * read, never a snapshot taken before `resolve`'s `await` — the TOCTOU
 * discipline epic risk note 6 requires, since another writer's commit could
 * land in the gap a network round trip leaves open. Two things fall out of
 * re-reading fresh rather than trusting what the caller gathered earlier:
 *
 * 1. **Vanished — `{kind: "gone"}`, never a throw.** The ref (or its last
 *    holder, cascading it away) can disappear in that same gap (epic risk
 *    note 8) — `refresh` reports it and moves on, exactly like any other
 *    per-ref outcome, not an internal error that aborts every ref after it.
 * 2. **Already-current — `{kind: "unchanged"}`.** Two concurrent refreshes
 *    (or a re-run) can both resolve the same outcome; the second to reach
 *    this write sees its own value already sitting in the row and writes
 *    nothing but `synced_at` — the idempotence AC 1 and AC 2 both promise.
 *
 * **The write-seam backstop (iter-2 decision): caps, never refuses.**
 * `cached_status`/`cached_title` carry no DDL `CHECK` (migration 0005's own
 * docstring: a provider's vocabulary is not that migration's to define), so
 * this function is where a hostile or merely oversized tracker response gets
 * bounded (epic requirement 8) — never by throwing back at the caller, since
 * a `refresh` run has no useful way to "refuse" one ref out of many without
 * aborting the rest. `title` goes through {@link sanitizeCachedTitle}
 * (screen, then cap — silent, always). `status` gets no such treatment: this
 * function only **asserts** it is non-empty, an `internal` failure rather
 * than a typed refusal, because an empty status is a broken caller, not
 * malformed external data — every real provider (T3) validates its own
 * status vocabulary before ever calling this, and an empty string reaching
 * here means something upstream skipped straight past its own `unresolved`
 * branch.
 *
 * **Diffs on `status` *and* `title` together** — a title-only change (the
 * PR's headline was edited, its state did not move) still counts as
 * `"changed"` and still writes an event; comparing `status` alone would
 * silently drop it. On any difference, both columns are written together
 * with `synced_at`; on none, only `synced_at` bumps — `refresh`'s spec-
 * intended write amplification on an idempotent run (epic risk note 13:
 * "note in module docs" — this is that note). **Never touches `tasks`**: a
 * ref's cache is not task state, and nothing about a status catching up with
 * reality should move a lane, close a task, or touch `updated_at`.
 */
export function applyRefreshWithin(
  store: OpenStore,
  refId: number,
  outcome: RefreshOutcome,
  ctx: { readonly syncedAt: string },
): ApplyRefreshResult {
  if (!store.db.inTransaction) {
    throw new KatraException({
      code: "internal",
      message:
        "applyRefreshWithin must be called inside an open transaction — a cache " +
        "write that commits on its own can outlive the change it's part of",
    });
  }
  assertNotReadOnly(store.db, "applyRefreshWithin");

  if (outcome.status === "") {
    throw new KatraException({
      code: "internal",
      message:
        "applyRefreshWithin: outcome.status must not be empty — a provider with " +
        "nothing to report belongs in the unresolved branch upstream, never here",
    });
  }

  const currentRow = store.db
    .prepare("SELECT external_id, cached_status, cached_title FROM refs WHERE id = ?")
    .get(refId) as
    | {
        readonly external_id: unknown;
        readonly cached_status: unknown;
        readonly cached_title: unknown;
      }
    | undefined;

  if (currentRow === undefined) {
    return { kind: "gone" };
  }

  const previousStatus = narrowNullableText(currentRow.cached_status, "cached_status");
  const previousTitle = narrowNullableText(currentRow.cached_title, "cached_title");
  const nextTitle = sanitizeCachedTitle(outcome.title);

  if (outcome.status === previousStatus && nextTitle === previousTitle) {
    store.db.prepare("UPDATE refs SET synced_at = ? WHERE id = ?").run(ctx.syncedAt, refId);
    return { kind: "unchanged" };
  }

  store.db
    .prepare("UPDATE refs SET cached_status = ?, cached_title = ?, synced_at = ? WHERE id = ?")
    .run(outcome.status, nextTitle, ctx.syncedAt, refId);

  return {
    kind: "changed",
    externalId: narrowText(currentRow.external_id, "external_id"),
    from: previousStatus,
    to: outcome.status,
  };
}

/**
 * Applies one resolved provider outcome and records the transition —
 * `refresh` (T5)'s public entry point, called once per unique `refs.id`
 * after resolving it through a provider (epic risk note 9: resolve once,
 * dedupe by `refs.id`, halving API cost against a ref shared by several
 * tasks).
 *
 * One `writeTx` per ref, not one per holder — the named test this pins.
 * `applyRefreshWithin` does the row-mutation core; this wrapper adds the
 * event on top, fanned out to **every current holder of the ref, re-read
 * fresh inside this same transaction** — never the holder list a caller
 * gathered before the network round trip (`listOpenTaskRefs`'s own docs
 * explain why that list and this read do not promise to agree): a holder can
 * unlink, or a new one can link, in the gap a provider's `resolve` leaves
 * open, and only a read taken at write time can speak for what is true right
 * now. A ref shared by two tasks and one status transition therefore appends
 * exactly two events, one per holder, each carrying that holder's own
 * `epicIdFor` — never one event shared between them.
 *
 * The event's `reason` is the status transition, rendered `"OLD -> NEW"` in
 * this one place — `"OLD"` reads `"none"` when the ref had never synced
 * before (`applyRefreshWithin`'s `from: null`), since there is no prior
 * status to name. `ref` carries the qualified external id, matching
 * `ref-linked`/`ref-unlinked`'s own convention; `fromLane`/`toLane` stay
 * `NULL` — a ref's status is not a lane, and this event never touches one.
 *
 * `actor` is resolved once, before the transaction — the same reason
 * `linkRef`/`unlinkRef` do: resolving it spawns git subprocesses, and doing
 * that under `BEGIN IMMEDIATE` would hold the write lock across them.
 */
export function applyRefresh(
  store: OpenStore,
  refId: number,
  outcome: RefreshOutcome,
): ApplyRefreshResult {
  const actor = store.actor();

  return writeTx(store.db, (now) => {
    const result = applyRefreshWithin(store, refId, outcome, { syncedAt: now });

    if (result.kind !== "changed") return result;

    const holderRows = store.db
      .prepare("SELECT task_id FROM task_refs WHERE ref_id = ?")
      .all(refId) as Array<{
      readonly task_id: unknown;
    }>;

    const reason = `${result.from ?? "none"} -> ${result.to}`;

    for (const holderRow of holderRows) {
      const holderId = narrowText(holderRow.task_id, "task_id");
      const task = getTask(store, holderId);
      if (task === undefined) {
        throw new KatraException({
          code: "internal",
          message: `task ${holderId} disappeared between holding ref ${refId} and being read`,
        });
      }

      appendEvent(
        store,
        {
          type: "ref-status-changed",
          entityId: holderId,
          epicId: epicIdFor(task),
          actor,
          ref: result.externalId,
          reason,
        },
        now,
      );
    }

    return result;
  });
}
