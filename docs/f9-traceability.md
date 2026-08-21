# F9 traceability — reconcile: policy-driven advancement from external state

Acceptance criteria from epic `katra-9aw.65` mapped to the tests that prove them.
"Falsifiable?" records whether the cited test was shown to fail against a broken
implementation — a ✅ means a mutation was run and its failing output printed,
not that a line executed.

| # | Criterion | Tests | Falsifiable? |
|---|---|---|---|
| 1 | Bare `reconcile` changes no task/event/claim/ref state; preview shows moves with refs and synced age | `f9-feature.test.ts` — "AC1: bare reconcile previews moves…changes no task, event, claim, or ref state" (targeted direct DB reads — no byte-compare, the presence heartbeat is the documented exception); `reconcile.test.ts` — "bare reconcile previews an advance and changes no task, event, claim, or ref state" | ✅ security round 2's independent probe re-verified purity across text and `--json` runs |
| 2 | `--apply` advances with exactly one attributed lane-change event; rerun is a zero-change no-op | `reconcile.test.ts` — "--apply closes the task with actor reconcile and the pinned reason wording", "a second --apply run is a zero-change zero-event no-op"; `f9-feature.test.ts` — "AC2: --apply advances with exactly one lane-change event and reruns quietly" | ✅ actor-hardcode and guard-drop mutations at the T1 seam (printed); QA re-verified the original bare-rerun scenario survived the LOW-1 behavior change |
| 3 | ALL rule: partial merge blocks with the blocking ref named; Done-vs-Cancelled conflicts flag and never apply | engine tests — "one merged and one open PR yields blocked-by-ref naming the open ref", "refs mapping to Done and Cancelled yield conflict naming both targets", "conflict wins over blocked-by-ref when both apply"; `f9-feature.test.ts` — "AC3: the ALL rule holds back a partial merge…" with a direct DB read proving the lane did NOT move under a real `--apply` | ✅ ALL→ANY loosening fails exactly the blocked tests; precedence 1↔2 swap fails the overlap test (both printed) |
| 4 | Foreign claim skips under `--apply`; never-refreshed ref prevents advancement; canceled Linear ref cancels; self-claim emits released+closed both `reconcile` | `reconcile.test.ts` — claim-skip, race-path rendering parity, self-claimed apply, canceled-cancels tests; engine — "a merged PR plus a never-refreshed ref yields blocked-by-ref"; `lifecycle.test.ts` — the real in-tx guard (foreign claim refuses inside the transaction, proven un-hoistable) | ✅ in-tx placement pin fails the guard-hoist mutation; null-as-mapped-absent mutation fails the never-refreshed test; QA's own spot mutations (comparison, skip-claimed scope) all caught |
| 5 | `--json` parity preview and apply; scoped live dogfood recorded | `reconcile.test.ts` — "--json mirrors the text verdicts for preview and apply"; `f9-feature.test.ts` — "AC5" with real advance-item assertions on the apply half; operational run 2026-08-20 on the epic: throwaway `kt-5nxigv` advanced Defined→Done via the cached PR #13 ref, event `actor: reconcile, reason: "merged — github:itsacoyote/katra#13"`, explicit-id only, cleanup verified, board net-unchanged | live half is a one-time recorded run; the stubbed CLI tests are the repeatable half |

## Decisions that moved during the cycle (recorded on the epic)

- **The actor override widens the shared seam, never forks it** — `transition`/`closeTask`/`cancelTask` take optional `{ actor, refuseIfClaimedElsewhere }`; the claim guard runs inside the write transaction, doubly pinned (a hook test on `inTransaction`, plus `describeLiveness(claim, now)` needing the in-tx `now`, which makes hoisting non-compiling).
- **"Unresolved" narrowed to `cached_status IS NULL`** — refresh writes nothing on a failed resolve, so degraded and fresh are indistinguishable in the cache; only never-refreshed is detectable. No staleness cutoff: the preview's synced age is the human's staleness signal (plan-review HIGH-4).
- **Explicitly-named ineligible ids report under `no-op`** instead of vanishing (senior LOW-1, mirroring `next.ts`'s empty-state doctrine).
- **The constructed reason string is bounded** — first 3 clauses + ", +M more" at construction, `clamp` at render (security round 2; the one place F9 builds a stored string from ref data).
- **The shared invisible-codepoint class widened** to soft hyphen/zero-width/word-joiner/BOM, member-by-member pinned; ZWJ emoji sequences decompose — documented as the accepted cost.

## Known limits

- **Stale-but-cached advances** — a ref whose provider has been failing for a week still advances on its last successful read; only never-refreshed blocks. Deliberate (see decision above), surfaced via synced age in the preview.
- **GitHub `closed` is unmapped** — the cached vocabulary cannot distinguish issue-closed-as-completed from PR-closed-without-merge; `katra-9aw.64` tracks the `state_reason` provider extension.
- **No user-facing policy configuration** — the engine takes the policy as data (tests inject non-default tables), but no config file/flag/table ships (ADR-016).
- **Escape-hatch casing duplicates** — `Owner/Repo#12` and `owner/repo#12` stored via the escape hatch are two refs to one real PR; both count in the ALL set (harmless: both resolve to the same status).

## Validation

Full history in the validation summary on `katra-9aw.65`: senior branch approval round 1
(5 LOW + 4 INFO, all fixed), independent security scan no-CRITICAL/HIGH/MEDIUM (1 LOW
fixed with printed mutation proof; prototype-pollution and byte-level hostile-render
probes run live), QA approved at round 2 (one gap — the widened sanitizer's missing
regression guard — fixed and independently mutation-verified by QA), design review
skipped (no frontend). The `security-sensitive` task (T4) was scanned twice: per-task
(1 MEDIUM found and fixed) and at branch level. Final: 1442 tests / 79 files, clean
checks, live dogfood on the store at v6 — no schema change this cycle.
