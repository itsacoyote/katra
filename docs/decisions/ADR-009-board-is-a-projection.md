# ADR-009: The board is a fixed-shape projection, not a feed

## Status

Accepted

## Date

2026-08-05

## Supersedes

Nothing. Settles the shape of `katra board` before it is built, and draws the
line between it and `katra log`, which F2 shipped.

## Context

`docs/katra-spec.md` calls the board "recent global cross-entity activity from
the events table" (§5, §9) and asks for a session-start digest built from the
same query. Read literally, that describes a **feed**: the newest N events, newest
first, across every entity.

F2 already built that. `katra log` with no id argument is exactly the global
event stream, ordered by `events.id` descending, with `--limit` to bound it. If
`board` is also a feed, it is `log` with a different name and a slightly
different default limit — a second spelling of a read that already exists, which
is the mistake ADR-008 caught in `log --all`.

The question the board actually needs to answer is different from the one `log`
answers, and the difference is not cosmetic:

- **`log` answers "what happened".** It is chronological, unbounded in principle,
  and every row is equally weighted. To learn the repo's state from it, you read
  events and reconstruct state in your head.
- **The board answers "where do things stand".** That is a question about
  *current state* — what is in flight, what is stuck — with recent activity as
  context, not as the substance.

This matters more than it would in a human tool because of who reads it.
`AGENTS.md` will instruct every agent to run the board at session start and at
workflow checkpoints (spec §8, Tier 0). A feed forces each agent to re-derive
state from events on every read, in its own context, differently. A projection
does that derivation once, in SQL.

There is a second, slower consequence. A feed invites flags: filter by type,
filter by actor, filter by epic, page backwards. Each is individually reasonable
and together they turn the session-start read into a query language — one whose
output shape an agent can no longer predict, and whose cost grows with the
backlog. `list` and `log` already accept those narrowings and should keep them.

## Decision

**`katra board` is a fixed-shape projection of current state, and takes no
filters.** Its output is always the same five parts, in the same order:

```console
$ katra board
14 open · 2 in flight · 6 ready · 3 blocked · 3 untriaged
# The four sum to open. Counts are totals; sections below are capped.

in flight
  kt-x93  In Progress  wire up the note renderer
  kt-2ka  In Review    migration 0002

ready
  kt-4mn  P0  Planned  brief renders the handoff body
  kt-7qs  P1  Planned  board counts header

blocked
  kt-9f3  blocked by kt-x93
  ...

recent
  16:41  status-changed  kt-x93  Planned -> In Progress
  ...
```

Four rules follow, and they are the point of the ADR:

1. **Actionable first, activity last.** In flight, ready and blocked are the
   answer; `recent` is context. An agent that reads only the first two sections
   has still been oriented and knows what to pick up.

   `open` is exactly `level = 'task' AND lane NOT IN ('Done','Cancelled')`.
   Spelled out as a predicate because the first draft of this ADR showed the
   header without defining it at all, and the second defined it by pointing at
   `countUntriaged` — which also excludes `Planned` and epics, so copying that
   clause would omit every ready task.

   **There are five counts, not four, and they partition `open`.** The first
   draft had four and they did not add up — this ADR's own example showed
   `14 open · 2 · 6 · 3`. `LANES` has five non-terminal entries; `in flight`,
   `ready` and `blocked` between them leave `Defined`/`Researching` tasks that
   are startable uncovered, and `add` writes into `Defined`, so on a young store
   that residue is the largest population. `untriaged` is the fifth count,
   named after `NextResult.untriaged` and existing for the same reason: a store
   of twelve `Defined` tasks must not render as `12 open` above four empty
   sections. When it is the only non-zero section count, board prints a line
   naming where the work is and how to move it.

   **The counts are uncapped totals; the sections are capped.** `--limit 2`
   against six ready tasks prints `6 ready` and two rows. A header that shrank
   to match the cap would state a backlog size that is not true, which is the
   one thing an orientation view must never do.

   Epics appear in **no** section and in none of the counts. Rule 2 below
   excludes them from `ready`; the same exclusion applies to `in flight` and
   `blocked`, which are reachable by an epic (nothing forbids an epic in
   `In Progress`, and an epic with a dependency is unready). Excluding them from
   one section only would produce a board that refuses to offer an epic as work
   while showing it as work in progress.
2. **The board answers "what do I start" itself.** An earlier draft carried a
   `ready` *count* in the header and no `ready` section, leaving the most
   actionable question to a second command. That is precisely the failure
   `brief` exists to eliminate, and applying the rule to one command and not the
   other was an inconsistency, not a scope decision. The section shows the items.
3. **`--limit` bounds sections; it does not select them.** There is no
   `--type`, no `--actor`, no `--epic`, no pagination. A narrower question is
   `list` or `log`, both of which already answer it.
4. **`recent` is ordered by `events.id`, not by a wall-clock day.** "Changed
   today" was the first draft and is wrong twice: it depends on the reader's
   timezone, and a session opening at 00:05 sees an empty board on the busiest
   possible day. A count-bounded tail has neither problem.

**`ready` is ordered exactly as `next` chooses**, so the board's first ready row
is the task `next` would return. Two commands answering "what now" with
different answers would be worse than either one alone, so the ordering has one
implementation and a test asserts the two agree.

**`--digest` is a flag on `board`, not a command.** It prepends the store's
newest `handoff` note. It is the same projection with one section added, so a
session-start hook and a mid-session checkpoint run the same command and differ
by one flag — rather than being two commands that drift apart.

**Attribution is displayed as "last touch".** Every event carries an actor
(ADR-007), and the board and `brief` both show it. Until F4 ships claims, katra
has no concept of ownership, and a column headed `owner` or `assignee` would
assert one that does not exist — a session would read "someone has this" from a
line that only means "someone touched this". The label is a correctness
constraint, not wording polish.

## Consequences

- **`board` and `log` have disjoint jobs**, and the test suite can say so: the
  board's output is asserted by *section*, `log`'s by *sequence*. If a future
  change makes one substitutable for the other, those assertions collide.
- **The board's *output* is bounded by its shape; its *cost* is not.** A store
  with ten thousand tasks produces the same number of lines as one with ten —
  that part is what fixed shape buys. An earlier draft of this bullet went on to
  claim the cost was bounded too, and that is false. `ready` and `blocked` join
  `task_readiness`, a correlated `NOT EXISTS` evaluated for every row in `tasks`
  (`0001-init.ts:170-177`) before any `LIMIT` applies, and `--digest` filters
  `notes` by `kind` with no index covering it. Board is O(tasks), not O(output).

  This matters precisely because this ADR is the document arguing you should run
  it at every checkpoint. So the claim is replaced by a measurement: F3's
  acceptance criteria require board to be profiled against a seeded store of ten
  thousand tasks, with migration `0003` as the named escape hatch if it fails.
  Cheap enough to run constantly is a number, not an assertion.
- **Requests for board filters get refused by default.** The answer is `list` or
  `log`. If a narrowing turns out to be genuinely unanswerable by either, that is
  a signal those commands are missing something — fix them, not the board.
- **The digest cannot drift from the board**, because it is the board.
- **`board` is now coupled to `next`'s ordering**, deliberately. Changing how
  `next` picks changes what the board leads with, and the test asserting the two
  agree is what makes that visible rather than surprising. The alternative — a
  second ordering — is worse: two commands answering "what now" differently.
- **An agent parsing `--json` can rely on the top-level keys existing.** Fixed
  shape means fixed document: sections are always present, empty when they have
  nothing, rather than appearing and vanishing.

## Alternatives considered

**Make `board` a feed and drop `log`.** Rejected: `log` scopes to an entity and
its children, which is the read `show` and `brief` both build on. Removing it to
avoid overlap would delete the more foundational of the two.

**Make `board` a feed and accept the overlap** — different default limit, nicer
formatting. Rejected: two commands answering one question is how a CLI becomes
un-learnable, and it leaves the state-derivation work in every agent's context
where it is done repeatedly and inconsistently.

**Give `board` an `--epic` filter, matching `list`.** Rejected, and not on
slippery-slope grounds — **`brief <epic>` already is it.** Line the two up: an
epic-scoped board would show children grouped by lane, the blocked ones with
their blockers, and activity across the epic and its children. That is
`brief <epic>`'s specified output with the description removed. `board --epic`
would be a second spelling of a read F3 already ships, which is the same mistake
ADR-008 caught in `log --all`.

The global scope is also the *right* scope for the question `board` asks. katra
assumes one worktree per feature with several sessions live at once
(`AGENTS.md`), so another branch's in-flight work appearing on the board is the
point — it is how a session notices a conflict before claiming. Narrowing to
"my" epic would delete the coordination value and keep only the part `brief`
already covers.

**Compute "in flight" from claims instead of lanes.** Rejected as premature:
claims land in F4 (`katra-9aw.13`). Lanes are what exists now, `In Progress` and
`In Review` are what they mean, and F4 can refine the section without changing
the board's shape.
