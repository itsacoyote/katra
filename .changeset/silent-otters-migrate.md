---
"@itsacoyote/katra": minor
---

Add `katra migrate beads` — a one-shot converter from a beads (`bd export`) backlog into a katra store. Preview by default, `--apply` to write; refuses a store that already has tasks, so this is a one-shot import, not incremental sync. Every row keeps its real beads history instead of migration time: historical `created_at`/`updated_at`/`closed_at`, a `closed` event at the real close date carrying the close reason, and a `note-added` event at each note's own historical time, all inserted in true chronological order. Comments become notes carrying their original author; labels and the old beads id both arrive as tags (`beads:<id>`, queryable via `list --tag`); nothing that can't be represented is dropped without a name and a count in the report.

Built on new core `*Within` seams (`createTaskWithin`, `createNoteWithin`, `addDependencyWithin`, `addLinkWithin`, `applyMoveWithin`) that accept a caller-supplied historical timestamp instead of always stamping "now" — `loadMigration` is the first, and by design the only, bulk writer to use them.
