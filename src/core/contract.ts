/**
 * The documents katra's commands print — the `--json` contract, as types.
 *
 * These live apart from the modules that produce them for one reason: **this
 * file must never reach the storage engine.** TypeScript emits one declaration
 * file per source file, so a type re-exported from `src/index.ts` drags its
 * whole import graph into the published `.d.ts`. Declaring `DeleteResult` next
 * to `deleteTask` meant `dist/index.d.ts` → `delete.d.ts` → `store.d.ts` →
 * `connection.d.ts` → `import Database from "better-sqlite3"`, whose types are
 * a devDependency. A consumer with `skipLibCheck: false` — TypeScript's own
 * default — could not compile against katra at all:
 *
 * ```
 * dist/core/db/connection.d.ts(15,22): error TS7016: Could not find a
 *   declaration file for module 'better-sqlite3'.
 * ```
 *
 * Nothing here may import from `store.ts`, `db/`, or any module that does.
 * `enums.ts` and `tasks/types.ts` are the only permitted dependencies, and
 * neither touches the database.
 */

import type { Lane, NoteKind, Priority } from "./enums.js";
import type { LoggedEvent } from "./events/types.js";
import type { Note } from "./notes/types.js";
import type { Blocker, Task, TaskDetail, TaskSummary } from "./tasks/types.js";

/**
 * Something worth telling the user that is not fatal.
 *
 * Declared here rather than beside the code that raises it, for the same
 * reason as the rest of this file: `locate.ts` types its options with
 * `NodeJS.ProcessEnv`, so publishing anything from that module would put
 * `@types/node` into every consumer's required type graph.
 */
export interface StoreWarning {
  readonly code: "ambient-git-dir";
  readonly message: string;
}

/**
 * A task standing between another task and readiness.
 *
 * Defined in `tasks/types.ts` and re-exported here so this file stays the one
 * place to read the `--json` contract. It moved there because `TaskDetail`
 * needs it, and this module already imports that one.
 */
export type { Blocker };

/**
 * What `update` prints.
 *
 * An envelope rather than a bare {@link TaskDetail}, and deliberately the same
 * shape for one id as for ten: `update` takes a variable number of ids, and a
 * script passing a list it did not count must not get a different document
 * back depending on how many it happened to contain. Human output still adapts
 * — one task is worth printing in full, ten are worth printing as a list.
 */
export interface UpdateResult {
  readonly tasks: readonly TaskDetail[];
}

/**
 * What `log` prints.
 *
 * An envelope for the same reason `update`'s is one: the count varies, and a
 * document whose shape depends on how much happened is not a contract.
 */
export interface EventLog {
  readonly events: readonly LoggedEvent[];
  /**
   * True when the bound cut the result short.
   *
   * `list` is unbounded precisely because a default cap would have to report
   * truncating; `log` *is* bounded, so it owes the same report. Silence here
   * is worse than anywhere else in katra: this is the read F3's session digest
   * builds on, and a partial history that looks complete is one an agent acts
   * on.
   */
  readonly truncated: boolean;
}

/** What `note list` prints. */
export interface NoteList {
  readonly notes: readonly Note[];
}

/** What `list` prints. */
export interface TaskList {
  readonly tasks: readonly Task[];
}

/** What `init` prints. */
export interface InitResult {
  readonly path: string;
  readonly created: boolean;
}

/** What `dep` prints. */
export interface DependencyResult {
  readonly action: "added" | "removed";
  readonly taskId: string;
  readonly dependsOnId: string;
  /** Whether the dependent is unblocked after the change. */
  readonly ready: boolean;
  /** What still stands in its way, so the answer is actionable. */
  readonly blockers: readonly Blocker[];
}

/** What `link` prints. */
export interface LinkResult {
  readonly action: "linked" | "unlinked";
  readonly a: string;
  readonly b: string;
}

/** What `close`, `cancel` and `reopen` print. */
export interface LifecycleResult {
  readonly task: Task;
  /**
   * Tasks that became ready because of this transition.
   *
   * Reported rather than left to be discovered: releasing dependents is the
   * consequence a reader is least likely to predict, and for `cancel` it is
   * the whole reason the lane exists.
   */
  readonly unblocked: readonly TaskSummary[];
  /**
   * Tasks that stopped being ready because of this transition.
   *
   * The inverse surprise, and `reopen`'s alone: reviving a blocker takes work
   * away from whoever was about to start it. Always empty for `close` and
   * `cancel`, which can only release.
   */
  readonly reblocked: readonly TaskSummary[];
}

/** What `delete` prints. */
export interface DeleteResult {
  readonly id: string;
  readonly title: string;
  /**
   * Tasks that became ready because this one is gone.
   *
   * `ON DELETE CASCADE` removes the dependency rows, which silently makes
   * dependents startable — the same consequence `cancel` reports, and just as
   * easy to miss.
   */
  readonly unblocked: readonly TaskSummary[];
}

/** A planned task that cannot be started, and what stands in its way. */
export interface BlockedTask {
  readonly id: string;
  readonly title: string;
  readonly blockers: readonly Blocker[];
}

/**
 * What `next` prints.
 *
 * Deliberately a discriminated union rather than `Task | null`: the empty case
 * has to carry the blockers, or the caller learns only that it got nothing —
 * and an agent that reads "nothing" as "no work left" stops working.
 */
export type NextResult =
  | { readonly status: "found"; readonly task: Task; readonly epic: TaskSummary | null }
  | {
      readonly status: "none";
      readonly blocked: readonly BlockedTask[];
      /**
       * Unfinished work outside the `Planned` lane.
       *
       * Three answers hide behind "nothing to do", and an agent needs to tell
       * them apart: everything planned is blocked (`blocked` is non-empty),
       * nothing has been triaged yet (`blocked` empty, this above zero), or
       * there is genuinely no work left (both zero). The middle one used to
       * render as a dead end — `add` puts a task in `Defined`, so a fresh
       * store answered with a lane the caller had never heard of.
       */
      readonly untriaged: number;
    };

/** A note shown in full, and what the cap did to it. */
export interface BriefNote {
  readonly note: Note;
  /**
   * True when the character cap cut the body.
   *
   * The rule every bound in katra follows, and it matters most here: a handoff
   * that looks complete and is not is worse than an absent one, because a
   * session acts on it. The human rendering names `note list` when this is set;
   * `--json` has no prose, so it has this.
   */
  readonly truncated: boolean;
}

/** An epic's children, grouped under the lane they sit in. */
export interface BriefLane {
  readonly lane: Lane;
  readonly tasks: readonly TaskSummary[];
  /**
   * True when this lane holds more children than were returned.
   *
   * Per lane rather than for the children as a whole, because the cap is per
   * lane: a single global cap over a list ordered by priority can fill itself
   * from forty `Done` children and show none of the three that are left to do.
   */
  readonly truncated: boolean;
}

/** What `brief` prints, common to both shapes. */
interface BriefCommon {
  readonly task: Task;
  /** The epic this belongs to, resolved so output can name it. Null on an epic. */
  readonly epic: TaskSummary | null;
  /**
   * The latest `handoff`, in full — the reason `brief` exists.
   *
   * `show` prints note *previews* and caps them at five, which is exactly the
   * shape that makes a handoff useless: it is written to be read whole. Null
   * when the scope holds none.
   */
  readonly handoff: BriefNote | null;
  /** How many other notes are attached, by kind, so nothing is invisible. */
  readonly noteCounts: Partial<Record<NoteKind, number>>;
  readonly activity: readonly LoggedEvent[];
  readonly activityTruncated: boolean;
}

/**
 * What `brief` prints.
 *
 * A discriminated union on `level`, not one shape with optional fields, for the
 * same reason {@link NextResult} is one: a consumer must never have to guess
 * whether a field is absent because it does not apply or because nothing filled
 * it in. An epic has children and no blockers; a task has blockers and no
 * children. Those are different questions, and the type says so — which also
 * lets the formatter be exhaustive against `never`.
 *
 * {@link BoardResult} is deliberately the opposite: fixed keys, always present,
 * empty when they have nothing (ADR-009). `brief` describes one thing that is
 * one of two kinds; `board` describes one thing that is always the same shape.
 */
export type BriefResult =
  | (BriefCommon & {
      readonly level: "task";
      readonly blockers: readonly Blocker[];
      readonly blocking: readonly Blocker[];
    })
  | (BriefCommon & {
      readonly level: "epic";
      /** Children grouped by lane, in lane order, so the shape of the work reads. */
      readonly children: readonly BriefLane[];
    });

/** A task on the board, with just enough to decide what to do about it. */
export interface BoardTask {
  readonly id: string;
  readonly title: string;
  readonly lane: Lane;
  readonly priority: Priority;
  /**
   * True when this in-flight task has an unfinished dependency.
   *
   * Carried on the row rather than expressed by putting the task in `blocked`
   * too: the sections are disjoint so the counts reconcile, and a task somebody
   * is part-way through is in flight whatever is standing in its way. Always
   * false outside the in-flight section, where the section itself says it.
   */
  readonly blocked: boolean;
  /** What stands in its way. Populated for the blocked section. */
  readonly blockers: readonly Blocker[];
}

/** One bounded section of the board. */
export interface BoardSection {
  readonly tasks: readonly BoardTask[];
  /** True when the cap cut the section short. The counts above still say how many. */
  readonly truncated: boolean;
}

/**
 * The board's counts, which partition `open`.
 *
 * `open = inFlight + ready + blocked + untriaged`, exactly. The fifth number is
 * why: `in flight` takes two lanes, `ready` takes startable `Planned` work,
 * `blocked` takes what cannot start — and startable `Defined`/`Researching`
 * tasks fall through all three. `add` writes into `Defined`, so on a young
 * store that residue is the largest group, and a board without it renders
 * `12 open · 0 · 0 · 0` above four empty sections.
 *
 * **Uncapped totals.** The sections below are bounded by `--limit`; these are
 * not. A header that shrank to match the cap would state a backlog size that is
 * not true, which is the one thing an orientation view must never do.
 */
export interface BoardCounts {
  /** Non-terminal tasks: `level = 'task' AND lane NOT IN ('Done','Cancelled')`. */
  readonly open: number;
  readonly inFlight: number;
  readonly ready: number;
  readonly blocked: number;
  /**
   * Startable work nobody has planned yet.
   *
   * **Not** `next`'s `untriaged`, despite the name: that one counts everything
   * outside `Planned` regardless of readiness, including work in progress. The
   * two documents will legitimately disagree about this number for one store.
   */
  readonly untriaged: number;
}

/** The newest handoff in the store, with the task it belongs to. */
export interface BoardDigest {
  readonly note: Note;
  readonly truncated: boolean;
  readonly taskId: string;
  readonly taskTitle: string;
  /**
   * The lane of the task the handoff is attached to.
   *
   * The digest is deliberately not filtered to unfinished work — "I finished X,
   * next is Y" is the commonest real handoff and lives on a `Done` task, so
   * filtering would hide the best ones. The lane is what stops a finished
   * task's handoff from reading as live context.
   */
  readonly taskLane: Lane;
}

/**
 * What `board` prints.
 *
 * A **fixed shape**, deliberately the opposite of {@link BriefResult}'s union:
 * every key is always present and a section with nothing in it is empty rather
 * than absent (ADR-009). `brief` describes one thing that is one of two kinds;
 * `board` describes one store, which is always the same store.
 *
 * Epics appear in no section and in no count. Nothing forbids an epic sitting
 * in `In Progress`, and an epic with a dependency is unready — so excluding
 * them from `ready` alone would produce a board that refuses to offer an epic
 * as work while showing it as work in progress.
 */
export interface BoardResult {
  readonly counts: BoardCounts;
  readonly inFlight: BoardSection;
  readonly ready: BoardSection;
  readonly blocked: BoardSection;
  readonly recent: readonly LoggedEvent[];
  readonly recentTruncated: boolean;
  /**
   * Where the work is when nothing is startable and nothing is under way.
   *
   * Null unless the in-flight, ready and blocked **counts** are all zero while
   * `untriaged` is not. Triggered on the counts, never on the rendered
   * sections: sections are capped, and `--limit 0` empties all three while the
   * backlog is untouched.
   *
   * Without it a store holding twelve `Defined` tasks renders as four empty
   * sections and says nothing about where the twelve are — the dead end
   * `next`'s untriaged count exists to prevent, reintroduced in the command
   * meant to be run at every checkpoint.
   */
  readonly pointer: string | null;
  /** The newest handoff, when `--digest` asked for it. */
  readonly digest: BoardDigest | null;
}

/** What `--help --json` prints: the usage screen, as data. */
export interface HelpDocument {
  readonly help: string;
}

/** What `--version --json` prints. */
export interface VersionDocument {
  readonly version: string;
}

/**
 * Any command's document, as it is actually printed.
 *
 * `warnings` is merged into the top level of every `--json` document when the
 * store had something non-fatal to say — an ambient `GIT_DIR` redirect, today.
 * It is part of the contract, so the published types have to admit it rather
 * than describing a shape the CLI never quite emits.
 */
export type JsonDocument<T> = T & { readonly warnings?: readonly StoreWarning[] };
