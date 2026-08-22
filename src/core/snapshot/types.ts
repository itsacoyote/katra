/**
 * The snapshot format's shapes (F10, `katra-9aw.67`, T1): the file header and
 * one row type per {@link SnapshotTable}, each paired with an `as const
 * satisfies readonly (keyof Row)[]` field-order array — the `ISSUE_FIELDS`
 * precedent (`beads/extract.ts`) generalized to ten tables plus the header.
 *
 * Determinism is hand-pinned here, never inferred: `serialize.ts`'s
 * `rowToLine`/`buildHeader` walk these arrays field by field and never
 * `Object.keys`/spread a row or the header, so the byte order of every line a
 * snapshot ever writes is exactly this file's declaration order — reorder an
 * array and the output reorders with it, which is what makes a field-order
 * swap here a mutation `test/core/snapshot.test.ts`'s golden-byte test can
 * catch (plan decision 2).
 *
 * A row's field is typed by its truest primitive shape (`string`, `number`,
 * or nullable), never by one of `enums.ts`'s unions (`Level`, `Kind`, `Lane`,
 * …) — the same reasoning `beads/types.ts` gives `BeadsIssue.status`: a row
 * read back out of an old snapshot (T3 builds the target DB at the
 * snapshot's own recorded schema version before migrating forward) may carry
 * a value only a past schema's `CHECK` constraint validated, and this module
 * makes no claim about it. Whether a value is *actually* valid for the
 * schema it lands in is the live `CHECK` constraint's job at insert time
 * (T3, ADR-018's raw-INSERT path) — not a job this format has anywhere to do
 * twice.
 *
 * **This module must never reference the reader's own binary-buffer type**
 * (a driver artifact `better-sqlite3` can return for a `BLOB`-affinity value
 * — see `narrow.ts`'s `narrowText` docstring for the general hazard, and
 * `notes/repo.ts:45`'s `rowToNote` for the same finding on a live read path).
 * Refusing one as corruption is `serialize.ts`'s job, at the one function
 * that actually touches a real row (`rowToLine`) — a check this file has no
 * business duplicating, and the published-graph forbidden-import scan
 * (`test/core/snapshot.test.ts`'s structural suite) would reject it here
 * regardless if this module ever joined `src/index.ts`'s graph.
 *
 * Store-free like `beads/types.ts`: nothing here imports `store.ts`, `db/*`,
 * or anything that does. `SnapshotTable` is the one import, from `enums.ts`
 * — see that union's own docstring for why it lives there and not here.
 */

import type { SnapshotTable } from "../enums.js";

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/**
 * The only format version this build writes or accepts without refusing.
 * `serialize.ts`'s `parseHeader` compares a snapshot's own `formatVersion`
 * against this constant — never against a caller-supplied "current" value,
 * unlike `schemaVersion` below, because the format itself has no migration
 * chain to consult; the running build simply is, or is not, the format's
 * only known version.
 */
export const SNAPSHOT_FORMAT_VERSION = 1 as const;

/**
 * Line 1 of every snapshot file. Deliberately carries no timestamp and no
 * machine identity (epic requirement 2): an unchanged store must snapshot to
 * a byte-identical file, and either field would make two snapshots of the
 * same store disagree for no reason a diff should ever show.
 */
export interface SnapshotHeader {
  readonly format: "katra-snapshot";
  readonly formatVersion: typeof SNAPSHOT_FORMAT_VERSION;
  /** SQLite's `user_version` at export time — `readSchemaVersion` (`db/migrate.ts`). */
  readonly schemaVersion: number;
}

/** The header's own pinned key order — tested for determinism exactly like a table's field-order array (plan-review INFO). */
export const SNAPSHOT_HEADER_FIELDS = [
  "format",
  "formatVersion",
  "schemaVersion",
] as const satisfies readonly (keyof SnapshotHeader)[];

// ---------------------------------------------------------------------------
// Row shapes, one per table in migration order (mirrors SNAPSHOT_TABLES)
// ---------------------------------------------------------------------------

/** `tasks` (migration 0001). */
export interface TaskRow {
  readonly id: string;
  readonly level: string;
  readonly kind: string;
  readonly title: string;
  readonly description: string | null;
  readonly lane: string;
  readonly priority: number;
  readonly assignee: string | null;
  readonly parent_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at: string | null;
  readonly close_reason: string | null;
}
export const TASK_ROW_FIELDS = [
  "id",
  "level",
  "kind",
  "title",
  "description",
  "lane",
  "priority",
  "assignee",
  "parent_id",
  "created_at",
  "updated_at",
  "closed_at",
  "close_reason",
] as const satisfies readonly (keyof TaskRow)[];

/** `deps` (migration 0001). */
export interface DepRow {
  readonly task_id: string;
  readonly depends_on_id: string;
  readonly created_at: string;
}
export const DEP_ROW_FIELDS = [
  "task_id",
  "depends_on_id",
  "created_at",
] as const satisfies readonly (keyof DepRow)[];

/** `links` (migration 0001). */
export interface LinkRow {
  readonly a_id: string;
  readonly b_id: string;
  readonly created_at: string;
}
export const LINK_ROW_FIELDS = [
  "a_id",
  "b_id",
  "created_at",
] as const satisfies readonly (keyof LinkRow)[];

/** `tags` (migration 0001). */
export interface TagRow {
  readonly task_id: string;
  readonly tag: string;
}
export const TAG_ROW_FIELDS = ["task_id", "tag"] as const satisfies readonly (keyof TagRow)[];

/** `events` (migration 0002, columns as rebuilt through migration 0006). */
export interface EventRow {
  readonly id: number;
  readonly type: string;
  readonly entity_id: string;
  readonly epic_id: string | null;
  readonly actor: string;
  readonly from_lane: string | null;
  readonly to_lane: string | null;
  readonly ref: string | null;
  readonly reason: string | null;
  readonly title: string | null;
  readonly prior_actor: string | null;
  readonly created_at: string;
}
export const EVENT_ROW_FIELDS = [
  "id",
  "type",
  "entity_id",
  "epic_id",
  "actor",
  "from_lane",
  "to_lane",
  "ref",
  "reason",
  "title",
  "prior_actor",
  "created_at",
] as const satisfies readonly (keyof EventRow)[];

/** `notes` (migration 0002). */
export interface NoteRow {
  readonly id: string;
  readonly task_id: string;
  readonly kind: string;
  readonly body: string;
  readonly actor: string;
  readonly created_at: string;
}
export const NOTE_ROW_FIELDS = [
  "id",
  "task_id",
  "kind",
  "body",
  "actor",
  "created_at",
] as const satisfies readonly (keyof NoteRow)[];

/** `claims` (migration 0003). */
export interface ClaimRow {
  readonly task_id: string;
  readonly holder: string;
  readonly actor: string;
  readonly claimed_at: string;
}
export const CLAIM_ROW_FIELDS = [
  "task_id",
  "holder",
  "actor",
  "claimed_at",
] as const satisfies readonly (keyof ClaimRow)[];

/** `presence` (migration 0003). */
export interface PresenceRow {
  readonly worktree: string;
  readonly branch: string;
  readonly last_seen: string;
}
export const PRESENCE_ROW_FIELDS = [
  "worktree",
  "branch",
  "last_seen",
] as const satisfies readonly (keyof PresenceRow)[];

/** `refs` (migration 0005). */
export interface RefRow {
  readonly id: number;
  readonly provider: string;
  readonly external_id: string;
  readonly url: string | null;
  readonly cached_status: string | null;
  readonly cached_title: string | null;
  readonly synced_at: string | null;
}
export const REF_ROW_FIELDS = [
  "id",
  "provider",
  "external_id",
  "url",
  "cached_status",
  "cached_title",
  "synced_at",
] as const satisfies readonly (keyof RefRow)[];

/** `task_refs` (migration 0005). */
export interface TaskRefRow {
  readonly task_id: string;
  readonly ref_id: number;
}
export const TASK_REF_ROW_FIELDS = [
  "task_id",
  "ref_id",
] as const satisfies readonly (keyof TaskRefRow)[];

/**
 * Every table's row type, keyed by {@link SnapshotTable} — the type
 * `serialize.ts`'s generic `rowToLine`/`lineToRow` index against so a call
 * site's `table` argument alone pins the row type the compiler expects.
 */
export interface SnapshotRowByTable {
  readonly tasks: TaskRow;
  readonly deps: DepRow;
  readonly links: LinkRow;
  readonly tags: TagRow;
  readonly events: EventRow;
  readonly notes: NoteRow;
  readonly claims: ClaimRow;
  readonly presence: PresenceRow;
  readonly refs: RefRow;
  readonly task_refs: TaskRefRow;
}

/**
 * The field-order array for every table, keyed the same way as {@link
 * SnapshotRowByTable}. The `satisfies` clause pins each entry to a real key
 * of that table's own row type — a field renamed on one side without a
 * matching edit on the other is a compile error, not a silent drop, exactly
 * as `ISSUE_FIELDS`' own `satisfies` clause guards `toBeadsIssue`
 * (`beads/extract.ts`).
 */
export const SNAPSHOT_ROW_FIELDS = {
  tasks: TASK_ROW_FIELDS,
  deps: DEP_ROW_FIELDS,
  links: LINK_ROW_FIELDS,
  tags: TAG_ROW_FIELDS,
  events: EVENT_ROW_FIELDS,
  notes: NOTE_ROW_FIELDS,
  claims: CLAIM_ROW_FIELDS,
  presence: PRESENCE_ROW_FIELDS,
  refs: REF_ROW_FIELDS,
  task_refs: TASK_REF_ROW_FIELDS,
} as const satisfies {
  readonly [T in SnapshotTable]: readonly (keyof SnapshotRowByTable[T])[];
};
