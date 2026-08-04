---
"@itsacoyote/katra": minor
---

Add the core tracker: a SQLite store under the repo's shared git dir, tasks and epics with dependencies, and twelve commands over them.

Every worktree of a repo resolves to one store, so parallel sessions share a backlog. Tasks carry a hierarchy level and a Conventional-Commits kind, move through seven lanes, and depend on each other; readiness is computed from the dependency graph rather than stored.

Commands: `init`, `add`, `show`, `list`, `update`, `close`, `cancel`, `reopen`, `delete`, `dep`, `link`, `next`. Every read accepts `--json`, and every refusal names what would unblock it.
