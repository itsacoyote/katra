/**
 * Claude Code's hook wiring (F11, `katra-9aw.70.10`) — the canonical katra
 * ⇄ Claude Code mapping locked by the epic's "F11 locked wire contract v2"
 * comment (`bd show katra-9aw.70`), corrected by that comment thread's
 * round-3 corrigendum. Three touchpoints, three commands, no more:
 * session-start injects the board digest, before-edit runs the takeover
 * guard, session-end releases the worktree's claims.
 *
 * Verified against current official docs at implementation
 * (`code.claude.com/docs/en/*`, Aug 2026), per this task's own verification
 * duty:
 *
 * - **Tool names for the before-edit matcher.** `code.claude.com/docs/en/
 *   tools-reference`'s full tool table lists `NotebookEdit` — still a real,
 *   currently-shipping file-editing tool — but does **not** list
 *   `MultiEdit`: it was removed from Claude Code (announced Oct 2025), so
 *   it is dropped from the matcher entirely rather than kept as an inert
 *   alternative (the wire contract's own instruction: "drop it if absent,
 *   keep it if present — an inert alternative is sloppy, not harmful", read
 *   the other way once absence was confirmed).
 * - **SessionEnd reason matchers.** `code.claude.com/docs/en/hooks`
 *   documents `SessionEnd`'s matcher as filtering on "why the session
 *   ended", with exactly five reason values: `clear`, `resume`, `logout`,
 *   `prompt_input_exit`, `other`. Reason matchers are fully supported, so
 *   the stdin-allow-list contingency reserved for this in katra-9aw.70.8
 *   does **not** fire — report back per the task's own instruction.
 * - **The `timeout` field.** Documented as seconds, key literally
 *   `timeout` (not `timeout_sec`), defaulting to 600s for a `command`
 *   handler — the wire contract's explicit `10` sits comfortably inside
 *   that default and well above Claude Code's own ~1.5s SessionEnd hook
 *   budget.
 * - **Matcher syntax.** Pipe-separated tool names (`Edit|Write|NotebookEdit`)
 *   is the documented exact-match form; comma-separated is also accepted
 *   but the wire contract specifies pipe syntax.
 */

import { join } from "node:path";
import type { HookEntry } from "../types.js";

/** The three touchpoints, wired exactly as the locked wire contract v2 states. */
export const CLAUDE_HOOK_ENTRIES = [
  {
    touchpoint: "session-start",
    event: "SessionStart",
    handler: { type: "command", command: "katra board --digest" },
  },
  {
    touchpoint: "before-edit",
    event: "PreToolUse",
    matcher: "Edit|Write|NotebookEdit",
    handler: { type: "command", command: "katra guard" },
  },
  {
    touchpoint: "session-end",
    event: "SessionEnd",
    matcher: "logout|prompt_input_exit|other",
    handler: { type: "command", command: "katra release --mine", timeout: 10 },
  },
] as const satisfies readonly HookEntry[];

/**
 * Where the katra block lands: the shared, committed `.claude/settings.json`
 * by default, or the trial-before-commit `.claude/settings.local.json` when
 * `local` is set. Current docs (`code.claude.com/docs/en/settings`'s
 * precedence table) name these two files "Shared project" and "Project
 * local" respectively — the exact split the epic's install-hooks target
 * decision calls for. `root` is supplied by the caller (task
 * `katra-9aw.70.11` pins it to the invoking git toplevel) — this function
 * does no filesystem work of its own, just path arithmetic.
 */
export function claudeSettingsPath(root: string, local: boolean): string {
  return join(root, ".claude", local ? "settings.local.json" : "settings.json");
}
