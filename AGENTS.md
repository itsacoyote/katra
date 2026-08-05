# AGENTS.md

Instructions for AI coding agents working **on the katra repository**. This is the single source of truth; agent-specific files (`CLAUDE.md`, etc.) point here.

> Later, this file will also carry katra's own *runtime* workflow instructions — how an agent should use the `katra` CLI in any project (session-start digest, claim before working, release when done). That section lands when the CLI does. For now this covers contributing to katra itself.

## What katra is

A local, git-native, agent-first project manager and coordination layer for AI coding sessions across git worktrees. Read [`docs/katra-spec.md`](docs/katra-spec.md) before doing anything substantial — it is the settled design, including rationale.

**Status: pre-alpha.** The core tracker is built and tested — tasks, epics, dependencies, links, an append-only event stream, typed notes, and fourteen commands over them (`init add show list update close cancel reopen delete dep link next log note`). Everything else in the spec is not: `brief`, `board`, FTS5 search, claims and presence, external refs, snapshots, and the beads converter. Don't assume a command works because the spec describes it — check `src/cli/commands/`, which is the complete list.

Eight decisions in the spec were superseded or refined during implementation; the ADRs in `docs/decisions/` win where they disagree.

## Project layout

```
src/index.ts            public API barrel — an export list, not a place logic goes
src/cli.ts              the binary: hands argv to run(), sets the exit code
src/version.ts          the package version, importable from either side

src/core/               all logic lives here; never references exit codes
  enums.ts              the fixed value sets, their types, and sqlEnum()
  errors.ts             KatraException + its discriminated detail union
  clock.ts              the one place a timestamp is produced
  store.ts              openStore() — the single door to a database handle
  db/
    locate.ts           git-common-dir resolution + failure taxonomy
    connection.ts       pragmas + writeTx (BEGIN IMMEDIATE)
    migrate.ts          user_version migration runner
    retry.ts            busy-retry for statements SQLite's handler misses
    migrations/         one numbered module per schema step

src/cli/                parse, call, format — nothing else
  program.ts            createProgram() + run(); owns exitOverride
  output.ts             emit() and the ONE exit-code mapping table
  commands/             one module per command, each registering itself

test/core/  test/cli/   mirroring src/
test/helpers/           git repos, stores, seeding, in-process CLI, concurrency
test/fixtures/          golden files (the committed schema snapshot)
docs/                   spec, ADRs, design notes
```

**Nesting rule:** `core/db/*` is storage mechanics · `core/tasks/*`,
`core/events/*`, `core/notes/*` and the task-relationship modules are domain
logic, one directory per entity · `core/{enums,errors,clock,store,actor,git,id-format}.ts`
are shared roots. Tests live under `test/` mirroring `src/`, not colocated.

An entity directory holds `types.ts` (the shapes, importing nothing that
touches the database) and `repo.ts` (the reads and writes). Anything composing
*several* entities goes one level up rather than into either — `tasks/view.ts`
assembles a task with its notes and events for exactly that reason, since
`notes/repo.ts` already imports from `tasks/repo.ts` and reaching back would
make the two mutually dependent.

## Commands

```bash
pnpm install
pnpm build        # tsup → dist/
pnpm test         # vitest
pnpm typecheck    # tsc --noEmit
pnpm lint         # biome check
pnpm lint:fix     # biome check --write
pnpm check        # lint + typecheck + test — matches CI
```

Run `pnpm check` before declaring work done.

## Non-negotiable design rules

These come from the spec and are not open for re-litigation in a PR:

1. **katra is complete standalone.** Zero providers, no network, no external tracker — every core feature works unchanged. External refs are augmentation.
2. **Strictly one-directional.** katra reads external trackers and never writes to them. The provider interface has no write method *by construction*, not by convention.
3. **katra never reacts automatically to external state.** Task state changes only from an explicit command — never as a side effect of a read.
4. **The database is never committed.** It lives under the git common dir — *inside* `.git/`, which git cannot track — so this is structural, not enforced by an ignore rule. katra writes no ignore entry; see [ADR-004](docs/decisions/ADR-004-no-ignore-entry.md). What katra must never do is modify a tracked file. Snapshots are disposable backups, not a source of truth and not a review surface.
5. **Events are append-only and immutable.** Never edit or delete one, even when the underlying entity changes.
6. **Never auto-log every attribute edit.** Event types are a curated, fixed set. Field churn buries the signal.

## Code conventions

- **Library core, thin CLI wrapper.** Logic in the core; `cli.ts` only parses args, calls the core, and formats output.
- **`--json` on every read command.** Agents are the primary reader; parsing formatted text is where silent misreads happen.
- **Exit codes distinguish a refusal from a fault.** 0 ok · 1 refused · 2 malformed invocation · 3 state conflict · 4 katra broke ([ADR-005](docs/decisions/ADR-005-internal-fault-exit-code.md)). An agent branches on these, so 1 must never mean "retry later" — which is why `next` exits 0 even when nothing is ready ([ADR-006](docs/decisions/ADR-006-next-exits-zero.md)) and puts the answer in the payload.
- **Nothing published from `src/index.ts` may reach the storage engine.** Declarations are emitted per file, so a type re-exported there drags its whole import graph into the shipped `.d.ts` — and `@types/better-sqlite3` is a devDependency. `core/contract.ts` and `core/id-format.ts` exist to hold the store-free half, and `core/{enums,errors}.ts`, `core/{tasks,events,notes}/types.ts` are store-free for the same reason; `test/index.test.ts` walks the graph and fails on a regression.
- **Bodies via `--body-file`**, never inline args; `--body-file -` reads stdin. Bare stdin is *not* consulted — consuming whatever sits on fd 0 made every shell redirect a silent overwrite.
- **Rich blocked feedback.** A refused claim says *why* and *what unblocks it* — never a silent refusal.
- **TypeScript strictness stays on** (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Prefer `unknown` over `any`, `satisfies` over `as`, derived types over duplicated ones, discriminated unions with `never` exhaustiveness checks.
- **Formatting is Biome's job.** Run `pnpm lint:fix`; don't hand-format.

## Fixed enums

Don't invent values for these — they're fixed sets, deliberately:

- **Status lanes:** `Defined → Researching → Planned → In Progress → In Review → Done`, plus the terminal `Cancelled`.
  - The spec calls the third lane `Ready`; renamed per [ADR-002](docs/decisions/ADR-002-planned-lane-naming.md) so that **ready** means only one thing: *unblocked by dependencies*, computed from the deps graph.
  - `Cancelled` added per [ADR-003](docs/decisions/ADR-003-cancelled-terminal-lane.md) for work that was real but abandoned.
- **`TERMINAL` = `{ Done, Cancelled }`.** A task is ready when no dependency sits in a **non-terminal** lane — never `= 'Done'`. Define this in exactly one place; a missed site is a correctness bug.
- **Every write transaction uses `BEGIN IMMEDIATE`** (`db.transaction(fn).immediate()`). Measured: the deferred default loses ~33% of writes to `SQLITE_BUSY` under six concurrent processes, and `busy_timeout` does not save it. This also closes the cycle-detection TOCTOU race.
- **Level:** `epic | task`
- **Kind** (mirrors Conventional Commits): `feat | fix | refactor | perf | docs | test | chore`
- **Note kinds:** `general | handoff | decision | acceptance`
- **Event types, as implemented:** `created`, `status-changed`, `note-added`, `closed`, `cancelled`, `reopened`, `deleted`. Seven, not the spec's nine: `claimed`/`released` arrive with F4's claims and `ref-linked`/`ref-status-changed` with F5's external refs. Declaring a value the code cannot write would put it in a `CHECK` constraint under forward-only migrations, which is expensive to take back. `deleted` is the addition the spec's list does not have, from ADR-008 — `delete` appends its own last event.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `<type>: <imperative, lowercase, no trailing period>`. Types match the `kind` enum above.

Add a changeset (`pnpm changeset`) for anything affecting the published package.

## Task tracking

This repo currently tracks its own work in [beads](https://github.com/steveyegge/beads) (`bd`), set up in stealth mode — it is local-only and nothing beads-related is committed. Once katra can track itself, the project migrates to katra via the converter described in [`docs/migrating-from-beads.md`](docs/migrating-from-beads.md).

Useful reads: `bd ready` (unblocked work), `bd list`, `bd show <id>`.
