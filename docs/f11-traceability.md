# F11 traceability — agent hook adapters (Tier-1 delivery)

Acceptance criteria from epic `katra-9aw.70` mapped to the tests that prove them.
"Falsifiable?" records whether the cited tests directly assert the failure mode the
criterion names (a seeded takeover, a staleness variant, a malformed input) — not that an
independent mutation pass was run against this cycle's code, which is not yet recorded on
the epic (unlike F10's).

| # | Criterion | Tests | Falsifiable? |
|---|---|---|---|
| 1 | `guard` allows when the worktree holds its task, holds nothing with no displacement history, has re-coordinated, or the rival is stale; denies with a reason when a different **live** worktree holds a task it was displaced from and never re-coordinated away from; `--json` mirrors the text verdict | `guard.test.ts` (core) — "denies when another live worktree force-took the in-progress task" (seeded takeover), "allows when the rival's last-seen and claim time are both outside the liveness window" (staleness variant), "allows when the worktree holds no claim and has no claim history", "allows when the worktree still holds its claimed task", "allows once the worktree claims different work after being taken over" (re-coordination), "denies when the worktree already held other work before the takeover", "carries the rival's actor, claim time, and last-seen in the deny verdict", "denies when the rival's claim is old but its presence was just bumped", "denies when the rival's presence is stale but its claim is recent", "denies when the rival has no presence row but its claim is recent", "allows when the worktree released the task itself before the rival claimed", "denies when an older displaced tenure's holder is live even though the most recent one is stale", "reports the most recent live displaced tenure when several exist", "detects a takeover recorded under a different branch than the claim's", "detects a takeover when the displaced claim was made on a detached HEAD", "allows again after the rival releases the taken-over task", "returns the correct verdict with 50 foreign-held claims seeded" (K-bounded reads), "honors a caller-supplied liveness floor"; `guard.test.ts` (cli) — "exits 0 and reports allow when the worktree holds its task", "exits 2 on a live takeover with the sanitized reason on stderr", "mirrors the text verdict in --json", "exits 0 with a warning and no deny when katra was never initialized" (fail-open), "emits a parseable allow document with empty stderr under --json when katra was never initialized", "strips a hostile stored actor's control characters from the deny reason", "ends the deny reason with the release --force unblock hint", "honors --liveness overriding the default window", "exits 0 with a warning when the --liveness value is malformed", "prints no verdict on stdout when the invocation is malformed" | Yes — the takeover and staleness scenarios are dedicated seeded tests by name; not independently mutation-verified this cycle |
| 2 | `release --mine` releases all claims the worktree holds (multiple proven), emits one release event each, reports them, and is a clean no-op on zero; `release <id>` behavior unchanged | `claims.test.ts` (core) — "lists only the caller worktree's claims", "is empty when the worktree holds nothing" (`claimsHeldBy`); "releases every claim the worktree holds and emits one release event per claim", "is a clean no-op when the worktree holds nothing", "leaves other worktrees' claims untouched" (`releaseMine`); `release.test.ts` (cli) — "release --mine reports each claim it released", "release --mine exits 0 and reports nothing held when the worktree has no claims", "release --mine --json lists the released claim ids", "release --mine with an explicit id is a usage error"; unchanged-`release <id>` coverage: "releases an owned claim", "refuses another worktree's claim without --force, exit 3", "force-releases another worktree's claim", "exits 1 releasing an unclaimed task", "exits 1 releasing an unclaimed task even with --force", "emits parseable JSON with nothing on stderr" | Yes — multiple-claims and zero-claims cases are both dedicated tests |
| 3 | `install-hooks claude` produces a settings file with katra's three hooks plus everything pre-existing; a second run is byte-identical; `--print` leaves the file untouched; `--remove` strips only katra's entries. Same for `codex` | `hooks.test.ts` (core) — "merges the three katra hook groups into an empty settings object", "preserves pre-existing user hooks and unrelated settings keys", "changes nothing on a second merge", "normalizes a hand-edited katra entry back to canonical without duplicating it", "still normalizes a drifted variant of the entry's own subcommand", "preserves a user's unrelated katra-command hook at the same touchpoint", "preserves the user's group order when re-merging after a user appended their own group", "removes only katra's entries and leaves user hooks intact", "remove changes nothing when no katra entries are present", "raises a typed error on malformed settings JSON", "raises a typed error on a malformed hook handler"; `install-hooks.test.ts` (cli) — "creates .claude/settings.json with the three katra hooks when none exists", "leaves the file byte-identical on a second run", "preserves pre-existing hooks and unrelated settings on install", "--print emits the hook block and leaves the filesystem untouched", "--remove strips katra's entries and keeps user hooks intact", "--remove against a never-installed repo is a clean no-op", "writes .codex/hooks.json with the same touchpoints for codex", "refuses an unknown agent with a usage error", "--local targets .claude/settings.local.json", "refuses to modify a malformed settings file", "writes into the git toplevel even when run from a subdirectory", "warns that katra init has not run when installing into a repo with no store", "names the target file and its committed visibility in the install report", "refuses to write anything outside a git repository" | Yes — idempotence, preservation, and removal are each dedicated tests for both agents |
| 4 | The installed Claude Code config invokes `board --digest` at SessionStart, `guard` at PreToolUse on `Edit\|Write\|NotebookEdit`, and `release --mine` at SessionEnd (config level); live hook firing is a documented manual smoke check | `hooks.test.ts` (core) — "wires board --digest to SessionStart, guard to PreToolUse on the file-editing tools, and release --mine to SessionEnd for claude", "restricts SessionEnd to the logout, prompt-input-exit, and other reasons", "sets an explicit timeout on the SessionEnd entry", "maps the same three touchpoints for codex" | Yes at the config level; live hook firing is not automated — an accepted manual smoke check, matching F10's own precedent for live-dogfood items |
| 5 | `AGENTS.md` has a Tier-1 setup section; ADR-019 and ADR-020 exist, are Accepted, and are linked from the epic; `katra-9aw.6`'s agent-adapter half is marked resolved | `AGENTS.md`'s "Tier-1 setup: hook adapters" section (this task); `docs/decisions/ADR-019-guard-is-task-level-takeover.md` and `docs/decisions/ADR-020-tier1-adapters-over-abstract-touchpoints.md`, both `Status: Accepted`; the epic body's requirement 8 and acceptance criterion 5 link both ADRs; `katra-9aw.6` comment recording the agent-adapter half resolved | No — a documentation/process criterion; verified by direct inspection of the artifacts this task produced, not an automated test |

## Decisions that moved during the cycle (recorded on the epic)

- **Deny = exit 2, scoped to the confirmed-takeover arm only** — chosen as the one
  agent-agnostic signal (no per-agent stdout schema, no dependency on the agent parsing
  katra's own output) over a per-agent `--hook <agent>` flag emitting a JSON
  `permissionDecision` on stdout. The reasoning moved mid-cycle: round-2 of plan review
  justified exit 2 by claiming the JSON channel is "overridable" by permission allow-rules
  and permissive modes; round 3's corrigendum retracted that — current docs show a JSON deny
  blocks exactly as unconditionally as exit 2 does — and re-grounded the choice on
  agent-agnosticism alone. `guard` has no per-agent flag; every failure inside the handler
  (no store, a locked/corrupt database, a malformed `--liveness`, any exception while
  rendering an already-decided verdict) is caught and reads as allow — fail-open by
  construction, within the binary, across every agent.
- **SessionEnd allow-list `logout|prompt_input_exit|other`, `clear` AND `resume` both
  excluded, with an explicit timeout.** Releasing on `/clear` or `resume` breaks
  resume-after-reset (ADR-012; own-claim-first ranking in `tasks/next.ts:83`) and lets a
  rival's later, ordinary claim look like a voluntary self-release — permanently disarming
  guard for that tenure. Claude Code's default SessionEnd budget (~1.5s) is too tight for a
  cold node start + SQLite open + migrate + write tx, so the wire contract sets an explicit
  `timeout: 10` (seconds); Codex clamps `SessionEnd` to a hard `[1, 3]` ceiling
  (`SESSION_END_MAX_TIMEOUT_SEC = 3`), so the Codex adapter writes `timeout: 3` — the real
  value Codex will honor — rather than repeating Claude Code's `10` and having it silently
  downgraded.
- **The bounded (recency-gated) tenure rule.** Guard does not track a single "in-progress
  task" — it walks every task the worktree was ever displaced from that some other worktree
  still holds, and denies iff *any* surviving tenure is live and un-re-coordinated, reporting
  the most recent live one (a stale most-recent tenure must never mask an older one whose
  rival is still live). Liveness is recency-gated: a rival's claim is live iff the later of
  its presence `lastSeen` and its own `claimedAt` is at or after a floor, default 60 minutes
  (`GUARD_LIVENESS_DEFAULT_MS`) — deliberately not the unrelated `PRESENCE_FRESH_MS` (30s)
  write-skip window, two orders of magnitude off for this purpose since a Tier-0 rival only
  heartbeats when it runs a katra command. `--liveness` overrides the default with an
  explicit duration or ISO instant.
- **Any-live-tenure deny, re-coordination gate.** A worktree currently holding nothing is not
  automatically an allow: if it was displaced from a task another live worktree still holds,
  and has not claimed anything else since that displacement, guard denies. Claiming something
  else *after* the displacement (re-coordination) clears it; a claim held *before* the
  displacement does not.
- **`worktreeFromActor` parse exception in displacement detection.** A takeover is recognized
  by parsing the worktree half out of the stored `prior_actor`/`actor` fused strings
  (`worktreeFromActor`), never by comparing the fused strings directly — so a takeover
  recorded under a different branch than the original claim, or where the displaced claim was
  made on a detached HEAD, is still detected correctly.
- **Codex's hooks flag resolved before implementation.** The Research-phase open question
  (an experimental flag, unpinned config location) resolved to: hooks default-enabled since
  ~v0.133.0 (May 2026), config pinned to `.codex/hooks.json` at the project level, confirmed
  against the `openai/codex` Rust source directly. ADR-020 is amended accordingly (see its own
  amendment note) — the adapter's best-effort framing now rests on verified upstream
  reliability bugs, not a stale feature-flag claim.

## Known limits

- **ADR-007 path recycling inherited unmitigated.** Worktree identity is the absolute
  worktree path; a deleted-and-recreated worktree at the same path is indistinguishable from
  the original, for guard and `release --mine` alike, same as every other claims-reading
  command.
- **SessionEnd is unreliable on a crash.** A hard kill never fires the hook, so
  `release --mine` never runs and the claim dangles — the same stale-claim shape every other
  crash leaves, cleared by `release --force` informed by the liveness a rival's guard call
  reports.
- **Usage-path exit-2 is a loud, not a silent, known limit.** Commander's own usage-error path
  (an unknown flag or command) also exits 2 and never reaches `guard`'s handler to be caught
  and turned into allow — so a hand-edited hook line, or an older `katra` binary invoked
  before `guard` existed, blocks unconditionally rather than failing open. Self-correcting
  (update `katra`, fix the hook line) and distinguishable from a real deny only by the stderr
  text; deliberately not silenced with a shell `|| true` wrapper, which would disarm every
  real deny along with it.
- **Store-less repo hook banners — the install-time warning is the mitigation, not a fix.**
  `install-hooks` warns rather than refuses when no store exists yet, but the installed
  SessionStart/SessionEnd hooks still error at every session boundary until `katra init` runs.
- **`release --mine` is worktree-scoped, not session-scoped.** Two agent sessions running in
  the same worktree share one identity and one claim set; the first session's SessionEnd
  releases claims the second session is still working from.
- **Guard's <1s latency claim, and live hook firing in either agent, are manual smoke checks —
  not automated.** ADR-019 itself notes the budget is a target, not an enforced deadline:
  guard sets no timeout of its own around the store open or its reads, so a slow `git`
  subprocess resolving identity, or SQLite's `busy_timeout` retrying a held write lock, can in
  principle run past it — latency only, never correctness, since a slow verdict still resolves
  to the right answer once it returns.
- **Codex is best-effort; the `--print-only` off-ramp did not fire.** The wire schema was
  confirmed against Codex's own source, so `install-hooks codex` writes `.codex/hooks.json`
  for real rather than falling back to print-only. Open upstream bugs remain, unresolved by
  this cycle: project `.codex/hooks.json` can be silently misresolved when Codex runs inside a
  git worktree — katra's whole architecture (openai/codex#27133, #23996); `PreToolUse` deny is
  not always reliably enforced for `apply_patch`, the before-edit touchpoint itself
  (openai/codex#27833, #39872); `codex exec` skips repo hooks entirely (openai/codex#26383).
  Separately, Codex's hard 3s `SessionEnd` cap may not be enough for a cold-start
  `release --mine` (node start + git rev-parse + SQLite open + migrate + one write
  transaction) — a known limit of the adapter's timeout value, not a bug in what it writes.
- **Path-prefixed katra recognition limit.** Recognition requires the command's first
  whitespace-separated token to be exactly `katra` — a hand-edited command like
  `/usr/local/bin/katra guard` or `npx katra guard` is not recognized as katra's own. The next
  `install-hooks` run adds a duplicate canonical entry beside it instead of normalizing it,
  and `--remove` leaves the hand-edited one behind. Correct-by-design (katra only ever
  reclaims what it wrote), but foreseeable given how naturally an agent or user might edit a
  hook line to be explicit about the binary path.
- **`install-hooks`' settings write is last-writer-wins, not compare-and-swap.** The
  read-merge-`writeAtomic` sequence has a sub-second window between reading the target file
  and renaming the new one into place; a concurrent edit to the same settings file inside that
  window is silently discarded. `writeAtomic` guarantees no torn file, nothing more. Accepted
  as an on-the-record limit — the unchanged-skip path (a merge that decides nothing changed)
  is safe regardless, since a stale read there only ever skips a write it would have skipped
  anyway.
- **`writeAtomic` gained mode preservation this cycle** (`src/core/fs.ts`, extracted from
  `snapshot/export.ts` under task `.9`, mode preservation landing under task `.11`'s security
  review rather than `.9` itself): a rewrite now preserves an existing target's permission
  bits instead of silently loosening them to the umask-default create mode. This is a behavior
  change that also affects the pre-existing `snapshot` caller — a user-tightened
  `.katra/snapshot.jsonl` mode now survives a re-snapshot; a fresh file's mode is unaffected.
  Covered by `fs.test.ts` (core) — "preserves the target file's mode across a rewrite"
  (POSIX-gated: exact permission bits are meaningless on Windows).
