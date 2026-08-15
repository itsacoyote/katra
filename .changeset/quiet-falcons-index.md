---
"@itsacoyote/katra": minor
---

Add `search`, `recent` and `stale` — full-text search over task titles, descriptions and note bodies (SQLite's built-in FTS5, kept in sync by triggers on every write, migration 0004), plus structured filters (`--lane`/`--kind`/`--level`/`--epic`/`--tag`/`--updated-before`/`--updated-after`) usable with or without query text, and a partial-id shortcut that ranks above text matches. `recent` reads the same activity ordering back newest-first; `stale` inverts it — open items untouched since before a window, `--older-than 2w` by default. Both accept relative durations (`2w`, `3d`, `12h`, `30m`) or an absolute timestamp through a new shared time parser, also driving `--updated-before`/`--updated-after`. Existing stores get the index for free the moment they open at the new schema version — no manual step.
