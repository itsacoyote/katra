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
 * alongside `LinkResult` (F7 T5) and is imported back from there; the shape
 * is unchanged from what this module declared before that move — `action:
 * "linked" | "already-linked" | "unlinked"`, `taskId`, `ref: Ref` — so every
 * caller here needed no change beyond the import.
 */

import type { RefResult } from "../contract.js";
import { assertNotReadOnly, writeTx } from "../db/connection.js";
import { KatraException } from "../errors.js";
import { appendEvent, epicIdFor } from "../events/repo.js";
import { narrowNullableText, narrowText } from "../narrow.js";
import type { OpenStore } from "../store.js";
import { requireResolved, resolveId } from "../tasks/ids.js";
import { getTask } from "../tasks/repo.js";
import type { Ref } from "./types.js";

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
 * `action: "linked"`.
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
 * 2. `task_refs`, the join row. `.changes === 1` here is what `action`
 *    reports: a fresh link for *this task*, regardless of whether the `refs`
 *    row itself was just created or already existed for some other task.
 */
export function linkRefWithin(
  store: OpenStore,
  taskIdInput: string,
  input: RefInput,
): {
  readonly taskId: string;
  readonly refId: number;
  readonly ref: Ref;
  readonly action: "linked" | "already-linked";
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
    }
  }

  const taskRefInfo = store.db
    .prepare(
      `INSERT INTO task_refs (task_id, ref_id) VALUES (?,?)
       ON CONFLICT (task_id, ref_id) DO NOTHING`,
    )
    .run(taskId, record.id);

  return {
    taskId,
    refId: record.id,
    ref: record.ref,
    action: taskRefInfo.changes === 1 ? "linked" : "already-linked",
  };
}

/**
 * Links a reference to a task and records that it happened.
 *
 * Idempotent: re-linking the same `(task, provider, externalId)` is a no-op
 * that reports `already-linked` rather than a duplicate row or a second
 * event. The ref, the `task_refs` row and the `ref-linked` event — when one
 * is written at all — share one transaction and one timestamp.
 */
export function linkRef(
  store: OpenStore,
  taskIdInput: string,
  input: RefInput,
): RefResult & { readonly action: "linked" | "already-linked" } {
  // Before the transaction: resolving the actor spawns git subprocesses, and
  // under `BEGIN IMMEDIATE` that holds the write lock across both.
  const actor = store.actor();

  return writeTx(store.db, (now) => {
    const { taskId, ref, action } = linkRefWithin(store, taskIdInput, input);

    if (action === "linked") {
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
 * Resolves `refInput` against `taskId`'s **own** linked refs — never the
 * whole `refs` table, and never `resolveId`/`requireId` (risk note 17: those
 * range-scan `kt-`-prefixed ids against `tasks`, the wrong table entirely).
 *
 * Comparison is case-insensitive (`toLowerCase()`, locale-independent) and
 * checked against both a row's `url` and its `external_id` — never provider,
 * and never `parseRefInput`: this lets an escape-hatch ref with a `NULL` url
 * be removed by its id, and a differently-cased re-typing of an accepted
 * input resolve back to the row it named (spec amendment, epic comment 2).
 *
 * The task-scoped match runs **first**. Only when nothing matches does a
 * purely numeric input get its own refusal, naming the two accepted forms —
 * the internal rowid is never published and never a valid input (spec
 * amendment), but a provider whose own qualified id happens to be all
 * digits (a Jira/Bugzilla-style numeric id via the escape hatch) is a real,
 * removable external_id and must resolve like any other. Two or more
 * case-insensitive matches on one task refuse, naming every match so a url
 * can disambiguate them.
 */
function requireLinkedRef(store: OpenStore, taskId: string, refInput: string): RefRecord {
  const trimmed = refInput.trim();
  const lower = trimmed.toLowerCase();

  const rows = linkedRefRows(store, taskId);

  const matches = rows
    .map(rowToRefRecord)
    .filter(
      (record) =>
        (record.ref.url !== null && record.ref.url.toLowerCase() === lower) ||
        record.ref.externalId.toLowerCase() === lower,
    );

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
        `use the url or qualified id exactly as "katra show ${taskId}" lists them`,
      id: trimmed,
    });
  }

  if (matches.length > 1) {
    throw new KatraException({
      code: "ambiguous_id",
      message:
        `"${trimmed}" matches ${matches.length} refs linked to ${taskId} — ` +
        "disambiguate with the url",
      input: trimmed,
      candidates: matches.map((match) => describeRefCandidate(match.ref)),
      truncated: false,
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
 * for why that is `task_refs`'s own rowid and not `refs.id`.
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
