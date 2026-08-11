# ADR-012: Claims steer ordering and annotate rows; they move nothing

## Status

Accepted

## Date

2026-08-11

## Supersedes

Nothing. Resolves the refinement ADR-009 explicitly deferred to F4
("compute in flight from claims — F4 can refine the section without
changing the board's shape").

## Context

Once claims exist, every read that answers "what should I start" has to
decide what a claim means for its answer. Three surfaces are affected:
`next`, the board's ready section, and the five counts that partition
`open`. F3 settled the counts arithmetic (ADR-009) and pinned it with a
summing test; it also pinned "the board's first ready row is the task `next`
returns" so the two commands cannot answer "what now" differently.

The tempting refinement — a claimed task counts as in flight — breaks the
partition: in flight is lane-defined, and moving claimed `Planned` tasks
between buckets reopens arithmetic that took three review rounds to get
right. Excluding other-claimed tasks from the ready *section* breaks it
differently: the task leaves every bucket and the counts stop summing.

## Decision

**Claims change ordering and annotation, never membership.**

- The five counts are computed exactly as F3 left them. A claim moves no
  task between buckets, so the partition — and its test — stand.
- The ready section orders unclaimed rows first (their relative order is
  `next`'s ordering, unchanged), then other-worktree-claimed rows last,
  each marked `claimed by <branch> · last seen <ago>`.
- `next` never offers a task claimed by **another** worktree — and ranks
  the calling worktree's **own** claim first among candidates, so a session
  that loses its context (`/clear`, crash, restart) runs `next` and resumes
  its task instead of orphaning it. The resumption stays within `next`'s
  settled scope: `next` offers **startable** work, so an own claim already
  moved to `In Progress` is not `next`'s to return — it is the first thing
  the session-start `board --digest` shows under in flight, and `brief`
  resumes it from there. One command answers "what do I start", another
  answers "where was I"; blurring them would put started work back in the
  startable queue.
- The agreement invariant evolves with it: **when the caller holds no
  Planned claim of its own**, the board's first unclaimed ready row is
  `next`'s answer, asserted by calling both. An own Planned claim is the
  one sanctioned divergence — `next` resumes it while the board leads with
  the top-priority unclaimed row — and a test pins the divergence
  deliberately rather than letting it read as drift.

## Consequences

- ADR-009's shape and arithmetic survive F4 untouched; the summing test
  gains claimed tasks in its fixture rather than an amendment to its claim.
- A capped ready section might show only claimed rows when unclaimed ones
  were cut — the `showing N of M` header already reports the cap, and the
  markers say why the visible rows are not offers.
- "Claimed by me" is deliberately not a special ready marker: the session
  can see its own actor string, and `brief` carries the claim in full.
- Own-claim resumption makes `claim` idempotent from the holder's side by
  design, which is also what makes the crash-restart story work with no
  reclaim machinery.

## Alternatives considered

**Claimed counts as in flight.** The truest picture of intent, but it
redefines a lane-based count as lane-or-claim, reopens ADR-009's settled
partition, and makes the board's counts disagree with `list --lane` — two
commands, one number, two meanings.

**Display only — `next` still offers claimed work.** Zero behaviour change,
but the command whose whole job is "what do I start" would hand a second
session the exact task a first session recorded intent to work on. That is
the collision claims exist to prevent, delivered by the tool that created
it.

**Exclude other-claimed tasks from the ready section entirely.** The task
falls out of every bucket and the counts lie. A board that understates the
backlog is the one thing ADR-009 says an orientation view must never do.
