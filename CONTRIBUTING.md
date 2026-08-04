# Contributing to katra

Thanks for considering a contribution. katra is early — the design is settled but the implementation has barely started, so there is a lot of room to help.

## Before you start

**Read [`docs/katra-spec.md`](docs/katra-spec.md).** It is the source of truth for what katra is and isn't. Critically, §2 lists ideas that were **considered and declined** — time tracking, comment threads, a GraphQL query engine, and others. If something looks missing, check there first: it may be a deliberate omission rather than a gap.

A few decisions are non-negotiable and PRs that violate them will be closed:

- **katra is complete standalone.** Every core feature works with zero providers installed, no network, and no external tracker.
- **External integration is strictly one-directional.** katra *reads* external trackers. It never writes to them — no comments, labels, status pushes, or backlinks. The provider interface has no `write` method by construction.
- **katra never reacts automatically to external state.** Task state changes only from an explicit command.
- **The database is never committed.** It lives inside `.git/` on purpose.

## Getting set up

Requires **Node ≥ 22.12** and **pnpm** (`corepack enable` gets you pnpm).

That floor comes from the dependencies, not preference: `better-sqlite3` 13 requires Node ≥ 22 and `commander` 15 is ESM-only and requires ≥ 22.12.

```bash
git clone https://github.com/itsacoyote/katra.git
cd katra
pnpm install
pnpm check     # lint + typecheck + test — run this before pushing
```

`better-sqlite3` is a native addon, but it ships prebuilt binaries for Linux, macOS, and Windows, so a normal install needs no compiler. If your platform has no prebuild and it falls back to compiling, you'll need build tools (`build-essential` on Debian/Ubuntu, Xcode Command Line Tools on macOS).

pnpm blocks dependency build scripts by default; `better-sqlite3` and `esbuild` are allowlisted in `pnpm-workspace.yaml`, so this is already handled.

## Workflow

1. **Open an issue first** for anything non-trivial. It's cheaper to discuss an approach than to review a PR built on the wrong one.
2. **Branch from `main`**, named `<type>/<short-description>` (e.g. `feat/task-claims`, `fix/partial-id-match`).
3. **Write tests.** New behavior needs coverage; bug fixes need a regression test.
4. **Add a changeset** if your change affects the published package:
   ```bash
   pnpm changeset
   ```
   Pick the bump level and write one sentence for the changelog. Docs-only and CI-only changes don't need one.
5. **Open a PR** and fill in the template.

## Commit messages

katra uses [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <imperative, lowercase, no trailing period>
```

Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`.

This isn't just style — katra's own task `kind` field uses the same set, so a task's kind lines up with the commits it produces.

## Code style

Formatting and linting are handled by [Biome](https://biomejs.dev/) — run `pnpm lint:fix`. Don't hand-format.

TypeScript conventions:

- **`strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`** are on. Don't loosen them.
- **Prefer `unknown` over `any`.** `noExplicitAny` is an error.
- **Prefer `satisfies` over `as`.** Validate without destroying inference.
- **Derive types from values** (`as const` + indexed access) rather than maintaining a parallel type by hand.
- **Model states as discriminated unions** with `never` exhaustiveness checks.
- **Validate data crossing runtime boundaries.** A type assertion is not validation.

## Architecture rules

- **Library core, thin CLI wrapper.** Logic goes in `src/core/`; `src/cli/` only parses, calls, and formats. This keeps a future MCP surface a wrapper instead of a rewrite.
- **The core never mentions exit codes.** It throws a `KatraException` carrying a structured detail; exactly one table in `src/cli/output.ts` maps those to process exit codes. A future MCP surface catches the same exceptions and maps them its own way.
- **`openStore` is the only way to get a database handle.** The pragmas that make a connection safe — `foreign_keys`, `busy_timeout` — are per-connection, so a handle obtained anywhere else silently loses them.
- **Every write goes through `writeTx`**, which uses `BEGIN IMMEDIATE`. The deferred default loses about a third of its writes to `SQLITE_BUSY` under six concurrent processes, and `busy_timeout` does not save it.
- **Every read command supports `--json`.** An agent parsing formatted text is a silent-misread bug waiting to happen.
- **Bodies come from stdin or `--body-file`**, never inline args — shell escaping is the main CLI failure mode for writes with bodies.
- **Blocked actions explain themselves.** Never refuse silently; say what blocked it and what would unblock it.
- **Events are append-only and immutable.** Never edit or delete one. An editable history isn't trustworthy.

## Reporting bugs

Use the issue templates. For a bug, include your OS, Node version, katra version, and the exact command plus its output.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be decent to each other.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
