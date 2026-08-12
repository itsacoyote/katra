# F4 traceability — claims and presence

Every acceptance criterion from the F4 spec (`docs/katra-spec.md`, as amended
by [ADR-011](decisions/ADR-011-every-call-heartbeats.md) and
[ADR-012](decisions/ADR-012-claims-steer-not-move.md)), mapped to the named
test that would fail if the behaviour regressed. Same convention as
[`f3-traceability.md`](f3-traceability.md): the column on the right is the
point of the document, not the tick — a criterion whose "test" cannot fail is
not covered, and saying so is more useful than pretending otherwise.

Test names are quoted exactly as they appear in the suite, so `vitest -t`
finds them. `(core)` and `(cli)` disambiguate same-named files the way
`f3-traceability.md` already does.

| # | Criterion | Test | Falsifiable? |
|---|---|---|---|
| 1 | Claiming an unclaimed task records the claim and a `claimed` event in one transaction; re-claiming from the same worktree is a no-op success with no duplicate event | `claims.test.ts` (core) — "claims an unclaimed task and appends claimed in one transaction", "re-claims from the same worktree as a no-op with no second event"; `claim.test.ts` (cli) — "claims a task and echoes the claim", "re-claiming your own task succeeds quietly" | ✅ the no-op test asserts the second `ClaimResult` is byte-identical to the first (`toEqual`) and that the event list still has length one — a re-claim that touched `claimed_at` or appended a second `claimed` fails either half |
| 2 | A contended claim exits 3, names the holder's actor and last-seen age, and leaves the claim and the event stream unchanged | `claims.test.ts` (core) — "refuses a claim held elsewhere with the holder and last-seen age"; `claim.test.ts` (cli) — "exits 3 naming the holder when the task is already claimed", "names release --force as the unblock in the refusal hint"; `f4-feature.test.ts` — "claims, refuses a contended claim, and releases across two real worktrees" | ✅ the feature test is the one place the "unchanged" half is proven through the CLI, across a genuinely different worktree: it reads `log --json` after the refusal and pins `["claimed", "created"]` — a refusal that leaked a second `claimed` event, or silently released the first, fails it |
| 3 | Two real processes in two linked worktrees of one repository, sharing one store, race to claim one task: exactly one wins, the loser reports the winner | `claims.test.ts` (core) — "lets exactly one of two worktrees win the claim"; `f4-feature.test.ts` — "lets exactly one of two real CLI processes across two worktrees win a contested claim" | ✅ two independent spawns of real OS processes: the core test races `claims/repo.ts`'s `claimTask` directly, the feature test races `run()` — the same function `src/cli.ts` hands `process.argv` to — so the second also covers command dispatch and exit-code mapping under contention, which the first cannot. Both assert exactly one winner, exactly one `conflict`, and exactly one row in `claims` |
| 4 | `release` by the holder appends `released`; by a non-holder exits 3 naming the holder; `--force` succeeds and its event carries the prior holder; releasing an unclaimed task exits 1 | `claims.test.ts` (core) — "releases a held claim and appends released", "refuses a non-holder release without force, naming the holder", "force-releases and records the prior holder on the event", "refuses releasing an unclaimed task"; `release.test.ts` (cli) — "releases an owned claim", "refuses another worktree's claim without --force, exit 3", "force-releases another worktree's claim", "exits 1 releasing an unclaimed task", "exits 1 releasing an unclaimed task even with --force"; `f4-feature.test.ts` — "force-release displaces a live holder, and the takeover is visible in the log" | ✅ the feature test is the only one that reads the takeover back out of `katra log` rather than out of the event's own fields, across two real worktrees — proving the column the CLI actually renders, not just what `settleClaim` wrote |
| 5 | `close`/`cancel` on a claimed task release it in the same transaction — the events land together or not at all | `lifecycle.test.ts` (core) — "releases a claim and logs released when a claimed task closes", "releases a claim and logs released when a claimed task is cancelled", "records the displaced holder when a non-holder closes a claimed task", "appends no released event when the task was never claimed", "lands the lifecycle and released events atomically or not at all"; `f4-feature.test.ts` — "closing a claimed task releases it in the same transaction" | ✅ "lands the lifecycle and released events atomically or not at all" fails the write after `settleClaim`'s own insert/delete have already run and asserts nothing committed — the claim is still held, the lane never moved, neither event exists. The feature test additionally proves it through `close`'s real CLI path and confirms the release is genuine (`show --json`'s `claim` field, not just the event stream) |
| 6 | Claiming an epic or a Done/Cancelled task exits 1 with a reason | `claims.test.ts` (core) — "refuses claiming an epic and a Done task with a reason" (asserts all three: epic, Done, **and** Cancelled, despite the name); `claim.test.ts` (cli) — "refuses claiming an epic, exit 1" | ✅ the core test's reason strings are asserted per lane (`"is an epic"`, `"is already Done"`, `"is already Cancelled"`), so a shared refusal message that stopped naming the specific lane would still fail it |
| 7 | Every command touches presence for its worktree: writing when the row is absent or stale (30s), skipping within the window without resolving the branch; the row exists after any command; `readBoard`/`briefEntity` stay heartbeat-free with read-purity tests pinning "no event and no presence row" | `presence.test.ts` — "bumps last_seen when the row is absent or stale", "picks up a branch change on the next write after the window", "skips the write and the branch spawn when the row is fresh", "opens the store even when the bump cannot write", "does not serialize six concurrent readers behind the heartbeat", "keeps a read command's wall time bounded with the heartbeat on"; `board.test.ts` (core) — "leaves the event count unchanged and opens no write transaction"; `brief.test.ts` (core) — "writes no event and opens no transaction"; `f3-feature.test.ts` — "runs brief and board without writing an event" | ✅ "picks up a branch change on the next write after the window" pins ADR-011's branch-lag consequence directly: it seeds a stale row under one branch, reopens the store under a different one — the same `openStore` door every real command uses, not `bumpPresence` called a second time by hand — and asserts the row now carries the new branch. Dropping `branch` from the UPSERT's `DO UPDATE SET` clause fails it. Paired with "skips the write and the branch spawn when the row is fresh" (proves the skip half), the two together pin the full contract |
| 8 | `next` skips a task claimed by another worktree and offers the caller's own claimed task, both proven with two linked worktrees sharing one store; an all-claimed-elsewhere backlog reports `claimedElsewhere` distinct from empty | `next.test.ts` (core) — "skips a task claimed by another worktree", "ranks the caller's own claim above a higher-priority unclaimed task", "does not resurrect an own claim that already left Planned", "reports claimed-elsewhere separately from an empty backlog", "keeps another worktree's blocked task in the blocked list", "keeps list --ready claim-neutral where next is not"; `next.test.ts` (cli) — "names the claimed count instead of claiming the lane is empty", "prints both the blocked list and the claimed count when both apply", "drops the empty-lane claim when untriaged work coexists with a claim", "surfaces claimedElsewhere on the none arm's --json payload"; `f4-feature.test.ts` — "next and board steer around another worktree's claim in both directions" | ✅ the core and cli suites use a same-process identity swap (a real second `Identity`/seeded holder, not a real second worktree) — sufficient for the query logic, but not what AC8 literally asks for. `f4-feature.test.ts` calls `next` from two genuinely different, linked worktrees and gets opposite answers from each — the "both proven" half of the criterion. The resume-own half of that test (`nextOther.task.id` equalling `unclaimed`) is not on its own falsifiable — priority alone produces the same answer if the exclusion is deleted, since `unclaimed` outranks `own` regardless — so the same test goes on to claim the remaining task too and assert worktreeB's `next` returns the **none** arm with `claimedElsewhere: 2`: with nothing left unclaimed, only the exclusion itself can produce that answer. Deleting `AND NOT CLAIMED_ELSEWHERE` from `nextTask`'s candidate query (neutralised as `AND (CLAIMED_ELSEWHERE OR 1=1)` to keep the bound-parameter count valid, rather than a bare deletion that throws on a parameter-count mismatch before reaching either assertion) fails exactly this line, with the test's earlier assertions still green — confirmed by hand and reverted |
| 9 | When the caller holds no Planned claim of its own, the board's first unclaimed ready row equals `next`'s answer; an own Planned claim is the pinned, deliberate divergence | `board.test.ts` (core) — "leads ready with the task next returns", "leads ready with next's answer past a higher-ranked claimed task", "resumes an own claim next offers but the board does not lead with"; `f3-feature.test.ts` — "agrees with next about the first ready task, through the CLI" | ✅ "resumes an own claim..." calls both `nextTask` and `readBoard` against one fixture and asserts they disagree on exactly the own-claim row — a single-command test could not catch the two silently drifting apart, agreeing or disagreeing, by accident |
| 10 | The five counts still sum to `open` with claimed tasks present in every section | `board.test.ts` (core) — "makes the five counts sum to open" (now seeds a claim into the in-flight, ready, blocked and untriaged row each), "keeps every count identical when claims exist" | ✅ the second test reads the counts before and after seeding three claims into three different sections and asserts byte-identical `BoardCounts` — a claim that moved a task between buckets, even without breaking the sum, still fails this one |
| 11 | `brief`, `show` and the board carry the claim in text and `--json`; the published-types check covers the new field | `brief.test.ts` (core) — "carries the claim on the task arm and declares none on the epic arm", "declares the task arm's claim null when the task is unclaimed", "fills the claim on a claimed task's view and null otherwise"; `brief.test.ts` (cli) — "renders claimed by with last seen on a claimed task", "renders a claim whose holder never heartbeat, with no crash and no null"; `add-show.test.ts` (cli) — "shows the claim where one exists", "carries the claim in the JSON document", "shows no claimed line for an unclaimed task"; `board.test.ts` (cli) — "marks a claimed row with claimed by and last seen", "renders a claim whose holder never heartbeat", "carries no marker on a row this worktree claimed itself"; `board.test.ts` (core) — "carries claim data on in-flight and blocked rows too"; `index.test.ts` — "publishes a type for every --json document, checked by the compiler" | ✅ under `pnpm typecheck` for the published-types half, same exception F3's row 10 states — vitest's esbuild pipeline does not type-check, so only `tsc --noEmit` can fail that assertion. `ClaimInfo` is listed standalone in the tuple, not only inside `TaskView`/`BriefResult`/`BoardTask`, so dropping the bare export (not just a field referencing it) is still a compile error |
| 12 | Board perf against the 10k seed with claims joined stays under the F3 budget | `board.perf.test.ts` — "answers board under 250ms on ten thousand tasks" | ✅ same test name as F3's row 6h — T7 extended `seedLargeStore()` to claim roughly one task in seven (coprime with the six-lane cycle, so every lane gets claimed rows), rather than adding a second perf test with its own budget. Measured 37ms against the 250ms budget at T7's close, comfortable margin; this pass did not re-measure |
| 13 | `docs/agents-snippet.md` gains claim-before-working and release-when-done; the snippet guard test passes only because the commands now exist | `agents-snippet.test.ts` — "names only registered commands, subcommands included" | ✅ the guard test itself is unmodified by this task (by design — see its own module docs); it fails today if `claim`/`release` are named in the snippet before being registered commands, and would fail again if either command were ever removed while the snippet still names it |

## Mutation notes

F3's table cites mutation testing inline, in the test files themselves
("verified by mutation" appears as a code comment next to the assertion it
protects). No F4 test file carries that comment — grepping
`test/core/claims.test.ts`, `presence.test.ts`, `lifecycle.test.ts`,
`next.test.ts`, `board.test.ts`, `schema.test.ts` and the `cli/` equivalents
for "mutation" returns nothing.

That does not mean no falsifiability work happened — every child task's close
reason in the tracker records a review pass: T2 ("HIGH wiring gap
mutation-verified"), T4 ("race proven falsifiable 3/3", plus a security scan
finding no critical/high issues), T3/T5/T6/T10 ("falsifiability proven both
directions"). Those passes ran senior-review and efficiency-review at every
task boundary, per the project's own workflow discipline, and for T4
specifically a dedicated security scan. But the tracker records the outcome
as a summary, not as a reproducible in-repo artifact tied to one test name —
so unlike F3's rows, nothing here can honestly cite "verified by mutation"
against a specific assertion. This pass (T11) did not independently re-run
mutation testing against F4's code; the ✅ marks above mean "the assertion, as
read, pins the described behaviour" — confirmed by inspection and by the
tests actually failing when the described protection is removed by hand
during this task's own review (see the two exceptions below), not by a
mutation-testing tool's report.

Two exceptions, checked directly during this task: reverting
`claims/repo.ts`'s `existing.holder !== worktree` guard to always throw fails
"re-claims from the same worktree as a no-op with no second event" (row 1);
deleting `describeEvent`'s `priorActor` branch in `cli/format.ts` fails
`f4-feature.test.ts`'s "force-release displaces a live holder, and the
takeover is visible in the log" (row 4) — the only mutation probes this
document can attribute to itself rather than to an earlier task's tracker
entry.

## Known limits

- **Path recycling is accepted, not solved.** A worktree deleted and later
  recreated at the same filesystem path inherits whatever claim that path
  held — `holder` is the absolute worktree path (ADR-007), and nothing in
  `claims/repo.ts` can distinguish "the same worktree, still working" from "a
  new worktree that happens to reuse an old path". No test exercises this
  because there is no correct behaviour to pin: the remedy is the same one
  every stale claim has, `release --force`, informed by the liveness every
  conflict already reports. See `claims/repo.ts`'s own module docs, and
  ADR-012's consequences.
- **The 30-second freshness window can lag a branch rename by up to its own
  width.** `bumpPresence` skips the write — and the branch re-resolution —
  while the row is fresher than `PRESENCE_FRESH_MS`, keyed on the worktree
  alone (`presence.ts`). A branch renamed inside that window shows its old
  name in every claim display until the next command that lands outside the
  window bumps it. This is accepted, not a gap: `presence.test.ts` pins both
  halves ("skips the write and the branch spawn when the row is fresh" and
  "picks up a branch change on the next write after the window", row 7
  above), so the window width is the only remaining slack, by design.
- **Sessions sharing one worktree share one identity.** A claim's holder is
  the worktree path, not a process or session id. Two agent sessions running
  in the same directory — the same physical worktree — look like one holder
  to katra: the second session's `claim` on a task the first already holds is
  the same idempotent no-op row 1 covers, not a conflict, and `release` from
  either settles it for both. Coordination inside one worktree is out of
  scope for F4 by design; only cross-worktree contention is claims' job. This
  is also why `docs/agents-snippet.md`'s claim guidance carries an explicit
  same-worktree caveat rather than promising more than the mechanism gives.
- **Presence reports worktree liveness, not activity on any one task.**
  `last_seen` is bumped by every command a worktree runs, regardless of which
  task it names or whether it names one at all — polling `board` in a loop
  keeps every claim that worktree holds looking "recently seen," including
  ones it has not touched in an hour. `claimLiveness`'s wording is
  deliberately "last seen," never "active on" (T4's security review; pinned
  by `board.test.ts` (cli) — "marks a claimed row with claimed by and last
  seen", which also asserts the row does **not** contain "active on"). A
  human reading a conflict message should weigh it as "this worktree is
  running commands," not "this worktree is working on this task right now."
