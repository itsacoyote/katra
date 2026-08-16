# F7 traceability — external refs: storage + URL parsing

Acceptance criteria from epic `katra-9aw.58` (as amended in its comments: the numeric
remove form was dropped at plan review; `RefResult.action` gained `url-backfilled` and
`ref remove` gained the `provider:id` form at validate round 2) mapped to the tests that
prove them. "Falsifiable?" records whether the cited test was shown to fail against a
broken implementation — this branch's review history killed several coverage-green,
discrimination-false tests, so a ✅ here means a mutation was actually run, not that a
line executed.

| # | Criterion | Tests | Falsifiable? |
|---|---|---|---|
| 1 | GitHub PR URL stores `github` / `owner/repo#n` / canonical url; re-add exits 0, one row, one event total | `refs.test.ts` — "link stores one refs row + one task_refs row + one ref-linked event", "re-link returns already-linked, zero new rows/events"; `ref.test.ts` — "add with github PR URL prints canonical ref, exit 0", "re-add prints already linked, exit 0" | ✅ event-gate mutation (event on every call) fails the re-link test; canonical-form table in `refs-parse.test.ts` covers every URL variant yielding one identical `ParsedRef` |
| 2 | Bare linear id stores with null url, renders unlinked, `--json` carries `url: null` | `refs-parse.test.ts` bare-form round-trips; `ref.test.ts` — "linear bare id renders without hyperlink"; `brief.test.ts` — show/brief `--json` with null-url refs | ✅ url-derivation mutation breaks the round-trip table |
| 3 | Unknown URL refuses naming all three flags; explicit form stores arbitrary provider | `ref.test.ts` — "unknown URL refuses naming all three flags", "explicit-flag add stores arbitrary provider verbatim"; wrong-path-shape refusals in `refs-parse.test.ts` (the commit/board examples deliberately carry valid trailing parts so only the kind/literal checks can refuse them — QA caught the masking versions) | ✅ kind/literal checks neutralized → exactly those tests fail (run in-session, printed) |
| 4 | Shared row across tasks; unlink keeps the other holder; last unlink GCs the row (direct DB read) | `refs.test.ts` — "same ref on two tasks shares one row", "unlink from one keeps the other", "last unlink deletes the refs row"; `delete.test.ts` — sole-holder GC + two-holder survival through `deleteTask` | ✅ `NOT EXISTS` guard dropped → 4 tests fail; GC-removed mutation fails the sole-holder test |
| 5 | `log` shows `ref-linked`/`ref-unlinked` with actor and qualified id in the event ref field | `refs.test.ts` — actor/epic-id assertions on events; `ref.test.ts` — "log renders ref-linked/ref-unlinked rows through the existing path"; `f7-feature.test.ts` epic-scoped log | ✅ `epicIdFor` dropped → epic-log test fails (senior round verified) |
| 6 | Migration 0005 upgrades v4 in place; golden fixture byte-matches; suite green | `schema.test.ts` 0005 block — fixture byte-compare, v4-upgrade id/`prior_actor` preservation, index recreation, sentinel injection, live-store convergence (v4-upgraded vs fresh-v5 `sqlite_master` equality) | ✅ `prior_actor`/`id` dropped from the copy list → seeded tests fail (mutation-run); convergence test rebuilt after review to compare live stores, not same-process fixtures |
| 7 | Hostile inputs never crash the parser and never reach a terminal unsanitized | `refs-parse.test.ts` — fromCharCode corpus, splice/double-encode/dot-segment refusals, malformed percent-encoding, output bounds incl. astral 256/257; `ref.test.ts` — RLO oneLined in show/brief + verbatim `--json`, ambiguous-candidate stderr sanitization, NUL `--id` as typed refusal | ✅ output-sink `oneLine` reverted → candidate test fails (run twice in-session); astral boundary proven by `.length`-swap mutation; the security scans' 140k-case fixpoint fuzz backs the corpus |
| 8 | `--help`/contract cover the commands; counts updated | `feature.test.ts` — "registers all twenty-three commands on the program" + `--json`-everywhere sweep; `index.test.ts` — PublishedDocuments at 24 with `Ref`/`RefResult`, exact import-graph allowlist | ✅ the count test iterates the live Command tree; the allowlist is exact-match and fails on any missing path |

## Decisions that moved during the cycle (all recorded on the epic)

- **Numeric remove form dropped** (plan review): `refs.id` is a reusable rowid — never
  published, never CLI input. Remove takes url, qualified id, or `provider:id`.
- **`url-backfilled` action added** (validate round 2, M1): a url backfill mutates a row
  every holder shares, so it events like a fresh link and reports its own action instead
  of `already-linked`. Cross-task backfills event under the task the command named —
  the other holder's view change is traceable through the shared external id, not a
  phantom event on its timeline (documented + pinned).
- **`provider:id` remove form added** (validate round 2, M2): two refs sharing external
  id *and* url on one task were otherwise permanently unremovable. Precedence is
  url-match-first — an input exactly matching a stored url never splits on its colon
  (pinned).

## Known limits

- **Cached fields ship empty.** `cachedStatus`/`cachedTitle`/`syncedAt` are declared in
  full (house rule) but stay null until the provider cycles; nothing renders them yet,
  and when providers land they must route through `text()`/`timeAgoOrNull`.
- **The DDL CHECKs are NUL-truncatable** — SQLite's `length()` stops at the first NUL.
  The app-layer control screen in `parse.ts` is the real bound (probe-verified,
  documented in migration 0005's JSDoc). Raw-SQL writers bypass it; katra's trust model
  (AGENTS.md) already treats the store file as local and writable.
- **Zero-width characters ride through `oneLine`** — a `ENG-45<ZWSP>1` renders
  identically to `ENG-451` while being a distinct row. Pre-existing, house-wide
  (task titles share it), tracked as a scan INFO.
- **Commander echoes raw argv on unknown commands/options** (`katra-9aw.60`, LOW,
  pre-existing) — argv-sourced, not store-sourced; the F7 surfaces all sanitize.
- **Bare `owner/repo#n` derives an `/issues/n` url** — GitHub redirects issues→pull, so
  the link is always right, but the stored url for a PR added by bare id names
  `/issues/`.

## Validation

Full history in the validation summary on `katra-9aw.58`: senior branch review approved
at iteration 3 (1 MEDIUM + 4 LOW found and fixed); branch security scan no-CRITICAL/HIGH
with 2 MEDIUM + 2 LOW found, fixed, and probe-verified closed; QA closed at iteration 2
with all six filed gaps (.58.8–.12) pinned and mutation-proven; per-task reviews on all
seven tasks with fix rounds recorded in their close reasons. Final: 1256 tests / 73
files, typecheck/lint/format clean, dogfood evidence on the epic (live store at v5, the
real PR #13 ref kept on the migrated F5 epic task).
