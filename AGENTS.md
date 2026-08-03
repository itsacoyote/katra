# AGENTS.md

Instructions for AI coding agents working **on the katra repository**. This is the single source of truth; agent-specific files (`CLAUDE.md`, etc.) point here.

> Later, this file will also carry katra's own *runtime* workflow instructions — how an agent should use the `katra` CLI in any project (session-start digest, claim before working, release when done). That section lands when the CLI does. For now this covers contributing to katra itself.

## What katra is

A local, git-native, agent-first project manager and coordination layer for AI coding sessions across git worktrees. Read [`docs/katra-spec.md`](docs/katra-spec.md) before doing anything substantial — it is the settled design, including rationale.

**Status: pre-alpha.** The spec exists; the implementation does not. Don't assume a command works because the spec describes it.

## Project layout

```
src/index.ts      library core — all logic lives here
src/cli.ts        thin CLI wrapper — parse, call, format; no logic
test/             vitest tests
docs/             spec and design notes
scripts/          maintenance and migration scripts
```

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
- **Bodies via stdin or `--body-file`**, never inline args.
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
- **Note kinds:** `general | decision | handoff | acceptance`
- **Event types:** `created`, `claimed`, `released`, `status-changed`, `note-added`, `ref-linked`, `ref-status-changed`, `closed`, `reopened`

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `<type>: <imperative, lowercase, no trailing period>`. Types match the `kind` enum above.

Add a changeset (`pnpm changeset`) for anything affecting the published package.

## Task tracking

This repo currently tracks its own work in [beads](https://github.com/steveyegge/beads) (`bd`), set up in stealth mode — it is local-only and nothing beads-related is committed. Once katra can track itself, the project migrates to katra via the converter described in [`docs/migrating-from-beads.md`](docs/migrating-from-beads.md).

Useful reads: `bd ready` (unblocked work), `bd list`, `bd show <id>`.
