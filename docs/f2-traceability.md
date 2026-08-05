# F2 traceability — event stream and typed notes

Every acceptance criterion from the F2 spec, mapped to the named test that
would fail if the behaviour regressed. The point of writing this down is the
column on the right: a criterion whose "test" cannot fail is not covered, and
saying so is more useful than a tick.

Test names are quoted exactly as they appear in the suite, so `vitest -t` finds
them.

| # | Criterion | Test | Falsifiable? |
|---|---|---|---|
| 1 | A v1 store migrates to v2 without data loss; a fresh store reaches v2 directly | `schema.test.ts` — "migrates a v1 store to v2 without touching its tasks", "brings a fresh store straight to version 2" | ✅ removing migration 0002 from `MIGRATIONS` fails both |
| 2 | The golden schema matches byte for byte after regeneration | `schema.test.ts` — "matches the committed v2 schema byte for byte", "leaves migration 1's golden fixture untouched" | ✅ any enum edit reaching the DDL fails it; that is the point |
| 3 | Every one of the seven event types is emitted by a real command path | `events-emission.test.ts` — "emits all seven declared event types from a real command path"; `notes.test.ts` — "records a note-added event pointing at the note" | ✅ asserted as a set difference against `EVENT_TYPES`, so a new type with no producer fails |
| 4 | `add` inside a failing transaction leaves neither task nor event | `events-emission.test.ts` — "leaves neither task nor event when the create fails" | ✅ |
| 5 | `update --title` emits no event; `update --lane` emits exactly one carrying both lanes | `events-emission.test.ts` — "records nothing when only the title changes", "records nothing for priority, kind, assignee or tags", "records both lanes when the lane changes" | ✅ dropping the lane guard fails "records nothing when the lane is set to the one it already holds" — verified by mutation |
| 6 | Deleting a task leaves its events readable and adds a `deleted` event | `events.test.ts` — "still returns a deleted task's history"; `log.test.ts` — "still reads the history of a task that has been deleted" | ✅ rewriting the read as a join to `tasks` fails eight tests — verified by mutation |
| 7 | Deleting a task removes its notes | `notes.test.ts` — "loses a task's notes when the task is deleted, but keeps the event"; `schema.test.ts` — "removes a task's notes when the task is deleted" | ✅ |
| 8 | `katra log <epic>` returns the epic's own events **and** its children's | `events.test.ts` — "returns an epic's own events and its children's"; `log.test.ts` — "includes an epic's children in its history" | ✅ and "keeps a deleted child's history under its epic" fails against a `parent_id` join |
| 9 | An event's actor names branch and worktree; two linked worktrees are distinguishable | `actor.test.ts` — "names the branch and the worktree path", "gives two linked worktrees distinguishable actors" | ✅ reverting to `rev-parse --abbrev-ref` fails four — verified by mutation |
| 10 | A note round-trips: stdin in, byte-identical out, listed by kind, referenced by its event | `note.test.ts` — "reads a body from stdin on --body-file -", "sets the event ref to the note id", "lists a task's notes newest first, filtered by kind"; `notes.test.ts` — "round-trips a body containing newlines, tabs and unicode", "round-trips a body containing an embedded null byte" | ✅ |
| 11 | A note on a nonexistent task is `not_found`; an unknown kind names the four | `note.test.ts` — "refuses a note on a task that does not exist, naming how to create one", "refuses an unknown kind, naming all four" | ✅ |
| 12 | `log --limit` bounds the result, and ordering is total across identical timestamps | `events.test.ts` — "bounds the result with limit, keeping the newest", "orders by id so identical timestamps stay deterministic"; `log.test.ts` — "bounds the result with --limit" | ✅ the ordering test asserts one shared timestamp first, so it is testing the tie and not the clock |
| 13 | Both new commands emit valid JSON under `--json` with nothing on stderr | `log.test.ts` — "emits parseable JSON with nothing on stderr"; `note.test.ts` — "emits parseable JSON with nothing on stderr"; `feature.test.ts` — "emits parseable JSON with no prose from every command that returns data" | ✅ the feature test asserts the set of exercised commands equals the registered set, so a new command cannot be forgotten |
| 14 | `pnpm check` passes and every criterion maps to a named test that can fail | This document, plus `f2-feature.test.ts` — "records a full task lifecycle as a readable history" | — |

## Beyond the criteria

Findings that produced tests of their own, none of which any criterion asked
for:

| What | Test | Why it exists |
|---|---|---|
| Timestamps agreed with commit order | `connection.test.ts` — "orders timestamps the same way it orders commits under contention" | `nowIso()` was read before `BEGIN IMMEDIATE` took the lock, so a queued writer committed later with an earlier stamp |
| One spawn site for git | `git.test.ts` — "is the only module under src that spawns a subprocess" | A second `execFileSync("git", …)` would reopen F1's Windows PATH-shadowing finding on every event write |
| An append cannot escape its transaction | `events.test.ts` — "refuses to append outside a transaction at all" | The plan's suggested mutation proves nothing: better-sqlite3 turns a nested transaction into a savepoint, so it rolls back with the outer one and the suite stays green |
| Notes ordered by insertion, not by id | `notes.test.ts` — "orders notes written in the same millisecond by insertion, not by id" | Three separate `createNote` calls landed in one millisecond, and `nt-` ids are random |
| Subcommand flags are seen | `feature.test.ts` — "recognises a value-taking flag declared on a subcommand"; `note.test.ts` — "treats a missing --kind value as a refusal, not a JSON request" | `--kind` lives on `note add`, not on `note`; a parent-only lookup misparsed the following `--json` |
| Control characters do not reach the terminal | `add-show.test.ts` — "strips control characters from a note preview", "strips control characters from a note body in note list too", "keeps the body verbatim under --json" | Notes are where pasted content lands, and F3's `brief` will hand them to other agents |
| `show` stays a summary | `add-show.test.ts` — "caps both sections regardless of how much history exists" | A long-lived task accumulates notes without bound |
| Eight processes migrating one v1 store | `f2-feature.test.ts` — "survives eight processes migrating a v1 store at once" | Late queuers wait on `busy_timeout` with no retry around `migrate`'s transaction |

## Known limits

- **The `--json` documents are typed but not schema-validated at runtime.** A
  test asserts each parses and matches the published interface structurally;
  nothing checks a consumer's compiled types against the shipped `.d.ts`
  beyond `test/index.test.ts`'s import-graph walk.
- **The actor is not tested across two *processes* in different worktrees.**
  `actor.test.ts` resolves both in one process from different directories,
  which exercises the same code path but not two concurrent `katra`
  invocations. The concurrency harness could do it; nothing in F2 depends on
  it, so it is recorded rather than built.
- **`entityTitle` prefers the live title over the stamped one.** After a
  rename, a `created` event reads with the new name. That is the deliberate
  choice — a log's job is saying *which* task a row is about — and the stamped
  value stays on the event, but it means the human rendering is not a verbatim
  record of what was displayed at the time.
