/**
 * Pure, idempotent hook-settings merge (F11, `katra-9aw.70.10`). No file
 * I/O, no store: `mergeHooks`/`removeHooks` take the target file's raw text
 * (or `undefined` when it does not exist yet) and hand back a plain object
 * plus a `changed` flag — the CLI task (`katra-9aw.70.11`) is the only
 * place that ever reads or writes an actual file, exactly the split
 * `snapshot/serialize.ts` draws between itself and `export.ts`/`restore.ts`.
 *
 * **Agent-agnostic by construction.** Both `adapters/claude.ts` and
 * `adapters/codex.ts` describe their three touchpoints as plain
 * `HookEntry` values (`types.ts`) — an event name, an optional matcher, and
 * a handler — because both agents' real schemas share the identical
 * `{"hooks": {<Event>: [{matcher?, hooks: [...]}]}}` shape (confirmed
 * against each agent's own current docs/source — see the adapters' own
 * module docs). This module never branches on `agent` beyond picking which
 * three entries to apply; every merge/remove/normalize rule below is one
 * algorithm shared by both.
 *
 * **Recognition, not metadata.** A hook handler is "katra's" iff its
 * `command` starts with {@link KATRA_COMMAND_PREFIX} — never a marker key
 * riding along on the handler object, since neither agent's schema reliably
 * tolerates one (epic Research synthesis, reuse map).
 *
 * **Idempotence is proved by content, not tracked through the algorithm.**
 * `changed` is computed by deep-comparing the freshly built settings object
 * against the original parsed input — not by threading a "did I mutate
 * anything" boolean through every helper. This is deliberately simpler than
 * it looks: every touchpoint is rebuilt from scratch on every call (prune
 * any existing katra handler for that touchpoint's event, then re-add the
 * canonical one), so a second merge over a first merge's own output prunes
 * the katra handler it just wrote and re-adds the identical thing —
 * different intermediate objects, identical final content, so the deep
 * compare reports no change. The same rebuild-from-scratch approach is what
 * makes "normalizes a hand-edited katra entry back to canonical" free: a
 * drifted katra command is recognized by its prefix regardless of what
 * changed about it, pruned, and replaced by the canonical handler, with no
 * separate "is this drifted" check to keep in sync with what "canonical"
 * means.
 *
 * **Deterministic output.** `applyMerge`/`applyRemove` only ever
 * shallow-copy the caller's existing objects and reassign known keys —
 * reassigning an *existing* JS object key does not move it in enumeration
 * order, and a genuinely new key is always appended in this module's own
 * fixed touchpoint order (`session-start` → `before-edit` → `session-end`).
 * Two independent "build from empty" calls therefore produce
 * key-for-key-identical objects, which `JSON.stringify` (the CLI task's
 * job, not this module's) renders as byte-identical text — the property
 * `katra-9aw.70.11`'s "second run yields a byte-identical file" acceptance
 * criterion depends on.
 */

import { KatraException } from "../errors.js";
import { CLAUDE_HOOK_ENTRIES } from "./adapters/claude.js";
import { CODEX_HOOK_ENTRIES } from "./adapters/codex.js";
import type {
  Agent,
  HookEntry,
  HookEventMap,
  HookHandler,
  HookMatcherGroup,
  HookSettings,
} from "./types.js";
import { KATRA_COMMAND_PREFIX } from "./types.js";

/** Which three {@link HookEntry} values `mergeHooks`/`removeHooks` apply for each agent — the one place this module knows the adapters exist. */
const ENTRIES_BY_AGENT: Record<Agent, readonly HookEntry[]> = {
  claude: CLAUDE_HOOK_ENTRIES,
  codex: CODEX_HOOK_ENTRIES,
};

/** What `mergeHooks`/`removeHooks` hand back: the resulting settings object, and whether it differs from the input. */
export interface HookMergeResult {
  readonly settings: HookSettings;
  readonly changed: boolean;
}

// ---------------------------------------------------------------------------
// Parsing — "never overwrite what can't be parsed"
// ---------------------------------------------------------------------------

/**
 * `reason` is always one of this module's own fixed strings, or a
 * known-safe schema token (a `hooks.<Event>` key) — never raw file content
 * — mirroring `snapshot/serialize.ts`'s `malformedLine` precedent for a
 * refusal that must reference untrusted input.
 */
function malformedSettings(reason: string): never {
  throw new KatraException({
    code: "validation",
    field: "settings",
    value: reason,
    message: `katra hook settings are malformed (${reason}) — the file may be corrupt or hand-edited`,
  });
}

/** Shape basics only — same scope line as `snapshot/serialize.ts`'s `isPlainObject`. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates only the parts of `hooks` this module actually reads or
 * rewrites — every other key inside `hooks` (a user's own event, e.g.
 * `Notification`) is left alone entirely by `applyMerge`/`applyRemove`, so
 * there is nothing to gain by validating it here beyond the two shape
 * basics every value under `hooks` needs to be walked safely: each event's
 * value is an array, and each element of that array is a matcher-group
 * object carrying its own `hooks` array.
 */
function validateHooksShape(hooks: unknown): asserts hooks is HookEventMap {
  if (!isPlainObject(hooks)) {
    malformedSettings('"hooks" is not a JSON object');
  }
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      malformedSettings(`"hooks.${event}" is not an array`);
    }
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
        malformedSettings(`"hooks.${event}" contains a malformed matcher group`);
      }
    }
  }
}

/** Parses raw settings text into a validated {@link HookSettings}. `undefined` (no file yet) builds from empty, never a parse error. */
function parseSettings(existing: string | undefined): HookSettings {
  if (existing === undefined) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    malformedSettings("invalid JSON");
  }
  if (!isPlainObject(parsed)) {
    malformedSettings("not a JSON object");
  }
  if ("hooks" in parsed) {
    validateHooksShape(parsed.hooks);
  }
  return parsed as HookSettings;
}

// ---------------------------------------------------------------------------
// Deep equality — how `changed` is decided (see module docs)
// ---------------------------------------------------------------------------

/** Order-independent for objects (JSON object keys carry no meaning), order-dependent for arrays (hook/group order is real behavior). */
function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => deepEqualJson(value, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => key in b && deepEqualJson(a[key], b[key]));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Building canonical pieces
// ---------------------------------------------------------------------------

function buildHandler(entry: HookEntry): HookHandler {
  return entry.handler.timeout !== undefined
    ? { type: "command", command: entry.handler.command, timeout: entry.handler.timeout }
    : { type: "command", command: entry.handler.command };
}

function buildGroup(entry: HookEntry): HookMatcherGroup {
  const hooks = [buildHandler(entry)];
  return entry.matcher !== undefined ? { matcher: entry.matcher, hooks } : { hooks };
}

function matcherEquals(a: string | undefined, b: string | undefined): boolean {
  return a === b;
}

/** Strips every katra-recognized handler out of `groups`, dropping any group left with zero handlers. Never mutates its input. */
function pruneKatraHandlers(groups: readonly HookMatcherGroup[]): HookMatcherGroup[] {
  const pruned: HookMatcherGroup[] = [];
  for (const group of groups) {
    const keptHooks = group.hooks.filter((hook) => !hook.command.startsWith(KATRA_COMMAND_PREFIX));
    if (keptHooks.length === 0) continue;
    pruned.push(
      group.matcher !== undefined
        ? { matcher: group.matcher, hooks: keptHooks }
        : { hooks: keptHooks },
    );
  }
  return pruned;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Rebuilds one touchpoint's matcher-group array: prune any existing katra
 * handler for this event (wherever it landed, drifted matcher included),
 * then either fold the canonical handler into a pre-existing group sharing
 * the exact same matcher (a coincidental collision with someone else's
 * group, e.g. a user hook already scoped to the identical matcher text), or
 * append a fresh canonical group.
 */
function applyTouchpointMerge(
  existingGroups: readonly HookMatcherGroup[] | undefined,
  entry: HookEntry,
): HookMatcherGroup[] {
  const pruned = existingGroups ? pruneKatraHandlers(existingGroups) : [];
  const matchIndex = pruned.findIndex((group) => matcherEquals(group.matcher, entry.matcher));
  if (matchIndex === -1) {
    return [...pruned, buildGroup(entry)];
  }
  const matched = pruned[matchIndex] as HookMatcherGroup;
  const mergedHooks = [...matched.hooks, buildHandler(entry)];
  const mergedGroup: HookMatcherGroup =
    matched.matcher !== undefined
      ? { matcher: matched.matcher, hooks: mergedHooks }
      : { hooks: mergedHooks };
  return pruned.map((group, index) => (index === matchIndex ? mergedGroup : group));
}

function applyMerge(
  existingHooks: HookEventMap | undefined,
  entries: readonly HookEntry[],
): HookEventMap {
  const result: Record<string, readonly HookMatcherGroup[]> = existingHooks
    ? { ...existingHooks }
    : {};
  for (const entry of entries) {
    result[entry.event] = applyTouchpointMerge(result[entry.event], entry);
  }
  return result;
}

/**
 * Merges `agent`'s three canonical hook entries into `existing` settings
 * text. `existing` absent builds from empty; malformed JSON refuses via
 * {@link malformedSettings} rather than guessing at a fix. See this
 * module's own docs for how `changed` is decided and why the output is
 * deterministic across repeated calls.
 */
export function mergeHooks(existing: string | undefined, agent: Agent): HookMergeResult {
  const original = parseSettings(existing);
  const mergedHooks = applyMerge(original.hooks, ENTRIES_BY_AGENT[agent]);
  const settings: Record<string, unknown> = { ...original, hooks: mergedHooks };
  return { settings: settings as HookSettings, changed: !deepEqualJson(original, settings) };
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

/** Prunes katra's entries out of every one of `agent`'s three events; an event or the whole `hooks` object that ends up empty is deleted rather than left as inert clutter. */
function applyRemove(
  existingHooks: HookEventMap | undefined,
  entries: readonly HookEntry[],
): HookEventMap | undefined {
  if (!existingHooks) return undefined;
  const result: Record<string, readonly HookMatcherGroup[]> = { ...existingHooks };
  for (const entry of entries) {
    const groups = result[entry.event];
    if (!groups) continue;
    const pruned = pruneKatraHandlers(groups);
    if (pruned.length === 0) {
      delete result[entry.event];
    } else {
      result[entry.event] = pruned;
    }
  }
  return result;
}

/**
 * Removes `agent`'s katra entries from `existing` settings text, leaving
 * every other hook and every unrelated top-level key untouched. A settings
 * object that never had `hooks` at all, or whose `hooks` never held any
 * katra entry for `agent`, round-trips to a deep-equal result — `changed`
 * is `false`, the same "prove it by content" rule {@link mergeHooks} uses.
 */
export function removeHooks(existing: string | undefined, agent: Agent): HookMergeResult {
  const original = parseSettings(existing);
  const newHooks = applyRemove(original.hooks, ENTRIES_BY_AGENT[agent]);
  const settings: Record<string, unknown> = { ...original };
  if (newHooks === undefined || Object.keys(newHooks).length === 0) {
    delete settings.hooks;
  } else {
    settings.hooks = newHooks;
  }
  return { settings: settings as HookSettings, changed: !deepEqualJson(original, settings) };
}
