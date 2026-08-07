# F3 traceability — brief and board

Every acceptance criterion from the F3 spec, mapped to the named test that
would fail if the behaviour regressed. The point of writing this down is the
column on the right: a criterion whose "test" cannot fail is not covered, and
saying so is more useful than a tick.

Test names are quoted exactly as they appear in the suite, so `vitest -t` finds
them.

| # | Criterion | Test | Falsifiable? |
|---|---|---|---|
| 1 | `brief <task>` prints the latest handoff in full, in one invocation | `brief.test.ts` (core) — "returns the latest handoff body in full"; `brief.test.ts` (cli) — "prints the handoff body in one invocation" | ✅ |
| 2 | An over-cap handoff truncates, says so, and names the command showing the rest | `brief.test.ts` (core) — "truncates a handoff longer than the cap and reports it"; `brief.test.ts` (cli) — "names note list with the resolved id when it truncates a handoff" | ✅ asserts the resolved id, so a message naming a literal `<id>` fails |
| 3 | `brief --full` prints a body the default run truncated | `brief.test.ts` (core) — "does not truncate under --full, however long the body is"; `brief.test.ts` (cli) — "prints the whole body under --full" | ✅ the core test uses a body **50×** the default cap, so it can tell a *lifted* bound from one that merely moved. An earlier version multiplied the cap by twenty and used `cap + 100`, which passed for any multiplier ≥ 2 |
| 4 | `brief <epic>` groups children by lane and includes a **child's event** | `brief.test.ts` (core) — "groups an epic's children by lane, in lane order", "includes a child's event in the epic's activity"; `brief.test.ts` (cli) — "groups an epic's children under their lanes" | ✅ the CLI test slices the output above the `activity` heading. Asserting on the whole output passed with `childrenByLane` returning nothing, because `created` and `status-changed` rows name the child and its lanes too |
| 4a | `brief <epic>` surfaces a handoff written on a **child** | `brief.test.ts` (core) — "surfaces a handoff written on a child, not only on the epic" | ✅ **and this is the point of splitting it from 4** — dropping `OR t.parent_id = ?` from the note scope fails this test alone, while 4's child-*event* assertion stays green. Verified by mutation |
| 4b | An over-cap children list truncates, and every occupied lane still appears | `brief.test.ts` (core) — "truncates an over-cap children list and reports it", "shows every occupied lane when children are lopsided across lanes" | ✅ replacing the per-lane cap with a global one fails the lopsided test — verified by mutation |
| 5 | A task with no notes and no activity prints no empty section | `brief.test.ts` (core) — "says nothing rather than inventing sections on a bare task"; `brief.test.ts` (cli) — "omits the note sections when a task has none" | ⚠️ the CLI half cannot assert an empty *activity* section: `add` writes a `created` event, so a task made through the CLI always has one. The core test covers the genuinely-empty case |
| 6 | `board` places an In Progress task under in flight and a blocked task under blocked, naming the blocker | `board.test.ts` (core) — "puts an In Progress task under in flight and a blocked task under blocked"; `board.test.ts` (cli) — "names the blocker in the blocked section" | ✅ |
| 6a | The board's first ready row is the id `next` returns, asserted against `next` | `board.test.ts` (core) — "leads ready with the task next returns"; `f3-feature.test.ts` — "agrees with next about the first ready task, through the CLI" | ✅ builds the expectation by calling `nextTask`, so a hard-coded id cannot mask a drift |
| 6b | A `Planned` epic at P0 beside a `Planned` task at P1: `next` returns the **task** | `next.test.ts` — "returns the planned task, not a higher-priority planned epic", "omits a blocked planned epic from the blocked list" | ✅ deleting the `t.level = 'task'` guard fails exactly two tests, one per branch — verified by mutation |
| 6c | A task both `In Progress` and blocked appears once, and is counted once | `board.test.ts` (core) — "shows a blocked in-flight task once, under in flight, marked blocked" | ✅ |
| 6d | Capping a handoff containing a non-BMP character emits no lone surrogate | `text.test.ts` — "caps on a code-point boundary rather than mid-surrogate", "round-trips a capped body through JSON and back"; `brief.test.ts` (core) — "caps a handoff on a code-point boundary" | ✅ reverting `capText` to `.slice()` fails all three |
| 6e | Epics appear in no board section and in no count | `board.test.ts` (core) — "omits an In Progress epic and a blocked epic from every section", "counts open as non-terminal tasks, excluding Done, Cancelled and epics" | ✅ neutering `TASKS_ONLY` fails both — verified by mutation |
| 6f | With `--limit` below the ready count, the header reports the true total | `board.test.ts` (core) — "reports the true ready total when the section is capped"; `board.test.ts` (cli) — "reports the true total when a section is capped" | ✅ |
| 6g | `board` and `--digest` label attribution as **last touch** | `board.test.ts` (cli) — "labels attribution as last touch, not as an owner"; `brief.test.ts` (cli) — same name | ✅ asserts the absence of "owner" and "assignee" too, so renaming the label is not enough to pass |
| 6h | `board` and `board --digest` stay under 250 ms on 10,000 tasks / 5,000 notes | `board.perf.test.ts` — "answers board under 250ms on ten thousand tasks", "answers the digest read under 250ms on five thousand notes" | ✅ asserted, not logged. Measured **40.9 ms** and **1.0 ms**; migration `0003` declined on that basis |
| 6i | A store whose work is all in `Defined` prints the pointer, not four empty sections | `board.test.ts` (core) — "carries the pointer when everything sits in Defined"; `board.test.ts` (cli) — "names where the work is when everything sits in Defined" | ✅ |
| 6j | The five counts sum: `open = inFlight + ready + blocked + untriaged` | `board.test.ts` (core) — "makes the five counts sum to open" | ✅ seeds a task in every non-terminal lane, startable and blocked, so a missing category breaks the equality |
| 6k | `board --json` and `next --json` report different `untriaged` numbers | `board.test.ts` (core) — "reports a different untriaged count than next for the same store" | ✅ pins the divergence deliberately, so someone "fixing" the inconsistency has to read why |
| 6l | With more blocked in-flight tasks than the cap, none leaks into `blocked` | `board.test.ts` (core) — "keeps blocked in-flight tasks out of blocked even past the in-flight cap" | ✅ replacing the SQL exclusion with a post-filter over rendered rows fails it — verified by mutation |
| 6m | A write inside `readTx` throws rather than passing `appendEvent`'s guard | `transactions.test.ts` — "refuses appendEvent inside a read transaction", "refuses writeTx nested inside a read transaction" | ✅ removing `assertNotReadOnly` from `appendEvent` fails the first — verified by mutation |
| 9a | `--limit` bounds **every** section, `recent` included, and each reports its own truncation | `board.test.ts` (core) — "bounds recent with the same limit as the task sections", "returns no activity at all under --limit 0" | ✅ `recent` was hard-wired to its own constant, so `--limit 0` emptied the task sections and still printed eight activity rows, and `recentTruncated` was computed, published and never rendered |
| 7 | `board --digest` leads with the newest handoff across all tasks | `board.test.ts` (cli) — "leads with the newest handoff, labelled with its lane", "shows a digest handoff from a Done task without implying it is live"; `notes.test.ts` — "returns the newest handoff across every task" | ✅ ordering asserted against the counts header, and the **lane** asserted against the digest line specifically. Both lane assertions previously matched the whole output, where a `Defined -> In Review` activity row satisfied them with the lane deleted from the heading entirely |
| 8 | `board` on an empty store exits 0 with one line | `board.test.ts` (cli) — "exits 0 with one line on an empty store" | ✅ asserts the line count, not just the exit code |
| 9 | ESC and bidi injected into title, description and body produce none in either command's output | `brief.test.ts` (cli) — "strips ESC and bidi control characters from every rendered field"; `board.test.ts` (cli) — same name | ✅ swapping `sanitizeBody` for a passthrough fails the brief case — verified by mutation |
| 10 | Both `--json` documents are exported and covered by the published-types check | `index.test.ts` — "publishes a type for every --json document, checked by the compiler" | ✅ removing `BoardResult` from the barrel fails `tsc --noEmit`, not the test run — verified by mutation |
| 11 | `brief` includes a note body; `show` includes none | `brief.test.ts` (cli) — "includes a note body where show includes none" | ✅ uses a body longer than `show`'s 56-character preview *and* spanning two lines. An earlier draft used a short body and passed for the wrong reason — `show`'s preview contained it whole |
| 12 | Neither command writes a row | `brief.test.ts` (core) — "writes no event and opens no transaction"; `board.test.ts` (core) — "leaves the event count unchanged and opens no write transaction"; `f3-feature.test.ts` — "runs brief and board without writing an event" | ✅ the feature test covers **both** commands in one run, which is what the criterion says |

## Beyond the criteria

Findings that produced tests of their own, none of which any criterion asked
for.

| What | Test | Why it exists |
|---|---|---|
| Columns measured in characters, not code units | `log.test.ts` — "aligns log columns when a title contains non-BMP characters" | Three sites measured in UTF-16 code units and only work as a set: `clamp` could split a surrogate pair, `columnWidth` sized emoji at 2× their visible width, and `padEnd` then decided the column was already wide enough and added nothing. Fixing any one alone leaves the table misaligned with the suite green |
| `readTx` does not block a writer | `transactions.test.ts` — "does not block a concurrent writer" | The property `.immediate()` would destroy. Mutating to immediate makes it fail after 7.6 s — the `busy_timeout` exhausting, which is the stall the design exists to prevent |
| A read snapshot is released when the callback throws | `transactions.test.ts` — "releases the snapshot when the callback throws" | A transaction left open holds a read snapshot forever, which stops WAL checkpointing for the whole store, not just that handle |
| Nested read transactions keep the guard accurate | `transactions.test.ts` — "keeps the guard accurate through nested read transactions" | A flag would be cleared by the inner one on its way out, re-permitting writes for the rest of the outer transaction |
| `brief` refuses a deleted task's id | `brief.test.ts` (core) — "refuses an id that no live task matches" | `requireEntityId` resolves historical ids so `log <deletedId>` works; reaching for it here for consistency would resolve successfully and then read back `undefined` |
| The digest survives a finished task | `notes.test.ts` — "returns a handoff on a Done task rather than skipping it" | "I finished X, next is Y" is the commonest real handoff and lives on `Done` work. Filtering would hide the best ones, so the lane disambiguates instead |
| The digest reads inside the board's snapshot | `board.test.ts` (core) — "carries the handoff and its task's lane when asked" | The digest was assembled in the command layer *after* `readTx` committed, so `taskLane` — the field whose whole job is stopping a finished handoff reading as live work — came from a different snapshot than the sections above it |
| `clamp` keeps a boundary-length title whole | `text.test.ts` — "keeps a title of exactly the column width whole" | Capping at `width - 1` and asking *that* whether it truncated ellipsizes a title that fitted exactly, silently dropping its last character in `log` and `list` |
| A read transaction cannot nest inside a write | `transactions.test.ts` — "refuses a read transaction opened inside a write transaction" | The depth counter would forbid writes inside a SAVEPOINT where they are perfectly safe, surfacing a legal write as exit 4 |
| `--limit 0` does not fire the pointer | `board.test.ts` (cli) — "treats --limit 0 as truthfully empty sections, not unbounded" | The pointer keys off the counts, never the rendered rows — a cap that emptied the sections would otherwise trigger it on a healthy backlog |
| Board and `next` agree about an epic | `f3-feature.test.ts` — "agrees when the only planned work is an epic — neither offers it" | The behaviour change F3 makes to `next`, checked from both sides at once |

## Known limits

- **Epic-scoped notes and events disagree after a reparent.** `listEvents`
  scopes by the `epic_id` stamped on each event at write time; the note scope
  joins the live `parent_id`, because `notes` has no such column. Move a task
  from epic A to epic B and `brief B` shows its old notes while `brief A` keeps
  its old events. Neither answer is wrong — they answer different questions —
  and nothing can reconcile them without adding a stamped column to `notes`,
  which would then be wrong in the other direction.
- **`brief <epic>` is bounded in output but not in cost.** `listTasks({epic})`
  returns every child and `rowToTask` runs a per-row tag query, so a 500-child
  epic costs 501 queries even though the per-lane cap keeps the rendering
  short. Left unoptimised deliberately: epics with hundreds of children are not
  the shape katra is built for, and criterion 6h profiles `board`, not this.
- **Board's read snapshot is consistent, not current.** The deferred
  transaction guarantees the five sections agree with each other, not that they
  reflect a commit that landed a millisecond ago.
- **`tasks` rowids are reused.** No `AUTOINCREMENT` (`0001-init.ts:74`), so a
  deleted task's rowid can go to a new one. The shared
  `priority, created_at, rowid` ranking is still **total** — two runs against an
  unchanged store cannot disagree — but "insertion order" is not reliable across
  a delete-then-create sequence.
- **The 250 ms budget is a wall-clock assertion.** It passed with a 6× margin on
  a developer machine; a heavily loaded CI runner could still make it flaky. If
  it does, raise the budget deliberately and say so here rather than deleting
  the assertion — a benchmark that cannot fail is a comment.
