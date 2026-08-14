# katra — design spec

A consolidated design doc to seed a build session. Architecture and decisions are settled; **schema-level details (exact tables/columns) are intentionally left for the build session.** Rationale is included inline so decisions don't get re-litigated.

---

## 1. What it is

**katra** is a local, git-native, **agent-first** project manager and coordination layer for AI coding sessions working in a single repo (across multiple git worktrees). It tracks tasks and — when needed later — lets parallel sessions coordinate.

Named after the Vulcan *katra* (Star Trek): stored consciousness/memory that can be carried and later restored — i.e. context that persists across sessions.

**Design center:** in the ideal case the human never touches katra directly. It exists for the agent; the human gets information *through* the agent, not by reading files.

---

## 2. Goals & non-goals

**In scope (v1):**
- Track tasks/epics: status, dependencies, links, notes.
- **Reference** external issues/PRs (GitHub, later Linear/Jira) via a generic, pluggable ref — see §7.
- An explicit **reconcile** command that reads external state and can advance katra tasks, with provenance — see §7.
- A broadcast **event board** + per-entity **activity history** sessions read to orient (see §5): tasks created, claimed/released, status moved, refs linked, notes added, closed, etc.
- Comments/notes on tasks and epics, with an optional **kind** (`general | decision | handoff | acceptance`, see §6a).
- Agent-facing reads: **`brief`** (context-pack), **`next`** (ready task), **search** (`search`/`recent`/`stale`, see §6c), and **`--json`** on every read (see §6b).

**Considered and declined (don't build; here so they're not re-raised):**
- Time tracking, estimates, burndown — human-manager instrumentation, useless to the agent.
- Comment threads / discussion — multi-user coordination (aweb territory); deferred deliberately. Handoff + decision notes cover the solo need.
- A query engine / GraphQL — beans went there; scoped reads plus `--json` are enough at this scale.
- Encoding phase exit-criteria in the schema — that's workflow guidance for `AGENTS.md`, not tool structure.

**Core guarantees (non-negotiable):**
- **katra is complete standalone.** Zero providers installed, no network, no external tracker — every core feature (tasks, deps, notes, claims, events, board) works unchanged. External refs are *augmentation*, never a requirement.
- **Strictly one-directional.** katra reads external trackers; it **never writes** to them. The external issue never learns katra exists — no comments, labels, status pushes, or backlinks.
- **katra never reacts automatically** to external state. Task state changes only from an explicit action (an agent/human command), never as a side effect of a read.

**Explicitly deferred (design for it, don't build it yet):**
- Multi-agent point-to-point messaging / message bus. (Sessions currently run isolated; no urgent cross-agent need.)
- Real-time push / MCP channel / any background daemon.
- Blocking `watch` rendezvous (build when parallel agents are a real workflow).
- Auto-reclamation of orphaned claims.
- Cross-machine and cross-repo aggregation (katra is strictly per-repo, single-machine).
- Semantic search over tickets (could add `sqlite-vec` later).
- Any write-back to external trackers (explicitly out of scope, not just unbuilt).

---

## 3. Storage & durability — the core decision

**Single SQLite database** (WAL mode), accessed via `better-sqlite3` (synchronous — no async ceremony in CLI code).

- **Location:** `$(git rev-parse --git-common-dir)/katra/` — the shared common git dir that every worktree resolves to identically regardless of branch. All worktrees hit **one** shared store.
- **Gitignored, never committed.** It lives inside `.git`, so it's inherently out of version control. `katra init` also writes the ignore entry.
- **Do NOT commit the binary DB.** Committing it reintroduces the exact "binary merge / mangling" pain that pushed us off beads/dolt.
- **Task state is global** across all worktrees and branches — no git-branch scoping. This is a *feature* for a cross-worktree PM/coordination tool, but it's a real behavior change from a file-per-ticket model. Named on purpose.

**Durability via snapshots, not versioning.** WAL gives crash-consistency, not undo. So:
- `katra snapshot` exports the DB to diffable text, committed to git, purely as a **disposable backup** for time-travel / restore. It is **not** a source of truth and **not** a review surface (nobody reads it). SQLite is truth; the snapshot is insurance you regenerate.
- `katra restore <snapshot>` rebuilds the DB from a snapshot — for recovering from a bad agent write, or seeding a fresh clone on a new machine.

**Why SQLite (and not the alternatives):**
- Daemon-free, single file, ACID transactions for compare-and-set claims, WAL for safe multi-process concurrency on a local filesystem, most battle-tested durable store in existence.
- No shared-server conflict surface: SQLite is a file, not a daemon — no port, no global database/role namespace, so there is no "existing database" for katra to collide with. Each repo's store is an isolated file under that repo's `.git/`. (This is the Postgres-server hazard — port/db-name/role collisions — that SQLite sidesteps entirely.)
- **PGlite** rejected: it's a single embedded instance per JS runtime and doesn't support multiple OS processes sharing one data dir; sharing requires a leader process/socket — i.e. the daemon we're avoiding. Its "AI" angle is pgvector/RAG, orthogonal to task tracking.
- **dolt** rejected: mangling/complexity; git already gives us history via snapshots.
- **DuckDB / LMDB / RocksDB / Redis / NATS / Postgres** rejected: wrong shape (analytical/KV) or require a daemon.
- Note: the storage engine is invisible to the agent behind the CLI, so "optimize for AI" was never the deciding axis — **concurrency and durability** were.
- One real caveat: SQLite file locking is unreliable on **network filesystems** (NFS/SMB). katra is strictly local, so this never applies.

**Simplification win:** collapsing to one store dissolves the earlier two-plane seam rules. Updating an entity and appending its event is now a **single atomic transaction**, and "what's ready" is one SQL join. No cross-store ordering, no sync, no dual code paths.

---

## 4. Data model (high level — schema TBD in build session)

Entities, conceptually:

- **Tasks / epics:** id, **level**, **kind**, title, description, status, priority, assignee, parent (epic hierarchy), tags, timestamps. See §4a for the level/kind split.
- **Dependencies:** task depends on task (drives `ready` / `blocked`).
- **Links:** symmetric task↔task association.
- **Notes:** durable **artifact** attached to an entity, timestamped, **records authoring worktree/session** (so a later reader can judge staleness). Keep these — distinct from Claude's ambient memory; payoff is cross-session. Each note has an optional **`kind`**: `general | decision | handoff | acceptance` (see §6a) — one field, several high-value uses. Adding one emits a `note-added` event (see §5); the note body lives here, not in the event.
- **Claims:** (task, holder-worktree, claimed_at). Compare-and-set on claim.
- **Presence:** per worktree — last_seen heartbeat, status. Decoupled from claims.
- **Events:** append-only, immutable activity stream — see §5. One table powers the board, the session-start digest, and per-entity activity history.
- **External refs:** task ↔ a **generic, provider-agnostic reference** — `{provider, id, url, cached_status, cached_title, synced_at}`. Core stores and displays it; only a **provider plugin** knows how to resolve it (see §7). IDs are stored **fully qualified** (`owner/repo#12`, `ENG-451`, `PROJ-88`) — never bare numbers.

**Task ↔ external ref cardinality: many-to-many** (one PR/issue can close several tasks; one task can span several PRs/issues). Decide this on purpose — widening later is painful. It also drives the reconcile policy in §7 (all-vs-any).

**Status lanes (decided starting set):** the six workflow phases, one per Define→Document stage —
`Defined → Researching → Ready → In Progress → In Review → Done`.

> **Superseded:** the `Ready` lane is named `Planned` as of [ADR-002](decisions/ADR-002-planned-lane-naming.md), so that "ready" refers only to the computed unblocked-by-dependencies property. The rest of this section stands.
Fixed for now; go user-defined only if the pinch is felt. `status-changed` events record from→to across these lanes.

---

## 4a. Level & kind (two separate axes)

The old single `type` field mixed two different questions. Split them — they filter independently ("show me epics" vs "show me open bugs") and shouldn't compete for one label. **Both are fixed enums, not free text** (same discipline as status lanes and note kinds) — free-text types drift into `Bug`/`bug`/`defect` and break `search --kind`.

- **`level`** — hierarchy: `epic | task`. A `task`'s `parent` points at an `epic`. Add a middle tier (`story`, `subtask`) later only if felt; two is the right start.
- **`kind`** — what the work is, **aligned to Conventional Commits** so a task's kind matches the commit/PR prefix the work produces (a `fix` task yields `fix:` commits; `search --kind fix` later lines up with git history). Starting set:
  `feat | fix | refactor | perf | docs | test | chore`

  Mapping notes: `build`/`ci` fold into `chore` to start (split later only if you want to filter CI work separately); `style` (formatting) lives in commits, not the backlog — dropped; `revert` is an action, not planned work — omitted. This is the standard set minus the types that don't earn a backlog slot.

**This is a real decision, not an inherited placeholder** — the `type` field existed in the spec but hadn't been examined. Tune `kind` to the user's *actual* frequently-used commit types if they differ from the textbook set (e.g. adding `hotfix`/`wip`); the point is that it mirrors their commits.

---

## 5. Activity & event model

The **board and per-entity activity history are the same append-only event stream, read two ways** — not two systems. Every meaningful action appends one immutable event; different `WHERE` clauses produce the board, the session-start digest, and an entity's activity history.

**Event shape (schema TBD):**
- `type` — from a **curated, fixed set** of lifecycle / state-transition events (never field-level diffs).
- `entity` — the task/epic/item it happened to.
- `epic` — the parent epic it rolls up to (**single-level**), stamped at write time so an epic's history naturally includes all its children's activity. Epic-level events stamp themselves.
- `actor` — the worktree/session that did it (free, since worktree = identity).
- `timestamp`.
- `ref` (optional) — e.g. the note id for `note-added`, the external ref for `ref-linked`.

**Curated event types (starting set):** `created`, `claimed`, `released`, `status-changed` (from→to lane), `note-added`, `ref-linked`, `ref-status-changed` (external state moved, e.g. merged), `closed`, `reopened`. Add types deliberately; **never auto-log every attribute edit** — field churn buries the signal, and an over-logged history is one nobody reads.

**Provenance:** events record *why*, not just *what*. An event caused by `katra reconcile` is stamped with `actor = reconcile` and a `reason` naming the ref that triggered it (e.g. *closed — `owner/repo#12` merged*), so the history distinguishes an agent's judgment from a reconcile-derived change. `ref-status-changed` events only exist when a provider is installed and resolving; without one, the board is simply quieter — nothing else changes.

**Rollup: single level (decided).** An event stamps the task and its immediate epic. "Show this epic's activity" = events where `entity = <epic>` OR `epic = <epic>`. Because `epic` is stamped at write time, historical events keep the epic they rolled up to at the time — acceptable for single-level. (If deep nesting or history-follows-reparenting is ever wanted, resolve ancestry at read time instead of stamping. Not now.)

**Notes stay separate from events.** A note is a durable **artifact** (fat content) living on an entity; `note-added` is a thin event that references the note by id. Never inline note bodies into events — keep history a thin stream and notes the fat artifacts.

**Immutable & append-only.** Never edit or delete an event, even when the underlying entity changes. Editable history isn't trustworthy, and an untrustworthy activity log is worse than none.

**One table, three reads:**
- **Board** — recent, global, cross-entity.
- **session-start digest** — recent, global (same query as the board, injected on session open). **Surfaces the latest `handoff` note first** (see §6a) so a cold session resumes with the last session's summary.
- **Entity activity history** — scoped to an entity and its children (via the `epic` stamp), all-time, chronological. This is the "look at an epic and see everything that happened to it and its tasks" view.

No new subsystem — this is the single SQLite store's events table with three `WHERE` clauses.

---

## 6. IDs & identity

- **IDs:** collision-free-without-coordination, because sequential numbers race across parallel worktrees. **ULID** preferred (time-sortable, so listings sort chronologically) or a short random suffix with a tk-style prefix (e.g. `kat-5c46`). Support **partial-ID matching** (`katra show 5c4`) for ergonomics.
- **Identity = the worktree.** One agent per worktree, keyed by worktree path (resolved via git-common-dir + worktree). No session-id minting. If you ever run two sessions in one worktree, layer a session id on top — but the default assumption is one active agent per worktree.

---

## 6a. Typed notes

Notes carry an optional `kind`. Same entity, same storage — the kind just lets reads filter and lets the workflow lean on them. No new tables.

- **`general`** (default) — freeform context.
- **`handoff`** — end-of-session summary: what was done, what's next, the gotcha that'll bite. The **session-start digest surfaces the latest `handoff` first** — this is the direct fix for cold-start amnesia (the claude-mem / beans project-memory lesson).
- **`decision`** — a decision plus its rationale, captured in Define/Plan so settled questions don't get re-litigated. Queryable via `katra decisions <epic>`.
- **`acceptance`** — acceptance criteria on a task, written in Define/Plan and checked in **Validate**. Gives "done" something concrete to validate against instead of agent discretion, and keeps scope from drifting.

Kinds are a small fixed set; add deliberately (same discipline as event types). Nothing else in the model changes.

---

## 6b. Agent reads (built for the consumer)

The agent is the primary reader, so a few read shapes matter as much as the writes:

- **`katra brief <epic|task>`** — the context-pack. Assembles in one call what a session needs to resume: the item, its tasks and statuses, open blockers, recent activity, and attached notes (latest `handoff` first). **Token-bounded — summary by default, `--full` on demand.** This is the katra metaphor made operational: one command restores the working context before I start, instead of a dozen scattered reads or guesswork. (beans reaches for GraphQL to get this; at katra's scale one well-shaped assembly command is enough.) **Highest-value single feature here.**
- **`katra next [task]`** — hand back the highest-priority *ready* task (or the next action on the current one). Accepts the same `--kind` / `--level` / `--epic` filters as search, so "next ready bug" or "next ready task in this epic" narrows the candidate pool — it still returns one item. Thin over the ready/blocked logic; removes flailing at phase boundaries.
- **`--json` on every read** — structured output alongside human text. Parsing formatted CLI text is where an agent silently misreads a field; structured output means reliable extraction, not guessing. (tk already does this.)
- **Rich blocked feedback** — when a claim or start-work is refused, say *why* and *what unblocks it* (`blocked by task Y, in progress in worktree A`), never a silent refusal.

---

## 6c. Finding things (search)

The agent is usually the one searching, and often from vague input ("that auth thing from a couple weeks ago") — so search must be forgiving and return **structured, rankable** results, not a list to eyeball. "Search" is really three needs:

- **`katra search <query>`** — full-text over the fields that carry meaning: titles, descriptions, note bodies. Uses SQLite's built-in **FTS5** — a full-text index for free, no extra dependency, no engine to run. The index is a rebuildable derivation over the store, like everything else. Covers "I remember it was about the OAuth migration" without the ID or exact title.
- **Structured filters, same command** — `--lane <lane> --kind <k> --level <epic|task> --epic <id> --tag <t> --updated-before/after <when>`, usable *with or without* text. Both real examples are filter queries, not text: "what was I working on" = recently-touched, sorted by activity; "an old task lying around" = open with no recent activity.
- **Two named shortcuts** over the events data (§5), because they're the common temporal cases:
  - **`katra recent`** — recently-touched items, activity-sorted. The direct answer to "I don't remember what I was working on" — reads your own event history back to you. Essentially the board data filtered to entities.
  - **`katra stale [--older-than 2w]`** — open items with no recent activity. The direct answer to "bring up that old task lying around." Same events table, inverted.

**Notes:**
- Results ride the `--json` + rankable convention: id, title, status, epic, last-activity, snippet/score — so a search result is actionable or narrowable, not prose to re-parse.
- **Partial-ID match folds in:** `search 5c4` finds the task whose ID starts with that, so a half-remembered ID is a valid query.
- **No semantic/vector search.** Tempting "AI" answer, but it needs embedding infra and is the parked `sqlite-vec` idea (§2 deferred). FTS5 + filters covers every case described. Reserve vectors for "find *conceptually similar* tasks" only if that becomes a felt need — a different, later problem than "find the thing I know exists."

---

## 7. External references (pluggable providers)

katra tracks a **relationship** to an external issue/PR. It is not an integration, a mirror, or a sync target. **GitHub is the first provider, not a dependency.**

**Split: the linkage is core, the resolution is a plugin.**
- **Core** owns the `external_ref` on a task (§4): provider, qualified id, url, cached status/title, `synced_at`. Core can store, display, and link refs with **no plugin installed and no network** — an unresolvable ref renders as a plain link with its last cached values.
- **Providers** are plugins that know how to *read* one tracker. Discovered like tk-style plugins (`katra-provider-<name>` on PATH / as a module), so adding Jira is dropping in a module — **no core changes**.

**Provider interface (read-only by construction):**
- `match(ref) → bool` — is `owner/repo#12` / `ENG-451` mine?
- `resolve(ref) → {state, status, title, url}` — read live (e.g. GitHub via the `gh` CLI; Linear/Jira via their APIs).
- `parse(url) → ref` *(optional)* — paste a URL, get a ref.
- Declares its requirements (`gh`, a token) and **degrades gracefully**: unauthenticated, offline, or missing → return the cached ref marked *unresolved*. Never an error that blocks katra.

There is deliberately **no `write` / `push` / `update` method.** One-directional is enforced by the interface shape, not by convention — a provider *cannot* write back, so the external tracker can never learn katra exists.

**Two verbs, deliberately different blast radius:**

- **`katra refresh`** — pure read. Resolves refs and updates cached status/title/`synced_at`, emitting `ref-status-changed` events. **Never touches katra task state.** Always safe; safe to run in a hook or at any checkpoint.
- **`katra reconcile`** — the explicit action that *may advance katra tasks* based on external state (e.g. PR merged → close the task). **Preview by default; `--apply` to commit.** This is the only path by which external state can change a task, and it never runs implicitly.

**Reconcile safety rules:**
- **Explicit only.** Never triggered by a read, a hook, or a background process. `refresh` is what checkpoints run; `reconcile --apply` is a decision.
- **Policy is configurable, not hardcoded** — a provider-agnostic mapping of external state → katra lane (e.g. *merged → Done*), so switching trackers doesn't rewrite logic.
- **Provenance always.** Every change emits its event with `actor = reconcile` and a reason naming the triggering ref (*closed — `owner/repo#12` merged*). No silent state changes.
- **Never act on unresolved refs.** Offline / auth failure / missing provider is a **no-op** — never interpret "couldn't read it" as "it's gone."
- **Forward-only by default.** Advance tasks (e.g. → Done); never auto-reopen or move backward. Backward transitions surface as suggestions only.
- **Respect live claims.** Skip (and report) tasks actively claimed by another worktree — never yank state out from under a running session.
- **Multi-ref rule (many-to-many).** One of three linked PRs merging ≠ done. Default to **all** linked refs satisfying the policy before advancing; configurable to *any*.
- **Idempotent.** Safe to re-run; acts only on diffs from cached state.

**Never** does katra's own logic depend on external state: `ready`/`blocked`, dependency resolution, and lanes are computed **purely from katra's own data**. External status is displayed reference information the agent can read and act on — it never silently drives katra's model.

---

## 8. Interface

- **CLI-first** (`katra ...`), agent-driven. All actions go through the CLI.
- **Library core + thin CLI wrapper.** Build the logic as a plain TS module; the CLI is a thin surface over it. This keeps a later MCP surface a wrapper, not a rewrite.
- **MCP held in reserve.** For a greenfield tool the "agent knows the CLI better" familiarity advantage is null on both sides, and the CLI wins on context-budget and universality. MCP's one unique benefit here is pushing events into a live session — which needs a daemon. Add MCP **surgically** later if a specific operation demands it. (Pattern validated by aweb: MCP for inbound push, CLI for outbound actions.)
- **Discoverability:** workflow instructions live in `AGENTS.md` — the cross-agent convention Claude Code, Codex, and Pi all read — plus `katra help`. Agent-specific files (`CLAUDE.md`, etc.) just reference `AGENTS.md` so there's one source of truth. No per-command MCP schema tax.
- **Bodies via `--body-file`.** Note/message bodies (arbitrary text, code, quotes) are read from a file, or from stdin with the conventional `--body-file -`, not inline args — sidesteps shell-escaping, the main CLI failure mode for writes-with-bodies. Bare stdin is deliberately *not* read: a command that never mentions the description must not change it just because the caller's shell redirected fd 0.

---

## 9. Delivery & awakening (agent-agnostic)

Agents are turn-based and pull-only: no clock, no background thread, can't be interrupted mid-turn. So "delivery" happens at turn boundaries. Structured in two tiers so katra works on **any** agent, with richer behavior where hooks exist. (The CLI itself is already agnostic — every agent can run a shell command; only this delivery layer needs per-agent glue.)

**Tier 0 — universal baseline (any shell-capable agent, zero hooks).** The CLI plus `AGENTS.md` instructions: run `katra board --digest` at session start, check the board at workflow checkpoints (before claiming, after finishing a unit, before committing), `katra claim` before working and respect a conflict, `katra release` when done. Pure pull. Works identically on Claude Code, Codex, Pi, or a bare shell.

**Tier 1 — per-agent hook adapters (optional enhancement).** katra defines delivery as ~4 abstract touchpoints and ships a thin adapter per agent mapping each to a CLI call:
- **on-session-start** → inject the board digest.
- **before-edit/tool** → `katra guard <target>`: deny the edit if another live worktree holds the claim (enforced collision safety).
- **on-stop/settled** → check for unread; force the agent to keep working instead of idling (**guard against infinite loops** — only when genuinely new).
- **on-session-end** → `katra release` on graceful exit.

Adapter mechanics differ; the touchpoints don't:
- **Claude Code** — `hooks.json` in `.claude/settings.json` (SessionStart, PreToolUse, Stop, SessionEnd).
- **Codex** — the *same* `hooks.json` event schema (in `.codex/` or `config.toml`), behind its experimental hooks flag. Largely shareable with the Claude adapter.
- **Pi** — a small `.pi/hooks/*.ts` module calling the same CLI on Pi's lifecycle events (tool-call interception, before-LLM injection, `agent_settled`).

Hooks are an *enhancement* (automatic + enforced), not a requirement. Where an agent lacks a touchpoint, that behavior degrades to the Tier-0 pull equivalent: enforced lock guard → advisory `claim` conflict; stop-force-continue → caught by the next session-start digest.

**Blocking `katra watch --for <cond>`** (with timeout) for *solicited* waits (orchestrator→worker rendezvous) is **deferred** until parallel work is real.

**Constraints:**
- Hook handlers block the session and must be **fast (<1s)** — do only the cheap indexed check, never heavy work.
- **No true real-time push** (that's the daemon line — deferred). The board + session-start digest is the near-term delivery model.
- **Latency floor:** turn-boundary delivery means worst-case latency = length of the current uninterruptible action. Fine for coordination; for collisions use the before-edit guard instead.
- Make the board check a **single indexed query** so "check often" is nearly free.

---

## 10. Liveness & claims

- **Presence = heartbeat:** a stored `last_seen`, **bumped as a side effect of every `katra` CLI call** — so presence works on any agent with no hooks required; hooks (where present) just add extra heartbeat points. **Staleness is computed at read time** — no background reaper.
- **Decoupled from ownership.** Claims do **not** auto-expire. An idle-but-alive session (still heartbeating) holds its claim **indefinitely** — which is the desired behavior.
- **No auto-reclaim in v1.** A contended claim surfaces "held by X, last seen Ym ago"; provide **manual** `katra release --force`. (Validated by aweb, which decouples presence from claims and does not auto-reclaim.) Rationale: idle-vs-dead is undecidable by observation; don't make an automated decision that can't be made correctly.
- **Explicit close is the clean 95%:** `katra release` / session close; the per-agent **session-end** adapter does it on graceful exit. Heartbeat machinery exists only for the crash/kill/disconnect minority (session-end hooks don't fire reliably on crash).
- **If reclamation is added later:** make it visible + event-logged + reversible; a returning session must re-verify ownership before resuming; keep it **TOCTOU-safe** by folding the staleness check into the same guarded `UPDATE`.
- **Two timescales:** "actively working right now" (short) is a different question, with a different threshold, than "still holds the claim" (long/indefinite while heartbeating).

---

## 11. Concurrency correctness

- **Claims = atomic compare-and-set:** in one transaction, check if held by another worktree; if not, insert/update.
- **WAL mode + `busy_timeout`** to absorb the rare write collision by retrying.
- **Keep transactions short** — never hold one open across an agent's thinking.
- Keep the event-append path cheap and well-indexed so activity churn doesn't contend with reads.

---

## 12. Lifecycle

- **`katra init`:** creates the DB under git-common-dir, writes the `.gitignore` entry, fails gracefully when run outside a git repo. Walks up from `cwd` to find the git root so it works from any subdirectory.
- **Same machine, multiple worktrees:** all worktrees share the one DB — no rehydration needed.
- **Fresh clone on a new machine:** the gitignored DB starts empty (correct). To repopulate task history, `katra restore` from the latest committed snapshot. (This is the one lifecycle cost of dropping committed files: a new machine needs a restore to seed. Acceptable given single-machine use.)

---

## 13. Tech stack

- **TypeScript.**
- **`better-sqlite3`** (synchronous SQLite). Search uses built-in **FTS5** (a rebuildable full-text index over titles/descriptions/notes — §6c); no extra search dependency.
- **Library core + thin CLI wrapper.**
- **Agent adapters (thin, over the same CLI):** Claude Code (`hooks.json`), Codex (shared `hooks.json` schema, behind its hooks flag), Pi (`.pi/hooks/*.ts` module). `AGENTS.md` is the shared instruction file. Adding a new agent = one small adapter, no core changes.
- Distribution: `npx` / global npm install (bundled binary a later option).
- **Crib from `tk` (wedow/ticket):** random-ID scheme, partial-ID resolution, `ready`/`blocked`/dependency-cycle algorithms, and the plugin-dispatch pattern (`tk-<cmd>`/`katra-<cmd>` executables in PATH) — **adapted to SQLite storage** instead of files. (Glance at tk's LICENSE if porting actual code; reimplementing the ideas in TS is clean.)
- Note: `gray-matter` and ripgrep are **not** needed — those were for the dropped file-based tracker.

---

## 14. Prior art / references

- **beads** (steveyegge/beads) — what we're migrating from. Pains: aggressive install, hard removal, SQLite/dolt sync mangling, sequential-ID races. katra fixes each.
- **tk** (wedow/ticket) — the minimal, file-based beads replacement (single bash script, markdown files, `migrate-beads`, plugin architecture). We crib its tracker design. Does the tracker half well; its `--external-ref` is an inert string with no resolution, and it has no coordination. katra diverges by using SQLite (human-review isn't valued) and adding coordination + pluggable ref resolution.
- **beans** (hmans/beans) — agent-first tracker: markdown files + GraphQL query engine, TUI, growing Svelte web app, `beans prime` SessionStart hook. Closest existing tool to katra's tracker half, but files-committed, no live GitHub, heavy/churning, server for multi-agent.
- **Tasks** (Claude Code built-in) — free, native task/deps/session-coordination. No repo awareness, no GitHub, no durable board.
- **aweb** (awebai/aweb) — the maximal cross-machine/multi-user endgame (Postgres+Redis+FastAPI, identity/E2E, MCP push-channel + CLI actions). Validated several katra choices: worktree-awareness, presence-decoupled-from-claims, no-auto-reclaim, poll-default-with-opt-in-push. katra stays local/daemon-free; **aweb is the off-ramp** if this ever becomes serious cross-machine parallel work.

**Why build katra despite the above:** none of Tasks / tk / beans does katra's two core needs — **pluggable external-issue linkage** (GitHub now, Linear/Jira later, none required), and **daemon-free cross-worktree coordination** (claims/presence/activity via a gitignored shared store). katra's justified scope is that delta; the tracker half is cribbed, not reinvented.

---

## 15. Open questions for the schema/build session

- Exact table/column schema for every entity (tasks, deps, links, notes, claims, presence, events, external refs).
- Final ID scheme (ULID vs short-random) + human alias handling.
- Snapshot serialization format (faithful, restorable; format is only for git-diffability since no human reads it).
- Modeling task↔external-ref many-to-many and the cached-status shape.
- The default reconcile policy map (external state → lane) and whether the multi-ref rule defaults to *all* or *any*.
- Which providers ship at launch (GitHub via `gh` is the reference implementation; Linear/Jira later).
- Which agent adapters ship at launch (Claude Code / Codex / Pi) and the exact fast-check CLI calls each touchpoint runs.
- Whether the spec document produced in the Define phase is referenced by katra (as an external link/note) or lives entirely outside katra. (katra is not a document store; it tracks the tasks derived from the spec.)
