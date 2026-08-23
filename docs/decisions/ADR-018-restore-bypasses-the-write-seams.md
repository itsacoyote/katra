# ADR-018: Restore loads rows with raw INSERTs, bypassing the write seams

## Status

Accepted

## Date

2026-08-22

## Context

The house rule — stated in AGENTS.md and enforced hardest by the beads
migration loader — is that every write goes through the domain seams: even
the one bulk-historical writer routes tasks through `createTaskWithin`, notes
through `createNoteWithin`, and every event through the same `appendEvent`
every other path uses. Those seams deliberately mint fresh ids
(`insertWithRetry` generates a new random task id with no override; events
take SQLite's next rowid) because their job is admitting *new* data safely.

F10's restore has the opposite job: reproduce katra's own prior data
**exactly** — the same task ids, the same event ids and `prior_actor`
values, every column verbatim (AC2's byte-for-byte fidelity). No seam can do
that, and widening them all with force-this-id parameters would smear
restore's one exceptional need across every ordinary write path.

The codebase already contains the shape restore actually needs: migration
rebuilds (`0005-refs.ts`, `0006-refresh.ts`) copy tables forward with
explicit-column, literal-value-preserving `INSERT ... SELECT`, bypassing
`appendEvent` entirely — sanctioned because a rebuild reproduces existing
rows rather than admitting new data.

## Decision

Restore's row loading uses **raw, parameterized, explicit-column INSERTs**
per table — the migration-rebuild shape applied to an external source. The
snapshot's parsed rows are treated as katra's own prior data, not as
untrusted foreign input to re-validate through domain rules: schema
constraints (CHECKs, foreign keys, GLOB id patterns) still apply because the
rows land in a real schema built by the real migration chain, but domain
seams, id minting, and event appending are deliberately not involved. Restore
emits no events (design rule 6's curated vocabulary is untouched): the
restored events table *is* the history.

Three adjacent decisions ride with this, all surfaced by the same research
pass:

- **The FTS search index is never serialized.** It is derived state; the
  migration chain creates it and its triggers repopulate it as rows load
  (verified by a restored-store search test), so a snapshot carries only
  source-of-truth tables.
- **"Empty store" for the `--force` guard means no rows in any
  source-of-truth table except `presence`** — wider than migrate-beads'
  tasks-only check on purpose: its known gap (katra-9aw.52, tasks deleted
  but events surviving) would here mean a silent full-store swap with no
  guard shown, so events/notes/claims/refs all count.
- **The swap sequence and its residual crash window are explicit.** Build
  and fully verify the replacement file first; then checkpoint (TRUNCATE)
  and close the live connection, clear stale WAL/SHM sidecars, rename
  live → `katra.db.bak`, rename replacement → live. A crash between the
  two final renames leaves the live path empty with the good data in
  `.bak` — a named, accepted residual (the preview/`--force` ceremony has
  already established operator intent), documented rather than papered
  over. Other worktrees' open connections during a forced restore keep
  writing to the displaced inode (POSIX) or can fail the rename (win32);
  `--force` is the operator accepting exactly that race, and the preview
  surfaces other worktrees' presence so the acceptance is informed.

## Consequences

- AC2's fidelity is achievable and testable: source and restored stores can
  be diffed table-by-table, byte-for-byte.
- Restore is the second sanctioned seam-bypass after migration rebuilds,
  and the record of it lives here rather than as an implicit exception a
  reviewer trips over. Any future bulk writer proposing the same bypass has
  to argue from this ADR's "reproduce, don't admit" distinction.
- The raw INSERT path is fenced inside `core/snapshot/` — nothing else
  imports it, and the structural conventions that keep spawn sites and
  store imports contained apply to it the same way.
- If a future schema adds genuinely derived tables beyond FTS, the
  serialize-list test (which fails when an unlisted table appears) forces a
  triage decision per table, so the source-of-truth boundary stays explicit.
