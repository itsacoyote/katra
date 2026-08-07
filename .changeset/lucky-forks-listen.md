---
"@itsacoyote/katra": patch
---

`katra next` no longer offers an epic as the task to work on.

Its candidate query had no level guard — only the untriaged count did — so a `Planned` epic at a lower priority number outranked every task behind it and `next` answered with a container nobody can pick up. The blocked branch had the same gap and listed blocked epics as work waiting to start.

Both now exclude epics, and an explicit `--level epic` still asks the literal question.
