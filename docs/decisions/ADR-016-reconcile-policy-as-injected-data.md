# ADR-016: Reconcile policy is injected data with a compiled-in default

## Status

Accepted

## Date

2026-08-18

## Context

Spec §7 requires the reconcile policy to be "configurable, not hardcoded — a
provider-agnostic mapping of external state → katra lane". Read maximally,
that implies a user-facing configuration surface (a config file, a DB table, a
flag) shipping with the feature. Katra has no configuration mechanism of any
kind today, and inventing one inside F9 would bolt a second feature onto the
first.

The same section says backward transitions "surface as suggestions only".
Decision `katra-9aw.5` (closed 2026-08-18) fixed the default map to terminal
targets only — `github/merged` → Done, `linear/completed` → Done,
`linear/canceled` → Cancelled — with the multi-ref rule defaulting to ALL.
Under that map every reachable target is a forward move from every non-terminal
lane, so there is no input that could produce a backward suggestion.

## Decision

The policy is **data, not branches**: the reconcile engine is a pure core
module that takes the policy table — a mapping keyed `(provider, status)` to a
target lane — as a parameter. The compiled-in default table from `.5` is the
only policy the CLI injects in v1. **No user-facing configuration surface
ships**: no config file, no DB-stored policy, no CLI flag to swap maps.

The **suggestion tier is omitted** in v1: it is unreachable under the shipped
map, and untestable code guarding an impossible state is worse than an absence
with a recorded reason. It returns as its own slice when a future policy (a
backward-capable map, or `.64`'s `state_reason` extension) can produce one.

## Consequences

- Spec §7's configurability is honored at the engine boundary — swapping
  trackers or maps is a data change, not a logic rewrite — while the surface
  users would actually touch is deferred until someone wants a non-default
  policy. Same narrowing pattern as ADR-014 (parse scope) and ADR-015
  (provider discovery); this ADR is the record.
- Tests exercise non-default policies freely by injecting tables, so the
  engine's configurability is proven even though no user can reach it yet.
- A future config surface (file, table, or flag) is purely additive: parse,
  validate, inject. Its validation story (unknown lanes, unknown providers,
  backward-capable maps re-enabling the suggestion tier) is scoped to that
  future cycle, not smuggled into this one.
- `katra-9aw.64` (GitHub `state_reason`) and any Linear-vocabulary growth
  change only the default table's rows, not the engine.
