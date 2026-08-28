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

`katra guard` enforces at the **task level**. It walks the caller worktree's claim/release event
history to find every task it was ever displaced from that some other worktree still holds —
**amended 2026-08-25: plural, not singular** — the original "the caller worktree's in-progress
task" reading admits only one candidate task, when the real tenure rule tracks every displaced
tenure and reports the most recent one whose current holder is still live. It denies the edit iff
**any** such tenure remains live-held and the worktree has not claimed something else since being
displaced from it (re-coordination); it allows in every other case, holding nothing included. It
reuses `claims` + `events` + `presence`; **no schema change**. The check is **amended 2026-08-25:
K+1 indexed reads, bounded by the active foreign-claim count** — not the single read originally
decided — one `claims` read for every foreign holder (a single query, returning all K rows), one
`events` read per candidate task it returns, plus one further `claimsHeldBy` read when the
re-coordination gate runs at all (only once at least one displaced tenure exists), each still
well under the <1s hook budget. It **never mutates `claims`/`tasks`/`events`** — amended
2026-08-25: not "never writes" outright. The ADR-011 presence heartbeat still rides along on
every `openStore` a caller has to make before it can hand this function a store to read, bumped
at most once per `PRESENCE_FRESH_MS` window; that is a property of opening the store, not of this
check, which itself opens no transaction and appends no event.

### Deny signalling — added 2026-08-25

Deny is scoped to the confirmed-takeover arm only: a live displaced tenure, successfully read.
Every failure — no store (`init` never ran), a locked or corrupt database, an in-handler usage
refusal (a malformed `--liveness` value), any other exception — is caught by the CLI and reads as
allow, never deny. This is fail-open by construction, within the binary, across every agent —
safe even where a foreign agent treats any nonzero exit as blocking.

The CLI signals a deny with **exit 2** plus a sanitized one-line reason on stderr — a deliberate,
documented divergence from ADR-006 (`next` answers a legitimate negative with exit 0, the verdict
carried entirely in its payload). Claude Code's PreToolUse hook actually has **two** signals that
block a tool call unconditionally, in every permission mode including `bypassPermissions`: exit 2
with a stderr reason, and exit 0 with a JSON `permissionDecision: "deny"` on stdout. (An earlier
draft of this reasoning claimed the JSON channel is "overridable" by permission allow-rules and
permissive modes; that claim is wrong and is retracted here, not merely qualified — current docs
show a JSON deny blocks exactly as unconditionally as exit 2 does.) katra picks exit 2 anyway, on
the surviving, correct grounds: **agent-agnosticism, not strength**. Exit 2 needs no per-agent
stdout schema and takes no dependency on the agent parsing katra's own output — exactly what let
an earlier draft's per-agent `--hook <agent>` flag go — where a JSON decision would tie katra's
stdout shape to Claude Code's own schema, and would need a different shape again for any other
agent guard ever runs under.

**Known limits.** Commander's own usage-error path also exits 2, for a genuinely malformed
invocation (an unknown flag or command) — that path never reaches guard's handler at all, so it
cannot be caught and turned into allow. A hand-edited hook line, or an older binary invoked
before `guard` existed, therefore blocks loudly rather than failing open — the same
self-correcting known limit version skew already carries elsewhere, distinguishable from a real
deny only by stderr content. Deliberately not silenced by a shell `|| true` wrapper around the
hook command, which would disarm every real deny along with it. Separately, the <1s hook budget
this ADR cites throughout is a target, not an enforced deadline: guard sets no timeout of its own
around the store open or its reads, so a `git` subprocess resolving identity, or SQLite's
`busy_timeout` retrying a held write lock under real contention, can in principle run past it —
the same way any other katra command's identity resolution can. This does not weaken fail-open:
a slow verdict still resolves to allow or deny correctly once it returns, it is only latency, not
correctness, that the budget is unenforced for.

## Alternatives considered

- **Path-scoped claims (file-level).** Extend a claim to carry path globs; guard denies edits to
  files under another live worktree's claimed paths. Rejected: adds a schema dimension, glob
  matching, and a paths-declaration step at claim time — heavier and more friction for a
  collision that task-level detection already catches. YAGNI until a real need appears.
- **Advisory warning only.** guard prints a warning and never blocks. Rejected: "enforced
  collision safety" (spec §9) would be unenforced — no better than the Tier-0 pull model already
  in place.

## Consequences

- **Amended 2026-08-25 — inverted.** The original claim here ("guard is a no-op when the
  worktree holds no claim") is false under the bounded tenure rule above: a worktree displaced
  from a task, holding nothing since, is exactly the case that must deny — "holds no claim" is
  true of it and denial fires anyway. The real no-op condition is narrower: guard allows whenever
  there is no live, un-re-coordinated displaced tenure — holding nothing with no history of ever
  being displaced, holding exactly what was always held, having claimed something else *since*
  the displacement (re-coordination), or the displacing worktree having gone stale. Claiming
  remains the agent's own discipline for starting work; guard's only job is catching a takeover
  the worktree never noticed, whether or not it currently holds anything at all.
- Two agents on **different** tasks that happen to touch the same file are out of scope — that is
  a task-decomposition smell, not katra's to police.
- Takeover detection reads the **event log**, which is idiomatic (the event stream is katra's
  spine, F2) and stays within the latency budget.
- Inherits ADR-007's worktree path-recycling hazard unchanged: a deleted-and-recreated worktree
  at the same path is indistinguishable from the original. The remedy is the same one every stale
  claim already has — `release --force`, informed by the liveness guard reports.
