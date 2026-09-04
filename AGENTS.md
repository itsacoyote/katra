# AGENTS.md

Instructions for AI coding agents working **on the katra repository**. This is the single source of truth; agent-specific files (`CLAUDE.md`, etc.) point here.

> Later, this file will also carry katra's own *runtime* workflow instructions — how an agent should use the `katra` CLI in any project (session-start digest, claim before working, release when done). That section lands when the CLI does. For now this covers contributing to katra itself.

## What katra is

A local, git-native, agent-first project manager and coordination layer for AI coding sessions across git worktrees. Read [`docs/katra-spec.md`](docs/katra-spec.md) before doing anything substantial — it is the settled design, including rationale.

**Status: pre-alpha.** The core tracker is built and tested — tasks, epics, dependencies, links, an append-only event stream, typed notes, cross-worktree claims and presence, the two orientation reads, a beads (`bd`) migration converter, full-text search with structured filters, activity-sorted and staleness reads, provider-agnostic external refs with built-in GitHub/Linear URL parsing, live status resolution through built-in GitHub and Linear providers with `refresh`, policy-driven advancement from cached external status with `reconcile` (preview by default, `--apply` to commit, the only path external state can move a task), deterministic full-store `snapshot`/`restore` so a committed backlog survives a fresh clone (preview by default, `--apply` to execute, `--force` over a non-empty store), and twenty-seven commands over them (`init add show list update close cancel reopen delete dep link next log note brief board claim release migrate search recent stale ref refresh reconcile snapshot restore`). Everything else in the spec is not: external provider discovery. Don't assume a command works because the spec describes it — check `src/cli/commands/`, which is the complete list.

Eight decisions in the spec were superseded or refined during implementation; the ADRs in `docs/decisions/` win where they disagree.

## Tier-1 setup: hook adapters

katra's Tier-0 baseline (spec §9) is pure pull: an agent runs `katra board --digest`, `claim`, and `release` by convention, from `AGENTS.md` instructions alone. Tier-1 makes three of those touchpoints automatic and *enforced*, inside Claude Code and Codex, over each agent's own native hook mechanism — see [ADR-019](docs/decisions/ADR-019-guard-is-task-level-takeover.md) (what guard enforces) and [ADR-020](docs/decisions/ADR-020-tier1-adapters-over-abstract-touchpoints.md) (the adapter architecture).

### Install

```
katra init                    # once per repo — see the caveat below
katra install-hooks claude    # or: codex
```

`install-hooks <agent>` idempotently merges katra's three hook entries into the agent's own settings file: a second run is a byte-identical no-op, and pre-existing hooks and unrelated settings are preserved untouched. Flags:

- `--print` — emit the exact block that would be written; touches nothing.
- `--remove` — strip only katra's entries, leaving every other hook and setting intact.
- `--local` — target `.claude/settings.local.json` (trial-before-commit) instead of the default shared, committed `.claude/settings.json`. Codex has no local/shared split (one file, `.codex/hooks.json`); `--local` with `codex` is a usage refusal.

### What each hook does

| Touchpoint | Claude Code | Codex | Command |
|---|---|---|---|
| session-start | `SessionStart` | `SessionStart` | `katra board --digest` |
| before-edit | `PreToolUse`, matcher `Edit\|Write\|NotebookEdit` | `PreToolUse`, matcher `apply_patch` | `katra guard` |
| session-end | `SessionEnd`, allow-list `logout\|prompt_input_exit\|other`, timeout 10s | `SessionEnd` (reason is always `other`; no matcher), timeout 3s (Codex hard-caps it) | `katra release --mine` |

- **session-start** injects the board digest into agent context with no manual call.
- **before-edit** runs `katra guard` before every file edit: it denies iff the caller worktree was displaced from a task that a different, *live* worktree still holds **and** it has not claimed anything else since that displacement; it allows otherwise — holds the task, was never displaced, re-coordinated onto other work since the displacement, or the rival went stale. Holding nothing is *not* by itself an allow: a worktree displaced from a task and holding nothing since is exactly the case that must deny. Fail-open by construction — a locked/missing/corrupt store, or any other error, allows; only a successfully-read live takeover ever denies.
- **session-end** releases every claim the worktree holds (`release --mine`) on a real exit, and is a clean no-op when it holds none.

### Caveats — read before relying on this

- **Folder trust.** Claude Code requires each teammate to approve project hooks once, per folder, before they fire — a committed `.claude/settings.json` does not bypass that. A freshly cloned repo's hooks sit inert until that session approves the folder.
- **SessionEnd deliberately excludes `clear` AND `resume`, not just `clear`.** Claims survive both a `/clear` and a `resume` so the session picks its work back up where it left off ([ADR-012](docs/decisions/ADR-012-claims-steer-not-move.md); own-claim-first ranking in `tasks/next.ts:83`). An auto-release on either would let a rival's later, ordinary claim look like a voluntary self-release and permanently disarm guard for that tenure.
- **`guard` blocks by exiting 2 — a hard block in every permission mode, including `bypassPermissions`.** A deny is unconditional (ADR-019). The same exit code is also commander's own usage-error path: a hand-edited hook line, or an older `katra` binary invoked before `guard` existed, exits 2 too and blocks just as loudly on version skew — self-correcting (update `katra`, or fix the hook line) and distinguishable from a real deny only by the stderr text. See the exit-code bullet under "Code conventions" below.
- **`guard` covers the file-editing tools, not Bash.** The `PreToolUse` matcher is `Edit|Write|NotebookEdit` (Claude Code) / `apply_patch` (Codex), so a file change routed through the **Bash tool** — `echo > file`, `sed -i`, `tee`, a script — never triggers guard, and the takeover check is silently bypassed for that path. This is inherent to tool-matched enforcement: matching *all* Bash would fire guard on every `ls`/`git status` and blow the sub-second budget, and detecting a write inside an arbitrary shell command is unreliable. The practical guidance in a guarded repo is to make file changes through the Edit/Write tools. Codex is unaffected in shape — everything there routes through `apply_patch`, which the matcher covers.
- **Run `katra init` before installing hooks.** `install-hooks` warns rather than refuses when no store exists yet, but the installed SessionStart/SessionEnd hooks will error at every session boundary in a store-less repo until `init` runs.
- **Codex is best-effort; Claude Code is the proven path.** The wire schema is confirmed against Codex's own source, but open upstream bugs bite katra's exact use case: project `.codex/hooks.json` can be silently misresolved when Codex runs inside a git worktree — katra's whole architecture (openai/codex#27133, #23996) — and `PreToolUse` deny is not always reliably enforced for `apply_patch`, the before-edit touchpoint itself (openai/codex#27833, #39872).
- **Windows: hook command strings assume `katra` resolves on `PATH`.** A local (non-global) install may not resolve in whatever shell the agent spawns the hook command in.
- **Recognition requires the command's first token to be exactly `katra`.** A hand-edited command like `/usr/local/bin/katra guard` or `npx katra guard` is not recognized as katra's own — the next `install-hooks` run adds a duplicate canonical entry beside it instead of normalizing it, and `--remove` leaves the hand-edited one behind. Correct-by-design (katra only ever reclaims what it wrote), but worth knowing before hand-editing a hook line.

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

Cross-cutting concerns that aren't a single table's repo get their own
directory beside the entities: `core/providers/*` (F8), `core/reconcile/*`
(F9), `core/snapshot/*` (F10 — `serialize.ts` pure rows↔lines, `export.ts`
store→file, `restore.ts` file→store with the raw-insert seam bypass). Each
keeps a pure half (no `better-sqlite3` import, structurally enforced) apart
from the store-touching half.

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
4. **The database is never committed.** It lives under the git common dir — *inside* `.git/`, which git cannot track — so this is structural, not enforced by an ignore rule. katra writes no ignore entry; see [ADR-004](docs/decisions/ADR-004-no-ignore-entry.md). What katra must never do is modify a tracked file **as a side effect** — narrowed by [ADR-017](docs/decisions/ADR-017-snapshot-jsonl-and-worktree-artifact.md): `katra snapshot` writes exactly the `.katra/snapshot.jsonl` (or `--out`) file it was explicitly asked to, and nothing else, on explicit invocation only. Snapshots are disposable backups — a diffable text export you commit, not a source of truth and not a review surface. `restore` rebuilds the store from one through raw id-preserving inserts that deliberately bypass the domain write seams ([ADR-018](docs/decisions/ADR-018-restore-bypasses-the-write-seams.md)), fenced to `core/snapshot/restore.ts`.
5. **Events are append-only and immutable.** Never edit or delete one, even when the underlying entity changes.
6. **Never auto-log every attribute edit.** Event types are a curated, fixed set. Field churn buries the signal.

## Code conventions

- **Library core, thin CLI wrapper.** Logic in the core; `cli.ts` only parses args, calls the core, and formats output.
- **`--json` on every read command.** Agents are the primary reader; parsing formatted text is where silent misreads happen.
- **Exit codes distinguish a refusal from a fault.** 0 ok · 1 refused · 2 malformed invocation · 3 state conflict · 4 katra broke ([ADR-005](docs/decisions/ADR-005-internal-fault-exit-code.md)). An agent branches on these, so 1 must never mean "retry later" — which is why `next` exits 0 even when nothing is ready ([ADR-006](docs/decisions/ADR-006-next-exits-zero.md)) and puts the answer in the payload. **One deliberate exception: `guard` also uses exit 2 for a deny** ([ADR-019](docs/decisions/ADR-019-guard-is-task-level-takeover.md)), not a malformed invocation — chosen for agent-agnosticism (no per-agent stdout schema to parse) over ADR-006's own precedent. Reading every exit-2 as "malformed invocation" misreads a real deny as a usage error; the known limit runs the other way too — commander's own usage-error path also exits 2, so version skew (an older binary invoked before `guard` existed) or a hand-edited hook line blocks loudly and is distinguishable from a real deny only by the stderr text.
- **Nothing published from `src/index.ts` may reach the storage engine.** Declarations are emitted per file, so a type re-exported there drags its whole import graph into the shipped `.d.ts` — and `@types/better-sqlite3` is a devDependency. `core/contract.ts` and `core/id-format.ts` exist to hold the store-free half, and `core/{enums,errors}.ts`, `core/{tasks,events,notes}/types.ts` are store-free for the same reason; `test/index.test.ts` walks the graph and fails on a regression.
- **Bodies via `--body-file`**, never inline args; `--body-file -` reads stdin. Bare stdin is *not* consulted — consuming whatever sits on fd 0 made every shell redirect a silent overwrite.
- **`src/core/git.ts` is the only module that spawns a process.** `findGit` resolves the binary to an *absolute* path and skips relative `PATH` entries: on Windows libuv resolves a bare program name from the current directory before `PATH`, so a repository shipping `git.exe` would otherwise be executed by every command. `test/core/git.test.ts` fails if a second spawn site appears anywhere under `src/`.
- **Resolve the actor *before* opening a write transaction.** It costs two subprocess spawns, and doing that under `BEGIN IMMEDIATE` holds the exclusive write lock across both. The resolver is lazy, so the first write in a process is where it fires; every write path forces it first and a test asserts `db.inTransaction` is false when it runs.
- **A claim's compare-and-set is TOCTOU-safe by construction: one `writeTx`, never a separate read-then-write.** `claimTask`/`releaseTask` resolve identity before opening `BEGIN IMMEDIATE` — the actor rule above, applied here too — then check the holder and write the change inside that same transaction. A read outside the lock followed by a write inside one lets a second writer see "unclaimed" in the gap and both insert before either commits (spec §11); `test/core/claims.test.ts`'s two-real-process race is what would catch a regression back into that shape.
- **The presence heartbeat is eventless, non-fatal, and worktree-keyed with a fresh window.** `openStore` UPSERTs `presence` for the calling worktree on every command, reads included (ADR-011) — but it writes no event, so history stays exactly what happened to work, never who was breathing; it never fails the command it rides along with, so a broken heartbeat cannot turn a read into a failure; and it skips the write entirely while the row is still fresher than `PRESENCE_FRESH_MS` (30s), keyed on the worktree alone, so most commands cost nothing extra and a branch rename inside that window is picked up by the next write that does land.
- **`appendEvent` runs inside the caller's transaction and opens none of its own** — it throws if there is no transaction. An entity change and the event recording it commit together or not at all. Note that wrapping it in its own transaction does *not* break that: better-sqlite3 turns a nested transaction into a savepoint, so the obvious mutation proves nothing.
- **`appendEvent`'s guard means "inside a *write* transaction", and `db.inTransaction` alone cannot say that.** A deferred read sets the same flag, so once `readTx` existed the check passed inside one and the insert went on to attempt a lock upgrade it cannot get. `assertNotReadOnly` is the second half; `writeTx` consults it too.
- **Multi-statement reads that must agree with each other go inside `readTx`** (`db.transaction(fn).deferred()`). Under WAL the snapshot is pinned at the first read statement and held for the transaction. `board` needs it: five queries whose answers must describe one store, run constantly alongside other worktrees writing. Deferred, never `.immediate()` — a read that took the write lock would make the most-run command a source of contention. Nothing inside may write, and that is enforced rather than documented.
- **`katra migrate beads`'s preview never opens a store.** Without `--apply`, the command reads the export and prints the report without calling `withStore` at all — a preview has to be safe to run against a repo with no store, or none it's allowed to touch yet, and the only way to guarantee that is to never open one.
- **The migration loader is the one bulk-historical writer, and it still goes through every `*Within` seam.** `beads/load.ts` never raw-`INSERT`s a row or hand-builds an event row — every task/note/dependency/link goes through `createTaskWithin`/`createNoteWithin`/`addDependencyWithin`/`addLinkWithin`/`applyMoveWithin`, and every event through the same `appendEvent` every other write path uses, just with a caller-supplied historical timestamp instead of `writeTx`'s own clock. A seam that owns its own validation once is safer than a bulk loader trusted to reimplement it correctly for 146 records at once.
- **Never add a `RETURNING` clause to a write on `tasks` or `notes`.** Both carry `AFTER INSERT/UPDATE/DELETE` triggers that sync the FTS5 search index (ADR-013), and `RETURNING` combined with a table that has triggers is a known `better-sqlite3` bug class (#654/#1003) — dormant on the version this project pins, but unresolved upstream. `src/` has zero `RETURNING` today; keep it that way rather than reintroducing a landmine the next dependency bump could step on.
- **The search index is synced by triggers inside the same write transaction as the row change, never rebuilt at read time.** `search` only reads; nothing about the FTS5 index is maintained when a query runs (ADR-013).
- **A search query is always literal text, never interpreted FTS5 operator syntax.** `matchExpression` (`search-query.ts`) phrase-quotes every token before it reaches `MATCH`, so `AND`/`OR`/`NEAR`/`*`/quotes typed by a user are inert characters in a quoted phrase, not operators — an operator-laden query matches literally or returns nothing, it never changes what the query means.
- **A ref's canonical form comes from `refs/parse.ts`, nowhere else.** Core recognizes exactly `github.com` and `linear.app` URLs plus their bare-id forms (ADR-014); external ids derive from matched path segments only (query/fragment/credentials can never survive), and everything else refuses into the `--provider/--id/--url` escape hatch. The parser bounds its own outputs to the DDL CHECKs (SQLite's `length()` stops at the first NUL, so the app-layer screen is the real bound, not the CHECK). One `refs` row per `(provider, external_id)`, shared across tasks: a url backfill onto a null-url row is a real mutation of shared state and events as `url-backfilled` — never a silent no-op.
- **Last activity is computed from the event stream, never from `updated_at`.** Claims and releases append events but never touch a task's `updated_at` — `recent`, `stale`, and search's activity ordering all read `MAX(events.created_at)` for exactly this reason, and reading `updated_at` instead would silently disagree with what actually happened.
- **Text is measured and cut in code points, not UTF-16 code units.** `capText` and `textWidth` in `core/text.ts`; `clamp`, `columnWidth` and `padTo` in `cli/format.ts` all defer to them. The three used `.length`/`padEnd` and only work as a set — an emoji is two code units, so a column sized one way and padded another misaligns every row beside it. The cap lives in **core**, not the formatter, because `brief` bounds a note body inside its assembly and that bound is part of the `--json` document.
- **A task that introduces a published document declares it in full**, including fields a later task populates — `BoardResult` declares `digest` before `--digest` exists. A second task amending a shipped type is how a `--json` consumer ends up unable to tell "does not apply" from "nothing filled it in".
- **Every stored string rendered to a terminal goes through a sanitizer.** `oneLine` for single-line fields, `sanitizeBody` for multi-line ones (it keeps newlines and tabs). Both strip C0/C1 controls, the Unicode line separators (`U+2028`/`U+2029` — invisible to a terminal, line breaks to any other renderer), and the full Trojan Source bidi set including `U+061C` — notes and descriptions are where fetched content and model output land, and `--json` is the verbatim path because its consumer is not a terminal. This covers event `ref` and `entityId` too: those columns have no CHECK constraint, and F7's external refs route qualified ids through `ref`.
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
- **Event types, as implemented:** `created`, `claimed`, `released`, `status-changed`, `note-added`, `closed`, `cancelled`, `reopened`, `deleted`, `ref-linked`, `ref-unlinked`, `ref-status-changed`. Twelve now that F8's migration 0006 widens the `CHECK` — `ref-status-changed` is written by `katra refresh` when an external ref's status actually moves. `deleted`, `cancelled` and `ref-unlinked` are additions the spec's own list does not have (ADR-008; ADR-003; F7 requirement 5). F9's `reconcile` adds **no** event type: its applied moves emit the existing `closed`/`cancelled` with `actor = reconcile` and a reason naming the triggering ref — `events.actor` is unconstrained TEXT, so no migration was needed.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `<type>: <imperative, lowercase, no trailing period>`. Types match the `kind` enum above.

Add a changeset (`pnpm changeset`) for anything affecting the published package.

## Task tracking

This repo currently tracks its own work in [beads](https://github.com/steveyegge/beads) (`bd`), set up in stealth mode — it is local-only and nothing beads-related is committed. Once katra can track itself, the project migrates to katra via the converter described in [`docs/migrating-from-beads.md`](docs/migrating-from-beads.md).

Useful reads: `bd ready` (unblocked work), `bd list`, `bd show <id>`.
