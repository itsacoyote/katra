/**
 * Codex's hook wiring (F11, `katra-9aw.70.10`) — the same three touchpoints
 * as `adapters/claude.ts`, over Codex's own hooks schema.
 *
 * **Schema confirmed against the `openai/codex` source itself**, not a
 * third-party doc mirror: this task's verification duty found that
 * `developers.openai.com/codex/hooks` redirects to unofficial-feeling
 * pages whose content (field names, exit-code semantics) reads almost
 * identically to Claude Code's own docs — plausible given Codex's hooks
 * genuinely are modeled closely on Claude Code's, but not something to
 * install a settings-mutating schema on faith. The open-source
 * `openai/codex` repo's Rust source is the ground truth for what the CLI
 * actually parses and executes, and confirms the third-party pages were
 * substantively correct:
 *
 * - **Config shape.** `codex-rs/config/src/hook_config.rs`'s `HooksFile` /
 *   `HookEventsToml`: a top-level `hooks` object keyed by PascalCase event
 *   name (`PreToolUse`, `SessionStart`, `SessionEnd`, …), each an array of
 *   `MatcherGroup { matcher?: string, hooks: HookHandlerConfig[] }` — the
 *   identical shape `types.ts`'s `HookEventMap`/`HookMatcherGroup` already
 *   models for Claude Code.
 * - **Handler fields.** `HookHandlerConfig::Command`: `type: "command"`,
 *   `command`, and `#[serde(rename = "timeout")] timeout_sec: Option<u64>`
 *   — the *serialized* key is `timeout`, confirming
 *   openai/codex#35382's "timeout vs timeout_sec" drift resolves in
 *   `timeout`'s favor; `timeout_sec` is only the Rust field's internal
 *   name, never written to the file.
 * - **Matcher semantics.** `codex-rs/hooks/src/events/common.rs`'s
 *   `matches_matcher`/`is_exact_matcher`: an all-alnum/`_`/`|` string is an
 *   exact-match list split on `|` (no comma, no spaces — narrower than
 *   Claude Code's own grammar); anything else is a regex. `PreToolUse` and
 *   `SessionEnd` are both matcher-supporting events.
 * - **Deny signal.** `codex-rs/hooks/src/events/pre_tool_use.rs`'s
 *   `parse_completed`: exit code 2 with a non-empty stderr reason blocks
 *   the tool call — byte-for-byte the same convention as Claude Code's own
 *   PreToolUse deny. `katra guard`'s bare exit-2 deny (no `--hook` flag)
 *   needs no Codex-specific branch.
 * - **Target file.** `.codex/hooks.json`, project level —
 *   `codex-rs/external-agent-migration/src/detect/mod.rs`:
 *   `repo_root.join(".codex").join("hooks.json")`.
 * - **PreToolUse's tool identity.** Codex has no `Edit`/`Write`/
 *   `NotebookEdit`/`MultiEdit` tools at all — every file edit goes through
 *   one tool, `apply_patch`
 *   (`codex-rs/core/src/tools/handlers/apply_patch.rs`'s
 *   `ToolName::plain("apply_patch")`). The before-edit matcher is
 *   `"apply_patch"`, not a copy of Claude Code's tool-name list.
 *
 * Two confirmed divergences from the Claude adapter, both load-bearing:
 *
 * 1. **SessionEnd's reason is always `"other"`.** Codex hardcodes it
 *    (`codex-rs/hooks/src/events/session_end.rs`'s
 *    `SESSION_END_REASON: &str = "other"`) — there is no per-cause
 *    `clear`/`resume`/`logout` vocabulary at all. This block reuses the
 *    Claude adapter's allow-list matcher text
 *    (`logout|prompt_input_exit|other`) for schema parity and because it
 *    is harmless — `"other"` is one of its alternatives, so it always
 *    matches — but the `clear`/`resume` exclusion it encodes protects
 *    against nothing on Codex: `SessionEnd` fires on genuine session
 *    teardown (process exit, or an app-server thread unloading after 30
 *    idle minutes per `codex-rs/app-server/README.md`), never on an
 *    in-session reset, so the ADR-012 resume-after-clear hazard the
 *    exclusion exists for has no Codex analogue to begin with.
 * 2. **SessionEnd's timeout is hard-capped at 3s, not 10s.** Codex clamps
 *    every `SessionEnd` hook's `timeout` to `[1, 3]` seconds
 *    (`codex-rs/hooks/src/engine/discovery.rs`'s `normalize_command_hook`,
 *    `SESSION_END_MAX_TIMEOUT_SEC = 3`) and logs a warning if a higher
 *    value is configured — a stricter budget than Claude Code's own
 *    default (~1.5s) that the wire contract's `timeout: 10` was sized
 *    against. This block writes `timeout: 3` (the real ceiling) rather
 *    than `10`, so the installed file states what Codex will actually
 *    honor instead of a value it silently downgrades. `katra release
 *    --mine`'s cost (node start + git rev-parse + SQLite open + migrate +
 *    one write tx) may exceed 3s on a cold start — a known limit, not a
 *    bug in this block; record it beside the `apply_patch` deny caveat
 *    below in katra-9aw.70.12's known limits.
 *
 * One risk this schema confirmation does not remove: the epic's own
 * Research step already found open upstream reliability bugs specific to
 * katra's exact use case — openai/codex#27133 / #23996 (project
 * `.codex/hooks.json` misresolved inside a git worktree, which is katra's
 * whole architecture), openai/codex#27833 / #39872 (`PreToolUse` deny not
 * reliably enforced for `apply_patch`), openai/codex#26383 (`codex exec`
 * skips repo hooks entirely). The schema this block writes is confirmed
 * correct against the CLI's own source; whether Codex *reliably executes*
 * it in katra's worktree-per-agent setup is a separate, already-flagged
 * concern this task does not resolve — "Codex is best-effort, Claude Code
 * is the proven path" (epic spec, Constraints).
 */

import { join } from "node:path";
import type { HookEntry } from "../types.js";

/** The three touchpoints, mapped over Codex's own event/matcher vocabulary — see this module's own docs for each field's citation. */
export const CODEX_HOOK_ENTRIES = [
  {
    touchpoint: "session-start",
    event: "SessionStart",
    handler: { type: "command", command: "katra board --digest" },
  },
  {
    touchpoint: "before-edit",
    event: "PreToolUse",
    matcher: "apply_patch",
    handler: { type: "command", command: "katra guard" },
  },
  {
    touchpoint: "session-end",
    event: "SessionEnd",
    matcher: "logout|prompt_input_exit|other",
    handler: { type: "command", command: "katra release --mine", timeout: 3 },
  },
] as const satisfies readonly HookEntry[];

/**
 * `.codex/hooks.json`, project level. Codex has no committed/local split
 * like Claude Code's `settings.json`/`settings.local.json` pair — one file,
 * one location — so unlike {@link claudeSettingsPath} this takes no `local`
 * flag. `root` is supplied by the caller, same as the Claude adapter.
 */
export function codexHooksPath(root: string): string {
  return join(root, ".codex", "hooks.json");
}
