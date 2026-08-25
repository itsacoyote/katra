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
- **Amended 2026-08-25 — the experimental-flag framing is stale.** Codex hooks are
  default-enabled since ~v0.133.0 (May 2026); `[features] hooks = true` / `codex_hooks` survive
  only as accepted/deprecated config keys, and the config location is pinned (`.codex/hooks.json`,
  project level — confirmed against the `openai/codex` Rust source itself, not a doc mirror, by
  implementation task katra-9aw.70.10). What replaces the flag as the reason the adapter stays
  best-effort is a verified **reliability** picture, not an unstable feature gate: the before-edit
  matcher is the single tool `apply_patch` (Codex has no `Edit`/`Write`/`NotebookEdit`), the
  `SessionEnd` hook's timeout is hard-capped at 3s server-side (Claude Code's is 10s), and open
  upstream bugs hit katra's exact worktree-per-agent architecture — project `.codex/hooks.json`
  can be silently misresolved when Codex runs inside a git worktree (openai/codex#27133, #23996),
  and `PreToolUse` deny is not always reliably enforced for `apply_patch`, the before-edit
  touchpoint itself (openai/codex#27833, #39872). Claude Code remains the proven path; Codex
  remains best-effort — on sharper, source-confirmed grounds than the original flag framing gave.
