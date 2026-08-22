# F10 traceability — snapshot and restore: the store outlives the machine

Acceptance criteria from epic `katra-9aw.67` mapped to the tests that prove them.
"Falsifiable?" records whether the cited test was shown to fail against a broken
implementation — a ✅ means a mutation was run and its failing output printed,
not that a line executed.

| # | Criterion | Tests | Falsifiable? |
|---|---|---|---|
| 1 | Snapshot writes the pinned header + every table, canonical order; an unchanged store snapshots byte-identically | `f10-feature.test.ts` — "AC1: …byte-identical output for an unchanged store" (ages presence past the freshness window so the second run's heartbeat genuinely fires); `snapshot.test.ts` — pinned-header, byte-identity, canonical-order, temp+rename | ✅ field-order swap and dropped-`ORDER BY` mutations printed at T1/T2; the aged-presence mutation (presence temporarily restored to the table list) printed a presence-line diff |
| 2 | Round-trip fidelity: snapshot → restore (empty target) matches the source byte-for-byte incl. event ids/`prior_actor`, claims, hostile bytes | `f10-feature.test.ts` — "AC2: …round-trips every table including hostile bytes" (all 9 tables' counts + a byte-exact hostile title); `snapshot.test.ts` — "restores…byte-faithfully" (full `rowToLine` re-serialization vs the source lines) | ✅ a seam-routed / fresh-id-minting mutation fails the byte-fidelity test on ids (printed at T3); a senior branch-review probe re-confirmed byte-identity across all nine tables independently |
| 3 | Preview writes nothing; `--apply` refuses a non-empty store without `--force`; `.bak` survives a forced swap | `f10-feature.test.ts` — "AC3: …" (targeted table reads for purity, `EXIT.conflict` for the guard, `after == sourceCounts && != before` for the swap); `snapshot.test.ts` — preview purity, events-only guard, forced swap, first-rename-leak, dangling-symlink | ✅ narrowing the emptiness guard to tasks-only fails the events-only-survivor test (the `.52` gap made reachable, printed); the AC3 swap assertion fails a no-op-swap mutation |
| 4 | A v5-schema snapshot restores on current katra and converges with an ordinarily-migrated store | `f10-feature.test.ts` — "AC4: …the committed v5 snapshot fixture restores and converges" (full `sqlite_master` equality vs a fresh-init store + a nonzero-count assertion over all nine tables); `test/fixtures/snapshot-v5.jsonl` (generated at schema v5, all nine serialized tables) | ✅ the nonzero-per-table loop fails if the fixture ever dropped a table; the fixture is generated at v5 (not a v6 file relabeled), so a genuine v5→current migration is exercised |
| 5 | `--json` parity for snapshot and restore; live dogfood recorded | `f10-feature.test.ts` — "AC5: --json and text outputs agree…" (each command's text stdout compared against its JSON document's values); `snapshot.test.ts` — the T2/T4 `--json mirrors text` tests; operational run 2026-08-22 on the epic | ✅ efficiency review caught AC5's original well-formedness-only check and AC3's board-exit-only check as vacuous — both rewritten to genuine cross-mode / before-after comparisons, verified non-vacuous |

## Decisions that moved during the cycle (recorded on the epic)

- **Presence excluded from snapshots (amends decision `.4`).** The original "everything, no
  exceptions" fell to a proven conflict: the presence heartbeat rewrites `last_seen` on every
  store open past its 30s window, so a snapshot carrying presence is never byte-identical across
  real runs and commits every worktree's absolute path. Presence is derived telemetry `openStore`
  repopulates after a restore; nothing recoverable is lost. Claims stay (stable coordination state).
  ADR-017 records the amendment.
- **Restore bypasses the write seams (ADR-018).** Byte-faithful fidelity needs the exact stored
  ids/events, which the domain seams can't give (they mint fresh ids by design). Restore uses raw
  explicit-column parameterized inserts — the migration-rebuild shape — fenced to `restore.ts`, a
  second sanctioned seam-bypass after migration rebuilds.
- **The swap sequence and its residual crash window are explicit.** Build+validate the temp file
  fully, checkpoint(TRUNCATE)+close both the temp and live connections, clear stale sidecars
  (live and old `.bak`), rename live→`.bak`, rename temp→live. A crash between the two final
  renames leaves the data safe in `.bak` — a named, accepted residual.
- **A non-scalar bind value is refused as corruption.** better-sqlite3 splices an array argument
  into the bind list, so a count-balanced array would silently shift every later column; the
  `bindable` scalar guard refuses it before `stmt.run`.
- **`.katra/snapshot.jsonl` is the sanctioned tracked-file exception** — the first katra-written
  path outside `.git/`, written only on explicit `snapshot` invocation.

## Known limits

- **Single `.bak`** — each restore overwrites the previous backup; a second restore in a row
  loses the first's pre-restore state. Surfaced in the command's own wording.
- **Concurrent forced restore** — another worktree's open connection during a `--force` swap keeps
  writing to the displaced inode (POSIX) or can fail the rename (win32); `--force` is the operator
  accepting that race, and the preview surfaces other worktrees' presence so the acceptance is
  informed. A busy WAL checkpoint refuses rather than leaving a possibly-incomplete `.bak`.
- **Whole-file validation is in-memory** — ~3.8× the file size in live objects at the 256 MiB
  cap; a streaming parser is the fix if that ceiling ever binds, not a smaller constant.
- **GitHub `closed`-style vocabulary growth** is out of scope; snapshots carry whatever the schema
  holds.

## Validation

Full history in the validation summary on `katra-9aw.67`: senior branch approval round 1
(1 LOW + 1 INFO, both fixed; an independent round-trip probe as a third fidelity witness),
independent security scan CLEAN (no CRITICAL/HIGH/MEDIUM/LOW; the untrusted-file → raw-insert
→ swap path re-probed live), QA approved at round 2 (two gaps — both correct-code-no-test:
`orderTasksForInsert`'s parent-before-child reorder and `checkpointOrThrow`'s busy refusal —
fixed and independently mutation-verified), design review skipped (no frontend). Both
`security-sensitive` tasks (T3, T4) were scanned per-task and at branch level. Final:
1486 tests / 82 files, clean checks, live dogfood on the real store (954 rows, byte-identical
board/brief real-vs-clone, real store never restored into). No schema change this cycle.
