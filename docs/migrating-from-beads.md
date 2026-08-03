# Migrating from beads to katra

How an existing [beads](https://github.com/steveyegge/beads) (`bd`) database converts into katra, what carries over, and — just as importantly — what doesn't.

> **Status: designed, not built.** The mapping below is settled and verified against a real `bd export` (beads 1.0.4). The converter itself is blocked on katra's schema — see the tracked task in the backlog. katra will dogfood this converter on its own backlog, which is currently tracked in beads.

## Approach

The converter is **extract → transform → load**, and strictly one-directional:

1. **Extract** — read `bd export` JSONL. Never touch beads' Dolt database directly.
2. **Transform** — map beads records onto katra's fixed enums, producing a normalized import document plus a **report of everything dropped or degraded**.
3. **Load** — write into a katra store via the library core.

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
| `id` | new katra ID | beads IDs (`katra-9aw.15`) are hierarchical and prefix-scoped; katra mints its own. **The old ID is preserved on the task** so history stays traceable. |
| `title` | `title` | Direct. Also parsed for a kind prefix — see below. |
| `description` | `description` | Direct. |
| `design` ◦ | note, kind `decision` | beads has a dedicated field; katra models it as a typed note (§6a). |
| `acceptance_criteria` ◦ | note, kind `acceptance` | Exact conceptual match — katra's `acceptance` note kind exists for this. |
| `notes` ◦ | note, kind `general` | Direct. |
| `comments[]` ◦ | notes, kind `general` | One note per comment, preserving `author` and `created_at`. katra **declined comment threads** (§2), so threading flattens. |
| `status` | status lane | See status mapping. |
| `priority` | `priority` | Both use `0`–`4`, `0` highest. Direct. |
| `issue_type` | `level` **+** `kind` | Splits into two axes — see below. |
| `assignee` ◦ | `assignee` | Direct. |
| `owner` | — | **Dropped.** katra's identity is the worktree (§6), not a person. |
| `estimated_minutes` ◦ | — | **Dropped by design.** §2 declined estimates and time tracking as human-manager instrumentation. |
| `created_at` / `updated_at` | timestamps | Direct. |
| `closed_at` / `close_reason` ◦ | `closed` event + reason | Becomes a real event in the append-only stream (§5). |
| `external_ref` ◦ | `external_refs` | Needs **qualification** — see below. |
| `labels[]` ◦ | `tags` | Direct. |
| dep `blocks` | dependency | Direct — drives katra's `ready`/`blocked`. |
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

Both target enums are fixed sets — the converter never invents a value.

## Status mapping

katra's lanes are `Defined → Researching → Ready → In Progress → In Review → Done`.

| beads | katra | Why |
| --- | --- | --- |
| `open` | `Defined` | Conservative. beads `open` means "available to work"; it carries no evidence the item was researched, so it enters at the first lane rather than being promoted to `Ready`. |
| `in_progress` | `In Progress` | Direct. |
| `blocked` | `Defined` + its dependency edges | **katra has no `blocked` lane** — blocked is *computed* from dependencies (§4). The edges carry the meaning; a lane would duplicate and desync it. |
| `deferred` | `Defined` + tag `deferred` | katra has no deferred lane. Tagging keeps the information without inventing an enum value. |
| `pinned` | `Defined` + tag `pinned` | Same reasoning. |
| `hooked` | `In Progress` | Closest equivalent. |
| `closed` | `Done` | Direct, plus a `closed` event. |

beads has no analogue for `Researching` or `In Review`, so nothing maps into them. That's expected — those lanes fill in as work proceeds in katra.

## External refs need qualifying

beads stores `external_ref` as a **bare string** (`gh-9`, `jira-ABC`). katra requires **fully qualified** IDs (`owner/repo#9`, `ENG-451`) because a bare number is ambiguous across repos (§4).

The converter:

- Qualifies `gh-<n>` / `#<n>` using the repo's `origin` remote → `owner/repo#<n>`.
- Passes through anything already qualified.
- **Reports, and does not guess,** anything it can't confidently qualify — an unqualified ref is left in the report for a human to resolve rather than silently attached to the wrong repo.

Note that beads' single `external_ref` string is one-to-one, whereas katra's model is **many-to-many** (§4). Migration only ever widens, so this direction is lossless.

## Hierarchy depth

katra is deliberately two levels: `epic` → `task` (§4a). If a beads database nests deeper via `parent-child` chains, the converter **flattens to two levels**, reparents the deeper items onto their nearest ancestor epic, and reports every item it reparented. It does not invent a middle tier.

## What does not carry over

Named up front so nobody discovers it mid-migration:

- **Estimates / time tracking** (`estimated_minutes`) — declined by design (§2).
- **`owner`** — katra keys identity to the worktree, not a person.
- **Comment threading** — comments survive as notes; reply structure does not.
- **Dolt version history** — katra starts fresh. Its equivalent is the event stream going forward plus committed snapshots (§3). Keep the beads database if you want the old history.
- **beads-specific machinery** — wisps, gates, merge-slots, molecules/swarms, agents, rigs, roles, memories, and federation have no katra equivalent and are skipped. `bd export` already excludes most of these by default.
- **IDs** — every item is renumbered. The old ID is preserved for traceability.

## Planned usage

```bash
# Preview: convert and print the report, write nothing.
katra migrate beads --dry-run

# Convert into the current repo's katra store.
katra migrate beads --apply

# Or drive it from a specific export.
bd export -o beads.jsonl
katra migrate beads --from beads.jsonl --apply
```

Consistent with the rest of katra: **preview by default, `--apply` to commit** (§7), and `--json` on the report.

## Migration checklist

1. `bd export -o beads-backup.jsonl` — keep it, independent of the converter.
2. `katra migrate beads --dry-run` and read the report.
3. Resolve anything flagged as unqualified or reparented.
4. `katra migrate beads --apply`.
5. Spot-check with `katra brief <epic>` and `katra ready`.
6. Keep beads installed but unused until you trust katra. Nothing was modified, so falling back costs nothing.
