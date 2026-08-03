# ADR-002: Rename the `Ready` status lane to `Planned`

## Status

Accepted

## Date

2026-08-02

## Supersedes

The lane names fixed in `docs/katra-spec.md` §4.

## Context

The design spec fixes six status lanes, one per stage of the Define → Research → Plan → Implement → Validate → Document workflow:

```
Defined → Researching → Ready → In Progress → In Review → Done
```

Separately, the spec defines `katra next` as returning "the highest-priority **ready** task" (§6b), where *ready* means **unblocked by dependencies** — a value computed from the dependency graph, never stored.

These two uses of "ready" collide. A task can sit in the `Ready` lane while being blocked by an unfinished dependency, so the sentence "this task is ready" has two different truth values depending on which sense is meant. Worse, katra's primary consumer is an agent, and §6b's stated reason for `--json` everywhere is precisely that ambiguous output causes silent misreads. Shipping an ambiguity into the core vocabulary works against that.

The collision also reveals an inconsistency. Five of the six lanes are named after their workflow stage. The Plan-stage lane is the only one named after a *state* rather than its stage.

## Decision

Rename the Plan-stage lane from `Ready` to `Planned`:

```
Defined → Researching → Planned → In Progress → In Review → Done
```

`ready` is then reserved for exactly one meaning throughout katra: **has no unresolved blockers**, computed from the `deps` graph.

`katra next` returns the highest-priority task that is both in the `Planned` lane and unblocked.

## Consequences

**Good:**

- "Ready" has exactly one meaning in the CLI, the docs, and the JSON output.
- All six lanes are now consistently named after their workflow stage, so the mapping is memorable rather than memorized.
- `katra list --lane Planned --blocked` reads as a sensible query. Under the old names, `--lane Ready --blocked` read as a contradiction.

**Costs / risks:**

- This is a deliberate deviation from the spec's "fixed for now" lane set. The spec remains the design source of truth; this ADR is the recorded exception, and `AGENTS.md` carries the corrected list.
- Anyone who read the spec before this ADR will expect `Ready`. Mitigated by the rename landing before any implementation exists — there is no stored data and no user to migrate.

## Alternatives Considered

### Keep `Ready` and disambiguate with flags

Use `--lane Ready` for the lane and `--unblocked` for the computed property, and never use "ready" bare in output.

- **Pros:** Stays exactly on-spec; zero deviation to justify.
- **Cons:** Pushes the ambiguity onto every future reader and every piece of output. The `Ready`-lane-but-not-ready state still exists and still has to be explained.
- **Rejected because:** it manages the confusion rather than removing it, and the cost of removing it is one word changed before any code exists.

### Rename the lane to `Todo`

- **Pros:** Instantly familiar from other trackers; short.
- **Cons:** Breaks the one-lane-per-workflow-stage naming symmetry that makes the six lanes coherent.
- **Rejected because:** `Planned` resolves the collision just as well while preserving the mapping to the Plan stage.

### Rename the computed property instead

Keep the `Ready` lane and call the computed property something else (`actionable`, `unblocked`).

- **Pros:** Also removes the collision.
- **Cons:** `ready`/`blocked` is established vocabulary from the prior art katra cribs from (§13), and the spec uses "ready" for the computed sense in several places. Renaming the concept would fight more established usage than renaming one lane.
- **Rejected because:** the lane name is the newer and less load-bearing of the two.
