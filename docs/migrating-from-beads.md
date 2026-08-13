# Migrating from beads to katra

How an existing [beads](https://github.com/steveyegge/beads) (`bd`) database converts into katra, what carries over, and — just as importantly — what doesn't.

> **Status: shipped.** `katra migrate beads` is a real command. The mapping below is verified against a real `bd export` (beads 1.0.4) and against this repository's own backlog — 146 issues migrated for real during F5's validation, spot-checked through `board`, `brief`, `list --tag`, `show`, and `log`. See [`f5-traceability.md`](f5-traceability.md) for the acceptance-criteria-to-test map.

## Approach

The converter is **extract → transform → load**, and strictly one-directional:

1. **Extract** — read `bd export` JSONL. Never touch beads' Dolt database directly.
2. **Transform** — map beads records onto katra's fixed enums, producing a normalized import document plus a **report of everything dropped or degraded**.
3. **Load** — write into a katra store via the library core, inside one transaction.

Two rules:

- **beads is never modified.** The converter only reads. Your beads database is untouched and remains a working fallback.
- **Nothing is dropped silently.** Anything that can't be represented is named in the report. A migration that quietly loses data is worse than one that refuses.

## What beads gives us

Verified field surface from `bd export` (fields marked ◦ appear only when populated):

```
id  title  description  status  priority  issue_type  owner  created_at
created_by  updated_at  dependencies[]  dependency_count  dependent_count
comment_count
◦ design  ◦ acceptance_criteria  ◦ notes  ◦ assignee  ◦ estimated_minutes
◦ closed_at  ◦ close_reason  ◦ external_ref  ◦ labels[]  ◦ comments[]
```

Dependency edge types: `blocks`, `parent-child`, `discovered-from`, `related`.

## Field mapping

| beads | katra | Notes |
| --- | --- | --- |
| `id` | new katra ID | beads IDs (`katra-9aw.15`) are hierarchical and prefix-scoped; katra mints its own. **The old ID is preserved as tag `beads:<id>`** on the task, so `katra list --tag beads:<id>` finds it by old id and history stays traceable. |
| `title` | `title` | Direct. Also parsed for a kind prefix — see below. |
| `description` | `description` | Direct. |
| `design` ◦ | note, kind `decision` | beads has a dedicated field; katra models it as a typed note (§6a). |
| `acceptance_criteria` ◦ | note, kind `acceptance` | Exact conceptual match — katra's `acceptance` note kind exists for this. |
| `notes` ◦ | note, kind `general` | Direct. |
| `comments[]` ◦ | notes, kind `general` | One note per comment, preserving `author` as the note's actor and `created_at`. A comment with no `author` (or a blank one) falls back to the identity running the migration, and is named in the report so nothing silently misattributes history. katra **declined comment threads** (§2), so threading flattens. |
| `status` | status lane | See status mapping. |
| `priority` | `priority` | Both use `0`–`4`, `0` highest. Direct. |
| `issue_type` | `level` **+** `kind` | Splits into two axes — see below. |
| `assignee` ◦ | `assignee` | Direct. |
| `owner` | — | **Dropped and reported.** katra's identity is the worktree (§6), not a person. |
| `estimated_minutes` ◦ | — | **Dropped by design, and reported.** §2 declined estimates and time tracking as human-manager instrumentation. |
| `created_at` / `updated_at` / `closed_at` | timestamps | **Kept as-is — this is real history, not migration time.** See "History is honest," below. |
| `close_reason` ◦ | close reason on the `closed` event | Carried verbatim onto the historical `closed` event (§5). |
| `external_ref` ◦ | — | **Report-only.** No storage target until katra's external refs ship (tracked internally as `katra-9aw.20`) — named in the report, never guessed at. See "External refs," below. |
| `labels[]` ◦ | `tags` | Direct. A blank label (empty after trimming) is dropped and reported rather than becoming an empty tag. |
| dep `blocks` | dependency | Direct — drives katra's `ready`/`blocked`, computed from the edge, not a lane. A `blocks` edge that would close a dependency cycle is detected and broken deterministically before it ever reaches the store; the dropped edge is named in the report. |
| dep `parent-child` | `parent` (epic hierarchy) | Direct, but katra is two levels only — see below. |
| dep `discovered-from`, `related` | link | katra's symmetric task↔task link (§4). |

## `issue_type` → `level` + `kind`

beads has one `type` field; katra deliberately splits hierarchy from work-type (§4a). Resolution order:

1. **Parse a Conventional Commit prefix from the title first.** katra's `kind` mirrors Conventional Commits, so a title like `feat: katra brief` yields `kind = feat` directly — more accurate than any type map, and free when the project already writes titles that way.
2. **Fall back to the `issue_type` map:**

| beads `issue_type` | `level` | `kind` |
| --- | --- | --- |
| `epic` | `epic` | `feat` |
| `milestone` | `epic` | `chore` |
| `feature`, `story` | `task` | `feat` |
| `bug` | `task` | `fix` |
| `chore` | `task` | `chore` |
| `decision` | `task` | `docs` (+ a `decision` note) |
| `spike` | `task` | `chore` |
| `task` | `task` | `chore` |

Both target enums are fixed sets — the converter never invents a value. An `issue_type` outside this table defaults to `task`/`chore` and is named in the report rather than refused.

## Status mapping

katra's lanes are `Defined → Researching → Planned → In Progress → In Review → Done`, plus the terminal `Cancelled`.

| beads | katra | Why |
| --- | --- | --- |
| `open` | `Defined` | Conservative. beads `open` means "available to work"; it carries no evidence the item was researched, so it enters at the first lane rather than being promoted to `Planned`. |
| `in_progress` | `In Progress` | Direct. |
| `blocked` | `Defined` + its dependency edges | **katra has no `blocked` lane** — blocked is *computed* from dependencies (§4). The edges carry the meaning; a lane would duplicate and desync it. |
| `deferred` | `Defined` + tag `deferred` | katra has no deferred lane. Tagging keeps the information without inventing an enum value. |
| `pinned` | `Defined` + tag `pinned` | Same reasoning. |
| `hooked` | `In Progress` | Closest equivalent. |
| `closed` | `Done` | Plus a `closed` event at the real historical `closed_at`, carrying `close_reason` — see below. |

beads has no analogue for `Researching`, `Planned`, or `In Review`, so nothing maps into them. That's expected — those lanes fill in as work proceeds in katra. An unrecognised status value defaults to `Defined` and is named in the report rather than refused.

## History is honest

A migrated row is not stamped with "now" — it keeps beads' own timeline, and the event stream tells the same true story a live katra project would have recorded, had it existed:

- Every item gets a `created` event at its real historical `created_at`, carrying the title (the same way a live `created` event does — the title outlives the row if it's later deleted).
- A closed item additionally gets a `closed` event at its real `closed_at`, carrying `close_reason`.
- Every migrated note — from `design`/`acceptance_criteria`/`notes`, or from a comment — gets a `note-added` event at *that note's own* historical time, not the issue's.
- Nothing else is fabricated: no lane transitions, no claims, no activity nobody witnessed.

The whole event set is inserted in one pass, in strict chronological order (time, then old beads id, then `created` before `note-added` before `closed` for anything tied) — not in row-insertion order, which is epics-first for a structural reason (a task's parent must exist before the row referencing it does) and has nothing to do with when things actually happened. `events.id` is katra's real total order, so `katra log` reads migrated history exactly as it occurred.

## External refs

beads' `external_ref` is **report-only** for now: it is named under the report's dropped-fields section when present, and nothing is written for it. katra's external-refs feature (many-to-many task↔issue links, per §4) hasn't shipped yet, and a bare `gh-9`-style string is ambiguous across repos without qualification — rather than guess at the right repo, the converter reports the value and leaves it for a human to attach once that feature lands.

## Hierarchy depth

katra is deliberately two levels: `epic` → `task` (§4a). If a beads database nests deeper via `parent-child` chains, the converter **flattens to two levels**: a task keeps its *nearest* ancestor that maps to `epic`, skipping over any intervening tasks, and reports every item it reparented that way.

Two situations leave an item with **no** katra parent at all, both reported under one category ("parent edges dropped"), since both mean the same thing — nothing in katra to attach the edge to:

- An **epic-to-epic** `parent-child` edge. An epic can never keep a beads parent (katra's schema enforces `parent_id IS NULL` for an epic), whatever level that parent itself maps to.
- A chain that **never reaches an epic** at all — every ancestor up to the top is a `task`, with no `epic`/`milestone` anywhere above it. Reachable in any beads project that never used those types.

A `parent-child` cycle (an issue chain that loops back on itself) is detected and broken the same way a live `katra dep` refusal would catch it, and reported — the item involved keeps no parent rather than the converter guessing which edge in the loop was "right."

## What does not carry over

Named up front so nobody discovers it mid-migration:

- **Estimates / time tracking** (`estimated_minutes`) — declined by design (§2).
- **`owner`** — katra keys identity to the worktree, not a person.
- **`external_ref`** — report-only until katra's external refs ship; see above.
- **Comment threading** — comments survive as notes; reply structure does not.
- **Dolt version history** — katra starts fresh. Its equivalent is the event stream going forward plus committed snapshots (§3), once that feature ships. Keep the beads database if you want the old history.
- **beads-specific machinery** — wisps, gates, merge-slots, molecules/swarms, agents, rigs, roles, memories, and federation have no katra equivalent and are skipped. `bd export` already excludes most of these by default.
- **IDs** — every item is renumbered. The old ID is preserved as a tag (see the field mapping table).

Every one of these is named in `katra migrate beads`'s report with counts and the affected ids — nothing above is a silent loss.

## Usage

```bash
# Preview: convert and print the report, write nothing. This is the default —
# there is no --dry-run flag, because there is nothing else to opt out of.
katra migrate beads

# Convert into the current repo's katra store. Requires an existing store —
# run `katra init` first if you haven't. Refuses a store that already has
# any task or epic, so this is a one-shot import, not incremental sync.
katra migrate beads --apply

# Drive it from a specific export instead of the default .beads/issues.jsonl.
bd export -o beads.jsonl
katra migrate beads --from beads.jsonl --apply
```

Consistent with the rest of katra: **preview by default, `--apply` to commit** (§7), and `--json` works on both. `--from` is capped at 32 MiB — comfortably beyond any real project's history, and a guard against reading an unbounded file into memory before the first byte is validated.

## Migration checklist

1. `bd export -o beads-backup.jsonl` — keep it, independent of the converter. Nothing here modifies beads, but a backup costs nothing.
2. `katra init`, if this repository has no katra store yet.
3. `katra migrate beads` and read the report. Nothing is written yet.
4. Resolve anything worth resolving — reparented items, dropped fields, unmapped values — the report names ids for all of them.
5. `katra migrate beads --apply`.
6. Spot-check with real commands: `katra board`, `katra brief <epic>`, `katra list --tag beads:<old-id>` for a specific item, `katra show <id>` for a closed task's historical dates.
7. Keep beads installed but unused until you trust katra. Nothing was modified, so falling back costs nothing.
