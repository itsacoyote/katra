# ADR-017: Snapshots are deterministic JSONL, and the one tracked file katra writes

## Status

Accepted

## Date

2026-08-22

## Context

Spec §3 promises `snapshot`/`restore`: the store exported to diffable text,
committed to git purely as a disposable backup — SQLite stays truth, nobody
reads the artifact, and a fresh clone repopulates by restoring. Decision
`katra-9aw.4` (closed 2026-08-22) fixed the format triad after weighing an
SQL-dump text format: better-sqlite3 has no `.dump` API, so that route means
hand-writing both the dumper and its escaping — recreating exactly the
hostile-bytes surface (control characters, bidi, zero-width in titles, notes,
and refs) that F7–F9 spent three cycles fencing, for no diffability gain.

Separately, the repo's design rules say katra never modifies a tracked file —
its store lives inside `.git/` by construction (ADR-004). A committed snapshot
is definitionally a tracked file katra writes.

## Decision

- **Format: JSONL, deterministic.** Line 1 is a header object
  (`format`, `formatVersion`, `schemaVersion`) — **no timestamp, no machine
  identity** — followed by one self-describing JSON object per row, tables in
  a fixed order, rows in primary-key order. An unchanged store snapshots to a
  byte-identical file, so committed snapshots diff empty when nothing moved.
  JSON escaping gives exact round-tripping of every stored byte for free.
- **Full fidelity — amended 2026-08-22: presence excluded.** Every
  source-of-truth table, claims included. The original "everything, no
  exceptions" reading fell to a proven conflict during implementation: the
  presence heartbeat rewrites `last_seen` on every store open past its 30s
  freshness window, so a snapshot containing presence is never byte-identical
  across real runs (killing the clean-commit story this ADR's determinism
  exists for) and carries every worktree's absolute path into a committed
  file. Presence is derived operational telemetry — `openStore` repopulates
  it on the first command after any restore — so nothing recoverable is
  lost. Claims stay: they are stable coordination state, and stale restored
  claims cannot wedge work (claims never gate lane movement — ADR-012 — and
  `release --force` exists).
- **Restore rebuilds at the snapshot's schema version, then migrates
  forward** through the existing migration chain, so a snapshot dug out of
  git history stays restorable after any number of upgrades. The rebuild
  happens in a fresh file that is atomically swapped in, with the prior
  database preserved as `katra.db.bak`; a failed restore leaves the live
  store untouched.
- **`.katra/snapshot.jsonl` is the sanctioned tracked-file exception.** The
  default output path is a worktree directory the user commits. Writing it
  happens only on an explicit `katra snapshot` invocation — the same
  explicitness class as `migrate --apply` — never as a side effect of any
  read or other write. The "katra never modifies a tracked file" rule is
  hereby narrowed to: *never as a side effect; `snapshot --out` writes
  exactly the file it was asked to write, and nothing else.*

## Consequences

- The three lifecycle gaps the 2026-08-04 dogfood named (share a backlog,
  survive a clone, undo a bad write) close with one artifact and two
  commands, no daemon and no git integration.
- Determinism makes snapshot committing cheap enough to habituate — an
  AGENTS.md session-end recipe can run it unconditionally, because a no-op
  session produces a no-op diff.
- Restoring is destructive by design and gated accordingly
  (preview / `--apply` / `--force` on non-empty stores); merging divergent
  stores is explicitly not this feature and would need its own cycle.
- The format version is independent of the schema version: a future line-
  shape change bumps `formatVersion` with its own compatibility story, while
  schema evolution keeps riding the migration chain unchanged.
