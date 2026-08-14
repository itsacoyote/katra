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
 * `enums.ts`, `tasks/types.ts`, `claims/types.ts` and `beads/types.ts` are the
 * only permitted dependencies, and none of them touches the database.
 */

import type { MigrationReport } from "./beads/types.js";
import type { ClaimInfo } from "./claims/types.js";
import type { Kind, Lane, Level, NoteKind, Priority } from "./enums.js";
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
 * Three types this file does not define, re-exported here so it stays the one
 * place to read the `--json` contract.
 *
 * `Blocker` is defined in `tasks/types.ts` because {@link TaskDetail} needs
 * it there, and this module already imports that one back.
 *
 * `ClaimInfo` (F4) is defined in `claims/types.ts`, the third of this file's
 * permitted dependencies (see the module docs above): that module has to
 * stay free of `store.ts`/`db/*` too, for the identical reason. It rides on
 * `TaskView.claim`, the {@link BriefResult} task arm, and `BoardTask.claim`.
 *
 * `MigrationReport` (F5) is defined in `beads/types.ts`, the fourth permitted
 * dependency, for the same reason again — plus one more: `beads/types.ts`
 * also declares `MigrationPlan`, `transform.ts`'s internal work order for
 * `load.ts`. Declaring `MigrationReport` beside it, rather than here, keeps
 * the plan and the report each other's neighbor and this file untouched by
 * `transform.ts`/`load.ts`'s internals — only the report crosses back.
 */
export type { Blocker, ClaimInfo, MigrationReport };

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
      /**
       * Planned work that exists but is claimed by another worktree (F4).
       *
       * A fourth answer behind "nothing to do", distinct from `untriaged`:
       * every one of the backlog's `Planned` candidates being claimed
       * elsewhere is not the same as the store having none at all, and an
       * agent that cannot tell the two apart reads a live backlog as an empty
       * one. Declared here in full by T8; `nextTask` (`tasks/next.ts`)
       * produces `0` until T6 makes the candidate query claim-aware.
       */
      readonly claimedElsewhere: number;
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
  /** How many children this lane holds in total, capped or not. */
  readonly total: number;
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
  /**
   * Unfinished dependencies — what stops this being started.
   *
   * On **both** shapes. An epic can carry a dependency like anything else, and
   * `brief`'s stated first question is whether the thing can be picked up, so
   * an epic arm without this answered by omission. `docs/katra-spec.md` §6b
   * lists open blockers as part of the context pack without qualifying it by
   * level.
   */
  readonly blockers: readonly Blocker[];
  /** Tasks waiting on this one — what finishing it would release. */
  readonly blocking: readonly Blocker[];
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
 *
 * `claim` (F4) is on the **task arm only**, for the same reason `children` is
 * on the epic arm only: an epic cannot be claimed (AC6), so a `claim` field on
 * that arm would be permanently `null` — the exact absent-vs-unfilled
 * ambiguity this union exists to rule out, not ordinary nullable data.
 */
export type BriefResult =
  | (BriefCommon & { readonly level: "task"; readonly claim: ClaimInfo | null })
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
   * is part-way through is in flight whatever is standing in its way.
   *
   * Always false in `ready`, which selects `is_ready = 1`, and always true in
   * `blocked`, which selects `is_ready = 0`. It earns its place in `inFlight`,
   * where it is the only signal that a task under way has become stuck.
   */
  readonly blocked: boolean;
  /** What stands in its way. Populated for the blocked section. */
  readonly blockers: readonly Blocker[];
  /**
   * Who holds this task, or `null` when it is unclaimed (F4).
   *
   * Declared here in full by T8; `toBoardTask` (`board.ts`) produces `null`
   * for every row until T7 joins `claims` into the section queries — the
   * board's `SELECT`s do not reach that table yet, so there is nothing
   * truthful to fill in before then. Not the union-arm ambiguity
   * {@link BriefResult} avoids: this is one fixed shape (ADR-009) reporting
   * data it genuinely does not have yet, the same as any other honest `null`.
   */
  readonly claim: ClaimInfo | null;
  /**
   * True when another worktree holds this task (F4).
   *
   * A second field rather than deriving "claimed by someone else" from
   * `claim` at render time: `toBoardTask` is a pure function of one row and
   * has no caller identity to compare `claim.holder` against, so own-vs-other
   * has to ride in on the row itself. `false` for every row until T7 wires
   * the join and the caller-identity comparison it evaluates for the section
   * `ORDER BY` — see `toBoardTask`.
   */
  readonly claimedElsewhere: boolean;
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

/**
 * One entity with recorded activity — the row shape `recent` and `stale`
 * share (F6 T4), and the base that `search`'s hit extends (T5).
 *
 * Epics appear here on equal footing with tasks: unlike {@link BoardResult}'s
 * sections, which exclude an epic because it is a container nobody picks up,
 * activity is a question about *history*, not about what is startable, and an
 * epic accrues events the same as any task.
 */
export interface ActivityHit {
  readonly id: string;
  readonly title: string;
  readonly level: Level;
  readonly lane: Lane;
  readonly kind: Kind;
  readonly priority: Priority;
  /** The epic this belongs under, or null for top-level work and for an epic itself. */
  readonly epicId: string | null;
  /**
   * The most recent event's timestamp, or null when there is none.
   *
   * Null is only ever real on search's outer-joined filter path (T5): a task
   * that matches the filters but was never touched still has to appear there
   * — a filter narrows, it never deletes. `recent` and `stale` join inner
   * (`activityJoin({outer: false})`, `src/core/activity.ts`), so every hit
   * either of them returns truly has one; the field stays nullable regardless,
   * because one document's shape cannot depend on which command produced it.
   */
  readonly lastActivity: string | null;
}

/** What `recent` prints. */
export interface RecentResult {
  readonly hits: readonly ActivityHit[];
  /** True when the bound cut the result short. `recent` is capped by default, so it owes this the same as `log` does. */
  readonly truncated: boolean;
}

/** What `stale` prints. */
export interface StaleResult {
  readonly hits: readonly ActivityHit[];
  readonly truncated: boolean;
  /**
   * The cutoff actually applied, in katra's canonical timestamp format.
   *
   * Echoed rather than left implicit: `--older-than` has a default (2 weeks),
   * and a result that does not say which instant it compared against leaves a
   * caller guessing whether the default or an explicit flag produced it.
   */
  readonly olderThan: string;
}

/**
 * One `search` result row — {@link ActivityHit} plus what made it match
 * (F6 T5).
 *
 * `search.ts`'s rollup pins two independent properties, and both ride on this
 * one row per matched entity:
 *
 * - `idMatch` is an **any-row property**: true the moment *any* branch of the
 *   underlying query matched this entity by id, even when the row chosen to
 *   populate `snippet`/`score` came from a different branch entirely (a task
 *   matching both by id fragment and by text keeps `idMatch: true`, with the
 *   text branch's real snippet on display — see `search.ts`'s `readSearch`
 *   docs for the SQL shape that makes this true).
 * - `snippet`, `score` (and the tier that picked them, internal to the query)
 *   are **winning-row properties**: whichever single branch's row the rollup
 *   selected for this entity.
 *
 * `null` on both `snippet` and `score` for an id-only match (nothing to
 * excerpt or rank when the hit came from `tasks.id`, not FTS5) and for every
 * row on the filter-only path (no query text at all to score or excerpt).
 */
export interface SearchHit extends ActivityHit {
  /**
   * A marked excerpt from the winning field, or `null` for an id-only match
   * and for the filter-only path.
   *
   * Raw stored bytes, exactly as FTS5's `snippet()` returns them — sanitized
   * at render, not here (module docs, `search.ts`). `--json` carries it
   * verbatim per policy; the markers are display-best-effort and can collide
   * with identical literal characters already in the stored text, so they
   * carry no structural meaning a consumer should parse.
   *
   * The same holds for the CLI's own text-mode addition on top of this
   * field: `formatSearch` (`cli/format.ts`) prefixes a note hit's rendered
   * snippet line with a literal `note match — ` marker. Stored text — a
   * title, a description, a note body — is exactly as free to *start with*
   * that same literal as it is to contain `snippet()`'s own `[`/`]`
   * brackets, so the prefix is display-best-effort too, not a signal a
   * consumer can trust to distinguish a real note hit from a task hit whose
   * stored text happens to spoof it. `matchedIn` below is the actual,
   * structured answer to "did this come from a note or the task itself" —
   * it is derived from which branch of the query matched, never from parsing
   * rendered text, and it is what a caller should read instead.
   */
  readonly snippet: string | null;
  /**
   * The winning row's bm25 score — more negative is a better match — or
   * `null` for an id-only match and for the filter-only path.
   *
   * Comparable only against another hit in the **same tier** (`matchedIn` the
   * same value): bm25 magnitudes are not commensurable across `tasks_fts` and
   * `notes_fts`, two structurally different indexes over different content.
   */
  readonly score: number | null;
  /**
   * Where the winning row's text lived — spec req 3's provenance marker,
   * nothing more. `"task"` for a title/description hit and for an id-only
   * match; `"note"` only when the winning row came from a note body. Also
   * `"task"` on the filter-only path, where nothing actually matched by text
   * or id at all — the value has no provenance to report there, and `"task"`
   * is the same default an id-only match already uses rather than a third,
   * union-widening state.
   */
  readonly matchedIn: "task" | "note";
  /** True when this entity matched the id-fragment branch — see this interface's docs. */
  readonly idMatch: boolean;
}

/** What `search` prints. */
export interface SearchResult {
  /**
   * Echoed as given; empty when no query was supplied.
   *
   * A caller need not thread the query text through separately to know what
   * produced these hits. A whitespace-only query still routes to the
   * filter-only path (`search.ts`'s `readSearch`: `matchExpression` returns
   * `null` for it, the one input FTS5's `MATCH` throws on) but is echoed
   * verbatim here regardless — this field reports what was *asked*, not
   * which path answered it.
   */
  readonly query: string;
  readonly hits: readonly SearchHit[];
  readonly truncated: boolean;
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
