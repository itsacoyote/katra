# beads-full.jsonl — the audit map

`beads-full.jsonl` is a synthetic `bd export` for F5 (`katra-9aw.49`, T8,
`katra-9aw.49.8`): one planted record per `MigrationReport` category
(`src/core/beads/types.ts`), plus every branch this repository's own real
`.beads/issues.jsonl` does not exercise (all seven beads statuses, both link
edge types, every optional field, several hostile shapes). JSONL has no
comments, so this file is the fixture's legibility — every row below names
the record(s), the category or branch it proves, the exact count the
pipeline produces today, and the `test/cli/f5-feature.test.ts` assertion that
depends on it.

Every count in this document was read off a real run of `extractBeadsExport`
+ `planMigration` against this exact file, not hand-derived — see "Ground
truth", below, if the fixture ever changes and the numbers need re-checking.

Record ids are prefixed `bf-` (beads-full) except where the id itself is the
point (`__proto__`) or an id beads owns (a comment's own `id`).

## MigrationReport categories (21), each at its exact planted count

| # | Category | Planted by | Count | Proven in f5-feature.test.ts |
|---|---|---|---|---|
| 1 | `droppedFields.owner` | `bf-kitchen-sink` (`owner: "alice-owner"`) | 1 | "previews the full-coverage fixture…" |
| 2 | `droppedFields.createdBy` | `bf-kitchen-sink` (`created_by: "bob-creator"`) | 1 | same |
| 3 | `droppedFields.estimatedMinutes` | `bf-kitchen-sink` (`estimated_minutes: 45`) | 1 | same |
| 4 | `droppedFields.externalRef` | `bf-kitchen-sink` (`external_ref: "EXT-4471"`) | 1 | same |
| 5 | `droppedFields.startedAt` | `bf-kitchen-sink` (`started_at` set) | 1 | same |
| 6 | `droppedFields.commentAuthor` | `bf-comments-edge`'s comment `cec-noauth` (no `author` key at all) | 1 | same, plus "finds migrated items by their beads:\<oldId\> tag" indirectly exercises the same record |
| 7 | `reparented` | `bf-flatten-leaf` — two hops below `bf-flatten-epic` via `bf-flatten-mid` | 1 | same |
| 8 | `epicEdgesDropped` | `bf-mid-epic` (`issue_type: "milestone"`, katra level `epic`) → `bf-top-epic`, a `parent-child` edge between two epic-level issues | 1 | same |
| 9 | `commentsConverted` | `bf-kitchen-sink`'s `kitchen-c1`, `bf-comments-edge`'s `cec-noauth`, `bf-order-q`'s `order-c1` — `cec-blank` (blank body) does **not** count | 3 | same |
| 10 | `unmappedStatuses` | `bf-status-ctor` (`status: "constructor"` — a string, but not an own key of `STATUS_MAP`; proves `mapStatus`'s `Object.hasOwn` guard) | 1 | same |
| 11 | `unmappedTypes` | `bf-unmapped-type` (`issue_type: "gizmo"`) | 1 | same |
| 12 | `skippedRecords` | `bf-wisp-1` (`_type: "wisp"`, beads machinery with no katra equivalent) | `count: 1`, `byType: [{type:"wisp",count:1}]`, `truncated: false` | same |
| 13 | `danglingEdges` | `bf-dangling-source` → `bf-ghost-nonexistent` (`blocks`; the target is never its own record) | 1 | same |
| 14 | `duplicateEdges` | `bf-self-edge` (self-edge: `issue_id === depends_on_id`) + `bf-dup-edge-a`'s second identical `related` edge to `bf-dup-edge-b` | 2 | same |
| 15 | `parentCycles` | `bf-cycle-a` ↔ `bf-cycle-b`, a 2-node `parent-child` cycle — each side's own ancestry walk discovers it independently, so it reports once per side | 2 | same |
| 16 | `blocksCycles` | `bf-bc-a` → `bf-bc-b` → `bf-bc-c` → `bf-bc-a` (`blocks`); sorted by `(issue_id, depends_on_id)`, `bf-bc-c → bf-bc-a` is the edge that would close the loop and is the one dropped | 1 | same |
| 17 | `invalidTimestamps` | `bf-bad-timestamp` (`created_at: "not-a-real-date"`) — see "The invalidTimestamps count", below | 1 | same |
| 18 | `invalidItems` | `bf-empty-title` (title is `"   "`, empty after trim); `bf-dup-id`'s second occurrence (same id planted twice — first occurrence wins, deterministically, by input order); `bf-status-nonstring` (`status: 42`, a number — fails the shape gate before `mapStatus` ever runs) | 3 | same |
| 19 | `invalidNotes` | `bf-comments-edge`'s `cec-blank` (comment `text` is `"   "`, blank after trim) | 1 | same |
| 20 | `clampedValues` | `bf-bad-priority` (`priority: 99`, clamped to `4`) | 1 | same |
| 21 | `emptyLabels` | `bf-blank-label` (`labels: ["ok-label", "   "]"` — the blank one is dropped, `"ok-label"` survives as a tag) | 1 | same |

**Successful migration totals** (also asserted in the same test): 40 issue
records − 3 `invalidItems` = **37** planned items (`report.idMap` length),
**3** epics (`bf-top-epic`, `bf-mid-epic`, `bf-flatten-epic`) and **34**
tasks (`report.imported.byLevel`).

## Branch coverage the real corpus does not exercise

Not `MigrationReport` categories on their own — these are mapping/graph
*branches*, proven either by feeding into the categories above or by their
post-apply behavior through real commands.

| Branch | Planted by | Proven by |
|---|---|---|
| All seven beads statuses | `bf-in-progress` (in_progress), `bf-blocked-status` (blocked), `bf-deferred` (deferred), `bf-pinned` (pinned), `bf-hooked` (hooked), `bf-closed-prereq` (closed), everything else defaults to open | "computes blocked-ness…" (blocked/in_progress), "shows a migrated closed task…" (closed); the rest map cleanly and surface only in `imported`/`idMap` totals |
| `discovered-from` **and** `related` link edges | `bf-dup-edge-a` → `bf-dup-edge-b` (`related`, first occurrence) and → `bf-discovered-target` (`discovered-from`) | Both become `PlannedEdge{kind:"link"}` rows; not asserted individually via `show`'s `links` field in the e2e (out of this task's named tests) but exercised by every preview/apply run, and unit-tested at `beads-transform.test.ts` |
| `design`/`acceptance_criteria`/`notes`/`comments` all populated on one record | `bf-kitchen-sink` (all four, plus a `feat(scope):` prefix, plus every dropped field) | "previews the full-coverage fixture…" via `droppedFields`/`commentsConverted`; the notes themselves are unit-tested in `beads-mapping.test.ts` |
| `feat(scope):` title prefix winning over a conflicting `issue_type` | `bf-kitchen-sink` — `issue_type: "bug"` (would map to kind `fix`) but titled `"feat(migration): …"` (kind `feat` wins) | Not asserted directly in the e2e (the prefix-precedence rule itself is `beads-mapping.test.ts`'s job); the fixture proves the full pipeline does not choke on the conflict |
| `decision:`-titled, task-typed conflict (the `decision`-is-a-`NoteKind`-not-a-`Kind` trap) | `bf-decision-conflict` (`issue_type: "task"`, title `"decision: use SQLite over Postgres for the store"`) | Same as above — the trap itself is `beads-mapping.test.ts`'s "TRAP" test; this fixture proves it does not derail a real migration |
| Prototype-key **id** | `__proto__` — a real, otherwise ordinary issue whose beads id is literally `"__proto__"` | "finds migrated items by their beads:\<oldId\> tag" (`list --tag beads:__proto__`) — the tag `beads:__proto__` round-trips as ordinary text through a `Map`-keyed pipeline and a real SQL `tags` row |
| 3-deep parent chain whose middle is an epic (the direct-parent-already-an-epic case `resolveAncestry` must *not* flag as reparenting) | `bf-bottom-task` — a task whose direct `parent-child` parent is `bf-mid-epic`, itself epic-level via `issue_type: "milestone"` | Not asserted by its own dedicated command call; the rest map cleanly the same way the seven-statuses row above does — a wrongly-reparented or dropped `bf-bottom-task` would corrupt the aggregate totals ("previews the full-coverage fixture…"'s `idMap` length of 37 and `imported.byLevel.task` of 34), and `resolveAncestry`'s one-hop-is-not-reparenting branch is unit-tested directly in `beads-transform.test.ts` |
| Prototype-key **status** | `bf-status-ctor` (`status: "constructor"`) | `unmappedStatuses` (#10 above) |
| Control character + bidi override in a title | `bf-hostile-title` — `[31m……‮…` (ESC, BEL, RIGHT-TO-LEFT OVERRIDE), written as literal `\u` escape text in this file so the committed fixture stays plain ASCII; the real characters exist only after `JSON.parse` | "renders hostile titles harmlessly…" — storage is raw (idMap resolves it like any other item), and `show` after apply renders it with the hostile bytes stripped |
| Non-string status value | `bf-status-nonstring` (`status: 42`) | `invalidItems` (#18 above) — fails `hasValidShape`, never reaches `mapStatus` |
| Duplicate old id | `bf-dup-id` planted twice, second occurrence with a different title | `invalidItems` (#18) — first occurrence wins deterministically; a real command (`show`) on the resolved id proves it is the *first* occurrence's title that survived |
| Directionally asymmetric `blocks` edge (open task blocked by an already-closed prerequisite) | `bf-open-dependent` (open) → `bf-closed-prereq` (closed), mirroring a real finished dependency | "computes blocked-ness of a migrated blocked item from its edges, not a lane" — `bf-open-dependent` is *ready* despite carrying a real dependency edge, and `show` reports zero blockers; a flipped edge direction fails this loudly (see "Falsifiability", below) |
| Cross-item chronological event interleaving | `bf-order-q` (created 2024-01-01, commented 2024-01-15), `bf-order-r` (created 2024-01-05), `bf-order-p` (created 2024-01-10) | "interleaves created, note-added and closed events chronologically across items in log" — `q`'s own history is not contiguous in the log (its `created` event sorts before `r`'s and `p`'s, its `note-added` event sorts after both) |

## The `invalidTimestamps` count

`bf-bad-timestamp` plants exactly **one** bad value (`created_at:
"not-a-real-date"`) and reports exactly **one** `invalidTimestamps` entry.
Historically this read as 2: `assembleNotes` (`mapping.ts`) independently
re-normalized the same raw `created_at` that `mapIssue` (`transform.ts`)
had already normalized, so one bad value reported twice. katra-9aw.49.10
fixed it — the normalized value is threaded into `assembleNotes`, and
`test/core/beads-transform.test.ts` pins the exactly-once behavior by name.
`bf-bad-timestamp` gives `updated_at` a clean, distinct value specifically
so this record's degradation story stays "created_at is unparseable" rather
than also pulling in an unrelated second entry.

## Ground truth

The counts above were read directly off a real pipeline run, not
hand-derived, using:

```sh
npx tsx -e '
import { readFileSync } from "node:fs";
import { extractBeadsExport } from "./src/core/beads/extract.ts";
import { planMigration } from "./src/core/beads/transform.ts";
const text = readFileSync("./test/fixtures/beads-full.jsonl", "utf8");
const extract = extractBeadsExport(text);
const { report } = planMigration(extract, "migrator@fixture-check", "1970-01-01T00:00:00.000Z");
console.log(JSON.stringify(report, null, 2));
'
```

Re-run this whenever the fixture changes, and update the table above to
match — `test/cli/f5-feature.test.ts` asserts these exact numbers, so a
drift here means the test and the fixture disagree, not that either is
wrong on its own.

## Falsifiability

Five targeted mutations were run against this fixture and against
`test/cli/f5-feature.test.ts` while writing it, each reverted afterward,
confirming the suite is actually coupled to the fixture's contents and to
the pipeline's real behavior rather than passing by construction:

1. **Removed `bf-blank-label`** → `report.emptyLabels.count` dropped from 1
   to 0; the exact-count assertion failed.
2. **Changed `bf-bad-priority`'s `priority` from 99 to 2** (in range) →
   `report.clampedValues.count` dropped from 1 to 0; the assertion failed.
3. **Moved `bf-order-r`'s `created_at` from 2024-01-05 to 2024-01-20**
   (after `bf-order-p`'s 2024-01-10 and `bf-order-q`'s comment at
   2024-01-15) → the real, committed event stream reordered and the
   chronological-interleave assertion failed on the resulting sequence
   mismatch.
4. **Flipped the dependency edge direction in `src/core/beads/transform.ts`**
   (swapped `taskOldId`/`dependsOnOldId` when building `PlannedEdge`s) →
   `bf-blocked-status`'s new id stopped appearing in `list --blocked`'s
   output; the "computes blocked-ness… not a lane" assertion failed. This
   mutation targeted production code, not the fixture, to prove the test is
   coupled to the pipeline's actual direction handling and not merely to
   the JSON file.
5. **Renamed the skipped record's `_type` from `"wisp"` to `"gate"`** →
   `report.skippedRecords.byType` no longer matched the planted `"wisp"`
   entry; the assertion failed.
