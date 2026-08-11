---
"@itsacoyote/katra": minor
---

Add `katra claim` and `katra release` — cross-worktree coordination.

`katra claim <id>` records that this worktree is working a task; a second worktree attempting the same task is refused (exit 3), naming the current holder and how recently they were seen. Re-claiming from the same worktree is a quiet no-op, which is what lets a session resume its own claim after `/clear`, a crash, or a restart rather than starting over. `katra release <id>` gives a claim back; a non-holder needs `--force`, and the event records who was displaced. `close` and `cancel` release a claim automatically, in the same transaction as the lifecycle change — the events land together or not at all. Claiming an epic, or a task already `Done`/`Cancelled`, is refused with a reason.

`next` and `board` steer around a claim without moving it between the board's five counts ([ADR-012](docs/decisions/ADR-012-claims-steer-not-move.md)): `next` never offers a task another worktree holds, and ranks the caller's own still-`Planned` claim first among candidates; the board's ready section lists other-worktree-claimed rows last, each marked with the holder and how long since they were last seen. `brief`, `show` and `board` all carry the claim in their text and `--json` output.

Presence backs the liveness in that marker. Every command now bumps a per-worktree `last_seen` at entry — reads included ([ADR-011](docs/decisions/ADR-011-every-call-heartbeats.md)) — so a session that only reads still shows as alive. The bump writes no event, never fails the command it rides along with, and skips itself entirely while the row is still fresh (30 seconds), so the cost is one single-row write at most and usually none.

Migration `0003` adds the `claims` and `presence` tables and extends the event-type constraint with `claimed`/`released`. An existing store upgrades in place, keeping its tasks, events and notes.
