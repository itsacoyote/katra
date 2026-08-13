/**
 * beads → katra: the pure per-item mapping layer (F5, T4, `katra-9aw.49.4`).
 *
 * Every function here maps *one* beads value — a status, an `issue_type`, a
 * title, a timestamp, a priority, a label set, a note field — onto its katra
 * equivalent. None of it touches the store, mints an id, walks the
 * dependency graph, or decides event order: that's `transform.ts` (T5),
 * which calls these functions once per issue and accumulates their
 * degradations into the sixteen-category {@link MigrationReport}
 * (`types.ts`, T2).
 *
 * Two rules hold across every function in this file:
 *
 * 1. **Never throw.** An unrecognised status, an unparseable timestamp, an
 *    out-of-range priority — none of it is exceptional here. `--from`
 *    accepts an arbitrary `bd export`, so a value this module cannot map is
 *    the expected case, not a bug. Every function that can encounter one
 *    reports it and substitutes a safe default, using the non-throwing
 *    `is*` predicates from `enums.ts` (`isPriority`, `isKind`) — never the
 *    `narrow*` family in `narrow.ts`, which exists precisely to throw at a
 *    trusted boundary this module is not.
 * 2. **Pure and deterministic.** No clock reads, no randomness, no I/O.
 *    Every function that needs "now" (`normalizeTimestamp`'s `fallback`) or
 *    "who is running this migration" (`assembleNotes`'s `migratingIdentity`)
 *    takes it as a parameter — `transform.ts` captures each once per run and
 *    threads it through, the same discipline `clock.ts` documents for
 *    `nowIso()` inside a single transaction.
 *
 * The common return shape is `{ value, degradations }`: the mapped value,
 * plus zero or more report-section entries already shaped to slot straight
 * into the matching {@link MigrationReport} key (`unmappedStatuses`,
 * `clampedValues`, `emptyLabels`, …) without `transform.ts` reconstructing
 * them. `assembleNotes` returns more than one degradation array because note
 * assembly genuinely feeds three different report categories at once
 * (`invalidNotes`, `droppedFields.commentAuthor`, `invalidTimestamps`).
 */

import { toIso } from "../clock.js";
import type { Kind, Lane, Level, NoteKind, Priority } from "../enums.js";
import {
  isKind,
  isPriority,
  KINDS,
  PRIORITY_DEFAULT,
  PRIORITY_MAX,
  PRIORITY_MIN,
} from "../enums.js";
import type {
  BeadsComment,
  ClampedValue,
  CommentRef,
  InvalidNote,
  InvalidTimestamp,
  MigrationItemRef,
  UnmappedValue,
} from "./types.js";

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/** Where a beads status lands, plus the tag it carries when katra has no lane for it. */
export interface StatusMapping {
  readonly lane: Lane;
  readonly tag?: string;
}

/**
 * beads `status` → katra lane, exactly `docs/migrating-from-beads.md`'s
 * "Status mapping" table.
 *
 * Declared `as const satisfies Record<string, StatusMapping>` rather than
 * annotated `: Record<string, StatusMapping>`: `satisfies` checks every
 * value's `lane` against the real {@link Lane} union — so a typo (`"Defned"`,
 * or a lane katra doesn't have, like `"Ready"` — ADR-002 reserves that name
 * for computed readiness, not a lane) is a compile error — while `as const`
 * keeps the literal keys and values available to tests and callers instead
 * of widening them to `string`/`Lane`.
 */
export const STATUS_MAP = {
  // Conservative: beads `open` means "available to work", not "researched" —
  // it enters at the first lane rather than being promoted to `Ready`.
  open: { lane: "Defined" },
  in_progress: { lane: "In Progress" },
  // katra has no `blocked` lane — blocked is *computed* from dependency
  // edges (ADR-003), never stored, so a lane here would duplicate and desync
  // it. The edges themselves carry the meaning.
  blocked: { lane: "Defined" },
  deferred: { lane: "Defined", tag: "deferred" },
  pinned: { lane: "Defined", tag: "pinned" },
  hooked: { lane: "In Progress" },
  closed: { lane: "Done" },
} as const satisfies Record<string, StatusMapping>;

export interface MappedStatus {
  readonly value: StatusMapping;
  readonly degradations: readonly UnmappedValue[];
}

/**
 * Maps one beads `status` to its katra lane and status tag.
 *
 * An unrecognised status defaults to `Defined` — the same conservative
 * landing spot `open` gets — and is reported rather than thrown: `mapping.ts`
 * classifies and reports, it does not crash a migration over one bad row.
 *
 * `Object.hasOwn` guards the lookup, not a plain index: `status` is an
 * untrusted string from `--from`, and indexing a plain object with a hostile
 * key (`"constructor"`, `"toString"`, `"__proto__"`) resolves through
 * `Object.prototype` instead of returning `undefined` — the recognised-status
 * branch would then run with an inherited, non-`StatusMapping` value, landing
 * a `lane` of `undefined` on a `NOT NULL` column with zero degradations
 * reported. `extract.ts`'s per-type counter uses a `Map` for the same
 * reason — prototype-free by construction; a plain object needs the explicit
 * own-property check instead.
 */
export function mapStatus(ref: MigrationItemRef, status: string): MappedStatus {
  const mapped = Object.hasOwn(STATUS_MAP, status)
    ? (STATUS_MAP as Record<string, StatusMapping>)[status]
    : undefined;
  if (mapped !== undefined) return { value: mapped, degradations: [] };

  return {
    value: { lane: "Defined" },
    degradations: [{ oldId: ref.oldId, title: ref.title, raw: status }],
  };
}

// ---------------------------------------------------------------------------
// issue_type -> level + kind, and the title kind-prefix parser
// ---------------------------------------------------------------------------

/** An item's hierarchy level and work-type kind. */
export interface TypeMapping {
  readonly level: Level;
  readonly kind: Kind;
}

/**
 * beads `issue_type` → katra `{level, kind}`, exactly
 * `docs/migrating-from-beads.md`'s "issue_type -> level + kind" table.
 *
 * Same `as const satisfies` discipline as {@link STATUS_MAP}: a typo in
 * either `level` or `kind` is a compile error against the real {@link Level}/
 * {@link Kind} unions.
 */
export const TYPE_MAP = {
  epic: { level: "epic", kind: "feat" },
  milestone: { level: "epic", kind: "chore" },
  feature: { level: "task", kind: "feat" },
  story: { level: "task", kind: "feat" },
  bug: { level: "task", kind: "fix" },
  chore: { level: "task", kind: "chore" },
  // The doc's "(+ a decision note)" annotation is independent of this
  // level/kind mapping: an issue's `design` field, if present, always
  // becomes a `decision` note via `assembleNotes` below, regardless of
  // `issue_type`. This row only resolves level/kind.
  decision: { level: "task", kind: "docs" },
  spike: { level: "task", kind: "chore" },
  task: { level: "task", kind: "chore" },
} as const satisfies Record<string, TypeMapping>;

/**
 * Matches `<kind>:` or `<kind>(<scope>):` at the start of a title, strictly
 * against {@link KINDS} — built from the array itself so nothing here can
 * drift from it. The `(scope)` group is non-capturing: nothing downstream
 * consumes the scope text, only whether one was present so the prefix still
 * ends at `:`.
 */
const KIND_PREFIX_PATTERN = new RegExp(`^(${KINDS.join("|")})(?:\\([^()]+\\))?:`);

/**
 * Parses a Conventional-Commit kind prefix off a beads issue title, returning
 * just the {@link Kind} — no production caller has ever consumed a captured
 * scope, so this returns `Kind | undefined` rather than a wrapper type.
 *
 * TRAP (state it, don't just rely on it): `decision:` must **not** match
 * here. `decision` is a {@link NoteKind} — `design` maps to a `decision`
 * note (see {@link assembleNotes}) — not a task {@link Kind}; the two sets
 * share no value on purpose (`test/core/enums.test.ts`, "keeps note kinds
 * and task kinds separate"). Because {@link KIND_PREFIX_PATTERN} is built
 * from {@link KINDS} alone, `decision:` — and `gap:`, `finding:`, `sweep:`,
 * and anything else a beads author writes — falls through to
 * {@link TYPE_MAP} by construction. There is no separate exclusion list to
 * keep in sync with `KINDS`, which is what makes the trap hard to
 * reintroduce by accident.
 *
 * Strict on purpose: the kind must be followed immediately by `:` or
 * `(scope):`, anchored to the start of the string, so `feature:` (not a
 * `KINDS` value, but also not `feat` followed by `:`) and `a feat: thing`
 * (not anchored) both correctly fail to match.
 */
export function parseTitleKindPrefix(title: string): Kind | undefined {
  const match = KIND_PREFIX_PATTERN.exec(title);
  if (!match) return undefined;

  const kind = match[1];
  return kind !== undefined && isKind(kind) ? kind : undefined;
}

export interface MappedLevelAndKind {
  readonly value: TypeMapping;
  readonly degradations: readonly UnmappedValue[];
}

/**
 * Resolves an item's {@link Level} and {@link Kind}.
 *
 * Resolution order, per `docs/migrating-from-beads.md`: a valid title kind
 * prefix always wins for `kind` — even over an `issue_type` that
 * {@link TYPE_MAP} *does* recognise (req 4: "more accurate than any type
 * map"), falling back to `TYPE_MAP` only when the title carries none.
 * `level` has no title-derived signal, so it always comes from `TYPE_MAP`
 * (or the `task` default). An unrecognised `issue_type` is reported via
 * `degradations` regardless of whether the title prefix recovered a usable
 * `kind` — the raw `issue_type` value was still unmapped, and that fact
 * doesn't disappear just because `kind` didn't end up needing it.
 *
 * Parses `ref.title` — not a separate `title` parameter: `ref` already
 * carries the item's title, and a second copy would let a caller parse one
 * string while `degradations` reports another, drifting silently apart.
 *
 * Same `Object.hasOwn` guard as {@link mapStatus}, for the same reason: an
 * `issue_type` of `"toString"` or `"constructor"` must not resolve through
 * `Object.prototype` and be mistaken for a recognised type.
 */
export function mapLevelAndKind(ref: MigrationItemRef, issueType: string): MappedLevelAndKind {
  const typeMapping = Object.hasOwn(TYPE_MAP, issueType)
    ? (TYPE_MAP as Record<string, TypeMapping>)[issueType]
    : undefined;
  const level = typeMapping?.level ?? "task";
  const fallbackKind = typeMapping?.kind ?? "chore";
  const kind = parseTitleKindPrefix(ref.title) ?? fallbackKind;

  return {
    value: { level, kind },
    degradations:
      typeMapping === undefined ? [{ oldId: ref.oldId, title: ref.title, raw: issueType }] : [],
  };
}

// ---------------------------------------------------------------------------
// Timestamp normalization
// ---------------------------------------------------------------------------

export interface NormalizedTimestamp {
  readonly value: string;
  readonly degradations: readonly InvalidTimestamp[];
}

/**
 * Normalizes one beads timestamp — `created_at`/`updated_at`/`closed_at`, or
 * a comment's `created_at` — to katra's canonical width.
 *
 * beads exports second-precision `...Z` timestamps (20 chars, e.g.
 * `2026-08-03T09:05:00Z`). katra's own `created_at`/`updated_at` are SQLite
 * `TEXT` columns sorted lexicographically, not as dates (`clock.ts`) — so a
 * fixed, zero-padded 24-char millisecond width isn't cosmetic, it's the only
 * format where lexicographic order equals chronological order. A 20-char
 * value interleaved with 24-char ones would sort by string length before it
 * sorts by time, silently corrupting ordering.
 *
 * This reuses `clock.ts`'s own `toIso` — the one place katra formats a
 * timestamp — rather than re-deriving `.toISOString()` here, but only after
 * confirming `Date.parse` succeeded: `toIso` throws on an invalid `Date`,
 * and this module never throws (classify-and-report, not crash).
 *
 * An unparseable `raw` reports an {@link InvalidTimestamp} and returns
 * `fallback` verbatim. `fallback` is the caller's job to supply
 * (`transform.ts`, T5) rather than something this function reaches for
 * itself — reading the wall clock here would make the same bad input
 * normalize differently across two calls in the same run, breaking the
 * "deterministic" contract this whole module holds to.
 */
export function normalizeTimestamp(
  ref: MigrationItemRef,
  field: string,
  raw: string,
  fallback: string,
): NormalizedTimestamp {
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    return {
      value: fallback,
      degradations: [{ oldId: ref.oldId, title: ref.title, field, raw, fallback }],
    };
  }

  return { value: toIso(new Date(ms)), degradations: [] };
}

// ---------------------------------------------------------------------------
// Priority clamp
// ---------------------------------------------------------------------------

export interface ClampedPriority {
  readonly value: Priority;
  readonly degradations: readonly ClampedValue[];
}

/**
 * Clamps a raw beads `priority` to katra's `0`-`4` range, `0` highest.
 *
 * Both systems use the same `0`-`4` scale, so this repo's own corpus never
 * exercises the clamp — the threat model is an arbitrary `--from` export
 * (plan-review LOW: "arbitrary exports via `--from` are the threat model,
 * not this repo's 0-3 corpus"), which can carry anything: negative, `> 4`,
 * fractional, `NaN`. A value already inside `PRIORITIES` passes straight
 * through; anything else is bounded to `[0, 4]` and rounded to the nearest
 * integer, and a value with no finite bound (`NaN`, `±Infinity`) falls back
 * to {@link PRIORITY_DEFAULT}. Either branch is reported — the caller never
 * has to guess whether a `priority` in the plan is the one beads sent.
 */
export function clampPriority(ref: MigrationItemRef, raw: number): ClampedPriority {
  if (isPriority(raw)) return { value: raw, degradations: [] };

  const bounded = Math.min(PRIORITY_MAX, Math.max(PRIORITY_MIN, raw));
  const rounded = Number.isFinite(bounded) ? Math.round(bounded) : PRIORITY_DEFAULT;
  // isPriority, not a cast: the arithmetic above always lands rounded inside
  // [PRIORITY_MIN, PRIORITY_MAX], but the non-throwing predicate is what
  // proves it to the type system without asserting past it.
  const clamped = isPriority(rounded) ? rounded : PRIORITY_DEFAULT;

  return {
    value: clamped,
    degradations: [{ oldId: ref.oldId, title: ref.title, field: "priority", raw, clamped }],
  };
}

// ---------------------------------------------------------------------------
// Tag assembly
// ---------------------------------------------------------------------------

export interface BuiltTags {
  readonly value: readonly string[];
  readonly degradations: readonly MigrationItemRef[];
}

/**
 * Assembles an item's tags: its labels, `beads:<oldId>` (the traceability
 * the doc promises — "the old ID is preserved on the task"), and the status
 * tag {@link mapStatus} may have produced (`deferred`/`pinned`) — a set
 * union, so a label that happens to collide with either is not duplicated.
 *
 * A label blank after trimming is skipped and reported under `emptyLabels`,
 * not silently carried through: the tag-insert loop in `createTaskWithin`
 * (`repo.ts`) already skips a blank tag on write, so an unclassified blank
 * here would vanish from the store with nothing in the report to explain why
 * the written tag count doesn't match the label count.
 */
export function buildTags(
  ref: MigrationItemRef,
  labels: readonly string[] | undefined,
  statusTag: string | undefined,
): BuiltTags {
  const degradations: MigrationItemRef[] = [];
  const tags = new Set<string>();

  for (const label of labels ?? []) {
    const trimmed = label.trim();
    if (trimmed === "") {
      degradations.push({ oldId: ref.oldId, title: ref.title });
      continue;
    }
    tags.add(trimmed);
  }

  tags.add(`beads:${ref.oldId}`);
  if (statusTag !== undefined) tags.add(statusTag);

  return { value: [...tags], degradations };
}

// ---------------------------------------------------------------------------
// Note assembly
// ---------------------------------------------------------------------------

/**
 * One note {@link assembleNotes} has decided to create.
 *
 * Mirrors {@link Note} (`notes/types.ts`) field-for-field (`kind`, `body`,
 * `actor`, `createdAt`) short of an `id`: `transform.ts` (T5) mints the
 * plan-local {@link PlannedNote.id} and attaches `itemOldId` once it knows
 * where this note lands in the full plan — neither is this function's
 * concern to invent.
 */
export interface AssembledNote {
  readonly kind: NoteKind;
  readonly body: string;
  readonly actor: string;
  readonly createdAt: string;
}

/** The beads issue fields {@link assembleNotes} converts into typed notes. */
export interface BeadsNoteSources {
  readonly design?: string;
  readonly acceptanceCriteria?: string;
  readonly notes?: string;
  readonly comments?: readonly BeadsComment[];
}

export interface AssembledNotes {
  readonly value: readonly AssembledNote[];
  /** Blank-after-trim note bodies — the note was skipped, not written empty. */
  readonly blankNotes: readonly InvalidNote[];
  /** Comments whose `author` was missing or blank, resolved to `migratingIdentity`. */
  readonly commentAuthorFallbacks: readonly CommentRef[];
  /** Unparseable comment `created_at` values, normalized to `fallback` — same policy as {@link normalizeTimestamp}. */
  readonly invalidTimestamps: readonly InvalidTimestamp[];
}

/**
 * Converts one issue's free-text fields and comments into typed notes:
 * `design` → `decision`, `acceptance_criteria` → `acceptance`, `notes` →
 * `general`, each comment → `general`, preserving the comment's `author` as
 * the note's `actor` and its `created_at`, normalized to katra's canonical
 * width (`normalizeTimestamp`).
 *
 * The three issue-level fields share one `createdAt` — `issueCreatedAt`,
 * **already normalized by the caller** (`transform.ts`'s `mapIssue` calls
 * `normalizeTimestamp` on the issue's own `created_at` once, for the
 * `PlannedItem` itself, and threads that same value in here) rather than a
 * raw string this function would normalize again. Re-deriving it here used
 * to double-count one bad timestamp into `invalidTimestamps` — once from
 * `mapIssue`'s own call, once from this function silently repeating it on
 * the identical raw value (`katra-9aw.49.10`) — since beads carries no
 * per-field timestamp for `design`/`acceptance_criteria`/`notes` to
 * normalize independently anyway; all three share the issue's one value.
 *
 * A comment's own `created_at` is a genuinely separate value beads *does*
 * carry per-comment, so that one is still normalized here, same as always.
 *
 * A comment missing `author`, or blank after trimming, falls back to
 * `migratingIdentity` and is reported under `commentAuthorFallbacks`
 * (`droppedFields.commentAuthor` in the full report) — the policy
 * {@link BeadsComment.author}'s own doc comment in `types.ts` states, citing
 * `notes.actor NOT NULL` (migration 0002): a note's actor cannot be absent,
 * so *something* has to fill it in when beads didn't capture one.
 */
export function assembleNotes(
  ref: MigrationItemRef,
  issueCreatedAt: string,
  sources: BeadsNoteSources,
  migratingIdentity: string,
  fallbackTimestamp: string,
): AssembledNotes {
  const value: AssembledNote[] = [];
  const blankNotes: InvalidNote[] = [];
  const commentAuthorFallbacks: CommentRef[] = [];
  const invalidTimestamps: InvalidTimestamp[] = [];

  const addIssueLevelNote = (kind: NoteKind, body: string | undefined): void => {
    if (body === undefined) return;
    const trimmed = body.trim();
    if (trimmed === "") {
      blankNotes.push({ oldId: ref.oldId, title: ref.title, noteKind: kind });
      return;
    }
    value.push({ kind, body: trimmed, actor: migratingIdentity, createdAt: issueCreatedAt });
  };

  addIssueLevelNote("decision", sources.design);
  addIssueLevelNote("acceptance", sources.acceptanceCriteria);
  addIssueLevelNote("general", sources.notes);

  for (const comment of sources.comments ?? []) {
    const trimmed = comment.text.trim();
    if (trimmed === "") {
      blankNotes.push({
        oldId: ref.oldId,
        title: ref.title,
        noteKind: "general",
        commentId: comment.id,
      });
      continue;
    }

    const rawAuthor = comment.author?.trim();
    const hasAuthor = rawAuthor !== undefined && rawAuthor !== "";
    if (!hasAuthor) {
      commentAuthorFallbacks.push({ oldId: ref.oldId, title: ref.title, commentId: comment.id });
    }

    const commentCreatedAt = normalizeTimestamp(
      ref,
      `comment:${comment.id}.created_at`,
      comment.created_at,
      fallbackTimestamp,
    );
    invalidTimestamps.push(...commentCreatedAt.degradations);

    value.push({
      kind: "general",
      body: trimmed,
      actor: hasAuthor ? rawAuthor : migratingIdentity,
      createdAt: commentCreatedAt.value,
    });
  }

  return { value, blankNotes, commentAuthorFallbacks, invalidTimestamps };
}
