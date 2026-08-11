# ADR-011: Every CLI call heartbeats, so reads write telemetry

## Status

Accepted

## Date

2026-08-11

## Supersedes

Narrows F3's criterion 12 ("neither command writes a row") as recorded in
`docs/f3-traceability.md`. ADR-009's board contract is otherwise untouched.

## Context

Presence exists so a contended claim can say "held by X, last seen 4m ago"
instead of forcing a guess about whether X is alive. The spec (§10) makes it
hook-free by design: `last_seen` is bumped **as a side effect of every katra
CLI call**, because the one thing every session does — on any agent, with no
adapter — is run katra commands. Sessions that only read are exactly the
idle-but-alive case the spec says must keep holding their claims.

F3 shipped the opposite guarantee for its two commands: `board` and `brief`
write nothing, and tests pin it ("leaves the event count unchanged and opens
no write transaction"). Both cannot stand. A heartbeat that skips reads
makes a session invisible the moment it stops writing — which is most of a
session's life, and all of a stuck one's.

## Decision

**Every command bumps presence, reads included.** The F3 contract narrows
from "reads write nothing" to **"reads write no event"**: history stays
pure — nothing an agent reads back from `log` is produced by reading — while
the single-row presence UPSERT is telemetry, not history.

Three properties keep the bump honest:

- **Outside the snapshot.** The UPSERT runs at CLI entry, before and apart
  from any `readTx`, so the board's one-snapshot guarantee is untouched.
- **Non-fatal.** A failed bump warns and the command proceeds — a read that
  fails because telemetry could not be written would invert the priorities.
- **Eventless.** No `presence-*` event type exists; the stream records what
  happened to work, not who was breathing.

## Consequences

- The F3 read-purity tests are amended deliberately: they now assert "no
  event appended" and additionally that `last_seen` moved — the narrowed
  contract is pinned as tightly as the old one was.
- Every katra invocation costs one single-row UPSERT. Measured against the
  same budget discipline as F3: the perf criterion covers it.
- `--json` output is unaffected; the bump changes no document.
- A scripted probe that must not register presence does not exist as a use
  case today; if one appears, an opt-out flag is additive.

## Alternatives considered

**Bump only on writes.** Keeps F3's contract untouched, but a session
running `board`/`brief`/`log` in a loop — the exact loop `AGENTS.md`
instructs — reads as dead while alive, and its claims invite a `--force`
takeover the moment a human believes the staleness display.

**Bump on reads with an opt-out flag.** A flag on every command for a
consumer nobody has. Additive later if real.
