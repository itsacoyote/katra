# @itsacoyote/katra

## 0.1.0

### Minor Changes

- [#7](https://github.com/itsacoyote/katra/pull/7) [`a65f0c5`](https://github.com/itsacoyote/katra/commit/a65f0c596f4a41839f3d107f63a4938007a8cfbb) Thanks [@itsacoyote](https://github.com/itsacoyote)! - Add `katra brief` and `katra board` — the two reads that restore context.

  `katra brief <id>` assembles in one call what a session needs to resume one task or epic: its state, its blockers, the latest `handoff` note **in full**, counts of the notes it did not show, and recent activity. That last part is the difference from `show`, which prints note previews — a handoff is written to be read whole, and a truncated one is worse than an absent one because a reader acts on it. `--full` lifts the caps. On an epic the blockers section becomes its children grouped by lane, capped per lane so a wall of finished work cannot hide the three tasks that are left.

  `katra board` answers the other question: where does the repository stand? A counts header over four sections — in flight, ready, blocked, and what just moved. Actionable first, activity last. It takes no filters and never will; `list` and `log` are where narrow questions go. `--limit` bounds the sections and never the counts, so a capped section says `showing 2 of 14` rather than quietly understating the backlog. `--digest` puts the store's newest handoff above everything, which is what a session opening in a fresh worktree wants first.

  The counts partition `open` five ways, not four. `in flight` takes two lanes, `ready` takes startable planned work, `blocked` takes what cannot start — and startable `Defined`/`Researching` tasks fall through all three. Since `add` writes into `Defined`, that residue is the largest group on a young store, so `untriaged` is the fifth count and the board says where the work is when nothing else is moving.

  Attribution reads **last touch** throughout. katra has no concept of ownership until claims land, and a column headed `owner` would assert one that does not exist.

  Neither command writes anything, and both read inside one deferred transaction, so the counts cannot describe a different snapshot from the rows beneath them.

- [#12](https://github.com/itsacoyote/katra/pull/12) [`29676cc`](https://github.com/itsacoyote/katra/commit/29676cc943c54c06a9f8132b6afee7bf1ac2147e) Thanks [@itsacoyote](https://github.com/itsacoyote)! - Add `katra claim` and `katra release` — cross-worktree coordination.

  `katra claim <id>` records that this worktree is working a task; a second worktree attempting the same task is refused (exit 3), naming the current holder and how recently they were seen. Re-claiming from the same worktree is a quiet no-op, which is what lets a session resume its own claim after `/clear`, a crash, or a restart rather than starting over. `katra release <id>` gives a claim back; a non-holder needs `--force`, and the event records who was displaced. `close` and `cancel` release a claim automatically, in the same transaction as the lifecycle change — the events land together or not at all. Claiming an epic, or a task already `Done`/`Cancelled`, is refused with a reason.

  `next` and `board` steer around a claim without moving it between the board's five counts ([ADR-012](docs/decisions/ADR-012-claims-steer-not-move.md)): `next` never offers a task another worktree holds, and ranks the caller's own still-`Planned` claim first among candidates; the board's ready section lists other-worktree-claimed rows last, each marked with the holder and how long since they were last seen. `brief`, `show` and `board` all carry the claim in their text and `--json` output.

  Presence backs the liveness in that marker. Every command now bumps a per-worktree `last_seen` at entry — reads included ([ADR-011](docs/decisions/ADR-011-every-call-heartbeats.md)) — so a session that only reads still shows as alive. The bump writes no event, never fails the command it rides along with, and skips itself entirely while the row is still fresh (30 seconds), so the cost is one single-row write at most and usually none.

  Migration `0003` adds the `claims` and `presence` tables and extends the event-type constraint with `claimed`/`released`. An existing store upgrades in place, keeping its tasks, events and notes.

- [#6](https://github.com/itsacoyote/katra/pull/6) [`5313ec1`](https://github.com/itsacoyote/katra/commit/5313ec1098c80e81f010764ca277d82ae733712b) Thanks [@itsacoyote](https://github.com/itsacoyote)! - **Breaking:** `katra update --json` now returns `{ "tasks": [...] }` rather than a bare task detail. Read `.tasks[0]` where you read the document itself before; nothing inside the entry moved.

  `update` takes several ids now, applied in one transaction — all of them or none. The envelope keeps the document one shape whatever the count, so a script passing a variable-length list cannot get a different structure back depending on how many ids it happened to contain. Human output still adapts: one task prints in full, several print a line each.

  `show` gains `blockers` and `blocking` — unfinished dependencies and the tasks waiting on this one. Additive, and it also appears in `update`'s entries. `show` was the only view that never mentioned dependencies, so a blocked task rendered identically to a startable one in the command used to decide whether to start it. `blockers` is the same set `next` reports, so the two commands cannot disagree.

  `list` gains `--limit`, unbounded by default.

  `list --ready` and `--blocked` now mean _startable_: both exclude epics and finished work, because an epic has no dependencies of its own and neither does a `Done` task — so "what can I start?" was answered with containers and completed work. An explicit `--level` or `--lane` still asks the literal question.

  `next` gains `untriaged` on its empty result, separating the three answers that hid behind "nothing to do": everything planned is blocked, nothing has been triaged yet, or there is no work left. The message now names how much is waiting and the command that plans it.

  `katra log` reports when its bound cut the history short, rather than ending mid-story with no marker.

- [#14](https://github.com/itsacoyote/katra/pull/14) [`24d6ba5`](https://github.com/itsacoyote/katra/commit/24d6ba5a469aeecc4e4237717e41707c23f8b483) Thanks [@itsacoyote](https://github.com/itsacoyote)! - Add `search`, `recent` and `stale` — full-text search over task titles, descriptions and note bodies (SQLite's built-in FTS5, kept in sync by triggers on every write, migration 0004), plus structured filters (`--lane`/`--kind`/`--level`/`--epic`/`--tag`/`--updated-before`/`--updated-after`) usable with or without query text, and a partial-id shortcut that ranks above text matches. `recent` reads the same activity ordering back newest-first; `stale` inverts it — open items untouched since before a window, `--older-than 2w` by default. Both accept relative durations (`2w`, `3d`, `12h`, `30m`) or an absolute timestamp through a new shared time parser, also driving `--updated-before`/`--updated-after`. Existing stores get the index for free the moment they open at the new schema version — no manual step.

- [#6](https://github.com/itsacoyote/katra/pull/6) [`00e1429`](https://github.com/itsacoyote/katra/commit/00e1429627e980f960540671b35955323c6edc4b) Thanks [@itsacoyote](https://github.com/itsacoyote)! - Add the append-only event stream and typed notes.

  Every write now records what happened. `add`, `update --lane`, `close`, `cancel`, `reopen` and `delete` append an event inside the same transaction as the change itself, so history can never describe something that did not happen — and `update --title` and its siblings append nothing, because attribute churn buries the signal the stream exists to carry.

  `katra log [id]` reads it back: one entity's history, an epic's own events plus its children's, or the whole store, newest first and bounded by `--limit`. A deleted task's history survives and stays readable by id — the event stream has no foreign key to `tasks` by design (ADR-008), and `delete` appends its own last event carrying the title, since nothing else can recover it afterwards.

  `katra note add` and `katra note list` attach typed prose to a task — `general`, `handoff`, `decision` or `acceptance`. Bodies come from `--body-file` (or `-` for stdin), never an inline argument, and round-trip byte-identically including newlines, tabs and unicode. `show` now carries a task's notes and recent activity, both bounded by fixed internal caps so a summary stays a summary.

  Every event and note records who wrote it as `<branch> @ <worktree path>` (ADR-007), so two agents in two worktrees are always distinguishable in the record.

  Migration `0002` adds the `events` and `notes` tables. An existing store upgrades in place, keeping its tasks.

- [#13](https://github.com/itsacoyote/katra/pull/13) [`dcc3195`](https://github.com/itsacoyote/katra/commit/dcc3195da9bf340e6f9af0d89210ad10be2aa245) Thanks [@itsacoyote](https://github.com/itsacoyote)! - Add `katra migrate beads` — a one-shot converter from a beads (`bd export`) backlog into a katra store. Preview by default, `--apply` to write; refuses a store that already has tasks, so this is a one-shot import, not incremental sync. Every row keeps its real beads history instead of migration time: historical `created_at`/`updated_at`/`closed_at`, a `closed` event at the real close date carrying the close reason, and a `note-added` event at each note's own historical time, all inserted in true chronological order. Comments become notes carrying their original author; labels and the old beads id both arrive as tags (`beads:<id>`, queryable via `list --tag`); nothing that can't be represented is dropped without a name and a count in the report.

  Built on new core `*Within` seams (`createTaskWithin`, `createNoteWithin`, `addDependencyWithin`, `addLinkWithin`, `applyMoveWithin`) that accept a caller-supplied historical timestamp instead of always stamping "now" — `loadMigration` is the first, and by design the only, bulk writer to use them.

- [#1](https://github.com/itsacoyote/katra/pull/1) [`1e2b4c9`](https://github.com/itsacoyote/katra/commit/1e2b4c96ae4553f8dc914a839ce3002e556ce28a) Thanks [@itsacoyote](https://github.com/itsacoyote)! - Add the core tracker: a SQLite store under the repo's shared git dir, tasks and epics with dependencies, and twelve commands over them.

  Every worktree of a repo resolves to one store, so parallel sessions share a backlog. Tasks carry a hierarchy level and a Conventional-Commits kind, move through seven lanes, and depend on each other; readiness is computed from the dependency graph rather than stored.

  Commands: `init`, `add`, `show`, `list`, `update`, `close`, `cancel`, `reopen`, `delete`, `dep`, `link`, `next`. Every read accepts `--json`, and every refusal names what would unblock it.

### Patch Changes

- [#7](https://github.com/itsacoyote/katra/pull/7) [`ab2e814`](https://github.com/itsacoyote/katra/commit/ab2e8144806b43dd6f7c07243562e896eba7f1e0) Thanks [@itsacoyote](https://github.com/itsacoyote)! - `katra next` no longer offers an epic as the task to work on.

  Its candidate query had no level guard — only the untriaged count did — so a `Planned` epic at a lower priority number outranked every task behind it and `next` answered with a container nobody can pick up. The blocked branch had the same gap and listed blocked epics as work waiting to start.

  Both now exclude epics, and an explicit `--level epic` still asks the literal question.

- [#7](https://github.com/itsacoyote/katra/pull/7) [`ace1671`](https://github.com/itsacoyote/katra/commit/ace16710b6c5a5f50541a41bc5b667c123c5562e) Thanks [@itsacoyote](https://github.com/itsacoyote)! - Titles and columns are measured in characters, not UTF-16 code units.

  `list` and `log` sized their columns with `String.length` and padded with `padEnd`, both of which count a single emoji as two. A title containing non-BMP characters therefore measured twice its visible width and pushed every other row's columns out of line. Clamping a title could also cut between the halves of a surrogate pair and emit a broken character, and a title of exactly the column width lost its last character to an ellipsis it did not need.
