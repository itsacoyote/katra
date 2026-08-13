/**
 * The beads → katra migration's store-free shapes (F5, `katra-9aw.49`).
 *
 * Three groups, in order:
 *
 * 1. **Input** — `BeadsIssue`/`BeadsDependency`/`BeadsComment`, typed against
 *    the verified `bd export` (beads 1.0.4) surface in
 *    `docs/migrating-from-beads.md`. `extract.ts` (T3) produces these from
 *    untrusted JSONL; nothing here validates a value, only its shape — see
 *    each interface for why enum-looking fields (`status`, `issue_type`, a
 *    dependency's `type`) are typed `string`, not a union.
 * 2. **Output** — `MigrationReport`, the `--json` document `katra migrate
 *    beads` prints on both preview and apply. Fixed shape per ADR-009 (the
 *    doctrine `BoardResult` established in `contract.ts`): every category is
 *    always present, `{count, items}`, empty renders as `{count: 0, items:
 *    []}` rather than being absent. The category list is pinned by plan-review
 *    finding 4 — one key per degradation `mapping.ts` or `transform.ts` can
 *    actually emit, not a paraphrase of `docs/migrating-from-beads.md`'s prose.
 * 3. **`MigrationPlan`** — what `transform.ts` (T5) hands `load.ts` (T6).
 *    Deliberately **not** re-exported through `contract.ts` or `src/index.ts`:
 *    it is a load-time work order keyed on beads' own ids (every `*OldId`
 *    field below names one), not a document a library consumer should ever
 *    read. Declaring it here anyway — rather than in `transform.ts` — keeps
 *    one file store-free and importable by both `transform.ts` and `load.ts`
 *    without either importing the other.
 *
 * Like `tasks/types.ts`, this module imports nothing from `store.ts`, `db/*`,
 * or anything that does — `test/index.test.ts` walks `src/index.ts`'s import
 * graph and asserts the exact file set reached; a storage import here would
 * both fail that walk (if this module joined the published graph) and,
 * before that, contradict the reason `contract.ts` is split from the modules
 * that produce its data in the first place (see `contract.ts`'s module docs).
 */

import type { Kind, Lane, Level, NoteKind, Priority } from "../enums.js";
import { KINDS, LANES, LEVELS } from "../enums.js";

// ---------------------------------------------------------------------------
// Input: the bd export surface
// ---------------------------------------------------------------------------

/**
 * One comment on a beads issue, as `bd export` embeds it.
 *
 * `author` is optional, not just possibly blank: beads does not guarantee the
 * field on every comment, and the migration's own policy for a missing or
 * blank one is to fall back to the migrating identity and report it under
 * {@link MigrationReport.droppedFields}`.commentAuthor` (T5 body, citing
 * `notes.actor`/`events.actor` `NOT NULL` — migration 0002 — and iteration-2
 * finding C). Typing it required would force `extract.ts` to either invent a
 * value that is not in the export or lie about having validated one it never
 * checked; T3's stated job is JSON → typed records, not classification.
 */
export interface BeadsComment {
  readonly id: string;
  readonly issue_id: string;
  readonly author?: string;
  readonly text: string;
  readonly created_at: string;
}

/**
 * One dependency edge, as `bd export` embeds it on the issue that owns
 * `issue_id`.
 *
 * `type` is `string`, not a union of the four documented edge types (`blocks`,
 * `parent-child`, `discovered-from`, `related`) — the same reasoning as
 * {@link BeadsIssue.status}: `extract.ts` makes no enum claim about untrusted
 * input, and `--from` accepts arbitrary exports (epic research, "security
 * adjacent"). `transform.ts`'s edge classification (T5 body, step 3) is where
 * an unrecognised value gets a decision, not this type.
 *
 * The real export also carries `created_by` and `metadata` on every edge
 * (verified in `.beads/issues.jsonl`), deliberately unmodeled here: edge-level
 * identity/machinery fields, dropped for the same reason `BeadsIssue.owner`/
 * `created_by` are — nothing in katra's dependency or link model has anywhere
 * to put them, and no report category exists for an edge-level drop the way
 * `droppedFields` covers issue-level ones. Named here so the "verified
 * field-by-field" claim above stays true rather than silent.
 */
export interface BeadsDependency {
  readonly issue_id: string;
  readonly depends_on_id: string;
  readonly type: string;
  readonly created_at: string;
}

/**
 * One issue, as `bd export` (beads 1.0.4) emits it — verified field-by-field
 * against a real export in `docs/migrating-from-beads.md` and this repo's own
 * `.beads/issues.jsonl` (145 records).
 *
 * Fields the doc's table marks with `◦` — populated only sometimes — are
 * optional here. `dependencies` is optional too even though the doc's table
 * does not mark it: the real export omits the key entirely on an issue with
 * no edges at all (verified against this repo's export, where exactly the one
 * issue with zero `dependency_count`/`dependent_count` lacks the key), rather
 * than emitting `[]`. `started_at` is not in the doc's table at all — an
 * undocumented field the epic's research pass found on 58/136 real records —
 * and is modeled here per this task's own instruction, reported as a dropped
 * field like `owner`/`estimated_minutes`.
 *
 * `status` and `issue_type` are `string`, not unions of the mapped values:
 * `mapping.ts` (T4) builds `STATUS_MAP`/`TYPE_MAP` as `Record<string, ...>`
 * specifically so an unrecognised value is a reportable, non-throwing case
 * (`unmappedStatuses`/`unmappedTypes` below) rather than a type error at the
 * boundary that read it. A narrower type here would make those two report
 * categories unreachable from `extract.ts`'s output.
 */
export interface BeadsIssue {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly priority: number;
  readonly issue_type: string;
  readonly owner: string;
  readonly created_at: string;
  readonly created_by: string;
  readonly updated_at: string;
  readonly dependencies?: readonly BeadsDependency[];
  /**
   * Precomputed by beads. Carried through for fidelity to the verified export
   * surface; nothing in the pipeline trusts these over the arrays they
   * summarise — `transform.ts` derives its own counts from `dependencies` and
   * `comments` directly, the only way its report can name the affected ids.
   */
  readonly dependency_count: number;
  readonly dependent_count: number;
  readonly comment_count: number;
  /** ◦ Becomes a `decision` note (`docs/migrating-from-beads.md` §"Field mapping"). */
  readonly design?: string;
  /** ◦ Becomes an `acceptance` note. */
  readonly acceptance_criteria?: string;
  /**
   * ◦ Becomes a `general` note. Distinct from {@link Note} (`notes/types.ts`)
   * and {@link NoteKind} despite the shared word — this is one free-text field
   * on the beads issue itself, not katra's typed-note model.
   */
  readonly notes?: string;
  readonly assignee?: string;
  /** ◦ Dropped by design (§2) — declined estimates/time tracking. Report-only. */
  readonly estimated_minutes?: number;
  /** ◦ Undocumented in the doc's table; see the interface docs above. Report-only. */
  readonly started_at?: string;
  readonly closed_at?: string;
  readonly close_reason?: string;
  /** ◦ Report-only — no storage target until external refs (`katra-9aw.20`) ship. */
  readonly external_ref?: string;
  readonly labels?: readonly string[];
  readonly comments?: readonly BeadsComment[];
}

// ---------------------------------------------------------------------------
// Output: MigrationReport
// ---------------------------------------------------------------------------

/**
 * A fixed report section: always present, `count` and `items.length` agree,
 * and an empty section is `{count: 0, items: []}` — never an absent key.
 * Named after the discipline ADR-009 states for `BoardResult`: "an agent
 * parsing `--json` can rely on the top-level keys existing."
 */
export interface ReportSection<T> {
  readonly count: number;
  readonly items: readonly T[];
}

/** Names one beads issue legibly — old id plus title, never the description body. */
export interface MigrationItemRef {
  readonly oldId: string;
  readonly title: string;
}

/**
 * Names one dependency edge by its two beads-side endpoints. Deliberately
 * without a title on either end: unlike {@link MigrationItemRef} sections,
 * these report on an edge between two already-legible beads ids, and a
 * migration that dropped or deduplicated an edge is explaining a relationship,
 * not introducing an unfamiliar id.
 */
export interface MigrationEdgeRef {
  readonly fromOldId: string;
  readonly toOldId: string;
  /** The raw beads edge type (`blocks`, `parent-child`, `discovered-from`, `related`, or anything else a hostile export supplied). */
  readonly type: string;
}

/** One beads issue reparented onto its nearest ancestor epic during two-level flattening. */
export interface ReparentedItem extends MigrationItemRef {
  readonly newParentOldId: string;
}

/**
 * Names one beads comment within its issue. Shared by {@link
 * MigrationReport.commentsConverted} (the successful case) and {@link
 * DroppedFieldsReport.commentAuthor} (the degraded one) — both are "this
 * specific comment, on this issue" facts.
 */
export interface CommentRef extends MigrationItemRef {
  readonly commentId: string;
}

/** An issue whose `status` or `issue_type` had no entry in `mapping.ts`'s maps. */
export interface UnmappedValue extends MigrationItemRef {
  readonly raw: string;
}

/** How many raw export records of one non-`issue` `_type` were skipped, forwarded from `extract.ts`. */
export interface SkippedRecordType {
  readonly type: string;
  readonly count: number;
}

/**
 * A parent-chain cycle transform broke while walking ancestry. `path` is the
 * beads ids the walk visited before it revisited one — the same shape
 * `KatraErrorDetail`'s `cycle` arm uses for `path` (`errors.ts`), reused here
 * because a broken parent cycle is legible the same way a refused one is.
 */
export interface CycleBreak extends MigrationItemRef {
  readonly path: readonly string[];
}

/** A `blocks` edge dropped to break a dependency cycle transform detected (deterministic edge-drop order — T5 body, step 4). */
export interface BlocksCycleBreak extends MigrationEdgeRef {
  readonly path: readonly string[];
}

/** A timestamp that failed to parse, the raw value, and the fallback substituted in its place. */
export interface InvalidTimestamp extends MigrationItemRef {
  readonly field: string;
  readonly raw: string;
  readonly fallback: string;
}

/**
 * An issue skipped outright because its title was empty after trimming. Its
 * edges then report as dangling (T5 body, step 4).
 *
 * Carries `rawTitle`, not {@link MigrationItemRef}'s `title` — the title is
 * exactly what's invalid here, so presenting it as legible would misstate the
 * finding.
 */
export interface InvalidItem {
  readonly oldId: string;
  readonly rawTitle: string;
}

/**
 * A note skipped because its body was blank after trimming — one of
 * `design`/`acceptance_criteria`/`notes`/a comment's `text`. `commentId` is
 * set only when the source was a comment; the three issue-level fields have
 * no id of their own to carry.
 */
export interface InvalidNote extends MigrationItemRef {
  readonly noteKind: NoteKind;
  readonly commentId?: string;
}

/** A numeric field clamped to the nearest valid bound — today, only `priority` (T4 body, item 7). */
export interface ClampedValue extends MigrationItemRef {
  readonly field: string;
  readonly raw: number;
  readonly clamped: Priority;
}

/**
 * The six named degradations under one issue, each its own fixed section
 * (plan-review finding 4's explicit list). `owner`/`createdBy`/
 * `estimatedMinutes`/`externalRef`/`startedAt` are whole fields beads carries
 * that katra has nowhere to put; `commentAuthor` is narrower — not a dropped
 * field but a per-comment actor fallback (see {@link CommentRef}).
 *
 * A closed interface rather than a keyed map: any object built to satisfy it
 * must supply exactly these six, so a category renamed or dropped from
 * `mapping.ts`/`transform.ts` is a compile error at every construction site —
 * the same guarantee a `satisfies` check over its keys would add, without the
 * indirection.
 */
export interface DroppedFieldsReport {
  readonly owner: ReportSection<MigrationItemRef>;
  readonly createdBy: ReportSection<MigrationItemRef>;
  readonly estimatedMinutes: ReportSection<MigrationItemRef>;
  readonly externalRef: ReportSection<MigrationItemRef>;
  readonly startedAt: ReportSection<MigrationItemRef>;
  readonly commentAuthor: ReportSection<CommentRef>;
}

/** Rows actually written (or, in preview, that would be), grouped the three ways a reader is likely to ask. Every key of `Level`/`Kind`/`Lane` is present, `0` when unused — ADR-009's "always present" applies to these counts too. */
export interface ImportedCounts {
  readonly byLevel: Record<Level, number>;
  readonly byKind: Record<Kind, number>;
  readonly byLane: Record<Lane, number>;
}

/**
 * One row of the old-id-to-new-id map.
 *
 * `newId` is `string | null` rather than the map gaining a second shape
 * between preview and apply: katra ids are minted only at load (T6 body, step
 * 2), so a preview report has every entry present with `newId: null`, and a
 * post-apply report is the identical shape with every `newId` filled in. A
 * consumer that only ever reads `MigrationReport` — never `MigrationPlan` —
 * sees one type regardless of which command produced it.
 */
export interface MigrationIdMapEntry {
  readonly oldId: string;
  readonly newId: string | null;
}

/**
 * What `katra migrate beads` prints, on both preview and `--apply` — the
 * `--json` contract for F5, same discipline `BoardResult` set for `board`
 * (ADR-009): fixed keys, always present, `{count, items}` per category so an
 * empty category renders as empty rather than vanishing. `T5 consumes this
 * shape without reopening it` is this task's own acceptance criterion; the
 * sixteen category keys below are the exact, closed list plan-review finding
 * 4 pinned — one per degradation `mapping.ts` or `transform.ts` can actually
 * emit, not a restatement of `docs/migrating-from-beads.md`'s prose.
 */
export interface MigrationReport {
  readonly droppedFields: DroppedFieldsReport;
  readonly reparented: ReportSection<ReparentedItem>;
  /**
   * A `parent-child` edge dropped because katra has nowhere to attach it —
   * two distinct causes share this one category: an epic's own beads parent
   * (an epic can never keep one; katra is two levels only), and a task
   * whose whole ancestor chain never reaches an epic at all (no
   * `epic`/`milestone` type anywhere above it, reachable in any beads
   * project that never used them). Both leave `toOldId` naming a parent
   * katra will not attach the item to.
   */
  readonly epicEdgesDropped: ReportSection<MigrationEdgeRef>;
  /** Count of comments that became notes — the observable, plantable half of "comment threading flattens"; the flattening itself has no field to observe (beads 1.0.4 comments carry no thread/reply field — iteration-2 finding D), so it is not a key here. */
  readonly commentsConverted: ReportSection<CommentRef>;
  readonly unmappedStatuses: ReportSection<UnmappedValue>;
  readonly unmappedTypes: ReportSection<UnmappedValue>;
  /**
   * Non-`issue` `_type` records, forwarded from `extract.ts`'s own per-type
   * counts. Deliberately **not** a {@link ReportSection}: that shape's own
   * invariant is `count === items.length`, and `SkippedRecordType` items are
   * per-type aggregates, not per-record entries — a `ReportSection` here
   * would make `count` read as "distinct types skipped" while the real
   * skipped-record total hid inside `items[].count`. `count` below is the
   * true sum across every type; `byType` is the breakdown.
   */
  readonly skippedRecords: {
    /** Total non-`issue` records skipped, summed across all types below — exact, unaffected by `truncated`. */
    readonly count: number;
    /** The first `MAX_SKIPPED_TYPES` (`extract.ts`) distinct types seen; each type string is capped too (`capText`, `core/text.ts`). */
    readonly byType: readonly SkippedRecordType[];
    /**
     * True when a distinct `_type` past `extract.ts`'s cap was folded into
     * `count` without a `byType` entry of its own — the same "a bounded
     * read reports itself" doctrine `MAX_CANDIDATES` follows in
     * `tasks/ids.ts` (AGENTS.md: "A bounded read reports that it
     * truncated").
     */
    readonly truncated: boolean;
  };
  readonly danglingEdges: ReportSection<MigrationEdgeRef>;
  /** Includes self-edges (an issue depending on itself). */
  readonly duplicateEdges: ReportSection<MigrationEdgeRef>;
  readonly parentCycles: ReportSection<CycleBreak>;
  readonly blocksCycles: ReportSection<BlocksCycleBreak>;
  readonly invalidTimestamps: ReportSection<InvalidTimestamp>;
  /** Empty-after-trim titles — the item itself was skipped, not just a field on it. */
  readonly invalidItems: ReportSection<InvalidItem>;
  /** Blank-after-trim note bodies — the note was skipped, not just degraded. */
  readonly invalidNotes: ReportSection<InvalidNote>;
  /** Out-of-range numeric values clamped to their nearest valid bound. */
  readonly clampedValues: ReportSection<ClampedValue>;
  /** Blank-after-trim labels dropped rather than becoming an empty tag (the tag-insert loop in `createTaskWithin` silently skips blanks, so an unclassified blank would drop with nothing to show for it). */
  readonly emptyLabels: ReportSection<MigrationItemRef>;
  readonly imported: ImportedCounts;
  readonly idMap: readonly MigrationIdMapEntry[];
  /** `false` on a preview; `true` once `load.ts` has actually committed the rows. */
  readonly applied: boolean;
}

// ---------------------------------------------------------------------------
// MigrationPlan — transform.ts's output, load.ts's input. Internal: never
// re-exported through contract.ts or src/index.ts. See the module docs above
// for why.
// ---------------------------------------------------------------------------

/**
 * One task or epic transform has decided to create, with every field
 * `load.ts` passes straight to a T1 Within seam.
 *
 * Mirrors {@link Task} (`tasks/types.ts`) field-for-field, `oldId`/
 * `parentOldId` standing in for `id`/`parentId`: the translation to
 * `createTaskWithin`'s parameters is close to a direct copy, which is the
 * point — a shape that diverged from `Task` would make `load.ts` reconcile
 * two field-naming schemes for no reason.
 *
 * `lane` is the item's **final** mapped lane (e.g. `Done` for a closed
 * issue), not a creation-time lane — `load.ts` alone decides, from
 * `isTerminal(lane)`, whether to create directly into it or create into
 * `Defined` and reach it through `applyMoveWithin` (T6 body, step 2; the
 * terminal-lane creation guard in `repo.ts:153-162` is why the second path
 * exists at all — iteration-2 finding B). `updatedAt` serves both paths: it is
 * the seam's `updatedAt` for a direct creation, and the `applyMoveWithin`
 * call's `updatedAt` for a closed one, since beads records only one
 * `updated_at` regardless of how the item got there.
 */
export interface PlannedItem {
  readonly oldId: string;
  readonly level: Level;
  readonly kind: Kind;
  readonly title: string;
  readonly description: string | null;
  readonly lane: Lane;
  readonly priority: Priority;
  readonly assignee: string | null;
  /** The nearest ancestor epic's beads id, after two-level flattening. `null` for a top-level epic or an item that lost its parent to a broken cycle. */
  readonly parentOldId: string | null;
  /** Labels ∪ `beads:<oldId>` ∪ any status tag (`deferred`/`pinned`) — already assembled; `load.ts` writes this list as-is. */
  readonly tags: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly closeReason: string | null;
}

/**
 * One note transform has decided to create.
 *
 * `id` is a plan-local key, not a katra id — katra mints `nt-` ids at load
 * time, same as tasks. It exists so a `PlannedEvent`'s `note-added` arm can
 * name *which* planned note it announces (`noteRef`) before that note has a
 * real id, and `load.ts` resolves the two against each other in memory the
 * same way it resolves `*OldId` fields against the id map it is building.
 */
export interface PlannedNote {
  readonly id: string;
  readonly itemOldId: string;
  readonly kind: NoteKind;
  readonly body: string;
  /** The injected actor (T6 body, step 3) — a comment's beads `author`, falling back to the migrating identity per `droppedFields.commentAuthor`. */
  readonly actor: string;
  readonly createdAt: string;
}

/**
 * A dependency or link edge to write, discriminated on `kind` rather than
 * carrying both id pairs with one unused — the two are written through
 * different Within seams with different parameter names (T5 body, step 1):
 * `addDependency(taskId = issue_id, dependsOnId = depends_on_id)` for a
 * `blocks` edge, `addLink(a, b)` for `discovered-from`/`related`. Naming the
 * dependency arm's fields after `addDependency`'s own parameters means
 * `load.ts`'s call is a direct pass-through, not a remapping.
 *
 * `createdAt` is the edge's own historical timestamp, falling back to its
 * owning item's `createdAt` when the export did not carry one (T6 body,
 * step 3) — that fallback is `transform.ts`'s decision, already resolved by
 * the time `load.ts` sees this.
 */
export type PlannedEdge =
  | {
      readonly kind: "dependency";
      readonly taskOldId: string;
      readonly dependsOnOldId: string;
      readonly createdAt: string;
    }
  | {
      readonly kind: "link";
      /** Pre-remap old ids. Canonical `a < b` ordering (the `links` `CHECK`) is computed after id remapping, since katra ids are random — `load.ts`'s job, not this plan's. */
      readonly aOldId: string;
      readonly bOldId: string;
      readonly createdAt: string;
    };

/**
 * One entry of the flat, chronologically-sorted event plan (T5 body, step 5):
 * sorted by `(at, itemOldId, type)` with `created < note-added < closed` as
 * the type tiebreak, so `events.id` — katra's real total order — reads as
 * true history once `load.ts` appends the whole list in this order, after
 * every row exists.
 *
 * A discriminated union, not one shape with optional fields, because the
 * three arms carry genuinely different truths: `title` exists only because
 * `createTaskWithin` stamps it on `created` (the event outlives the task —
 * `repo.ts:220-228`, ADR-008); `reason` only `closed` has; `actor` is fixed
 * per arm — `created`/`closed` always stamp the identity `load.ts` is called
 * with (T6's `identity` parameter, not carried here), so only `note-added`,
 * whose actor varies per note, needs the field at all.
 */
export type PlannedEvent =
  | {
      readonly type: "created";
      readonly itemOldId: string;
      readonly at: string;
      readonly title: string;
    }
  | {
      readonly type: "closed";
      readonly itemOldId: string;
      readonly at: string;
      readonly reason: string | null;
    }
  | {
      readonly type: "note-added";
      readonly itemOldId: string;
      readonly at: string;
      /** The {@link PlannedNote.id} this event announces. */
      readonly noteRef: string;
      readonly actor: string;
    };

/**
 * What `transform.ts`'s `planMigration` hands `load.ts`'s `loadMigration`
 * alongside the {@link MigrationReport} it produces in the same call.
 *
 * Everything here is already decided: invalid items and blank notes are
 * excluded (their exclusion is what {@link MigrationReport.invalidItems}/
 * `invalidNotes` report), cycles are broken, edges are classified, priorities
 * are clamped. `load.ts` performs no further validation — its own refusal is
 * the single non-empty-store check (T6 body, step 1); anything else would
 * mean `transform.ts` under-classified, which is a bug, not a write-path
 * refusal (epic requirement 9, as amended).
 */
export interface MigrationPlan {
  readonly items: readonly PlannedItem[];
  readonly notes: readonly PlannedNote[];
  readonly edges: readonly PlannedEdge[];
  readonly events: readonly PlannedEvent[];
}

// ---------------------------------------------------------------------------
// Shared pure helpers — used by both `transform.ts` (planned counts, for its
// preview report) and `load.ts` (written counts, for its post-apply report).
// The two answer different questions ("what would be written" vs "what was
// written") but compute them identically from a `PlannedItem[]`, so the
// arithmetic lives once, here, rather than as two copies that could drift.
// ---------------------------------------------------------------------------

/** A fully-keyed, zero-initialized `Record` from a fixed literal-union key list — `LEVELS`/`KINDS`/`LANES` are katra's own enums, not attacker content, so a plain object is fine here (unlike every old-id-keyed map in `transform.ts`). */
function zeroCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  const result = {} as Record<K, number>;
  for (const key of keys) result[key] = 0;
  return result;
}

/** Tallies a list of planned items by level, kind and lane — every key of each enum present, `0` when unused, per {@link ImportedCounts}'s own "always present" discipline. */
export function computeImportedCounts(items: readonly PlannedItem[]): ImportedCounts {
  const byLevel = zeroCounts(LEVELS);
  const byKind = zeroCounts(KINDS);
  const byLane = zeroCounts(LANES);

  for (const item of items) {
    byLevel[item.level] += 1;
    byKind[item.kind] += 1;
    byLane[item.lane] += 1;
  }

  return { byLevel, byKind, byLane };
}
