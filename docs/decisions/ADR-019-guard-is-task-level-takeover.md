# ADR-019: Guard enforces task-level takeover, not file-level collisions

- **Status:** Accepted
- **Date:** 2026-08-25
- **Feature:** F11 — Agent hook adapters (Tier-1 delivery)

## Context

The before-edit touchpoint (spec §9) fires on a file edit — a Claude Code `PreToolUse` hook
supplies the file path being written. But katra's claims are **task↔worktree** with no path or
file scope: `claims.task_id` is the primary key and `holder` is the worktree path (migration
0003). There is no file→task mapping anywhere in the store, so "deny **the edit**" cannot be
answered from the edited file alone.

The collision this touchpoint exists to stop: worktree A claims task X and edits its files;
worktree B runs `release --force` to take X over; A never notices and keeps editing — two live
worktrees silently own the same work.

## Decision

`katra guard` enforces at the **task level**. It determines the caller worktree's in-progress
task from claim/release event history, then denies the edit iff that task is currently held by a
**different, live** worktree. It reuses `claims` + `events` + `presence`; **no schema change**.
The check is a single cheap indexed read, well under the <1s hook budget, and never writes.

## Alternatives considered

- **Path-scoped claims (file-level).** Extend a claim to carry path globs; guard denies edits to
  files under another live worktree's claimed paths. Rejected: adds a schema dimension, glob
  matching, and a paths-declaration step at claim time — heavier and more friction for a
  collision that task-level detection already catches. YAGNI until a real need appears.
- **Advisory warning only.** guard prints a warning and never blocks. Rejected: "enforced
  collision safety" (spec §9) would be unenforced — no better than the Tier-0 pull model already
  in place.

## Consequences

- Guard is a **no-op when the worktree holds no claim** — editing without having claimed anything
  is not blocked. This is consistent with Tier-0 being advisory; claiming remains the agent's
  discipline, and guard only enforces the *takeover* case.
- Two agents on **different** tasks that happen to touch the same file are out of scope — that is
  a task-decomposition smell, not katra's to police.
- Takeover detection reads the **event log**, which is idiomatic (the event stream is katra's
  spine, F2) and stays within the latency budget.
- Inherits ADR-007's worktree path-recycling hazard unchanged: a deleted-and-recreated worktree
  at the same path is indistinguishable from the original. The remedy is the same one every stale
  claim already has — `release --force`, informed by the liveness guard reports.
