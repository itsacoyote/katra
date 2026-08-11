/**
 * The shape a claim hands back.
 *
 * Like `notes/types.ts`, this **is** part of the `--json` contract: it is
 * published through `contract.ts` (T8) onto `TaskView`, the brief task arm
 * and `BoardTask`, so this module must never import `store.ts`, `db/*`, or use
 * `NodeJS.*`/`Buffer` types — the same rule `test/index.test.ts` walks the
 * published graph to enforce, and the same reason `notes/types.ts` stays
 * clean of them today.
 */

/**
 * Who holds a task, and how fresh that holder looks right now.
 *
 * `holder` is the absolute worktree path (ADR-007) — identity that survives a
 * branch rename, unlike `actor`. `actor` is the branch-and-path string frozen
 * **at claim time**; a worktree renamed after claiming keeps showing the name
 * it claimed under, which is deliberate (see `claims/repo.ts`'s module docs).
 *
 * `branch` and `lastSeen` are read live off `presence`, joined on `holder`,
 * so they track the holder's current heartbeat rather than its claim-time
 * state. Both are `null` when the holder has no presence row — and that is
 * reachable by a real, non-seeded claim, not just a malformed one:
 * `bumpPresence` is deliberately non-fatal, so a session whose very first
 * heartbeat failed, or one that crashed before finishing its first
 * `openStore`, leaves exactly this shape. `claims/repo.ts` renders that
 * state as "never seen" in a conflict rather than inventing a last-seen age
 * from `claimedAt` — the crashed-session case is precisely where a
 * fabricated liveness observation would be most misleading.
 */
export interface ClaimInfo {
  readonly holder: string;
  readonly actor: string;
  readonly claimedAt: string;
  readonly branch: string | null;
  readonly lastSeen: string | null;
}
