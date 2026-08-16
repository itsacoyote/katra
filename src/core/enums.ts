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
 * not survive to runtime and this store is written by concurrent processes —
 * with one exception. {@link REFRESH_REASONS} is never written to a column
 * and carries no `CHECK`: it is a closed vocabulary for what the `refresh`
 * command (F8) reports on stdout/`--json` when a provider degrades, not a
 * value this store ever persists, so there is no `CHECK` for it to drift from
 * in the first place.
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
 * Lanes that mean somebody is working on it right now.
 *
 * `board`'s in-flight section, and the reason it is defined by lane rather
 * than by a claim: lanes are what the store actually records, and F4's
 * claims deliberately do not redefine this set. ADR-012 settled the question
 * this comment used to leave open — a claimed task moves no bucket, ever; a
 * claim only orders and annotates the rows a lane already put here.
 */
export const IN_FLIGHT_LANES = ["In Progress", "In Review"] as const satisfies readonly Lane[];

/**
 * Lanes holding work nobody has planned yet.
 *
 * The residue that made `board` need a fifth count. `in flight` takes two
 * lanes, `ready` takes `Planned`, `blocked` takes anything unstartable — and
 * these two, when startable, fall through all three. `add` writes into
 * `Defined`, so on a young store this is the largest group of all.
 */
export const UNTRIAGED_LANES = ["Defined", "Researching"] as const satisfies readonly Lane[];

/**
 * What an event records.
 *
 * Twelve now that `ref-status-changed` lands here — F8's provider refresh
 * cycle (migration 0006), writable at last by the `refresh` command (T5) once
 * an external ref's status actually moves. `ref-linked` and `ref-unlinked`
 * arrived first, with F7's external refs (migration 0005).
 *
 * Four of the twelve are not in `docs/katra-spec.md` §5's own list at all:
 * `deleted` (ADR-008 — `delete` appends its own last event), `cancelled`
 * (ADR-003 — a terminal lane distinct from `closed`), `ref-unlinked` (F7
 * requirement 5), and `ref-status-changed` (F8 requirement 4) — each a
 * deliberate addition with no counterpart in the spec's original curated set.
 *
 * The order is the rough order a task's life produces them, not alphabetical —
 * it is what a reader of the CHECK constraint sees.
 */
export const EVENT_TYPES = [
  "created",
  "claimed",
  "released",
  "status-changed",
  "note-added",
  "closed",
  "cancelled",
  "reopened",
  "deleted",
  "ref-linked",
  "ref-unlinked",
  "ref-status-changed",
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

/**
 * Why a `refresh` (F8) could not fill a ref's cached fields.
 *
 * Declared here rather than beside the provider code that produces them
 * (`src/core/providers/`) so the GitHub provider, the Linear provider and the
 * `refresh` command itself (T2/T3/T5) all import the one canonical set,
 * instead of three files independently inventing overlapping literal unions.
 *
 * Unlike every other set in this module, nothing here is `CHECK`-enforced —
 * see this file's own module doc. A provider degrades to one of these
 * literals rather than ever surfacing a raw `Error#message` (epic risk note
 * 14): the tokens are the whole vocabulary `refresh` reports on stdout and in
 * `--json`, closed the same way every other set here is closed, just not by
 * the database.
 */
export const REFRESH_REASONS = [
  "gh-not-available",
  "gh-unauthenticated",
  "not-found",
  "bad-credentials",
  "network",
  "timeout",
  "no-key",
  "bad-key",
  "malformed-response",
  "bad-shape",
  "no-provider",
  "gone",
] as const;
export type RefreshReason = (typeof REFRESH_REASONS)[number];

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
