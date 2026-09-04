# @itsacoyote/katra

## 0.6.0

### Minor Changes

- [#28](https://github.com/itsacoyote/katra/pull/28) [`2332045`](https://github.com/itsacoyote/katra/commit/23320452994e2bc809a9b475b176538db57acdb4) Thanks [@itsacoyote](https://github.com/itsacoyote)! - Add `katra install-hooks`, `katra guard`, and `katra release --mine` — Tier-1 hook adapters that make katra's coordination automatic inside Claude Code and Codex, over the same CLI. Coordination was pull-only: an agent had to remember to check the board, claim before working, and release after, all by convention. `katra install-hooks <agent>` (agent ∈ `claude`, `codex`) idempotently merges three touchpoints into the agent's own settings — session-start injects `board --digest`, before-edit runs `guard`, session-end runs `release --mine` — preserving any pre-existing hooks and unrelated settings; `--print` shows the block without writing, `--remove` strips only katra's entries, `--local` targets the un-committed settings file. `katra guard` is the enforcement: it denies an edit (exit 2, reason fed back to the agent) when the caller worktree's in-progress task has been force-taken by a _different, live_ worktree, allows otherwise, and fails open on any infrastructure error so a hook can never block every edit in a session ([ADR-019](docs/decisions/ADR-019-guard-is-task-level-takeover.md)). Enforcement is task-level — claims carry no file scope, so guard catches the takeover, not the file. `katra release --mine` releases every claim the current worktree holds, one release event each, a clean no-op at zero; the session-end hook fires only on a real exit, so a `/clear` or resume keeps your claims. The adapter layer is one thin per-agent mapping over shared touchpoints — adding an agent needs no core change ([ADR-020](docs/decisions/ADR-020-tier1-adapters-over-abstract-touchpoints.md)); Claude Code is the proven path, the Codex adapter is best-effort against an evolving hooks surface. No schema change. `katra install-hooks` writes an execution-control file, so it refuses a symlinked target, preserves an existing file's permissions, and never overwrites a file it can't parse.

### Patch Changes

- [#32](https://github.com/itsacoyote/katra/pull/32) [`8e246bd`](https://github.com/itsacoyote/katra/commit/8e246bdf935196819de1734800cc241ae178259c) Thanks [@itsacoyote](https://github.com/itsacoyote)! - Fix `install-hooks` reporting "shared with your team" for a target that git ignores, and document guard's tool-scope limit. In a repo whose `.gitignore` excludes `.claude/` (or `.codex/`), `install-hooks` wrote the settings file successfully but claimed it was committed and team-shared — the hooks fire locally, but nothing is committable. The install report now detects a gitignored target (best-effort `git check-ignore`) and says so instead, and `--json` carries an `ignored` field with the real visibility. Separately, `AGENTS.md` and the F11 traceability now record a known limit surfaced by live use: guard's `PreToolUse` matcher covers the file-editing tools (`Edit`/`Write`/`NotebookEdit`; `apply_patch` on Codex), so a file change routed through the Bash tool (`echo >`, `sed -i`, `tee`) is not guarded — inherent to tool-matched enforcement, with the practical guidance being to edit through the Write/Edit tools in a guarded repo.

## 0.5.0

### Minor Changes

- [#25](https://github.com/itsacoyote/katra/pull/25) [`d5a0630`](https://github.com/itsacoyote/katra/commit/d5a063069b6ddc8d6582f91620a5f458d1ca7247) Thanks [@itsacoyote](https://github.com/itsacoyote)! - Add `katra snapshot` and `katra restore` — the store now outlives the machine. `snapshot` writes the whole store to one deterministic, git-diffable JSONL file (`.katra/snapshot.jsonl` by default) you commit; an unchanged store produces a byte-identical file, so a no-op session commits a clean diff. `restore` rebuilds a store from one — preview by default, `--apply` to execute, `--force` additionally required over a non-empty store, since restore replaces everything. It builds a fresh database at the snapshot's own recorded schema version and migrates it forward through the existing chain, so snapshots dug out of git history stay restorable after upgrades; the previous store is kept alongside as `katra.db.bak`. Snapshots carry every source-of-truth table (presence excluded as machine-local telemetry — ADR-017), round-trip stored bytes exactly (a backup never sanitizes), and are the answer to sharing a backlog, surviving a fresh clone, or undoing a bad write. Restore loads rows through raw, id-preserving inserts rather than the domain write seams (ADR-018), so a restored store reproduces the original exactly, event ids and all. No schema change.

## 0.4.0

### Minor Changes

- [#23](https://github.com/itsacoyote/katra/pull/23) [`faead9a`](https://github.com/itsacoyote/katra/commit/faead9a4412eda1543cd63e4c52a8ca3d3fe16d7) Thanks [@itsacoyote](https://github.com/itsacoyote)! - Add `katra reconcile` — the policy-driven bridge from cached external ref status to task state. Previews by default; `--apply` commits. Reads only what `refresh` already cached (no network, no implicit runs): GitHub `merged` and Linear `completed` map to Done, Linear `canceled` maps to Cancelled, and a task with more than one linked ref advances only when every ref agrees — a partial merge is reported blocked, refs mapping to different targets are reported as a conflict, and neither is ever auto-applied. A task claimed by another worktree is skipped and reported, even under `--apply`; applying goes through the same `closeTask`/`cancelTask` machinery a manual close/cancel uses, stamped `actor: "reconcile"` with a reason naming the triggering ref(s), so reconcile can never produce a state a manual command could not. Re-running `--apply` on an already-advanced task is a quiet no-op. Every rendered ref field is sanitized at the render site, including against prototype-chain collisions in the policy lookup itself (an attacker-influenced provider/status pair can no longer resolve to an `Object.prototype` member).

## 0.3.0

### Minor Changes

- [#20](https://github.com/itsacoyote/katra/pull/20) [`4475f26`](https://github.com/itsacoyote/katra/commit/4475f26c024c379cbcfe00e70c6ea97620eccf17) Thanks [@itsacoyote](https://github.com/itsacoyote)! - Add `katra refresh` and built-in GitHub/Linear providers — external refs get live status. `refresh` resolves every ref linked to open work (or just the tasks you name) through the spec's provider seam: GitHub via your already-authenticated `gh`, Linear via its API with `LINEAR_API_KEY` in the environment. Real changes fill the cached status/title `show` and `brief` now render and land in task history as `ref-status-changed` events; unchanged refs just bump their sync time; offline, unauthenticated, or unknown-provider refs degrade to a named reason and the command still exits 0 — resolution failing is a state, not an error. Nothing here ever moves a task: acting on refreshed status is reconcile's job, a later, explicit command. Providers are compiled in rather than discovered (ADR-015), the interface has no write method by construction, and migration 0006 widens the event vocabulary; existing stores upgrade in place on open.

## 0.2.0

### Minor Changes

- [#18](https://github.com/itsacoyote/katra/pull/18) [`e9c2003`](https://github.com/itsacoyote/katra/commit/e9c200376d23f03471f66d1bbb53a0a5e55db426) Thanks [@itsacoyote](https://github.com/itsacoyote)! - Add `katra ref add` and `katra ref remove` — external references linking a task to the work that tracks or ships it elsewhere. Paste a GitHub PR/issue URL or a Linear id and katra derives the provider and a canonical qualified id by pure string parsing (ADR-014 — no network, no plugins); any other tracker stores through the explicit `--provider/--id/--url` form. One shared row per unique reference: two tasks linking the same PR share it, removing it from the last holder deletes it, and a later paste that fills in a bare id's missing url is reported and evented as `url-backfilled`, never as a silent no-op. `show` and `brief` render a task's refs; `--json` publishes `Ref` and `RefResult`; `ref-linked`/`ref-unlinked` events land in the task's history inside the same transaction as the write. Migration 0005 adds the tables and widens the event-type constraint; existing stores upgrade in place on open. Cached status/title fields exist but stay empty until provider plugins land.

## 0.1.1

### Patch Changes

- [#16](https://github.com/itsacoyote/katra/pull/16) [`c1b0017`](https://github.com/itsacoyote/katra/commit/c1b00170c9e005bb539c9d257491f8d6b87a631f) Thanks [@itsacoyote](https://github.com/itsacoyote)! - `katra --version` reads its answer from package.json at load time instead of a hardcoded constant, so a release can no longer ship a CLI that reports the previous version.

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
