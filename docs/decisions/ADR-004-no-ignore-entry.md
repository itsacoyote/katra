# ADR-004: katra writes no ignore entry

## Status

Accepted

## Date

2026-08-03

## Supersedes

The `init` ignore-entry clause in `docs/katra-spec.md` §3, and the "and is gitignored" phrasing in `AGENTS.md` rule 4.

## Context

The design spec says the store is "gitignored, never committed" and that `katra init` "also writes the ignore entry." `AGENTS.md` restates this as a non-negotiable rule.

The store lives at `<git-common-dir>/katra/katra.db` — that is, **inside `.git/`**. Git does not track anything there. Verified against a real repository:

```
$ git status --porcelain          # after creating .git/katra/katra.db
                                  # (empty)
$ git check-ignore -v .git/katra/katra.db
                                  # no rule matches
$ git ls-files .git/katra/katra.db
                                  # (empty)
$ git add -f .git/katra/katra.db  # silently does nothing
```

So the ignore entry has no target, and the acceptance criterion built on it ("the database is not visible to `git status`") was **vacuously true** — it passed whether or not anything was written, and no implementation could make it fail.

The clause is vestigial. It was written for the earlier file-per-ticket design, where tickets lived in the working tree and genuinely needed ignoring. That design was dropped in favour of a single SQLite database inside `.git/`, and the requirement outlived the thing it protected against.

Two candidate targets were considered for writing an entry anyway, and they differ sharply in blast radius:

- **`.git/info/exclude`** — never committed, therefore harmless, but equally pointless: it would exclude a path git already ignores structurally.
- **The repo-root `.gitignore`** — a **tracked** file. Writing to it means `katra init` dirties the user's working tree on first run, and picks the wrong root when invoked from a linked worktree.

## Decision

**katra writes no ignore entry.** `init` creates the store and reports whether it created or found one; nothing else.

The real invariant worth protecting is inverted and made testable: **katra modifies no tracked file.** Acceptance criterion 4 now asserts that `git status --porcelain` is byte-identical across a representative lifecycle (`init`, `add`, `update`, `close`).

## Consequences

**Good:**

- The acceptance criterion can now fail. Writing to `.gitignore` would surface as `?? .gitignore`, so the test detects the failure mode that actually matters.
- Scoped to the whole lifecycle rather than `init` alone. `init` was the least likely offender; the ongoing risk is any write command, or the WAL and SHM sidecars.
- `init` touches nothing outside `.git/`, so it cannot surprise a user by dirtying their tree.

**Costs / risks:**

- If a future feature ever stores something **outside** `.git/`, it must handle its own ignoring — this decision does not cover that case, and there is no existing entry to extend. F6 snapshots are deliberately *committed*, so they are not affected.
- A third deviation from a rule the project marked non-negotiable. Recorded here for the same reason as ADR-002 and ADR-003: the deviation is deliberate, and the reasoning should survive the person who made it.

## Alternatives Considered

### Write to `.git/info/exclude` anyway

- **Pros:** Belt-and-braces; never committed, so harmless. Some defensive value if the store ever moves out of `.git/`.
- **Cons:** Excludes a path git already ignores structurally. The acceptance criterion would have to be rewritten as a file-contents assertion, since `git status` can never fail on it — testing that we wrote a line whose only purpose is to do nothing.
- **Rejected because:** it preserves the ceremony of the requirement while keeping none of its value.

### Write to the repo-root `.gitignore`

- **Pros:** The only option matching the original wording's apparent intent.
- **Cons:** It is a tracked file. `katra init` would dirty the working tree on first run, and would resolve the wrong root from a linked worktree — the exact multi-worktree case katra is built for.
- **Rejected because:** a tool whose first action is to modify a tracked file has surprised the user before it has done anything useful.
