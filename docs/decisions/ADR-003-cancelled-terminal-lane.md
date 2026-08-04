# ADR-003: Add a `Cancelled` terminal lane, and define readiness against terminal lanes

## Status

Accepted

## Date

2026-08-03

## Supersedes

Extends the lane set fixed in `docs/katra-spec.md` §4, alongside [ADR-002](ADR-002-planned-lane-naming.md).

## Context

katra's six lanes each map to one stage of the Define → Research → Plan → Implement → Validate → Document workflow. Every lane therefore describes *progress toward completion*, and exactly one — `Done` — is terminal.

That leaves no way to record work that was real, planned, and then dropped: superseded by another approach, descoped, or obsoleted by a change elsewhere. This is ordinary and frequent, and it is distinct from the two things katra could already express:

- **`close`** means the work is finished. The task belongs in history and counts toward its epic's progress.
- **`delete`** means the task should never have existed — a typo, a duplicate, a misfile. It is removed.

Abandoned work is neither. Recording it as `Done` is a lie that makes "what did we actually finish?" unanswerable; deleting it destroys the record that the work was ever considered, which is exactly the context a future session needs in order not to re-propose it.

**The sharper problem is dependency readiness.** Readiness was defined as *"no dependency on an item that is not `Done`"*. Because `Done` was the only terminal lane, abandoning a blocker left everything behind it blocked permanently — there was no lane transition that could release its dependents. The only workaround would have been to mark abandoned work `Done`, reintroducing the same lie and corrupting the data that `katra next` reads.

## Decision

Add a seventh lane, `Cancelled`, which is terminal:

```
Defined → Researching → Planned → In Progress → In Review → Done
                                                          ↘ Cancelled
```

Introduce **terminal lanes** as an explicit concept:

```
TERMINAL = { Done, Cancelled }
```

and redefine readiness against it:

> A task is **ready** when none of its dependencies is in a non-terminal lane.

`katra cancel <id> --reason <why>` moves a task to `Cancelled` and records the reason in the existing `close_reason` column. Cancelling reports which tasks it unblocked, since that is the non-obvious consequence.

## Consequences

**Good:**

- Abandoning a blocker correctly releases the work behind it, with no dishonest state change.
- "What did we finish?" and "what did we drop, and why?" are both answerable, and are different questions.
- The reason for dropping the work is captured where a future session will find it, which is the context that stops a settled decision from being re-litigated.
- `TERMINAL` is a named set rather than a hardcoded `= 'Done'` comparison, so the readiness rule has exactly one definition to change if another terminal lane is ever added.

**Costs / risks:**

- A seventh lane in a set that the design spec called "fixed for now" — the second such deviation after ADR-002. Both are recorded rather than silent, and both land before any implementation exists.
- The lane set is no longer a strict one-per-workflow-stage mapping, which was ADR-002's stated appeal. `Cancelled` is deliberately an exit from the pipeline rather than a stage within it, and reads that way in the diagram above.
- Every query touching readiness must use the `TERMINAL` set rather than comparing to `Done`. A missed site is a correctness bug, so readiness must live in exactly one place in the core.

## Alternatives Considered

### Reuse `close` with a reason

Set `lane = Done` and record why in `close_reason`.

- **Pros:** No new lane; the column already exists; readiness logic unchanged.
- **Cons:** Abandoned work reports as `Done`. Progress counts, `katra next`, and any future reporting would all treat dropped work as completed. The distinction would exist only in a free-text field nothing queries.
- **Rejected because:** it puts a known-false value in the field that drives the tool's most important read.

### Delete abandoned work

- **Pros:** Simplest possible model — done or gone.
- **Cons:** Destroys the record that the work was considered and the reasoning for dropping it, which is precisely what prevents a later session from re-proposing it.
- **Rejected because:** katra exists to carry context across sessions; discarding the "we decided not to" record works directly against that.

### Keep `Done` as the only terminal lane and add a `cancelled` tag

- **Pros:** No lane-set change.
- **Cons:** Readiness would have to consult tags, mixing a free-text, user-extensible field into a core correctness computation.
- **Rejected because:** readiness must be computed from fixed, constrained values, not from free text.
