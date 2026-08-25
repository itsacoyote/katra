# ADR-020: Tier-1 delivery ships as thin per-agent adapters over abstract touchpoints, self-installed by idempotent merge

- **Status:** Accepted
- **Date:** 2026-08-25
- **Feature:** F11 — Agent hook adapters (Tier-1 delivery)

## Context

katra must deliver coordination inside turn-based, pull-only agents without a daemon and without
core changes per agent (spec §9, §13). Claude Code and Codex expose a native hook mechanism
sharing the same `hooks.json` event schema; Pi uses a `.pi/hooks/*.ts` module. The delivery layer
is the only per-agent glue — the CLI itself is already agent-agnostic.

## Decision

Define delivery as **~4 abstract touchpoints** (session-start, before-edit, on-stop,
session-end), each mapping to a single CLI call. Ship a **thin adapter per agent** that wires the
touchpoints to those calls; adding an agent is one adapter, **no core changes**. Adapters
self-install via **`katra install-hooks <agent>`**, which **idempotently merges** katra's entries
into the agent's own settings file (preserving pre-existing config), with `--print` (dry-run) and
`--remove` (clean uninstall). Claude Code and Codex share the `hooks.json` event schema, so their
adapters are near-identical.

This cycle wires three touchpoints (session-start, before-edit, session-end) for two agents
(Claude Code, Codex). The on-stop touchpoint and the Pi adapter are deferred as thin follow-ons
the abstraction already anticipates.

## Alternatives considered

- **Ship copyable adapter files the user wires by hand.** Rejected: worst UX, error-prone, and
  pushes the JSON-merge problem onto the user.
- **Print-only (user pastes the block).** Kept as the `--print` sub-mode for the cautious case,
  but not the primary path — a self-installing command is the agent-first ergonomic default.
- **A background daemon / real-time push.** Rejected and deferred (spec §9): out of scope for v1;
  the board plus the session-start digest is the near-term delivery model.

## Consequences

- The **touchpoint abstraction is the stable contract**; Pi and the on-stop hook become thin
  additions with no core churn.
- `install-hooks` **must merge, not overwrite**, and must **tag its own entries** so a re-run is a
  no-op and `--remove` strips only katra's hooks. That merge/identify logic is the real work of
  the install command and is fully unit-testable.
- The **session-end touchpoint requires `release --mine`** — `katra release` needs an explicit id
  and the hook has none to give, so a "release this worktree's claims" mode is a prerequisite of
  the touchpoint, not separate scope.
- **Codex rides an experimental hooks flag** and an unpinned config location; its adapter is
  best-effort against the shared schema, while Claude Code is the proven path.
