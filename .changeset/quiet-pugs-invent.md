---
"@itsacoyote/katra": minor
---

Add the append-only event stream and typed notes.

Every write now records what happened. `add`, `update --lane`, `close`, `cancel`, `reopen` and `delete` append an event inside the same transaction as the change itself, so history can never describe something that did not happen — and `update --title` and its siblings append nothing, because attribute churn buries the signal the stream exists to carry.

`katra log [id]` reads it back: one entity's history, an epic's own events plus its children's, or the whole store, newest first and bounded by `--limit`. A deleted task's history survives and stays readable by id — the event stream has no foreign key to `tasks` by design (ADR-008), and `delete` appends its own last event carrying the title, since nothing else can recover it afterwards.

`katra note add` and `katra note list` attach typed prose to a task — `general`, `handoff`, `decision` or `acceptance`. Bodies come from `--body-file` (or `-` for stdin), never an inline argument, and round-trip byte-identically including newlines, tabs and unicode. `show` now carries a task's notes and recent activity, both bounded by fixed internal caps so a summary stays a summary.

Every event and note records who wrote it as `<branch> @ <worktree path>` (ADR-007), so two agents in two worktrees are always distinguishable in the record.

Migration `0002` adds the `events` and `notes` tables. An existing store upgrades in place, keeping its tasks.
