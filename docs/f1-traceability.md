# F1 traceability

Acceptance criterion 30 requires that every criterion maps to at least one named test that could fail. This is that audit.

It is a real check, not a formality: the plan review found four criteria whose tests could never fail — one compared a value to itself, one asserted something vacuously true, one was scoped to a single field where four were required, and one had no owner at all. Each is now marked ✅ below because a test was written or rewritten, not because the criterion looked satisfied.

**Result: 46 of 46 covered.** `pnpm check` passes with 367 tests.

## Store and location

| # | Criterion | Named test | File |
| --- | --- | --- | --- |
| 1 | `init` creates the store; a second run reports it | "creates the store and reports it as newly created" · "reports the existing store and exits zero when run a second time" | `test/cli/init.test.ts` |
| 2 | Outside a repo exits non-zero; missing git and a broken worktree are distinct | "exits non-zero with a not-a-repository message outside a git repo" · "throws a distinct error when the git binary is absent from PATH" · "surfaces git's own stderr when a worktree's main repository has moved" | `test/cli/init.test.ts`, `test/core/locate.test.ts` |
| 3 | Identical from root, subdirectory and worktree | "resolves the same absolute store path from the repo root, a subdirectory, and a linked worktree" | `test/core/locate.test.ts` |
| 4 | `git status` byte-identical across a lifecycle | "stays byte-identical across a representative lifecycle" | `test/cli/feature.test.ts` |
| 5 | Foreign keys on, non-zero busy timeout, every connection | "reports foreign_keys enabled on every new connection" · "sets a non-zero busy_timeout on every new connection" · "actually enforces foreign keys rather than merely reporting them on" | `test/core/connection.test.ts` |

> AC4 previously asserted the database was invisible to `git status` — vacuously true for anything inside `.git/`, so no implementation could fail it. See ADR-004.

## Concurrency

| # | Criterion | Named test | File |
| --- | --- | --- | --- |
| 6 | Six concurrent processes, zero `SQLITE_BUSY` | "completes all writes from six concurrent processes with no SQLITE_BUSY" | `test/core/connection.test.ts` |
| 7 | Two processes adding opposite edges — one succeeds | "allows only one of two processes adding opposite edges" | `test/core/deps.test.ts` |
| 8 | Two processes racing `init` — migration applied once | "survives several processes racing to create the same store" · "applies the migration exactly once when several processes race a new store" | `test/core/store.test.ts`, `test/core/migrate.test.ts` |

> Both 6 and 7 are mutation-verified: removing `.immediate()` fails 4/4 runs, and moving the cycle check outside the transaction fails 4/4. The WAL-retry test at criterion 8 is probabilistic — 3 rounds catch a missing retry roughly 2 times in 3, and the retry logic itself is pinned deterministically in `test/core/retry.test.ts`.

## Identity

| # | Criterion | Named test | File |
| --- | --- | --- | --- |
| 9 | `kt-` ids, 2,000 distinct, retry path exercised | "generates an id matching kt- followed by six base36 characters" · "produces two thousand distinct ids" · "retries and succeeds when the first generated id already exists" | `test/core/ids.test.ts` |
| 10 | Unique prefix resolves; ambiguous lists candidates; no match is distinct | "resolves a unique prefix to exactly one task" · "returns every candidate when a prefix matches more than one task" · "reports no match distinctly from an ambiguous match" | `test/core/ids.test.ts` |
| 11 | A prefix below the minimum is rejected | "rejects a prefix shorter than the minimum length" | `test/core/ids.test.ts` |

## Model integrity

| # | Criterion | Named test | File |
| --- | --- | --- | --- |
| 12 | Invalid level/kind/lane/priority rejected by the database | four tests, one per field, under "database-level rejection of every constrained field" | `test/core/schema.test.ts` |
| 13 | `parent_id` pointing at a task is rejected, on insert and on update | "rejects a task whose parent_id references a task rather than an epic" · "rejects reparenting an existing task onto a non-epic" | `test/core/schema.test.ts` |
| 14 | An epic cannot be given a parent | "rejects an epic that is given a parent" · "rejects promoting a parented task to an epic" | `test/core/schema.test.ts` |
| 15 | An enum change alters the generated `CHECK` in the same build | "matches the committed schema byte for byte" (golden file) | `test/core/schema.test.ts` |
| 33 | All four constrained fields rejected against raw SQL that bypasses validation | as criterion 12 — each writes raw SQL directly | `test/core/schema.test.ts` |
| 34 | The DDL is built, not copied — proven by an injected value | "builds a constraint containing a value injected at build time" | `test/core/schema.test.ts` |
| 41 | A terminal lane can never carry a NULL `closed_at`, even by raw SQL | "rejects Done without closed_at even via raw SQL" · "rejects an UPDATE that moves a task to Done without closed_at" · "rejects clearing closed_at while the lane is still terminal" | `test/core/schema.test.ts` |

> Criterion 15 previously read `expect(MIGRATIONS[0].sql).toBe(buildInitDdl())` — a value compared to itself. Criterion 12 previously tested one field of four.

## Lifecycle

| # | Criterion | Named test | File |
| --- | --- | --- | --- |
| 16 | `close` sets Done and `closed_at`; `reopen` clears them | "sets the lane to Done and records closed_at" · "clears closed_at and close_reason" | `test/core/lifecycle.test.ts` |
| 17 | `cancel` records the reason and reports what it released | "lists the tasks that became ready as a result" · "reports every task the cancellation released" | `test/core/lifecycle.test.ts`, `test/cli/lifecycle.test.ts` |
| 18 | A task blocked only by a cancelled task is ready | "reports the same task as ready once its dependency is Cancelled" | `test/core/deps.test.ts` |
| 19 | `delete` removes dependency and link rows | "removes its dependency, link and tag rows" | `test/core/delete.test.ts` |
| 20 | Deleting an epic with children is refused, names the count, leaves children intact | "refuses to delete an epic that still has children" · "leaves every child's parent_id intact after a refused deletion" | `test/core/delete.test.ts` |
| 31 | `update` refuses a terminal lane | "refuses to set a terminal lane and names close or cancel" | `test/core/update.test.ts` |
| 40 | `reopen` refuses `Done` and `Cancelled` | "refuses a terminal lane on reopen" · "refuses --lane Done and --lane Cancelled on reopen" | `test/core/lifecycle.test.ts`, `test/cli/lifecycle.test.ts` |
| 42 | `cancel` on Done and `close` on Cancelled are refused with exit 3 | "refuses to cancel an already-terminal task" · "refuses to close a cancelled task" · "refuses to close an already-closed task with the conflict code" | `test/core/lifecycle.test.ts`, `test/cli/lifecycle.test.ts` |
| 43 | `delete` reports what its removal unblocked | "reports the tasks its removal unblocked" | `test/core/delete.test.ts` |

## Dependencies and links

| # | Criterion | Named test | File |
| --- | --- | --- | --- |
| 21 | Blocked while a dependency is non-terminal; ready once terminal | "reports a task as blocked while its dependency is in a non-terminal lane" · "reports the same task as ready once its dependency reaches Done" | `test/core/deps.test.ts` |
| 22 | A cycle is rejected and the path named | "names the full cycle path when rejecting" | `test/core/deps.test.ts` |
| 23 | Self-dependency rejected | "rejects a self-dependency" | `test/core/deps.test.ts` |
| 24 | Linking both directions yields one row, is not an error, shows from both ends | "stores a single row regardless of the order the two ids are given" · "treats re-linking in the reverse direction as a no-op" · "displays the link from both sides" | `test/core/links.test.ts` |
| 32 | A dependency and a link can each be removed, links from either direction | "removes the edge and releases the dependent" · "removes a link given from either direction" | `test/core/deps.test.ts`, `test/core/links.test.ts` |
| 46 | `isReady` agrees with the set query across all seven lanes | "agrees with the set-based query for every task across all seven lanes" | `test/core/deps.test.ts` |

## Reads and contract

| # | Criterion | Named test | File |
| --- | --- | --- | --- |
| 25 | `next` returns one Planned, ready, lowest-priority task; ties by oldest | "returns the lowest-priority-number ready task in the Planned lane" · "breaks a priority tie by choosing the oldest task" | `test/core/next.test.ts` |
| 26 | `next` exits non-zero naming the blockers when nothing is ready | "exits non-zero and names the blockers when everything planned is stuck" | `test/cli/feature.test.ts` |
| 27 | `next --kind` never returns another kind | "returns only tasks of the requested kind" · "narrows by kind without returning more than one item" | `test/core/next.test.ts`, `test/cli/feature.test.ts` |
| 28 | Every read accepts `--json`, valid, no human text | as criterion 35 | `test/cli/feature.test.ts` |
| 29 | Each of the four exit codes produced on a real path | "produces each of the four exit codes on a real path" · "reaches the conflict code by all three routes the spec names" | `test/cli/feature.test.ts` |
| 35 | Every data-returning command emits valid JSON, verified across the whole set | "emits parseable JSON with no prose from every command that returns data" | `test/cli/feature.test.ts` |
| 36 | Identical results from root, subdirectory and worktree, through the CLI | "produces identical results from the root, a subdirectory and a linked worktree" | `test/cli/feature.test.ts` |
| 37 | ISO-8601 `Z` timestamps; deterministic ordering on a tie | "produces a fixed-width ISO-8601 timestamp ending in Z" · "breaks a created_at tie by rowid" | `test/core/clock.test.ts`, `test/core/list.test.ts`, `test/core/next.test.ts` |
| 38 | All twelve commands registered and reachable | "registers all twelve commands on the program" | `test/cli/feature.test.ts` |
| 39 | A `GIT_COMMON_DIR` warning reaches the user from a non-`init` command | "surfaces the GIT_COMMON_DIR warning from show, not only from init" | `test/cli/add-show.test.ts` |
| 44 | `--body-file` resolves relative to the invoking directory | "reads --body-file relative to the invoking directory, not the repo root" | `test/cli/add-show.test.ts` |
| 45 | Rows sharing a `created_at` are ordered by `rowid` in `list` and `next` | "breaks a created_at tie by rowid" · "breaks a created_at tie by rowid, deterministically" | `test/core/list.test.ts`, `test/core/next.test.ts` |
| 30 | `pnpm check` passes and every criterion maps to a named test | this document, plus the suite | — |

> Criteria 35 and 38 previously had no owner: every task added a *per-command* test, and nobody was assigned the aggregate. Both now iterate the program's own command list rather than a hand-written one, so a command added later and left unwired fails the suite.

## What is deliberately not covered

- **Windows and macOS behaviour is asserted but not measured here.** CI runs the suite on all three platforms; the path-normalisation and handle-release code exists because those platforms differ, and the CI matrix is what proves it.
- **The six-process tests are probabilistic where the contention window is narrow.** Noted per criterion above, with the deterministic unit test that backs each one.
