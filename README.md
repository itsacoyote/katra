# katra

> **Status: pre-alpha.** The core tracker works — tasks, epics, dependencies, an append-only event stream, typed notes, cross-worktree claims and presence, full-text search with structured filters, activity and staleness reads, external refs that link tasks to GitHub PRs and Linear issues with live status through `refresh` and policy-driven advancement through `reconcile`, `snapshot`/`restore` so the store survives a fresh clone, and twenty-seven commands over them, including `brief` and `board` for restoring context at the start of a session, and `migrate beads` for importing an existing beads backlog. See [`docs/katra-spec.md`](docs/katra-spec.md) for the full design.

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
| `migrate beads` | Import an existing beads backlog — preview by default, `--apply` to write |
| `add` · `show` · `list` | Create and read tasks; `list` filters by lane, kind, level, epic, tag, assignee, priority, and ready/blocked |
| `update` | Change any mutable field, including reparenting |
| `close` · `cancel` · `reopen` | Finish, abandon, or revive — and report what each released |
| `delete` | Remove a task that should never have existed |
| `dep` · `link` | Blocking dependencies, and associations that don't block |
| `next` | The one task that can be started right now |
| `claim` · `release` | Hold a task for this worktree while you work it, and hand it back when you're done |
| `log` | What has happened — to one task, to an epic and its children, or across the store |
| `note add` · `note list` | Typed prose on a task: `general`, `handoff`, `decision`, `acceptance` |
| `brief` | Everything needed to resume one task or epic, in one call — handoff body included |
| `board` | Where the repository stands: in flight, ready, blocked, and what just moved |
| `search` | Full-text over titles, descriptions and notes, plus structured filters, with or without query text |
| `recent` | Activity-sorted — what has been touched, newest first |
| `stale` | Open items with no recent activity — `--older-than` defaults to two weeks |

Every read takes `--json`. Every refusal names what would unblock it — an ambiguous id lists the candidates, a rejected dependency prints the cycle path, and `next` with nothing ready tells you whether the work is blocked, untriaged, or simply finished.

### History that outlives the task

Every write records an event in the same transaction as the change itself, so history can never describe something that did not happen. Events are **never deleted**: `katra delete` appends a final `deleted` event carrying the task's title, and `katra log <id>` still answers for a task that no longer exists. Notes are the opposite case and are removed with their task — history survives, content does not ([ADR-008](docs/decisions/ADR-008-events-outlive-their-entities.md)).

Each event and note records who wrote it as `<branch> @ <worktree path>`, so two agents in two worktrees are always distinguishable in the record ([ADR-007](docs/decisions/ADR-007-actor-is-branch-and-worktree.md)).

### Claiming work across worktrees

`katra claim <id>` records that this worktree is working a task. A second worktree attempting the same claim is refused and told who holds it and how recently they were seen:

```console
$ katra claim kt-s3l2m4
kt-s3l2m4 claimed by main @ /path/to/repo

$ katra claim kt-s3l2m4   # from a second worktree of the same repo
katra: kt-s3l2m4 is held by main @ /path/to/repo, last seen just now — release --force to take it over
```

`next` and `board` steer around a claim without ever moving it between the board's counts ([ADR-012](docs/decisions/ADR-012-claims-steer-not-move.md)): `next` never offers a task another worktree holds, and hands your own still-`Planned` claim back first if you have one; the board marks another worktree's claimed rows and lists them last. `katra release <id>` gives a claim back, and `close`/`cancel` release it for you automatically. A claim left behind by a session that will not return is taken over with `katra release <id> --force`, informed by exactly the holder and liveness a refusal already showed. Presence — the "last seen" behind that liveness — is a heartbeat only: every command bumps it for its own worktree, no hooks required ([ADR-011](docs/decisions/ADR-011-every-call-heartbeats.md)), and claims are scoped to a worktree rather than a session, so two agent sessions sharing one worktree share one claim too.

### Finding things

`katra search <query>` is full-text over titles, descriptions and note bodies, built on SQLite's own FTS5 — no extra dependency, and the index stays current automatically ([ADR-013](docs/decisions/ADR-013-fts5-external-content-triggers.md)). A note match rolls up to the task it belongs to and says so:

```console
$ katra search oauth
kt-owvndz  P2  Defined  feat  oauth migration for the billing service
    [oauth] migration for the billing service
kt-cr8lrz  P2  Defined  feat  rotate the staging credentials
    note match — still need to sort out the [oauth] callback…
```

The same command takes structured filters — `--lane`, `--kind`, `--level`, `--epic`, `--tag`, `--updated-before`/`--updated-after` — with or without query text, so "everything tagged `urgent`" is as valid a search as a keyword:

```console
$ katra search --tag urgent
kt-ryc943  P2  Defined  feat  tag demo task
```

`katra recent` reads your own event history back to you, newest first — the direct answer to "what was I working on":

```console
$ katra recent
kt-cr8lrz  P2  Defined  rotate the staging credentials  just now
kt-owvndz  P2  Defined  oauth migration for the billing service  just now
kt-8ind1q  P2  Defined  core tracker foundation  just now
```

`katra stale` is the inverse — open items nothing has touched in a while, oldest first, default window two weeks:

```console
$ katra stale
stale — untouched since before 2026-07-31T02:43:24.049Z
  kt-dlcpbk  P2  Defined  old audit follow-up nobody touched  15d ago
```

### Linking external work

`katra ref add` attaches a task to the thing that tracks or ships it elsewhere — paste a GitHub PR/issue URL or a Linear id and katra derives the provider and a canonical qualified id ([ADR-014](docs/decisions/ADR-014-core-parses-known-ref-urls.md)); re-adding is a safe no-op that says so:

```console
$ katra ref add kt-28fs2e https://github.com/acme/billing/pull/128
kt-28fs2e  linked  github: acme/billing#128  https://github.com/acme/billing/pull/128
$ katra ref add kt-28fs2e ENG-451
kt-28fs2e  linked  linear: ENG-451
$ katra ref add kt-28fs2e https://github.com/acme/billing/pull/128
kt-28fs2e  already linked  github: acme/billing#128  https://github.com/acme/billing/pull/128
```

`show` and `brief` carry a task's refs, so the next session finds the review context without git archaeology:

```console
$ katra show kt-28fs2e
kt-28fs2e  oauth migration for the billing service
  level       task
  kind        feat
  lane        Defined
  priority    P2
  blockers    none
  refs        github: acme/billing#128  https://github.com/acme/billing/pull/128
              linear: ENG-451
```

Any other tracker stores through the explicit form — core is provider-agnostic in what it keeps, opinionated only in what it parses:

```console
$ katra ref add kt-28fs2e https://gitlab.com/acme/tool/-/merge_requests/9
katra: not a recognized github.com or linear.app reference URL — store it explicitly with --provider <name> --id <id> [--url <url>]
$ katra ref add kt-28fs2e --provider gitlab --id "acme/tool!9" --url https://gitlab.com/acme/tool/-/merge_requests/9
```

`ref add` itself never touches the network. `ref remove` takes the url, the qualified id, or `provider:id` when two refs collide, and linking/unlinking is recorded in the task's history like every other write.

### Live status

`katra refresh` asks each ref's tracker what actually happened — GitHub through your already-authenticated `gh`, Linear through its API with `LINEAR_API_KEY` in the environment — and fills the caches `show` and `brief` render:

```console
$ katra refresh
2 ref(s) checked — 1 updated, 1 unchanged, 0 unresolved

updated (1)
  linear: GRI-4  none -> unstarted

unchanged (1)
  github: itsacoyote/katra#13

$ katra show kt-qyeewf
  refs        linear: GRI-4  unstarted  Set up your teams  · synced just now
```

A real change lands in the task's history as a `ref-status-changed` event; an unchanged ref just bumps its sync time. Offline, unauthenticated, or an unknown provider is a *state*, not a failure — every ref reports its reason and `refresh` exits 0:

```console
$ katra refresh
2 ref(s) checked — 0 updated, 1 unchanged, 1 unresolved

unresolved (1)
  linear: GRI-4  LINEAR_API_KEY not set
```

`refresh` is pure read on the external side and never moves a task — acting on what it learned is `reconcile`'s job, deliberately a separate, explicit command ([ADR-015](docs/decisions/ADR-015-built-in-provider-registry.md) covers why providers are built-in rather than discovered plugins).

### Acting on it

`katra reconcile` is the one path by which external state can move a task, and it never runs implicitly. It reads only what `refresh` cached — no network — applies a fixed policy map (GitHub `merged` → Done, Linear `completed` → Done, Linear `canceled` → Cancelled; everything else no move), and **previews by default**:

```console
$ katra reconcile
2 task(s) checked — 1 would advance, 1 blocked, 0 conflicting, 0 skip-claimed, 0 no-op

advance (1)
  kt-qyeewf  wire the auth flow  -> Done
    reason: merged — github:itsacoyote/katra#13
    github: itsacoyote/katra#13  merged  · synced just now

blocked (1)
  kt-ab12cd  split the parser
    github: itsacoyote/katra#14  open  · synced just now

$ katra reconcile --apply
2 task(s) checked — 1 advanced, 1 blocked, 0 conflicting, 0 skip-claimed, 0 no-op
```

A task with several refs advances only when **all** of them agree (one merged PR out of three is not done); refs that disagree — one says Done, another Cancelled — are a flagged conflict and never auto-apply. A task claimed by another worktree is skipped and reported, even under `--apply`, and a never-refreshed ref holds its task back ("couldn't read it" never means "it's gone"). Every applied move lands in the task's history as a `closed`/`cancelled` event stamped `actor = reconcile` with the triggering ref in the reason — reconcile-derived changes are always distinguishable from an agent's own judgment. The policy is data inside the engine, not branches; a user-facing way to swap it is deliberately deferred ([ADR-016](docs/decisions/ADR-016-reconcile-policy-as-injected-data.md)).

### Surviving the machine

The store lives inside `.git/`, so it is invisible to git by construction — which is right for cross-worktree coordination but means a fresh clone starts empty. `katra snapshot` writes the whole store to one deterministic, git-diffable JSONL file you commit; `katra restore` rebuilds a store from one:

```console
$ katra snapshot
wrote 954 row(s) across 9 table(s) to /repo/.katra/snapshot.jsonl (schema v6)

$ git add .katra/snapshot.jsonl && git commit -m "snapshot the backlog"

# on a fresh clone, or to undo a bad write:
$ katra init && katra restore .katra/snapshot.jsonl --apply
applied .katra/snapshot.jsonl: loaded 954 row(s) across 9 table(s) (schema v6 -> v6)
```

An unchanged store snapshots to a **byte-identical** file, so a no-op session commits a clean diff. `restore` **previews by default** — `--apply` executes, and `--force` is additionally required over a non-empty store, since restore replaces everything. It rebuilds a fresh database at the snapshot's own recorded schema version and migrates it forward, so a snapshot dug out of git history stays restorable after upgrades; the previous store is kept alongside as `katra.db.bak`. Snapshots carry every source-of-truth table (claims included; presence, machine-local telemetry, is not), round-trip stored bytes exactly (a backup never sanitizes), and are how a backlog is shared, survives a fresh clone, or a bad write is undone ([ADR-017](docs/decisions/ADR-017-snapshot-jsonl-and-worktree-artifact.md), [ADR-018](docs/decisions/ADR-018-restore-bypasses-the-write-seams.md)).

### Enforcing coordination inside the agent

Everything above is **pull**: an agent (or its human) has to remember to check the board, claim before working, and release after. The specific failure that bites is a silent one — worktree A claims a task and edits it, worktree B runs `release --force` to take it over, and A never notices and keeps editing. Two live worktrees now own the same work, and nothing catches it at the moment of the edit.

`katra install-hooks <agent>` wires katra into an agent's own native hooks so the coordination happens on its own, no convention required. It merges three touchpoints into the agent's settings — for Claude Code and Codex today:

```console
$ katra install-hooks claude
installed claude hooks into .claude/settings.json — review and commit it; shared with your team
```

- **session start** injects `katra board --digest`, so the agent orients on the current board without being told to.
- **before edit** runs `katra guard`, which denies the edit — exit 2, with the reason fed back to the agent — when the caller worktree's in-progress task has been force-taken by a *different, live* worktree, and allows it otherwise (it still holds the task, it re-coordinated onto other work since, or the rival went stale). Enforcement is task-level: katra's claims are task↔worktree with no file scope, so guard catches the takeover, not which file you touch ([ADR-019](docs/decisions/ADR-019-guard-is-task-level-takeover.md)). Any infrastructure problem — no store, a locked database — **fails open**: a hook that can't read the store must never block every edit in the session.
- **session end** runs `katra release --mine`, releasing every claim this worktree holds so the next session sees them free. It fires only on a real exit — a `/clear` or a resume keeps your claims, so the session picks its work back up.

The merge is idempotent and reversible: re-running makes no further change, `--print` shows the exact block without writing, `--remove` strips only katra's entries and leaves the rest of your settings untouched, and `--local` targets `.claude/settings.local.json` for a personal trial before you commit. The adapter contract is one thin per-agent mapping over shared touchpoints, so adding an agent needs no core change ([ADR-020](docs/decisions/ADR-020-tier1-adapters-over-abstract-touchpoints.md)). Claude Code is the proven path; the Codex adapter is best-effort against an evolving hooks surface. See [`AGENTS.md`](AGENTS.md#tier-1-setup-hook-adapters) for the full setup, the trust step each agent requires, and the caveats.

## Still to come

External provider discovery. The [spec](docs/katra-spec.md) describes it.

## Install

Published as [`@itsacoyote/katra`](https://www.npmjs.com/package/@itsacoyote/katra):

```bash
npm install -g @itsacoyote/katra
# or run without installing
npx @itsacoyote/katra --help
```

> The unscoped `katra` name on npm belongs to an unrelated, abandoned package, so katra publishes under the `@itsacoyote` scope. The installed command is still `katra`.

Then, per repository: `katra init` creates the store, and [`docs/agents-snippet.md`](docs/agents-snippet.md) is the block to paste into that repository's `AGENTS.md` so agent sessions actually use it.

## Development

Requires **Node ≥ 22.12** and **pnpm**.

```bash
pnpm install
pnpm build      # bundle with tsup
pnpm test       # vitest
pnpm check      # lint + typecheck + test — what CI runs
```

The suite runs against real SQLite in throwaway git repositories, and spawns real OS processes where multi-process contention is the thing under test. The traceability docs map every acceptance criterion to the test that covers it, and record where coverage is genuinely limited rather than claiming a tick: [`f1`](docs/f1-traceability.md), [`f2`](docs/f2-traceability.md), [`f3`](docs/f3-traceability.md), [`f4`](docs/f4-traceability.md), [`f5`](docs/f5-traceability.md), [`f6`](docs/f6-traceability.md).

## Migrating from beads

Already tracking work in [beads](https://github.com/steveyegge/beads)? `katra migrate beads` converts your export in one shot — preview by default, `--apply` to write, and a report naming everything mapped, dropped, or degraded, nothing silent. See [`docs/migrating-from-beads.md`](docs/migrating-from-beads.md) for the field mapping and what does and doesn't carry over.

## Contributing

Contributions are welcome. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md), and please read the [spec](docs/katra-spec.md) first — it records which ideas were **considered and declined**, so you can tell a gap from a deliberate omission.

## Prior art

katra owes ideas to [beads](https://github.com/steveyegge/beads), [tk](https://github.com/wedow/ticket), [beans](https://github.com/hmans/beans), and [aweb](https://github.com/awebai/aweb). The spec's §14 explains what each got right and where katra diverges.

## License

[MIT](LICENSE) © itsacoyote
