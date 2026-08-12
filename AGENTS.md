# AGENTS.md

Instructions for AI coding agents working **on the katra repository**. This is the single source of truth; agent-specific files (`CLAUDE.md`, etc.) point here.

> Later, this file will also carry katra's own *runtime* workflow instructions — how an agent should use the `katra` CLI in any project (session-start digest, claim before working, release when done). That section lands when the CLI does. For now this covers contributing to katra itself.

## What katra is

A local, git-native, agent-first project manager and coordination layer for AI coding sessions across git worktrees. Read [`docs/katra-spec.md`](docs/katra-spec.md) before doing anything substantial — it is the settled design, including rationale.

**Status: pre-alpha.** The core tracker is built and tested — tasks, epics, dependencies, links, an append-only event stream, typed notes, cross-worktree claims and presence, the two orientation reads, and eighteen commands over them (`init add show list update close cancel reopen delete dep link next log note brief board claim release`). Everything else in the spec is not: FTS5 search, external refs, snapshots, and the beads converter. Don't assume a command works because the spec describes it — check `src/cli/commands/`, which is the complete list.

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
    connection.ts       pragmas + writeTx (BEGIN IMMEDIATE) + readTx (deferred)
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
- **`src/core/git.ts` is the only module that spawns a process.** `findGit` resolves the binary to an *absolute* path and skips relative `PATH` entries: on Windows libuv resolves a bare program name from the current directory before `PATH`, so a repository shipping `git.exe` would otherwise be executed by every command. `test/core/git.test.ts` fails if a second spawn site appears anywhere under `src/`.
- **Resolve the actor *before* opening a write transaction.** It costs two subprocess spawns, and doing that under `BEGIN IMMEDIATE` holds the exclusive write lock across both. The resolver is lazy, so the first write in a process is where it fires; every write path forces it first and a test asserts `db.inTransaction` is false when it runs.
- **A claim's compare-and-set is TOCTOU-safe by construction: one `writeTx`, never a separate read-then-write.** `claimTask`/`releaseTask` resolve identity before opening `BEGIN IMMEDIATE` — the actor rule above, applied here too — then check the holder and write the change inside that same transaction. A read outside the lock followed by a write inside one lets a second writer see "unclaimed" in the gap and both insert before either commits (spec §11); `test/core/claims.test.ts`'s two-real-process race is what would catch a regression back into that shape.
- **The presence heartbeat is eventless, non-fatal, and worktree-keyed with a fresh window.** `openStore` UPSERTs `presence` for the calling worktree on every command, reads included (ADR-011) — but it writes no event, so history stays exactly what happened to work, never who was breathing; it never fails the command it rides along with, so a broken heartbeat cannot turn a read into a failure; and it skips the write entirely while the row is still fresher than `PRESENCE_FRESH_MS` (30s), keyed on the worktree alone, so most commands cost nothing extra and a branch rename inside that window is picked up by the next write that does land.
- **`appendEvent` runs inside the caller's transaction and opens none of its own** — it throws if there is no transaction. An entity change and the event recording it commit together or not at all. Note that wrapping it in its own transaction does *not* break that: better-sqlite3 turns a nested transaction into a savepoint, so the obvious mutation proves nothing.
- **`appendEvent`'s guard means "inside a *write* transaction", and `db.inTransaction` alone cannot say that.** A deferred read sets the same flag, so once `readTx` existed the check passed inside one and the insert went on to attempt a lock upgrade it cannot get. `assertNotReadOnly` is the second half; `writeTx` consults it too.
- **Multi-statement reads that must agree with each other go inside `readTx`** (`db.transaction(fn).deferred()`). Under WAL the snapshot is pinned at the first read statement and held for the transaction. `board` needs it: five queries whose answers must describe one store, run constantly alongside other worktrees writing. Deferred, never `.immediate()` — a read that took the write lock would make the most-run command a source of contention. Nothing inside may write, and that is enforced rather than documented.
- **Text is measured and cut in code points, not UTF-16 code units.** `capText` and `textWidth` in `core/text.ts`; `clamp`, `columnWidth` and `padTo` in `cli/format.ts` all defer to them. The three used `.length`/`padEnd` and only work as a set — an emoji is two code units, so a column sized one way and padded another misaligns every row beside it. The cap lives in **core**, not the formatter, because `brief` bounds a note body inside its assembly and that bound is part of the `--json` document.
- **A task that introduces a published document declares it in full**, including fields a later task populates — `BoardResult` declares `digest` before `--digest` exists. A second task amending a shipped type is how a `--json` consumer ends up unable to tell "does not apply" from "nothing filled it in".
- **Every stored string rendered to a terminal goes through a sanitizer.** `oneLine` for single-line fields, `sanitizeBody` for multi-line ones (it keeps newlines and tabs). Both strip C0/C1 controls, the Unicode line separators (`U+2028`/`U+2029` — invisible to a terminal, line breaks to any other renderer), and the full Trojan Source bidi set including `U+061C` — notes and descriptions are where fetched content and model output land, and `--json` is the verbatim path because its consumer is not a terminal. This covers event `ref` and `entityId` too: those columns have no CHECK constraint, and F5 routes external refs through `ref`.
- **A bounded read reports that it truncated.** `log` and `show` cap their output and carry a flag saying so; `list` is unbounded precisely because a default cap would owe that report. A bound that cannot report itself is indistinguishable from the end of the data.
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
- **Event types, as implemented:** `created`, `claimed`, `released`, `status-changed`, `note-added`, `closed`, `cancelled`, `reopened`, `deleted`. Nine now that F4's claims land `claimed`/`released`; `ref-linked`/`ref-status-changed` still wait on F5's external refs — declaring a value the code cannot write would put it in a `CHECK` constraint under forward-only migrations, which is expensive to take back. `deleted` and `cancelled` are additions the spec's own list does not have (ADR-008 — `delete` appends its own last event; ADR-003 — a terminal lane distinct from `closed`).

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `<type>: <imperative, lowercase, no trailing period>`. Types match the `kind` enum above.

Add a changeset (`pnpm changeset`) for anything affecting the published package.

## Task tracking

This repo currently tracks its own work in [beads](https://github.com/steveyegge/beads) (`bd`), set up in stealth mode — it is local-only and nothing beads-related is committed. Once katra can track itself, the project migrates to katra via the converter described in [`docs/migrating-from-beads.md`](docs/migrating-from-beads.md).

Useful reads: `bd ready` (unblocked work), `bd list`, `bd show <id>`.
