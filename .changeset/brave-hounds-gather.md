---
"@itsacoyote/katra": minor
---

Add `katra brief` and `katra board` — the two reads that restore context.

`katra brief <id>` assembles in one call what a session needs to resume one task or epic: its state, its blockers, the latest `handoff` note **in full**, counts of the notes it did not show, and recent activity. That last part is the difference from `show`, which prints note previews — a handoff is written to be read whole, and a truncated one is worse than an absent one because a reader acts on it. `--full` lifts the caps. On an epic the blockers section becomes its children grouped by lane, capped per lane so a wall of finished work cannot hide the three tasks that are left.

`katra board` answers the other question: where does the repository stand? A counts header over four sections — in flight, ready, blocked, and what just moved. Actionable first, activity last. It takes no filters and never will; `list` and `log` are where narrow questions go. `--limit` bounds the sections and never the counts, so a capped section says `showing 2 of 14` rather than quietly understating the backlog. `--digest` puts the store's newest handoff above everything, which is what a session opening in a fresh worktree wants first.

The counts partition `open` five ways, not four. `in flight` takes two lanes, `ready` takes startable planned work, `blocked` takes what cannot start — and startable `Defined`/`Researching` tasks fall through all three. Since `add` writes into `Defined`, that residue is the largest group on a young store, so `untriaged` is the fifth count and the board says where the work is when nothing else is moving.

Attribution reads **last touch** throughout. katra has no concept of ownership until claims land, and a column headed `owner` would assert one that does not exist.

Neither command writes anything, and both read inside one deferred transaction, so the counts cannot describe a different snapshot from the rows beneath them.
