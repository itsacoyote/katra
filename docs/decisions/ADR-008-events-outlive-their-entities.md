# ADR-008: Events outlive the entities they describe

## Status

Accepted

## Date

2026-08-04

## Supersedes

Nothing. Resolves a conflict between `docs/katra-spec.md` §5 (*"never edit or delete an event, even when the underlying entity changes"*) and F1's `delete` command, which removes a task outright.

## Context

F1 gave every child table a foreign key to `tasks` with `ON DELETE CASCADE` — `deps`, `links` and `tags` all vanish with their task, which is correct: they are *attributes* of a task, meaningless without it.

Applying the same rule to `events` looks consistent and is wrong, because an event is not an attribute. It is a record that something happened, and it happened whether or not the row still exists. Cascading deletes the answer to the one audit question most worth asking — *who removed that, and when?* — at exactly the moment someone asks it.

The three options are genuinely in tension, and each gives up something real:

- **Cascade** keeps referential integrity and contradicts the spec's core promise.
- **Restrict** keeps both integrity and immutability, and makes `delete` unusable: every task gets a `created` event at birth, so every task would be undeletable.
- **No foreign key** keeps immutability and gives up integrity: `entity_id` can point at a row that no longer exists.

The third is uncomfortable in a codebase whose stated discipline is that invariants belong in the database. It is worth being precise about *which* invariant is being given up. `events.entity_id` was never a claim that the entity exists **now**. It is a claim that it existed **then**. A foreign key enforces the first, and the first was never true of an append-only log.

## Decision

**`events` has no foreign key to `tasks`. Events are never deleted.**

`delete` appends a `deleted` event as its last act, so the stream ends with an explanation rather than trailing off:

```console
$ katra delete kt-x93 --force
deleted kt-x93  "a typo"

$ katra log --all
  16:41  deleted         kt-x93  a typo
  16:22  status-changed  kt-x93  Defined -> Planned
  16:19  created         kt-x93  a typo
```

`deleted` is a **seventh event type**, not in the spec's list of nine — that list predates F1's `delete` command. Recorded here rather than added silently.

**The title lives in its own column, not in `reason`.** An earlier draft of this ADR said the `deleted` event "carries the title in its `reason`", and plan review caught that this does not survive contact with the example above. The `created` line shows a title too, and no column held it — a `LEFT JOIN` to `tasks` returns NULL precisely because the task is deleted, which is the whole scenario. The illustration was not producible from the schema it illustrated.

Worse, `reason` means *why* everywhere else: `close` and `cancel` put a human explanation there. Any generic renderer — including `brief`, the feature this table exists for — prints it as a reason. And a research lens reading this ADR concluded it implied a `katra delete --reason` flag, which is the correct reading of a column called `reason`. A design a careful reader misreads is a design problem, not a reader problem.

So `events` gets a nullable `title`, stamped on `created` and `deleted`. It costs one column, makes history readable with no join at all, and leaves `reason` meaning one thing. `events` is append-only under forward-only migrations, so a later fix could not reconstruct titles for rows already written — which is why this is settled before migration 0002 is authored rather than after.

**Notes are the opposite case and cascade.** A note is fat content attached to a live task, not a record of an occurrence; without its task it is unreachable and unreadable. `notes.task_id` keeps `ON DELETE CASCADE`. The `note-added` event survives and its `ref` becomes dangling, exactly like `entity_id` — the event still truthfully says a note was added.

This is coherent, not a compromise: **history survives, content does not.** `delete` is documented for work that should never have existed — a typo, a duplicate, a misfile — and work that was real but abandoned belongs in `Cancelled`, which keeps everything.

## Consequences

- `katra log --all` remains a complete record of the store's life, including tasks that no longer exist.
- `entity_id` and `ref` are **historical references, not foreign keys**. Any read joining events to tasks must use an outer join and handle the miss; a reader that assumes the task exists is the bug this ADR predicts.
- The events table grows monotonically and nothing prunes it. Acceptable at katra's scale — a busy repo generates thousands of events, not millions — and a retention policy is a decision for whoever first has the problem, with snapshots (F6) the natural home.
- A test asserts the property directly: delete a task, then read its history back. Without it, someone adds the "missing" foreign key in good faith.

## Alternatives considered

**`ON DELETE CASCADE`, matching `deps`/`links`/`tags`.** Rejected: locally consistent, globally wrong. Those are attributes; an event is a record. Consistency with the wrong analogy is not a reason.

**`ON DELETE RESTRICT`.** Rejected: makes `delete` unreachable, since every task has a `created` event from the moment it exists. A constraint that removes a command is a redesign wearing a foreign key's clothes.

**Soft-delete the task instead — a `deleted_at` column.** Rejected: `Cancelled` already *is* katra's soft delete (ADR-003), and it keeps the task, its notes, its dependencies and its reason. Adding a second, weaker soft-delete beside it would leave two ways to not-quite-remove something and no clear rule for choosing. `delete` should stay a real delete.

**Copy the *whole* entity onto every event so history reads without any join.** Rejected. The `title` column above is the narrow version of this and earns its place: a deleted task's title is unrecoverable by any other means, and the two event types that need it are exactly the two where the row may be absent. Denormalising lane, priority, kind and assignee alongside it would make every event a snapshot, quadruple the table, and create four more fields that can disagree with the entity — for the convenience of reads that can simply join.
