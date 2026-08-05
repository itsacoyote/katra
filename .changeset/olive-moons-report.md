---
"@itsacoyote/katra": minor
---

**Breaking:** `katra update --json` now returns `{ "tasks": [...] }` rather than a bare task detail. Read `.tasks[0]` where you read the document itself before; nothing inside the entry moved.

`update` takes several ids now, applied in one transaction — all of them or none. The envelope keeps the document one shape whatever the count, so a script passing a variable-length list cannot get a different structure back depending on how many ids it happened to contain. Human output still adapts: one task prints in full, several print a line each.

`show` gains `blockers` and `blocking` — unfinished dependencies and the tasks waiting on this one. Additive, and it also appears in `update`'s entries. `show` was the only view that never mentioned dependencies, so a blocked task rendered identically to a startable one in the command used to decide whether to start it. `blockers` is the same set `next` reports, so the two commands cannot disagree.

`list` gains `--limit`, unbounded by default.

`list --ready` and `--blocked` now mean *startable*: both exclude epics and finished work, because an epic has no dependencies of its own and neither does a `Done` task — so "what can I start?" was answered with containers and completed work. An explicit `--level` or `--lane` still asks the literal question.

`next` gains `untriaged` on its empty result, separating the three answers that hid behind "nothing to do": everything planned is blocked, nothing has been triaged yet, or there is no work left. The message now names how much is waiting and the command that plans it.

`katra log` reports when its bound cut the history short, rather than ending mid-story with no marker.
