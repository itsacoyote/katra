/**
 * beads → katra: transform — the graph work, flattening, event order, and
 * report assembly (F5, T5, `katra-9aw.49.5`).
 *
 * `planMigration` is the second pipeline stage: `extract.ts` (T3) turned
 * untrusted JSONL into typed {@link BeadsIssue} records without validating
 * their fields, and `mapping.ts` (T4) maps *one* field at a time. This module
 * is where the two meet — it calls `mapping.ts` once per issue and owns
 * everything that needs the *whole* graph: ancestry, two-level flattening,
 * edge classification, cycle breaking, event ordering, and assembling the
 * sixteen-category {@link MigrationReport} (`types.ts`, T2).
 *
 * **Pure and deterministic.** No `Date.now()`, no randomness, no I/O. "Now"
 * (`fallbackTimestamp`) and "who is running this migration"
 * (`migratingIdentity`) are the caller's job to supply — the same discipline
 * `mapping.ts`'s own module docs state for `normalizeTimestamp`'s `fallback`
 * and `assembleNotes`'s `migratingIdentity`: captured once per run and
 * threaded through, never read from inside a pure function. Every ordering
 * decision (which issue's edges get read first, which edge breaks a cycle,
 * where an event lands) is a function of the *input*, never of iteration
 * order that could vary between two runs of the same process — the
 * "identical input → identical plan and report" acceptance criterion depends
 * on that holding everywhere, not just at the top level.
 *
 * **Every old-id-keyed structure below is a `Map`, never a plain object.**
 * beads ids are attacker content — `--from` accepts an arbitrary export — and
 * a plain object keyed by an untrusted string resolves `"__proto__"` through
 * `Object.prototype` instead of storing it, the same hazard `extract.ts`'s
 * `toBeadsIssue` and `mapping.ts`'s `Object.hasOwn` guards exist for. `Map`
 * is prototype-free by construction, so this module never needs an own-key
 * guard the way a plain-object lookup would.
 *
 * ## Pipeline
 *
 * 1. **Shape gate + duplicate-id gate** ({@link hasValidShape}, `planMigration`'s
 *    first pass) — per issue, verify runtime field types before anything else
 *    touches it. `extract.ts` only guarantees `_type`/`id`/`title` at the
 *    JSON-record level (see its own module docs); `status`/`issue_type` being
 *    `string`, `priority` being `number`, the three timestamp fields being
 *    `string`, and `dependencies`/`comments`/`labels` being arrays of the
 *    right element shape are *this* module's job to confirm — "the
 *    `BeadsIssue` type is a claim `extract.ts` cannot enforce; `transform.ts`
 *    makes it true." A shape failure, or a second occurrence of an id already
 *    seen (first occurrence wins, deterministically, by input order), routes
 *    the issue to `invalidItems` and drops it before any mapping call touches
 *    its fields.
 * 2. **Title-trim gate** — an empty-after-trim title is a second, independent
 *    reason an otherwise shape-valid issue never becomes a {@link PlannedItem}
 *    — mirrors `tasks/repo.ts`'s `createTaskWithin` title refusal
 *    (`repo.ts:162-170`). Both this and the shape gate leave "its edges then
 *    report as dangling" to fall out naturally: edges are only ever read from
 *    the *final* accepted-issue set (step 4), so anything another issue's
 *    edge pointed at that didn't survive here is a missing endpoint, not a
 *    special case.
 * 3. **Per-item mapping** ({@link mapIssue}) — one call each to `mapStatus`,
 *    `mapLevelAndKind`, `normalizeTimestamp` (×2 or ×3), `clampPriority`,
 *    `buildTags`, `assembleNotes`, accumulating every degradation they report
 *    into the matching {@link MigrationReport} category.
 * 4. **Edge gathering + classification** ({@link classifyGenericEdges},
 *    {@link routeEdgesByType}) — every `dependencies[]` entry on an accepted
 *    issue, self- and duplicate-checked, then dangling-checked against the
 *    final accepted set, then routed by `type`.
 * 5. **Ancestry / two-level flattening** ({@link resolveAncestry}) — parent-child
 *    edges only, walked from each task with its own visited set.
 * 6. **`blocks`-cycle detection and deterministic breaking** ({@link
 *    breakBlocksCycles}) — mirrors `deps.ts`'s cycle refusal, but transform
 *    cannot throw, so it breaks the cycle itself instead of refusing.
 * 7. **Event plan** — one flat, chronologically-sorted list ({@link
 *    compareEvents}).
 * 8. **Report assembly** ({@link buildReport}) — every accumulator array
 *    wrapped into its fixed `{count, items}` section.
 */

import type { Level } from "../enums.js";
import { isTerminal } from "../enums.js";
import type { BeadsExtract } from "./extract.js";
import {
  assembleNotes,
  buildTags,
  clampPriority,
  mapLevelAndKind,
  mapStatus,
  normalizeTimestamp,
} from "./mapping.js";
import type {
  BeadsDependency,
  BeadsIssue,
  BlocksCycleBreak,
  ClampedValue,
  CommentRef,
  CycleBreak,
  InvalidItem,
  InvalidNote,
  InvalidTimestamp,
  MigrationEdgeRef,
  MigrationIdMapEntry,
  MigrationItemRef,
  MigrationPlan,
  MigrationReport,
  PlannedEdge,
  PlannedEvent,
  PlannedItem,
  PlannedNote,
  ReparentedItem,
  UnmappedValue,
} from "./types.js";
import { computeImportedCounts } from "./types.js";

// ---------------------------------------------------------------------------
// Step 0 — shape gate: verify BeadsIssue's field types before any mapping.
// ---------------------------------------------------------------------------

/** A parsed value treated as an untyped bag while its shape is being checked. */
type UnknownRecord = Record<string, unknown>;

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** The four fields `BeadsDependency` requires — every element of `dependencies[]` must have them, typed right. */
function isDependencyShaped(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as UnknownRecord;
  return (
    typeof candidate.issue_id === "string" &&
    typeof candidate.depends_on_id === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.created_at === "string"
  );
}

/** `BeadsComment`'s required fields, plus `author` typed right when present. */
function isCommentShaped(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as UnknownRecord;
  if (typeof candidate.id !== "string") return false;
  if (typeof candidate.issue_id !== "string") return false;
  if (typeof candidate.text !== "string") return false;
  if (typeof candidate.created_at !== "string") return false;
  if (candidate.author !== undefined && typeof candidate.author !== "string") return false;
  return true;
}

/**
 * Verifies the field types the task body names (`status`/`issue_type`
 * strings, `priority` a number, the timestamp fields strings,
 * `dependencies`/`comments`/`labels` arrays of the right element shape),
 * *plus* every other field that reaches a write path downstream, typed
 * right. The real rule is not "only a field this module calls a method on
 * needs checking" — `mapIssue`'s `owner`/`created_by`/`external_ref`/
 * `started_at` `.trim()` calls are one way a wrong type bites, but a SQL
 * bind parameter is exactly as type-sensitive as a method call: `load.ts`
 * binds `description`, `assignee`, and `close_reason` straight into an
 * `INSERT`/`UPDATE` (`tasks/repo.ts`'s `createTaskWithin`,
 * `tasks/lifecycle.ts`'s `applyMoveWithin`), and better-sqlite3 only accepts
 * numbers, strings, bigints, buffers, and `null` there — a boolean
 * `description` throws out of the bind call (surfacing as `internal`, exit
 * 4, *after* a clean preview said the migration was safe to apply), and a
 * single-element array like `["SHIFTED"]` is worse: better-sqlite3 flattens
 * it into its own positional parameter and writes it as the description
 * *silently*, no exception at all. Every field reaching a write path is
 * therefore verified here, whether this module calls a method on it or not.
 *
 * A failure here is whole-issue, not per-field: this function does not
 * report anything itself, it only answers "can the rest of this module trust
 * this issue's shape" — the caller routes a `false` to `invalidItems`.
 */
function hasValidShape(issue: BeadsIssue): boolean {
  const candidate = issue as unknown as UnknownRecord;

  if (typeof candidate.status !== "string") return false;
  if (typeof candidate.issue_type !== "string") return false;
  if (typeof candidate.priority !== "number") return false;
  if (typeof candidate.description !== "string") return false;
  if (typeof candidate.owner !== "string") return false;
  if (typeof candidate.created_by !== "string") return false;
  if (typeof candidate.created_at !== "string") return false;
  if (typeof candidate.updated_at !== "string") return false;
  if (candidate.closed_at !== undefined && typeof candidate.closed_at !== "string") return false;
  if (candidate.external_ref !== undefined && typeof candidate.external_ref !== "string")
    return false;
  if (candidate.started_at !== undefined && typeof candidate.started_at !== "string") return false;
  if (candidate.assignee !== undefined && typeof candidate.assignee !== "string") return false;
  if (candidate.close_reason !== undefined && typeof candidate.close_reason !== "string")
    return false;

  if (candidate.dependencies !== undefined) {
    if (
      !Array.isArray(candidate.dependencies) ||
      !candidate.dependencies.every(isDependencyShaped)
    ) {
      return false;
    }
  }
  if (candidate.comments !== undefined) {
    if (!Array.isArray(candidate.comments) || !candidate.comments.every(isCommentShaped)) {
      return false;
    }
  }
  if (candidate.labels !== undefined && !isStringArray(candidate.labels)) return false;

  return true;
}

interface ShapeGateResult {
  /** First-occurrence, shape-valid issues, insertion-ordered by `extract.issues`. */
  readonly shapeOkIssues: Map<string, BeadsIssue>;
  readonly invalidItems: InvalidItem[];
}

/**
 * Step 0: duplicate-id gate, then shape gate, in input order. First
 * occurrence of an id wins deterministically; every later occurrence is
 * `invalidItems` regardless of its own shape — a duplicate is never even
 * shape-checked, since the id it would occupy is already spoken for.
 */
function runShapeGate(issues: readonly BeadsIssue[]): ShapeGateResult {
  const seenIds = new Set<string>();
  const shapeOkIssues = new Map<string, BeadsIssue>();
  const invalidItems: InvalidItem[] = [];

  for (const issue of issues) {
    if (seenIds.has(issue.id)) {
      invalidItems.push({ oldId: issue.id, rawTitle: issue.title, reason: "duplicate id" });
      continue;
    }
    seenIds.add(issue.id);

    if (!hasValidShape(issue)) {
      invalidItems.push({ oldId: issue.id, rawTitle: issue.title, reason: "unusable field type" });
      continue;
    }

    shapeOkIssues.set(issue.id, issue);
  }

  return { shapeOkIssues, invalidItems };
}

/**
 * Title-trim gate: mirrors `tasks/repo.ts`'s `createTaskWithin` refusal
 * (`repo.ts:162-170`, `"a task needs a title"`) — an empty-after-trim title
 * cannot become a task or epic row, so it is pre-classified here instead of
 * reaching that refusal at load time.
 */
function filterEmptyTitles(shapeOkIssues: ReadonlyMap<string, BeadsIssue>): {
  readonly acceptedIssues: Map<string, BeadsIssue>;
  readonly invalidItems: InvalidItem[];
} {
  const acceptedIssues = new Map<string, BeadsIssue>();
  const invalidItems: InvalidItem[] = [];

  for (const [oldId, issue] of shapeOkIssues) {
    if (issue.title.trim() === "") {
      invalidItems.push({ oldId, rawTitle: issue.title, reason: "empty title" });
      continue;
    }
    acceptedIssues.set(oldId, issue);
  }

  return { acceptedIssues, invalidItems };
}

// ---------------------------------------------------------------------------
// Report accumulator — one mutable array per MigrationReport category, wrapped
// into {count, items} sections only once, in buildReport.
// ---------------------------------------------------------------------------

interface ReportAccumulator {
  readonly droppedFields: {
    readonly owner: MigrationItemRef[];
    readonly createdBy: MigrationItemRef[];
    readonly estimatedMinutes: MigrationItemRef[];
    readonly externalRef: MigrationItemRef[];
    readonly startedAt: MigrationItemRef[];
    readonly commentAuthor: CommentRef[];
  };
  readonly reparented: ReparentedItem[];
  readonly epicEdgesDropped: MigrationEdgeRef[];
  readonly commentsConverted: CommentRef[];
  readonly unmappedStatuses: UnmappedValue[];
  readonly unmappedTypes: UnmappedValue[];
  readonly danglingEdges: MigrationEdgeRef[];
  readonly duplicateEdges: MigrationEdgeRef[];
  readonly parentCycles: CycleBreak[];
  readonly blocksCycles: BlocksCycleBreak[];
  readonly invalidTimestamps: InvalidTimestamp[];
  readonly invalidItems: InvalidItem[];
  readonly invalidNotes: InvalidNote[];
  readonly clampedValues: ClampedValue[];
  readonly emptyLabels: MigrationItemRef[];
}

function createAccumulator(): ReportAccumulator {
  return {
    droppedFields: {
      owner: [],
      createdBy: [],
      estimatedMinutes: [],
      externalRef: [],
      startedAt: [],
      commentAuthor: [],
    },
    reparented: [],
    epicEdgesDropped: [],
    commentsConverted: [],
    unmappedStatuses: [],
    unmappedTypes: [],
    danglingEdges: [],
    duplicateEdges: [],
    parentCycles: [],
    blocksCycles: [],
    invalidTimestamps: [],
    invalidItems: [],
    invalidNotes: [],
    clampedValues: [],
    emptyLabels: [],
  };
}

// ---------------------------------------------------------------------------
// Per-item mapping — one call each to mapping.ts, per accepted issue.
// ---------------------------------------------------------------------------

/** One accepted issue, mapped. `draft.parentOldId` is a `null` placeholder — {@link resolveAncestry} patches it once the whole graph is known. */
interface MappedItem {
  readonly draft: PlannedItem;
  readonly level: Level;
  readonly notes: PlannedNote[];
  readonly events: PlannedEvent[];
}

interface ClosedInfo {
  readonly closedAt: string;
  readonly closeReason: string | null;
}

/**
 * Resolves a closed item's `closedAt`/`closeReason`, or `null` when the
 * item's final lane is not terminal (`isClosed` false) — one function instead
 * of two mutable `let`s in `mapIssue` plus a later `isClosed && closedAt !==
 * null` re-check, since "is this item closed" only needs deciding once.
 */
function resolveClosedInfo(
  ref: MigrationItemRef,
  issue: BeadsIssue,
  isClosed: boolean,
  fallbackTimestamp: string,
  acc: ReportAccumulator,
): ClosedInfo | null {
  if (!isClosed) return null;

  const closedAtResult = normalizeTimestamp(
    ref,
    "closed_at",
    issue.closed_at ?? "",
    fallbackTimestamp,
  );
  acc.invalidTimestamps.push(...closedAtResult.degradations);

  return { closedAt: closedAtResult.value, closeReason: issue.close_reason ?? null };
}

function mapIssue(
  issue: BeadsIssue,
  migratingIdentity: string,
  fallbackTimestamp: string,
  acc: ReportAccumulator,
): MappedItem {
  const ref: MigrationItemRef = { oldId: issue.id, title: issue.title };

  const status = mapStatus(ref, issue.status);
  acc.unmappedStatuses.push(...status.degradations);

  const typeMapping = mapLevelAndKind(ref, issue.issue_type);
  acc.unmappedTypes.push(...typeMapping.degradations);

  const createdAt = normalizeTimestamp(ref, "created_at", issue.created_at, fallbackTimestamp);
  acc.invalidTimestamps.push(...createdAt.degradations);

  const updatedAt = normalizeTimestamp(ref, "updated_at", issue.updated_at, fallbackTimestamp);
  acc.invalidTimestamps.push(...updatedAt.degradations);

  // Out-of-range priority: mirrors narrow.ts's narrowPriority refusal
  // (narrow.ts:63-67), which load's Within seams would otherwise throw —
  // clampPriority pre-classifies it here instead.
  const priority = clampPriority(ref, issue.priority);
  acc.clampedValues.push(...priority.degradations);

  const tags = buildTags(ref, issue.labels, status.value.tag);
  acc.emptyLabels.push(...tags.degradations);

  // Blank note/comment bodies: mirrors notes/repo.ts's requireBody refusal
  // (notes/repo.ts:68-78, "a note needs a body") — assembleNotes
  // pre-classifies every blank-after-trim source into invalidNotes instead of
  // ever handing load.ts a body that would hit that refusal.
  // Conditional spread, not a plain object literal: exactOptionalPropertyTypes
  // forbids assigning `string | undefined` to BeadsNoteSources's optional
  // `string`-typed fields, so an absent field must be an absent key, not a
  // key holding `undefined`.
  //
  // createdAt.value, not issue.created_at: assembleNotes takes the
  // already-normalized value (mapIssue just normalized it above) rather than
  // re-deriving it from the raw string a second time — the double-normalize
  // used to double-count one bad created_at into invalidTimestamps
  // (katra-9aw.49.10).
  const notesResult = assembleNotes(
    ref,
    createdAt.value,
    {
      ...(issue.design !== undefined ? { design: issue.design } : {}),
      ...(issue.acceptance_criteria !== undefined
        ? { acceptanceCriteria: issue.acceptance_criteria }
        : {}),
      ...(issue.notes !== undefined ? { notes: issue.notes } : {}),
      ...(issue.comments !== undefined ? { comments: issue.comments } : {}),
    },
    migratingIdentity,
    fallbackTimestamp,
  );
  acc.invalidNotes.push(...notesResult.blankNotes);
  acc.droppedFields.commentAuthor.push(...notesResult.commentAuthorFallbacks);
  acc.invalidTimestamps.push(...notesResult.invalidTimestamps);

  // commentsConverted tracks which *comments* (not design/acceptance/notes)
  // became notes — assembleNotes' AssembledNote carries no commentId to
  // recover that from its own output, so this mirrors its blank-body check
  // independently rather than widening mapping.ts's return shape (out of
  // this task's write surface).
  for (const comment of issue.comments ?? []) {
    if (comment.text.trim() !== "") {
      acc.commentsConverted.push({ oldId: ref.oldId, title: ref.title, commentId: comment.id });
    }
  }

  if (issue.owner.trim() !== "") acc.droppedFields.owner.push(ref);
  if (issue.created_by.trim() !== "") acc.droppedFields.createdBy.push(ref);
  if (issue.estimated_minutes !== undefined) acc.droppedFields.estimatedMinutes.push(ref);
  if (issue.external_ref !== undefined && issue.external_ref.trim() !== "") {
    acc.droppedFields.externalRef.push(ref);
  }
  if (issue.started_at !== undefined && issue.started_at.trim() !== "") {
    acc.droppedFields.startedAt.push(ref);
  }

  // A closed item's FINAL lane is a terminal one (Done today, but gated on
  // isTerminal rather than the literal `=== "Done"` — status mapping only
  // ever produces Done for a closed issue right now, but a lane-equality
  // check here would silently stop closing the item the day another status
  // maps to Cancelled instead, which load.ts's own isTerminal-gated
  // choreography would then have no closedAt/closeReason to honor).
  // tasks/repo.ts's createTaskWithin refuses to *create* directly into a
  // terminal lane (repo.ts:181-190, the terminal-lane creation guard), which
  // is exactly why T6's loader creates every item into Defined and reaches
  // its terminal lane through applyMoveWithin instead of stamping it on at
  // INSERT time. This module only decides the *final* lane; the two-step
  // creation is load's concern.
  const isClosed = isTerminal(status.value.lane);
  const closedInfo = resolveClosedInfo(ref, issue, isClosed, fallbackTimestamp, acc);

  const draft: PlannedItem = {
    oldId: issue.id,
    level: typeMapping.value.level,
    kind: typeMapping.value.kind,
    title: issue.title,
    description: issue.description,
    lane: status.value.lane,
    priority: priority.value,
    assignee: issue.assignee ?? null,
    parentOldId: null,
    tags: tags.value,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
    closedAt: closedInfo?.closedAt ?? null,
    closeReason: closedInfo?.closeReason ?? null,
  };

  const events: PlannedEvent[] = [
    { type: "created", itemOldId: issue.id, at: createdAt.value, title: issue.title },
  ];
  if (closedInfo !== null) {
    events.push({
      type: "closed",
      itemOldId: issue.id,
      at: closedInfo.closedAt,
      reason: closedInfo.closeReason,
    });
  }

  const notes: PlannedNote[] = notesResult.value.map((assembled, index) => {
    const id = `${issue.id}:note-${String(index)}`;
    events.push({
      type: "note-added",
      itemOldId: issue.id,
      at: assembled.createdAt,
      noteRef: id,
      actor: assembled.actor,
    });
    return {
      id,
      itemOldId: issue.id,
      kind: assembled.kind,
      body: assembled.body,
      actor: assembled.actor,
      createdAt: assembled.createdAt,
    };
  });

  return { draft, level: typeMapping.value.level, notes, events };
}

// ---------------------------------------------------------------------------
// Steps 1, 3 — edge gathering and classification.
// ---------------------------------------------------------------------------

/**
 * Self- then duplicate- then dangling-checks, in that order, over every
 * `dependencies[]` entry declared by an *accepted* issue (never a shape-gate
 * or title-gate reject — their fields cannot be trusted, and "its edges
 * report as dangling" falls out for free below: any OTHER accepted issue's
 * edge that named a rejected id as its target fails the membership check
 * here, with no special case needed for *why* that id is missing).
 *
 * Self-edges mirror both deps.ts's self-dependency refusal
 * (`deps.ts:241-248`, "a task cannot depend on itself") and links.ts's
 * self-link refusal (`links.ts:32-39`, "a task cannot be linked to itself") —
 * one check covers both, since neither relationship can hold between an
 * issue and itself. Reported under `duplicateEdges` per that section's own
 * doc: "Includes self-edges."
 */
function classifyGenericEdges(
  edges: readonly BeadsDependency[],
  acceptedIssues: ReadonlyMap<string, BeadsIssue>,
  acc: ReportAccumulator,
): BeadsDependency[] {
  const seenKeys = new Set<string>();
  const valid: BeadsDependency[] = [];

  for (const edge of edges) {
    const edgeRef: MigrationEdgeRef = {
      fromOldId: edge.issue_id,
      toOldId: edge.depends_on_id,
      type: edge.type,
    };

    if (edge.issue_id === edge.depends_on_id) {
      acc.duplicateEdges.push(edgeRef);
      continue;
    }

    if (!acceptedIssues.has(edge.issue_id) || !acceptedIssues.has(edge.depends_on_id)) {
      acc.danglingEdges.push(edgeRef);
      continue;
    }

    // NUL separates the three parts (not a printable delimiter like ":" or
    // " ") so an id or type crafted to contain the separator itself can
    // never forge a collision with a different, unrelated edge triple.
    const key = `${edge.issue_id}\u0000${edge.depends_on_id}\u0000${edge.type}`;
    if (seenKeys.has(key)) {
      acc.duplicateEdges.push(edgeRef);
      continue;
    }
    seenKeys.add(key);

    valid.push(edge);
  }

  return valid;
}

interface RoutedEdges {
  /** child oldId -> parent oldId, first parent-child edge per child wins. */
  readonly parentOf: Map<string, string>;
  readonly blocksCandidates: BeadsDependency[];
  readonly linkCandidates: BeadsDependency[];
}

/**
 * Routes self/duplicate/dangling-filtered edges by `type`. Edge direction is
 * pinned (plan-review finding 9), stated here rather than assumed at the call
 * site:
 *
 * - `parent-child`: `issue_id` is the CHILD, `depends_on_id` is the PARENT.
 * - `blocks`: `issue_id` is the blocked/dependent task, `depends_on_id` the
 *   prerequisite — maps straight onto `addDependency(taskId = issue_id,
 *   dependsOnId = depends_on_id)`.
 */
function routeEdgesByType(
  edges: readonly BeadsDependency[],
  levelOf: ReadonlyMap<string, Level>,
  acc: ReportAccumulator,
): RoutedEdges {
  const parentOf = new Map<string, string>();
  const blocksCandidates: BeadsDependency[] = [];
  const linkCandidates: BeadsDependency[] = [];

  for (const edge of edges) {
    if (edge.type === "parent-child") {
      // katra is two levels only (schema CHECK: an epic's parent_id is
      // always NULL) — an epic can never keep a beads parent, whatever level
      // that parent itself maps to. Dropped and reported rather than walked.
      if (levelOf.get(edge.issue_id) === "epic") {
        acc.epicEdgesDropped.push({
          fromOldId: edge.issue_id,
          toOldId: edge.depends_on_id,
          type: edge.type,
        });
        continue;
      }
      // A child with more than one parent-child edge keeps its first (stable
      // input order); this is not one of the pre-classified refusal
      // categories, so extra ones are silently ignored for ancestry rather
      // than invented into a report row.
      if (!parentOf.has(edge.issue_id)) parentOf.set(edge.issue_id, edge.depends_on_id);
      continue;
    }

    if (edge.type === "blocks") {
      blocksCandidates.push(edge);
      continue;
    }

    if (edge.type === "discovered-from" || edge.type === "related") {
      linkCandidates.push(edge);
      continue;
    }

    // An edge type outside the four documented ones has no katra target.
    // There is no dedicated report category for "unrecognised edge type" in
    // the closed 16-key list (plan-review finding 4) — MigrationEdgeRef.type
    // explicitly allows "anything else a hostile export supplied" for
    // exactly this case, so it is folded into danglingEdges (the closest "not
    // written" bucket) rather than dropped with no report at all.
    acc.danglingEdges.push({
      fromOldId: edge.issue_id,
      toOldId: edge.depends_on_id,
      type: edge.type,
    });
  }

  return { parentOf, blocksCandidates, linkCandidates };
}

/**
 * Collapses `linkCandidates` on the *unordered* pair, not the (issue_id,
 * depends_on_id, type) triple `classifyGenericEdges` already deduped on. A
 * link is symmetric (links.ts's own `CHECK (a_id < b_id)` stores one row per
 * pair regardless of which side supplied which id) and type-agnostic
 * (`discovered-from`/`related` both become the same `addLink`), so
 * `related(A,B)`, `discovered-from(A,B)`, and `related(B,A)` are one
 * relationship declared three times, not three distinct edges — the generic
 * pass's triple key treats each as unique since it differs by type and/or
 * direction. First occurrence wins (candidates arrive in the original edge
 * order); every later collapse is reported under `duplicateEdges`, whose own
 * doc already owns "collapsed" edges (the self-edge case above).
 */
function dedupeLinkCandidates(
  candidates: readonly BeadsDependency[],
  acc: ReportAccumulator,
): BeadsDependency[] {
  const seenPairs = new Set<string>();
  const deduped: BeadsDependency[] = [];

  for (const edge of candidates) {
    const pairKey = [edge.issue_id, edge.depends_on_id].sort().join("\u0000");
    if (seenPairs.has(pairKey)) {
      acc.duplicateEdges.push({
        fromOldId: edge.issue_id,
        toOldId: edge.depends_on_id,
        type: edge.type,
      });
      continue;
    }
    seenPairs.add(pairKey);
    deduped.push(edge);
  }

  return deduped;
}

// ---------------------------------------------------------------------------
// Step 2 — ancestry / two-level flattening.
// ---------------------------------------------------------------------------

interface AncestryWalk {
  readonly epicOldId: string | null;
  /** Present only when the walk revisited an already-seen ancestor. */
  readonly cyclePath?: readonly string[];
}

/**
 * Walks up `startOldId`'s parent-child chain (never beads id dot-counting —
 * `katra-9aw.9` is single-dot but chain-depth 3 via edges, per the epic's own
 * research notes) looking for the nearest ancestor whose level is `epic`,
 * with its own visited set so a cycle breaks this walk without corrupting
 * any other item's.
 *
 * `cache` is shared across every call {@link resolveAncestry} makes in one
 * `planMigration` run. A straight n-deep chain would otherwise cost O(n²) —
 * each node re-walking the full remaining suffix its descendants already
 * walked — the exact hostile-export threat model {@link findPath}'s own
 * docstring cites for the same reason. Once a walk resolves *without* hitting
 * a cycle (an epic found, or a genuine dead end), every node on that path
 * shares the identical answer — "Y's nearest epic ancestor" does not depend
 * on who asked — so it is memoized for all of them, turning the chain into
 * O(n) total. A cyclic termination is deliberately never cached: caching it
 * would let a downstream node's walk short-circuit past the cycle instead of
 * revisiting it on its own path, silently dropping that node's own
 * `parentCycles` report — every cyclic node must still discover the cycle
 * from its own `seen` set, exactly as the un-memoized walk did.
 */
function walkAncestry(
  startOldId: string,
  parentOf: ReadonlyMap<string, string>,
  levelOf: ReadonlyMap<string, Level>,
  cache: Map<string, string | null>,
): AncestryWalk {
  const cached = cache.get(startOldId);
  if (cached !== undefined) return { epicOldId: cached };

  const seen = new Set<string>([startOldId]);
  const path: string[] = [startOldId];
  let current = startOldId;

  for (;;) {
    const parent = parentOf.get(current);
    if (parent === undefined) {
      for (const node of path) cache.set(node, null);
      return { epicOldId: null };
    }
    if (seen.has(parent)) return { epicOldId: null, cyclePath: [...path, parent] };

    if (levelOf.get(parent) === "epic") {
      for (const node of path) cache.set(node, parent);
      return { epicOldId: parent };
    }

    const parentCached = cache.get(parent);
    if (parentCached !== undefined) {
      for (const node of path) cache.set(node, parentCached);
      return { epicOldId: parentCached };
    }

    seen.add(parent);
    path.push(parent);
    current = parent;
  }
}

/**
 * Resolves every accepted item's final `parentOldId`. Epics always resolve
 * to `null` (a beads parent an epic had was already dropped and reported by
 * {@link routeEdgesByType}). A task with no direct parent-child edge at all
 * resolves to `null` too, unreported — that is a legitimately parentless
 * task, not a degradation. A task whose walk finds an epic more than one hop
 * away is reparented onto it and reported; one hop away (the direct parent
 * already is the nearest epic) is not reparenting, just the ordinary case.
 *
 * A task that *does* have a direct parent-child edge, but whose whole chain
 * never reaches an epic (reachable in any beads project that never used
 * `epic`/`milestone` types — nothing but `task`-level ancestors all the way
 * up), also reports under `epicEdgesDropped`: `{fromOldId: oldId, toOldId:
 * direct, type: "parent-child"}`. This widens the same category
 * {@link routeEdgesByType} already uses for a dropped epic-to-epic edge
 * rather than adding a new one — both are "a parent-child edge that named a
 * parent katra will not attach this item to," just for different reasons
 * (the parent is an epic that can't itself have a parent, vs. no epic exists
 * anywhere on the chain to attach to).
 */
function resolveAncestry(
  draftByOldId: ReadonlyMap<string, MappedItem>,
  parentOf: ReadonlyMap<string, string>,
  levelOf: ReadonlyMap<string, Level>,
  acc: ReportAccumulator,
): Map<string, string | null> {
  const resolved = new Map<string, string | null>();
  // Shared across every walkAncestry call below — see that function's docs
  // for why this is what keeps a deep chain O(n) instead of O(n²).
  const ancestryCache = new Map<string, string | null>();

  for (const [oldId, mapped] of draftByOldId) {
    if (mapped.level === "epic") {
      resolved.set(oldId, null);
      continue;
    }

    const direct = parentOf.get(oldId);
    if (direct === undefined) {
      resolved.set(oldId, null);
      continue;
    }

    const walk = walkAncestry(oldId, parentOf, levelOf, ancestryCache);
    if (walk.cyclePath !== undefined) {
      acc.parentCycles.push({ oldId, title: mapped.draft.title, path: walk.cyclePath });
      resolved.set(oldId, null);
      continue;
    }

    resolved.set(oldId, walk.epicOldId);
    if (walk.epicOldId !== null) {
      if (walk.epicOldId !== direct) {
        acc.reparented.push({ oldId, title: mapped.draft.title, newParentOldId: walk.epicOldId });
      }
    } else {
      // The chain terminated (no more parent-child edges) without ever
      // finding an epic — the item's own direct parent edge names a task,
      // and nothing above it ever resolves to a katra parent either.
      acc.epicEdgesDropped.push({ fromOldId: oldId, toOldId: direct, type: "parent-child" });
    }
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Step 4 — blocks-cycle detection, deterministic break.
// ---------------------------------------------------------------------------

/**
 * Shortest path `from` → `to` over `adjacency`, breadth-first with an
 * index-walked queue (no `Array.prototype.shift`, which is O(n) per call).
 * Mirrors deps.ts's `cyclePath` (`deps.ts:169-199`) — a JS BFS, not a
 * recursive-CTE path enumeration, because enumerating every simple path is
 * exponential in depth even with `LIMIT 1` (deps.ts's own measured comment at
 * `deps.ts:123-137`).
 */
function findPath(
  adjacency: ReadonlyMap<string, readonly string[]>,
  from: string,
  to: string,
): readonly string[] | null {
  if (from === to) return [from];
  const cameFrom = new Map<string, string>();
  const seen = new Set<string>([from]);
  const queue: string[] = [from];

  for (let head = 0; head < queue.length; head++) {
    const current = queue[head] as string;
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      cameFrom.set(next, current);
      if (next === to) {
        const path: string[] = [];
        for (let at: string | undefined = next; at !== undefined; at = cameFrom.get(at))
          path.unshift(at);
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

/**
 * Detects and deterministically breaks `blocks` cycles — mirrors deps.ts's
 * cycle refusal (`closesCycle`/`addDependencyWithin`, `deps.ts:139-256`,
 * `KatraException` code `cycle`), except this module cannot throw: it must
 * pre-classify the refusal into `blocksCycles` instead so a transform-passed
 * plan loads with zero write-path exceptions (T6's own contract).
 *
 * Deterministic by construction: candidates are sorted by `(issue_id,
 * depends_on_id)` first, then added to the accepted graph one at a time in
 * that fixed order. An edge that would close a cycle — `depends_on_id` can
 * already reach `issue_id` through previously-accepted edges — is dropped
 * and reported instead of accepted; every earlier edge in sort order always
 * wins over a later one that would complete the loop.
 */
function breakBlocksCycles(
  candidates: readonly BeadsDependency[],
  acc: ReportAccumulator,
): BeadsDependency[] {
  const sorted = [...candidates].sort((a, b) => {
    if (a.issue_id !== b.issue_id) return a.issue_id < b.issue_id ? -1 : 1;
    return a.depends_on_id < b.depends_on_id ? -1 : 1;
  });

  const adjacency = new Map<string, string[]>();
  const accepted: BeadsDependency[] = [];

  for (const edge of sorted) {
    const closingPath = findPath(adjacency, edge.depends_on_id, edge.issue_id);
    if (closingPath !== null) {
      acc.blocksCycles.push({
        fromOldId: edge.issue_id,
        toOldId: edge.depends_on_id,
        type: edge.type,
        path: [edge.issue_id, ...closingPath],
      });
      continue;
    }

    const existing = adjacency.get(edge.issue_id);
    if (existing === undefined) adjacency.set(edge.issue_id, [edge.depends_on_id]);
    else existing.push(edge.depends_on_id);
    accepted.push(edge);
  }

  return accepted;
}

// ---------------------------------------------------------------------------
// PlannedEdge assembly — createdAt fallback per PlannedEdge's own docstring.
// ---------------------------------------------------------------------------

interface ItemMeta {
  readonly createdAt: string;
  readonly title: string;
}

/**
 * An edge's own historical `created_at`, falling back to its owning item's
 * (already-normalized) `createdAt` when the export's value does not parse —
 * "the export did not carry one" (`PlannedEdge`'s own docstring, `types.ts`).
 * That fallback is this module's decision, already resolved by the time
 * `load.ts` sees the plan — not the generic epoch `fallbackTimestamp`, which
 * is reserved for issue-level and comment timestamps.
 */
function edgeCreatedAt(
  edge: BeadsDependency,
  meta: ReadonlyMap<string, ItemMeta>,
  acc: ReportAccumulator,
): string {
  const owner = meta.get(edge.issue_id);
  // Invariant: every edge reaching this function already passed
  // classifyGenericEdges's acceptedIssues membership check, so `owner` is
  // always defined — the fallback below only satisfies noUncheckedIndexedAccess.
  const ownerCreatedAt = owner?.createdAt ?? edge.created_at;
  const ref: MigrationItemRef = { oldId: edge.issue_id, title: owner?.title ?? edge.issue_id };

  const normalized = normalizeTimestamp(
    ref,
    `edge:${edge.issue_id}->${edge.depends_on_id}.created_at`,
    edge.created_at,
    ownerCreatedAt,
  );
  acc.invalidTimestamps.push(...normalized.degradations);
  return normalized.value;
}

// ---------------------------------------------------------------------------
// Step 5 — event plan ordering.
// ---------------------------------------------------------------------------

const EVENT_TYPE_ORDER: Record<PlannedEvent["type"], number> = {
  created: 0,
  "note-added": 1,
  closed: 2,
};

/**
 * `(normalized time, then old beads id, then event type order created <
 * note-added < closed)` — the exact tiebreak T5's body pins. Returns `0` on a
 * full tie rather than inventing a fourth key: the acceptance criterion is a
 * *stable* sort (`Array.prototype.sort` has been stable since ES2019), so
 * ties fall back to the order events were pushed — itself deterministic,
 * since every earlier pass iterates accepted issues and their notes in fixed
 * input order.
 */
function compareEvents(a: PlannedEvent, b: PlannedEvent): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.itemOldId !== b.itemOldId) return a.itemOldId < b.itemOldId ? -1 : 1;
  return EVENT_TYPE_ORDER[a.type] - EVENT_TYPE_ORDER[b.type];
}

// ---------------------------------------------------------------------------
// Step 6 — report assembly.
// ---------------------------------------------------------------------------

function section<T>(items: readonly T[]): { readonly count: number; readonly items: readonly T[] } {
  return { count: items.length, items };
}

function buildReport(
  acc: ReportAccumulator,
  items: readonly PlannedItem[],
  skippedRecords: BeadsExtract["skippedRecords"],
): MigrationReport {
  const idMap: MigrationIdMapEntry[] = items.map((item) => ({ oldId: item.oldId, newId: null }));

  return {
    droppedFields: {
      owner: section(acc.droppedFields.owner),
      createdBy: section(acc.droppedFields.createdBy),
      estimatedMinutes: section(acc.droppedFields.estimatedMinutes),
      externalRef: section(acc.droppedFields.externalRef),
      startedAt: section(acc.droppedFields.startedAt),
      commentAuthor: section(acc.droppedFields.commentAuthor),
    },
    reparented: section(acc.reparented),
    epicEdgesDropped: section(acc.epicEdgesDropped),
    commentsConverted: section(acc.commentsConverted),
    unmappedStatuses: section(acc.unmappedStatuses),
    unmappedTypes: section(acc.unmappedTypes),
    skippedRecords,
    danglingEdges: section(acc.danglingEdges),
    duplicateEdges: section(acc.duplicateEdges),
    parentCycles: section(acc.parentCycles),
    blocksCycles: section(acc.blocksCycles),
    invalidTimestamps: section(acc.invalidTimestamps),
    invalidItems: section(acc.invalidItems),
    invalidNotes: section(acc.invalidNotes),
    clampedValues: section(acc.clampedValues),
    emptyLabels: section(acc.emptyLabels),
    imported: computeImportedCounts(items),
    idMap,
    applied: false,
  };
}

// ---------------------------------------------------------------------------
// planMigration — the orchestrator.
// ---------------------------------------------------------------------------

/**
 * Plans a beads → katra migration: maps every issue, builds the dependency
 * and parent graph, flattens hierarchy to two levels, orders the event
 * stream, and reports everything dropped or degraded.
 *
 * `migratingIdentity` and `fallbackTimestamp` are captured once by the
 * caller (T7's CLI layer) and threaded through — see the module docs for why
 * this function cannot source either itself and stay pure.
 */
export function planMigration(
  extract: BeadsExtract,
  migratingIdentity: string,
  fallbackTimestamp: string,
): { readonly plan: MigrationPlan; readonly report: MigrationReport } {
  const acc = createAccumulator();

  const { shapeOkIssues, invalidItems: shapeInvalid } = runShapeGate(extract.issues);
  acc.invalidItems.push(...shapeInvalid);

  const { acceptedIssues, invalidItems: titleInvalid } = filterEmptyTitles(shapeOkIssues);
  acc.invalidItems.push(...titleInvalid);

  const draftByOldId = new Map<string, MappedItem>();
  for (const issue of acceptedIssues.values()) {
    draftByOldId.set(issue.id, mapIssue(issue, migratingIdentity, fallbackTimestamp, acc));
  }

  const levelOf = new Map<string, Level>();
  for (const [oldId, mapped] of draftByOldId) levelOf.set(oldId, mapped.level);

  const allEdges: BeadsDependency[] = [];
  for (const issue of acceptedIssues.values()) {
    for (const edge of issue.dependencies ?? []) allEdges.push(edge);
  }

  const validEdges = classifyGenericEdges(allEdges, acceptedIssues, acc);
  const { parentOf, blocksCandidates, linkCandidates } = routeEdgesByType(validEdges, levelOf, acc);

  const parentOldIdByOldId = resolveAncestry(draftByOldId, parentOf, levelOf, acc);
  const dependencyEdgeSources = breakBlocksCycles(blocksCandidates, acc);
  const dedupedLinkCandidates = dedupeLinkCandidates(linkCandidates, acc);

  const itemMeta = new Map<string, ItemMeta>();
  for (const [oldId, mapped] of draftByOldId) {
    itemMeta.set(oldId, { createdAt: mapped.draft.createdAt, title: mapped.draft.title });
  }

  const dependencyEdges: PlannedEdge[] = dependencyEdgeSources.map((edge) => ({
    kind: "dependency",
    taskOldId: edge.issue_id,
    dependsOnOldId: edge.depends_on_id,
    createdAt: edgeCreatedAt(edge, itemMeta, acc),
  }));
  const linkEdges: PlannedEdge[] = dedupedLinkCandidates.map((edge) => ({
    kind: "link",
    aOldId: edge.issue_id,
    bOldId: edge.depends_on_id,
    createdAt: edgeCreatedAt(edge, itemMeta, acc),
  }));

  const items: PlannedItem[] = [];
  const notes: PlannedNote[] = [];
  const events: PlannedEvent[] = [];
  for (const [oldId, mapped] of draftByOldId) {
    items.push({ ...mapped.draft, parentOldId: parentOldIdByOldId.get(oldId) ?? null });
    notes.push(...mapped.notes);
    events.push(...mapped.events);
  }
  events.sort(compareEvents);

  const plan: MigrationPlan = {
    items,
    notes,
    edges: [...dependencyEdges, ...linkEdges],
    events,
  };

  const report = buildReport(acc, items, extract.skippedRecords);

  return { plan, report };
}
