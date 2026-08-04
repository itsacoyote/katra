# ADR-001: Short random flat IDs with a `kt-` prefix

## Status

Accepted

## Date

2026-08-02

## Context

katra needs identifiers for tasks and epics. Two requirements from the design spec pull in different directions:

1. **Collision-free without coordination** (§6). Sequential numbers race when parallel worktrees create tasks at the same time, which is katra's normal operating mode.
2. **Partial-ID matching** (§6). `katra show 5c4` must resolve, because agents and humans should not have to type or copy a full identifier.

The spec named ULID as the preferred option, primarily for time-sortability, with "a short random suffix with a tk-style prefix" as the alternative. That preference was recorded before the partial-matching requirement was examined alongside it.

A third question sits on top of the format: whether child tasks get **hierarchical** IDs encoding their parent (as beads does — `katra-9aw.15` is child 15 of epic `9aw`) or **flat** IDs with the parent held in a column.

## Decision

Use **short random IDs with a `kt-` prefix** — e.g. `kt-9f3k2a` — and keep them **flat**, with hierarchy stored in a `parent_id` column.

- The suffix is **six base36 characters** (`0-9a-z`), drawn from `crypto.randomBytes`. Randomness is uniform across the whole suffix.
- Collisions are handled by retrying the insert against a `UNIQUE` constraint.
- Chronological ordering comes from an indexed `created_at` column, not from the ID.
- Partial-ID resolution matches on prefix; an ambiguous prefix lists the candidates rather than guessing.

### Why six characters

An earlier draft of this ADR used a four-character example. Research measured the actual collision probability and four is too short:

| suffix length | keyspace | P(≥1 collision in 2,000) | P(≥1 collision in 10,000) |
| --- | --- | --- | --- |
| 3 | 46,656 | 100% | 100% |
| 4 | 1.68M | 69.6% | 100% |
| 5 | 60.5M | 3.25% | 56.3% |
| **6** | **2.18B** | **0.09%** | **2.27%** |

Retry makes any of these *correct*, so this is a question of how often the retry path fires, not whether it works. At four characters it fires routinely in normal use; at six it is genuinely exceptional while the ID stays short enough to type. A retry cap of 5–10 attempts is ample, because the per-draw collision probability stays low even when a collision somewhere across many draws is likely.

Two implementation constraints follow, both verified against real SQLite:

- **The retry must match narrowly on `SQLITE_CONSTRAINT_PRIMARYKEY`.** Retrying on any `SQLITE_CONSTRAINT_*` would silently mask an invalid-enum bug as a phantom ID collision.
- **Prefix lookups must use `GLOB` or explicit range bounds, never `LIKE`.** `LIKE 'prefix%'` does not get SQLite's index range-scan optimization: measured at 5,000 rows, 2,000 `LIKE` lookups took 1.17s versus 151ms for the equivalent `GLOB` — a 7.7× gap that widens with backlog size.

## Consequences

**Good:**

- Three characters usually disambiguate, so `katra show 5c4` works as the spec intends.
- IDs are short enough to read in a terminal, type by hand, and paste into a commit message.
- The `kt-` prefix keeps an ID from being mistaken for a git SHA or an external issue number in prose.
- Because IDs are flat, **reparenting a task does not change its ID**. An ID written into a commit message, a PR description, or an external issue stays valid forever.

**Costs / risks:**

- IDs are not sortable on their own. Any listing that wants chronological order must sort by `created_at`. This is a real constraint on query code, mitigated by indexing that column — which katra needs regardless.
- Collision handling is a code path that must exist and be tested, rather than being impossible by construction.
- Hierarchy is not visible from an ID alone; showing an epic's children requires a lookup. Acceptable, since katra's reads assemble context anyway.

## Alternatives Considered

### ULID

- **Pros:** Time-sortable, collision-free by construction, a well-known standard.
- **Cons:** 26 characters, and — decisively — **the leading characters are a timestamp**. Every task created in the same window shares a long prefix, so short prefixes are ambiguous exactly when a backlog is most active. Partial matching would require ~10+ characters to disambiguate, defeating the requirement.
- **Rejected because:** its headline benefit (sortability) is already available for free from an indexed `created_at` column, while its structure actively breaks the partial-matching requirement. ULIDs earn their keep in distributed systems with no shared clock; katra is a single local SQLite file with a `created_at` column right there.

### Short random with no prefix (`5c46`)

- **Pros:** Shortest possible.
- **Cons:** A bare hex string is ambiguous in prose and logs — "fixed in 5c46" could be a katra task, a git SHA, or a PR number.
- **Rejected because:** four characters of namespace is a trivial cost for unambiguous references.

### Hierarchical IDs (`kt-9aw.15`)

- **Pros:** Parentage is visible at a glance with no lookup.
- **Cons:** The ID encodes a mutable fact. Reparenting a task forces a choice between renumbering it — invalidating every existing reference, including ones already written into external systems katra cannot update — or keeping an ID that now names the wrong parent.
- **Rejected because:** katra explicitly expects tasks to move between epics, and it is strictly one-directional with external trackers, so it can never go back and fix a reference it invalidated.

### Sequential integers

- **Rejected because:** they race across parallel worktrees, which is the exact failure the spec calls out in beads (§14).
