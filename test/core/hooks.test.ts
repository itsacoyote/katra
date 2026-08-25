/**
 * Core hooks model + pure idempotent merge (F11 T6, `katra-9aw.70.10`):
 * `mergeHooks`/`removeHooks` (`src/core/hooks/merge.ts`) and the two
 * adapters' canonical entries (`src/core/hooks/adapters/{claude,codex}.ts`)
 * against the epic's "F11 locked wire contract v2" comment
 * (`bd show katra-9aw.70`). Every test here is store-free and file-free —
 * this whole feature is pure (module docs, `merge.ts`).
 */

import { describe, expect, it } from "vitest";
import { isKatraException } from "../../src/core/errors.js";
import { CLAUDE_HOOK_ENTRIES, claudeSettingsPath } from "../../src/core/hooks/adapters/claude.js";
import { CODEX_HOOK_ENTRIES, codexHooksPath } from "../../src/core/hooks/adapters/codex.js";
import { mergeHooks, removeHooks } from "../../src/core/hooks/merge.js";

describe("core hooks: merge/remove", () => {
  it("merges the three katra hook groups into an empty settings object", () => {
    const { settings, changed } = mergeHooks(undefined, "claude");

    expect(changed).toBe(true);
    expect(settings.hooks?.SessionStart).toEqual([
      { hooks: [{ type: "command", command: "katra board --digest" }] },
    ]);
    expect(settings.hooks?.PreToolUse).toEqual([
      { matcher: "Edit|Write|NotebookEdit", hooks: [{ type: "command", command: "katra guard" }] },
    ]);
    expect(settings.hooks?.SessionEnd).toEqual([
      {
        matcher: "logout|prompt_input_exit|other",
        hooks: [{ type: "command", command: "katra release --mine", timeout: 10 }],
      },
    ]);
  });

  it("preserves pre-existing user hooks and unrelated settings keys", () => {
    const existing = JSON.stringify({
      model: "opus",
      permissions: { allow: ["Bash(git *)"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./lint.sh" }] }],
        Notification: [{ hooks: [{ type: "command", command: "./notify.sh" }] }],
      },
    });

    const { settings, changed } = mergeHooks(existing, "claude");

    expect(changed).toBe(true);
    expect(settings.model).toBe("opus");
    expect(settings.permissions).toEqual({ allow: ["Bash(git *)"] });
    expect(settings.hooks?.Notification).toEqual([
      { hooks: [{ type: "command", command: "./notify.sh" }] },
    ]);
    expect(settings.hooks?.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "./lint.sh" }] },
      { matcher: "Edit|Write|NotebookEdit", hooks: [{ type: "command", command: "katra guard" }] },
    ]);
  });

  it("changes nothing on a second merge", () => {
    const first = mergeHooks(undefined, "claude");
    const second = mergeHooks(JSON.stringify(first.settings), "claude");

    expect(second.changed).toBe(false);
    expect(second.settings).toEqual(first.settings);
  });

  it("normalizes a hand-edited katra entry back to canonical without duplicating it", () => {
    const drifted = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit|Write|NotebookEdit",
            hooks: [{ type: "command", command: "katra guard --some-hand-added-flag" }],
          },
        ],
      },
    });

    const { settings, changed } = mergeHooks(drifted, "claude");

    expect(changed).toBe(true);
    expect(settings.hooks?.PreToolUse).toEqual([
      { matcher: "Edit|Write|NotebookEdit", hooks: [{ type: "command", command: "katra guard" }] },
    ]);

    // Merging the now-canonical result again is a no-op — no duplicate entry
    // was ever created alongside the normalized one.
    const again = mergeHooks(JSON.stringify(settings), "claude");
    expect(again.changed).toBe(false);
  });

  it("removes only katra's entries and leaves user hooks intact", () => {
    const existing = JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "./lint.sh" }] },
          {
            matcher: "Edit|Write|NotebookEdit",
            hooks: [{ type: "command", command: "katra guard" }],
          },
        ],
        SessionStart: [{ hooks: [{ type: "command", command: "katra board --digest" }] }],
      },
    });

    const { settings, changed } = removeHooks(existing, "claude");

    expect(changed).toBe(true);
    expect(settings.hooks?.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "./lint.sh" }] },
    ]);
    expect(settings.hooks?.SessionStart).toBeUndefined();
  });

  it("remove changes nothing when no katra entries are present", () => {
    const withOtherHooks = JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./lint.sh" }] }],
      },
    });
    const result = removeHooks(withOtherHooks, "claude");
    expect(result.changed).toBe(false);
    expect(result.settings).toEqual(JSON.parse(withOtherHooks));

    const noHooksAtAll = JSON.stringify({ model: "opus" });
    const result2 = removeHooks(noHooksAtAll, "claude");
    expect(result2.changed).toBe(false);
    expect(result2.settings).toEqual({ model: "opus" });
  });

  it("raises a typed error on malformed settings JSON", () => {
    let caught: unknown;
    try {
      mergeHooks("{not valid json", "claude");
    } catch (error) {
      caught = error;
    }
    expect(isKatraException(caught)).toBe(true);
    expect(isKatraException(caught) && caught.detail.code).toBe("validation");

    let caughtOnRemove: unknown;
    try {
      removeHooks("[]", "claude");
    } catch (error) {
      caughtOnRemove = error;
    }
    expect(isKatraException(caughtOnRemove)).toBe(true);
  });
});

describe("core hooks: claude adapter", () => {
  it("wires board --digest to SessionStart, guard to PreToolUse on the file-editing tools, and release --mine to SessionEnd for claude", () => {
    const byTouchpoint = Object.fromEntries(
      CLAUDE_HOOK_ENTRIES.map((entry) => [entry.touchpoint, entry]),
    );

    expect(byTouchpoint["session-start"]).toMatchObject({
      event: "SessionStart",
      handler: { type: "command", command: "katra board --digest" },
    });
    expect(byTouchpoint["before-edit"]).toMatchObject({
      event: "PreToolUse",
      matcher: "Edit|Write|NotebookEdit",
      handler: { type: "command", command: "katra guard" },
    });
    expect(byTouchpoint["session-end"]).toMatchObject({
      event: "SessionEnd",
      handler: { type: "command", command: "katra release --mine" },
    });

    expect(claudeSettingsPath("/repo", false)).toBe("/repo/.claude/settings.json");
    expect(claudeSettingsPath("/repo", true)).toBe("/repo/.claude/settings.local.json");
  });

  it("restricts SessionEnd to the logout, prompt-input-exit, and other reasons", () => {
    const sessionEnd = CLAUDE_HOOK_ENTRIES.find((entry) => entry.touchpoint === "session-end");

    expect(sessionEnd?.matcher).toBe("logout|prompt_input_exit|other");
    expect(sessionEnd?.matcher?.split("|")).not.toContain("clear");
    expect(sessionEnd?.matcher?.split("|")).not.toContain("resume");
  });

  it("sets an explicit timeout on the SessionEnd entry", () => {
    const sessionEnd = CLAUDE_HOOK_ENTRIES.find((entry) => entry.touchpoint === "session-end");

    expect(sessionEnd?.handler.timeout).toBe(10);
  });
});

describe("core hooks: codex adapter", () => {
  it("maps the same three touchpoints for codex", () => {
    expect(CODEX_HOOK_ENTRIES.map((entry) => entry.touchpoint).toSorted()).toEqual(
      CLAUDE_HOOK_ENTRIES.map((entry) => entry.touchpoint).toSorted(),
    );

    const byTouchpoint = Object.fromEntries(
      CODEX_HOOK_ENTRIES.map((entry) => [entry.touchpoint, entry]),
    );
    expect(byTouchpoint["session-start"]).toMatchObject({
      event: "SessionStart",
      handler: { type: "command", command: "katra board --digest" },
    });
    expect(byTouchpoint["before-edit"]).toMatchObject({
      event: "PreToolUse",
      matcher: "apply_patch",
      handler: { type: "command", command: "katra guard" },
    });
    expect(byTouchpoint["session-end"]).toMatchObject({
      event: "SessionEnd",
      handler: { type: "command", command: "katra release --mine", timeout: 3 },
    });

    expect(codexHooksPath("/repo")).toBe("/repo/.codex/hooks.json");

    // The merge/remove algorithm is generic over the agent — prove it here
    // rather than duplicating every claude-side merge test for codex too.
    const merged = mergeHooks(undefined, "codex");
    expect(merged.changed).toBe(true);
    expect(merged.settings.hooks?.PreToolUse).toEqual([
      { matcher: "apply_patch", hooks: [{ type: "command", command: "katra guard" }] },
    ]);

    const again = mergeHooks(JSON.stringify(merged.settings), "codex");
    expect(again.changed).toBe(false);
  });
});
