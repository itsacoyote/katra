# katra

> **Status: pre-alpha.** The core tracker works — tasks, epics, dependencies, an append-only event stream, typed notes, and sixteen commands over them, including `brief` and `board` for restoring context at the start of a session. Coordination, search, and external refs are still to come. See [`docs/katra-spec.md`](docs/katra-spec.md) for the full design.

**katra** is a local, git-native, **agent-first** project manager and coordination layer for AI coding sessions working in a single repo across multiple git worktrees.

Named for the Vulcan *katra* — stored consciousness that can be carried and later restored. That is the whole idea: context that survives the end of a session.

## The problem

An AI coding session starts cold every time. It doesn't know what the last session did, what was decided and why, or what another session in a sibling worktree is touching right now. Existing trackers are built for humans reading a web UI, and the ones that aren't tend to commit their database into the repo, where it turns into merge conflicts.

## The idea

- **Agent-first.** In the ideal case a human never touches katra directly — they get information *through* the agent. Every read has a `--json` mode, and `katra brief <task>` assembles a whole working context in one call.
- **Git-native, zero-ceremony.** One SQLite database under your repo's shared git dir. Every worktree resolves to the same store. It is gitignored by construction, so there is no binary merge conflict to have.
- **Daemon-free.** No server, no port, no background process. It's a file and a CLI.
- **External refs are augmentation, never a requirement.** katra links to GitHub issues/PRs (Linear and Jira later) through pluggable providers, and it **only ever reads them**. With no provider installed and no network, every core feature still works.

## What works today

```console
$ katra init
Created katra store at /your/repo/.git/katra/katra.db

$ epic=$(katra add "core tracker foundation" --level epic)
$ a=$(katra add "storage layer" --lane Planned --priority 0 --parent $epic)
$ b=$(katra add "task CRUD"     --lane Planned --priority 1 --parent $epic)
$ katra dep $b --blocked-by $a

$ katra next
kt-x93qjo  P0  storage layer
  lane      Planned
  blockers  none
  epic      kt-34vt8g  core tracker foundation

$ katra close $a --reason "shipped"
kt-x93qjo is now Done
  reason  shipped
  unblocked 1:
    kt-s3l2m4  task CRUD
```

Every write is recorded, so the next session can read what the last one did:

```console
$ katra update $b --lane "In Progress"

$ katra note add $b --kind handoff --body-file - <<'EOF'
Storage layer is done. CRUD is scaffolded but the update path
still needs the reparenting case.
EOF

$ katra log $b
2026-08-05 17:31  note-added      kt-s3l2m4  task CRUD  nt-rxqzhj
2026-08-05 17:31  status-changed  kt-s3l2m4  task CRUD  Planned -> In Progress
2026-08-05 17:31  created         kt-s3l2m4  task CRUD
```

`katra show` puts the same thing beside the task, both sections capped so a
summary stays a summary:

```console
$ katra show $b
kt-s3l2m4  task CRUD
  lane        In Progress
  epic        kt-34vt8g  core tracker foundation
  blockers    none

notes (1, newest first — `katra note list` for bodies)
  nt-rxqzhj  handoff     2026-08-05 17:31  Storage layer is done. CRUD is scaffolded but the updat…

activity (newest first — `katra log` for the rest)
  2026-08-05 17:31  note-added      nt-rxqzhj
  2026-08-05 17:31  status-changed  Planned -> In Progress
  2026-08-05 17:31  created
```

A session that comes back cold reads one command instead of three. `katra brief`
carries the handoff **in full** — that is the difference from `show`, which
prints previews:

```console
$ katra brief $b
kt-s3l2m4  task CRUD
  level       task
  lane        In Progress
  priority    P1
  epic        kt-34vt8g  core tracker foundation
  blockers    none

handoff — last touch main @ /your/repo, 2026-08-05 17:31
  Storage layer is done. CRUD is scaffolded but the update path
  still needs the reparenting case.

activity (newest first — `katra log` for the rest)
  2026-08-05 17:31  note-added      nt-rxqzhj
  2026-08-05 17:31  status-changed  Planned -> In Progress
  2026-08-05 17:31  created
```

And `katra board` answers the other question — where does the whole repository
stand? Actionable first, activity last, and the counts are totals even when a
section is capped:

```console
$ katra board
1 open · 1 in flight · 0 ready · 0 blocked · 0 untriaged

in flight
  kt-s3l2m4  P1  In Progress  task CRUD

recent (newest first — `katra log` for the rest)
  2026-08-05 17:31  note-added      kt-s3l2m4  task CRUD  nt-rxqzhj
  2026-08-05 17:31  status-changed  kt-s3l2m4  task CRUD  Planned -> In Progress
  2026-08-05 17:31  closed          kt-x93qjo  storage layer  Planned -> Done  shipped
  2026-08-05 17:31  created         kt-s3l2m4  task CRUD
  2026-08-05 17:31  created         kt-x93qjo  storage layer
  2026-08-05 17:31  created         kt-34vt8g  core tracker foundation
```

`katra board --digest` puts the newest handoff in the store above all of that,
which is what a session opening in a fresh worktree wants to read first.

| Command | What it does |
| --- | --- |
| `init` | Create the store for this repository |
| `add` · `show` · `list` | Create and read tasks; `list` filters by lane, kind, level, epic, tag, assignee, priority, and ready/blocked |
| `update` | Change any mutable field, including reparenting |
| `close` · `cancel` · `reopen` | Finish, abandon, or revive — and report what each released |
| `delete` | Remove a task that should never have existed |
| `dep` · `link` | Blocking dependencies, and associations that don't block |
| `next` | The one task that can be started right now |
| `log` | What has happened — to one task, to an epic and its children, or across the store |
| `note add` · `note list` | Typed prose on a task: `general`, `handoff`, `decision`, `acceptance` |
| `brief` | Everything needed to resume one task or epic, in one call — handoff body included |
| `board` | Where the repository stands: in flight, ready, blocked, and what just moved |

Every read takes `--json`. Every refusal names what would unblock it — an ambiguous id lists the candidates, a rejected dependency prints the cycle path, and `next` with nothing ready tells you whether the work is blocked, untriaged, or simply finished.

### History that outlives the task

Every write records an event in the same transaction as the change itself, so history can never describe something that did not happen. Events are **never deleted**: `katra delete` appends a final `deleted` event carrying the task's title, and `katra log <id>` still answers for a task that no longer exists. Notes are the opposite case and are removed with their task — history survives, content does not ([ADR-008](docs/decisions/ADR-008-events-outlive-their-entities.md)).

Each event and note records who wrote it as `<branch> @ <worktree path>`, so two agents in two worktrees are always distinguishable in the record ([ADR-007](docs/decisions/ADR-007-actor-is-branch-and-worktree.md)).

## Still to come

`brief` (the context-pack), `board` and the session digest, FTS5 search, claims and presence for cross-worktree coordination, external refs with pluggable providers, and snapshots. The [spec](docs/katra-spec.md) describes all of it.

Until `snapshot` lands, the store lives only in your `.git` directory: it is not shareable, not reviewable in a pull request, and does not survive a fresh clone.

## Install

Not published yet. When it is:

```bash
npm install -g @itsacoyote/katra
# or run without installing
npx @itsacoyote/katra --help
```

> The unscoped `katra` name on npm belongs to an unrelated, abandoned package, so katra publishes under the `@itsacoyote` scope. The installed command is still `katra`.

## Development

Requires **Node ≥ 22.12** and **pnpm**.

```bash
pnpm install
pnpm build      # bundle with tsup
pnpm test       # vitest
pnpm check      # lint + typecheck + test — what CI runs
```

The suite runs against real SQLite in throwaway git repositories, and spawns real OS processes where multi-process contention is the thing under test. The traceability docs map every acceptance criterion to the test that covers it, and record where coverage is genuinely limited rather than claiming a tick: [`f1`](docs/f1-traceability.md), [`f2`](docs/f2-traceability.md).

## Migrating from beads

katra ships a converter for projects already tracking work in [beads](https://github.com/steveyegge/beads). See [`docs/migrating-from-beads.md`](docs/migrating-from-beads.md) for the field mapping and what does and doesn't carry over. (Not implemented yet — the mapping is designed, the script is pending katra's schema.)

## Contributing

Contributions are welcome. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md), and please read the [spec](docs/katra-spec.md) first — it records which ideas were **considered and declined**, so you can tell a gap from a deliberate omission.

## Prior art

katra owes ideas to [beads](https://github.com/steveyegge/beads), [tk](https://github.com/wedow/ticket), [beans](https://github.com/hmans/beans), and [aweb](https://github.com/awebai/aweb). The spec's §14 explains what each got right and where katra diverges.

## License

[MIT](LICENSE) © itsacoyote
