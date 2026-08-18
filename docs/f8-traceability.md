# F8 traceability — providers + refresh: live status for external refs

Acceptance criteria from epic `katra-9aw.61` mapped to the tests that prove them.
"Falsifiable?" records whether the cited test was shown to fail against a broken
implementation — a ✅ means a mutation was run, not that a line executed. This
cycle's QA round itself caught a coverage-green-but-shapeless gap (AC 2's literal
scenario missing while adjacent tests looked like they covered it), so the column
is earned, not decorative.

| # | Criterion | Tests | Falsifiable? |
|---|---|---|---|
| 1 | Real GitHub ref refreshes to status+title, `show` renders; second run `unchanged`, no event | `refresh.test.ts` — "stubbed gh merged fills caches, show renders", "second run unchanged, zero events"; dogfood (live, PR #13) | ✅ event-gate and diff mutations run at the repo layer; live evidence on the epic |
| 2 | A status transition emits exactly one `ref-status-changed` with old and new | `refs.test.ts` — "a real status transition (open -> merged) updates the cache and events exactly once"; `refresh.test.ts` — "a real transition (open -> merged across two runs)…" | ✅ the `&&`→`\|\|` diff-check mutation fails the repo test (QA-verified); the CLI test swaps genuine stub bodies |
| 3 | No `gh` + no key → exit 0, named reasons, nothing written (DB read) | `refresh.test.ts` — "gh absent → unresolved gh-not-available", "linear no-key → …, zero network", both with direct `readRefRow` null assertions | ✅ classification mutations at the `git.ts` layer; the DB-read proofs added at QA round 1 |
| 4 | Unknown provider → `no provider`, untouched, exit 0 | `refresh.test.ts` — "no-provider ref reports unresolved no-provider…" with DB read | ✅ registry `providerFor` pinned in `providers.test.ts` |
| 5 | Hostile ref fields reach `gh` as inert argv or refuse before spawn | `providers.test.ts` — skeleton-conforming hostile ids (`-R evil/repo#1`, `own;er/repo#1`, `$(id)` shapes, dot-segments) all `bad-shape` with zero spawns; `git.test.ts` — argv/PATH discipline | ✅ relaxing each pattern to its skeleton fails exactly the charset tests (run and printed); the branch security scan's 5-id probe confirmed zero spawns live |
| 6 | The Linear key goes in the request header and nowhere else | `providers.test.ts` — key-sentinel absent from every failure path's output; raw-key (no Bearer) header assertion; `git.test.ts` — `GH_ENV_ALLOWLIST` blocks `LINEAR_API_KEY` from the `gh` child | ✅ allowlist-removal mutation leaks all 10 sentinels (T2 security round); the cancel-rejection HIGH (key-to-stderr via cause chain) was found, fixed, and A/B process-proven |
| 7 | Migration 0006 upgrades v5 preserving events (ids, `prior_actor`); fixture byte-match; convergence | `schema.test.ts` 0006 block — full-row survival with every nullable column populated, sentinel injection, v5-upgraded vs fresh-v6 convergence | ✅ column-drop and ref/reason-swap mutations fail the full-row test (run live at T1's review) |
| 8 | `refresh --json` published; 24 commands | `feature.test.ts` — count/title/sweep with the refresh entry env-isolated; `index.test.ts` — PublishedDocuments 25 + exact allowlist | ✅ the sweep's isolated-env test fails under a `process.env` swap (T5 review, 5 tests) |
| 9 | Dogfood: PR #13 resolves `merged` live; a real Linear issue resolves with real status | Operational run 2026-08-17, evidence on the epic: PR #13 `none -> merged` with its real title via real `gh`; GRI-4 `none -> unstarted` ("Set up your teams", workspace grit-and-glam) with the key sourced at spawn time; idempotent re-run quiet; keyless run degrades with `LINEAR_API_KEY not set` while GitHub still resolves | one-time live run, not a regression guard — the stubbed CLI tests are the repeatable half |

## Decisions that moved during the cycle (recorded on the epic)

- **The reason vocabulary lives in `enums.ts`** (graph root) with per-token producer
  comments; the sentence renderings live with the command and are pinned verbatim.
- **The write phase is per-ref, not batched** (resolve one, write one): an interrupted
  run keeps completed work. No transaction ever spans an `await` — `writeTx` is
  synchronous by construction.
- **Event fan-out includes terminal-lane holders** (a Done task's log still records that
  its ref moved) while the *scoping* read is lane-filtered — deliberate, documented, and
  pinned from both directions.
- **The confused-deputy acceptance names the whole consequence**: refresh persists and
  renders attacker-chosen provider content, not just probes it (`katra-9aw.63` holds the
  `--all` design question).

## Known limits

- **Sequential resolution, no total budget** — ~340 ms/gh call, ~270 ms/Linear call,
  dedupe by unique ref; a large backlog takes minutes (accepted, risk note 12).
- **Cross-origin redirect protection for the key is runtime behavior** (undici strips
  `Authorization` cross-origin — probed) rather than pinned; `redirect: "error"` is the
  optional hardening if Linear's endpoint ever redirects.
- **`EINVAL` (Windows `.cmd` shim refusal) classifies as `gh-not-available`** — reasoned,
  not probed (no Windows host in the loop).
- **Orphaned grandchildren of a timed-out `gh`** are `gh`'s to clean up — SIGKILL reaches
  the direct child only (documented in `runGh`).

## Validation

Full history in the validation summary on `katra-9aw.61`: senior branch approval (1 LOW),
branch security no-CRITICAL/HIGH (1 MEDIUM doc-completion + 2 LOW, all fixed), QA
approved at iteration 2 with all gaps mutation-verified, per-task review rounds on all
seven tasks recorded in their close reasons, and the key-leak incident + rotation +
dispatch-rule adoption recorded. Final: 1384 tests / 76 files, clean checks, live
dogfood on the store at v6.
