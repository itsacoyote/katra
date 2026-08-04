# ADR-007: An actor is a branch and a worktree path, stamped together

## Status

Accepted

## Date

2026-08-04

## Supersedes

Refines `docs/katra-spec.md` §6, which says *"Identity = the worktree. One agent per worktree, keyed by worktree path."*

## Context

Every event and every note records who wrote it. katra had no notion of an actor before F2, so this is decided from scratch — and decided once, because **events are immutable**. Whatever goes in the column stays there for the life of the store.

The spec's answer is the worktree path. That is right about the *model* — katra's whole coordination story is one agent per worktree, so the worktree genuinely is the identity, with no session ids to mint and no registry to keep. It is wrong about the *encoding*, for two reasons that only show up over time:

- **Paths are recycled.** Worktrees are created for a branch, merged, and torn down; the next one lands on a similar or identical path. A year of history keyed on `/repo/wt-3` cannot distinguish three different pieces of work.
- **Paths stop resolving.** `git worktree remove` deletes the directory. The event that says `/repo/wt-auth` closed a task now points at nothing, and the reader cannot tell what that worktree was for.

Neither is fatal — history is a record, and a record of a path that existed is not *wrong*. But the reader's actual question is "which piece of work did this?", and the branch answers it where the path does not.

The alternative pull is toward something stable and human, like git's `user.name`. That fails the opposite way: every parallel agent in every worktree becomes the same actor, which erases exactly the distinction the events exist to draw.

## Decision

**Stamp both, in one column, formatted `<branch> @ <absolute worktree path>`.**

```
feature/auth @ /home/me/repo/wt-auth
```

Resolved per invocation from git — the branch from `rev-parse --abbrev-ref HEAD`, the path from `rev-parse --show-toplevel` — using the same subprocess machinery `locate.ts` already owns, including its absolute-path resolution of `git` (see the M1 finding in F1's security review).

One column rather than two: the pair is a single identity and is only ever read as a whole. Splitting it would invite a query that groups on the path alone, which is precisely the collision this decision exists to avoid.

**Detached HEAD** stamps the short SHA in the branch position — `a1b2c3d @ /repo/wt`. It is what git itself reports and it stays truthful.

**No configuration.** `KATRA_ACTOR` was considered and deferred: nothing in F1–F3 runs outside a worktree, and an override that nothing needs is a documented, tested surface earning nothing. F5's providers and any CI use are where the case would become real, and it can be added then without touching stored data — an override changes what future events say, not what past ones mean.

## Consequences

- Two worktrees on two branches are always distinguishable, which is the point.
- One worktree used for two branches over time is also distinguishable, which the path alone could not manage.
- Deleting a worktree leaves history readable: the branch still names the work.
- The actor is a **display string, not a key**. Nothing joins on it, and nothing should — it is provenance, not a foreign key to a session table katra does not have.
- Two agents sharing one worktree are indistinguishable. That is the spec's stated assumption (*"the default assumption is one active agent per worktree"*), and layering a session id on top later changes only the format of new events.
- Every event write costs two `git rev-parse` calls. Resolved once per process and reused, so the cost is per invocation, not per event.

## Alternatives considered

**Worktree path alone**, as the spec says. Rejected for the recycling and resolution problems above — both of which arrive only after months of use, which is the worst time to discover them in an append-only table.

**git `user.name` / `user.email`.** Rejected: stable and familiar, but identical across every parallel agent, which defeats the cross-worktree coordination the stream is for.

**A minted session id.** Rejected as the spec already rejects it: it needs a registry, a lifecycle, and a way to recover from a crashed session, and it answers a question — *which run?* — that nobody has asked. The worktree is free.

**Two columns, `actor_branch` and `actor_path`.** Rejected: invites grouping by path alone, which is the collision this decision is about. If a future read genuinely needs the parts, splitting a well-formed string is cheaper than un-splitting a bad query.
