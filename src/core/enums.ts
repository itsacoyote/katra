/**
 * katra's fixed value sets, declared exactly once.
 *
 * Each set is an `as const` array and its TypeScript union is *derived* from
 * that array. The SQL `CHECK` constraints are generated from the same arrays
 * via {@link sqlEnum}, so the type and the constraint physically cannot
 * disagree — a `.sql` text file could not reference these arrays, which is
 * precisely how the two would drift.
 *
 * These are enforced in the database, not just in TypeScript, because types do
 * not survive to runtime and this store is written by concurrent processes.
 */

/** Hierarchy. A `task`'s parent is an `epic`; two levels is the whole tree. */
export const LEVELS = ["epic", "task"] as const;
export type Level = (typeof LEVELS)[number];

/**
 * What the work is, mirroring Conventional Commits so a task's kind matches
 * the prefix of the commits it produces.
 *
 * `build` and `ci` fold into `chore`; `style` belongs to commits rather than a
 * backlog; `revert` is an action, not planned work.
 */
export const KINDS = ["feat", "fix", "refactor", "perf", "docs", "test", "chore"] as const;
export type Kind = (typeof KINDS)[number];

/**
 * Workflow stage. The first six map one-per-stage onto Define → Research →
 * Plan → Implement → Validate → Document; `Cancelled` is an exit from the
 * pipeline rather than a stage within it.
 *
 * The Plan-stage lane is `Planned`, not `Ready` (ADR-002): "ready" is reserved
 * for the computed unblocked-by-dependencies property, so a task cannot be
 * simultaneously in the "Ready" lane and not ready.
 */
export const LANES = [
  "Defined",
  "Researching",
  "Planned",
  "In Progress",
  "In Review",
  "Done",
  "Cancelled",
] as const;
export type Lane = (typeof LANES)[number];

/**
 * Lanes that stop a task blocking its dependents (ADR-003).
 *
 * Readiness is defined against this set, never against `Done` alone —
 * otherwise abandoning a blocker would strand everything behind it forever.
 */
export const TERMINAL_LANES = ["Done", "Cancelled"] as const satisfies readonly Lane[];
export type TerminalLane = (typeof TERMINAL_LANES)[number];

/**
 * What an event records.
 *
 * Seven, where `docs/katra-spec.md` §5 lists nine. `claimed` and `released`
 * belong to F4's claims, `ref-linked` and `ref-status-changed` to F5's external
 * refs — declaring them now would put values into a `CHECK` constraint that
 * nothing can write, under forward-only migrations that make the mistake
 * expensive to take back. `deleted` is the one addition the spec's list does
 * not have, from ADR-008: `delete` appends its own last event.
 *
 * The order is the rough order a task's life produces them, not alphabetical —
 * it is what a reader of the CHECK constraint sees.
 */
export const EVENT_TYPES = [
  "created",
  "status-changed",
  "note-added",
  "closed",
  "cancelled",
  "reopened",
  "deleted",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * What a note is for.
 *
 * Distinct from {@link KINDS}, which is a *task's* kind. The two share a word
 * and nothing else: no value appears in both sets, and their narrowers are
 * separate on purpose — see `test/core/enums.test.ts`, which pins that.
 *
 * `handoff` is the one F3's `brief` reads back to the next agent, which is why
 * the set is closed rather than free text.
 */
export const NOTE_KINDS = ["general", "handoff", "decision", "acceptance"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** What a note is when the caller does not say. */
export const NOTE_KIND_DEFAULT = "general" satisfies NoteKind;

/** Priority, 0 highest. Declared as a set so the type derives like the others. */
export const PRIORITIES = [0, 1, 2, 3, 4] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_MIN = 0 satisfies Priority;
export const PRIORITY_MAX = 4 satisfies Priority;
export const PRIORITY_DEFAULT = 2 satisfies Priority;

/** True when `value` is one of `LEVELS`. */
export function isLevel(value: unknown): value is Level {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

/** True when `value` is one of `KINDS`. */
export function isKind(value: unknown): value is Kind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

/** True when `value` is one of `LANES`. */
export function isLane(value: unknown): value is Lane {
  return typeof value === "string" && (LANES as readonly string[]).includes(value);
}

/** True when `value` is a lane that no longer blocks its dependents. */
export function isTerminal(value: unknown): value is TerminalLane {
  return typeof value === "string" && (TERMINAL_LANES as readonly string[]).includes(value);
}

/** True when `value` is one of `EVENT_TYPES`. */
export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}

/** True when `value` is one of `NOTE_KINDS`. Not {@link isKind} — see there. */
export function isNoteKind(value: unknown): value is NoteKind {
  return typeof value === "string" && (NOTE_KINDS as readonly string[]).includes(value);
}

/** True when `value` is one of `PRIORITIES`. */
export function isPriority(value: unknown): value is Priority {
  return typeof value === "number" && (PRIORITIES as readonly number[]).includes(value);
}

/**
 * Renders a set as a SQL `IN`-list fragment: `'epic','task'`.
 *
 * Single quotes are doubled so a value can never terminate its own literal.
 * The current sets contain no quotes, but this fragment is interpolated
 * directly into DDL, and a helper that is only safe for its present inputs is
 * a trap for the next person who adds a value.
 */
export function sqlEnum(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(",");
}
