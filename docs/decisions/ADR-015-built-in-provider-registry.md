# ADR-015: Built-in provider registry, external discovery deferred

## Status

Accepted

## Date

2026-08-16

## Context

F8 builds the provider seam spec §7 describes: something that can read one
external tracker (`match`/`resolve`), read-only by construction, degrading to
cached-and-unresolved rather than erroring. The spec imagines providers as
*discovered* plugins — `katra-provider-<name>` executables on PATH or npm
modules — so that adding Jira is dropping in a module with no core changes.

Discovery is also the single largest security surface the spec proposes
anywhere: katra would execute code it found by name. A PATH lookup executes
whatever a cloned repo's tooling managed to prepend to PATH; an npm module
loads arbitrary code in-process with the store handle in reach. Every katra
command runs inside agent sessions on developer machines — exactly the
environment supply-chain attacks target.

Meanwhile the real provider list today is two: GitHub (via the `gh` CLI the
user already authenticates) and Linear (via its GraphQL API and a token).
Both are wanted in-tree, tested, and shipped with katra itself. No third
party has asked to write a provider.

## Decision

The `Provider` interface ships exactly as spec §7 shapes it — `name`,
`match(ref)`, `resolve(ref)`, no write method existing in the type — but
implementations live in a **compiled-in registry** inside katra: an array in
`src/core/providers/` containing the GitHub and Linear providers. No PATH
scanning, no module loading, no subprocess protocol.

External discovery is **deferred, not rejected**: the interface is the
contract a future discovery mechanism would adapt to, and that mechanism
becomes its own feature cycle — with its own threat model — when someone
outside the tree actually wants to ship a provider.

## Consequences

- All of F8's user value (live status for GitHub and Linear refs) ships with
  zero discovered-code execution. The supply-chain surface stays closed.
- Adding a tracker today means a PR to katra, not a drop-in module — the
  spec's "no core changes" property is traded away until the discovery cycle.
  Accepted: the set of trackers anyone here uses is two, both in-tree.
- The registry is the one place resolution capability is enumerated, so
  "which providers exist" is answerable by reading one file — no environment
  inspection needed to reason about what `refresh` can do.
- Spec §7's discovery language is narrowed the same way ADR-014 narrowed its
  `parse(url)`: the interface is faithful, the loading story is deliberately
  smaller than written. This ADR is the record.
