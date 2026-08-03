# katra

> **Status: pre-alpha.** The design is settled and written down; the implementation has not started. Nothing here works yet. See [`docs/katra-spec.md`](docs/katra-spec.md).

**katra** is a local, git-native, **agent-first** project manager and coordination layer for AI coding sessions working in a single repo across multiple git worktrees.

Named for the Vulcan *katra* — stored consciousness that can be carried and later restored. That is the whole idea: context that survives the end of a session.

## The problem

An AI coding session starts cold every time. It doesn't know what the last session did, what was decided and why, or what another session in a sibling worktree is touching right now. Existing trackers are built for humans reading a web UI, and the ones that aren't tend to commit their database into the repo, where it turns into merge conflicts.

## The idea

- **Agent-first.** In the ideal case a human never touches katra directly — they get information *through* the agent. Every read has a `--json` mode, and `katra brief <task>` assembles a whole working context in one call.
- **Git-native, zero-ceremony.** One SQLite database under your repo's shared git dir. Every worktree resolves to the same store. It is gitignored by construction, so there is no binary merge conflict to have.
- **Daemon-free.** No server, no port, no background process. It's a file and a CLI.
- **External refs are augmentation, never a requirement.** katra links to GitHub issues/PRs (Linear and Jira later) through pluggable providers, and it **only ever reads them**. With no provider installed and no network, every core feature still works.

## Planned surface

| Command | What it does |
| --- | --- |
| `katra brief <epic\|task>` | The context-pack — item, tasks, blockers, recent activity, notes. The headline feature. |
| `katra next` | Hand back the highest-priority *ready* task. |
| `katra search` / `recent` / `stale` | Full-text (SQLite FTS5) plus structured filters. |
| `katra board` | Recent cross-entity activity; `--digest` at session start. |
| `katra claim` / `release` | Cross-worktree coordination with atomic compare-and-set. |
| `katra refresh` / `reconcile` | Read external refs; explicitly advance tasks from them. |

Full command design lives in the [spec](docs/katra-spec.md).

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

## Migrating from beads

katra ships a converter for projects already tracking work in [beads](https://github.com/steveyegge/beads). See [`docs/migrating-from-beads.md`](docs/migrating-from-beads.md) for the field mapping and what does and doesn't carry over. (Not implemented yet — the mapping is designed, the script is pending katra's schema.)

## Contributing

Contributions are welcome. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md), and please read the [spec](docs/katra-spec.md) first — it records which ideas were **considered and declined**, so you can tell a gap from a deliberate omission.

## Prior art

katra owes ideas to [beads](https://github.com/steveyegge/beads), [tk](https://github.com/wedow/ticket), [beans](https://github.com/hmans/beans), and [aweb](https://github.com/awebai/aweb). The spec's §14 explains what each got right and where katra diverges.

## License

[MIT](LICENSE) © itsacoyote
