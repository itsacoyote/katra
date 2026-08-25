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
 * **Recognition is per-entry, not a global prefix.** A hook handler is
 * katra's own **for a given entry** iff its command's first two
 * whitespace-separated tokens are `katra` ({@link KATRA_COMMAND_TOKEN}) and
 * that entry's own subcommand (`isKatraHandlerForEntry`) — never a marker
 * key riding along on the handler object (neither agent's schema reliably
 * tolerates one), and never a bare `command.startsWith("katra ")` check
 * either: that broader rule would treat a user's own unrelated katra
 * invocation (e.g. `katra ready --json > audit.log` wired to
 * `SessionStart`) as katra's own `board --digest` entry and destroy it.
 * See `types.ts`'s `KATRA_COMMAND_TOKEN` docs for the full reasoning,
 * including why a *same-subcommand* collision is still normalized on
 * purpose.
 *
 * **Idempotence is proved by content, not tracked through the algorithm.**
 * `changed` is computed by deep-comparing the freshly built settings object
 * against the original parsed input (`node:util`'s `isDeepStrictEqual`) —
 * not by threading a "did I mutate anything" boolean through every helper.
 * This is deliberately simpler than it looks: every touchpoint is rebuilt
 * from scratch on every call (prune any existing katra handler for that
 * entry, then re-add the canonical one), so a second merge over a first
 * merge's own output prunes the katra handler it just wrote and re-adds the
 * identical thing — different intermediate objects, identical final
 * content, so the deep compare reports no change. The same
 * rebuild-from-scratch approach is what makes "normalizes a hand-edited
 * katra entry back to canonical" free: a drifted katra command is
 * recognized by its subcommand regardless of what else changed about it,
 * pruned, and replaced by the canonical handler, with no separate "is this
 * drifted" check to keep in sync with what "canonical" means.
 *
 * **Untouched input survives by reference, not just by structure.** A
 * matcher group with nothing katra recognizes in it (including one that was
 * already empty — `{hooks: []}`) is pushed through as the exact same
 * object, never rebuilt — so `removeHooks` over a file with no katra
 * entries touches nothing, and does not, for instance, drop a pre-existing
 * empty group as a side effect of a rebuild it never needed to do.
 *
 * **Merge preserves relative group order, even across an emptied group.**
 * When pruning fully empties the one group that held katra's own handler,
 * the canonical replacement is spliced back at the position that group
 * occupied — not appended at the end — so a user's own group added *after*
 * katra's stays after it on re-merge instead of katra's entry silently
 * hopping past it.
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

import { isDeepStrictEqual } from "node:util";
import { KatraException } from "../errors.js";
import { isPlainObject } from "../snapshot/serialize.js";
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
import { KATRA_COMMAND_TOKEN } from "./types.js";

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

/**
 * Validates the parts of `hooks` this module actually reads or rewrites:
 * each event's value must be an array, each element a matcher-group object
 * carrying its own `hooks` array, and — this is the part an earlier
 * revision of this module got wrong — each handler in that array must
 * itself be a plain object with a string `command`. `pruneKatraHandlers`
 * dereferences `hook.command` unconditionally, so a handler shaped wrong
 * (missing `command`, or `command` not a string) has to refuse here rather
 * than crash there with a raw `TypeError` no caller asked for. Every other
 * key inside `hooks` (a user's own event, e.g. `Notification`) is left
 * alone entirely by `applyMerge`/`applyRemove`, so there is nothing to gain
 * by validating it beyond the same shape basics every value under `hooks`
 * needs to be walked safely.
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
      for (const handler of group.hooks) {
        if (!isPlainObject(handler) || typeof handler.command !== "string") {
          malformedSettings(`"hooks.${event}" contains a malformed hook handler`);
        }
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

/** The subcommand token (`"guard"`, `"board"`, `"release"`, …) of a `katra <subcommand> ...` command, or `undefined` when `command` is not a katra invocation at all. */
function commandSubcommand(command: string): string | undefined {
  const tokens = command.trim().split(/\s+/);
  return tokens[0] === KATRA_COMMAND_TOKEN ? tokens[1] : undefined;
}

/** Whether `handler` is katra's own handler for `entry` specifically — same subcommand as `entry`'s own canonical command, per `types.ts`'s `KATRA_COMMAND_TOKEN` docs. */
function isKatraHandlerForEntry(handler: HookHandler, entry: HookEntry): boolean {
  return commandSubcommand(handler.command) === commandSubcommand(entry.handler.command);
}

/** What {@link pruneKatraHandlers} hands back. */
interface PruneResult {
  /** `groups` with every handler `isKatraHandlerForEntry` recognizes removed; a group left with zero handlers is dropped entirely. A group untouched by this prune (including one that started empty) is passed through as the exact same object reference — never rebuilt. */
  readonly groups: HookMatcherGroup[];
  /**
   * The position **in `groups` (the output array)** a group fully emptied
   * by this prune used to occupy — where a caller should splice a
   * replacement back in to preserve relative order — or `undefined` when no
   * group was fully emptied. Only the first such position is tracked: a
   * file with more than one group fully consisting of `entry`'s own katra
   * handler is itself a drifted/duplicated state outside what one
   * replacement slot can represent, and not a shape `applyMerge` ever
   * produces on its own.
   */
  readonly emptiedAt: number | undefined;
}

/** Strips every handler `isKatraHandlerForEntry` recognizes for `entry` out of `groups`. Never mutates its input. */
function pruneKatraHandlers(groups: readonly HookMatcherGroup[], entry: HookEntry): PruneResult {
  const pruned: HookMatcherGroup[] = [];
  let emptiedAt: number | undefined;
  for (const group of groups) {
    const keptHooks = group.hooks.filter((hook) => !isKatraHandlerForEntry(hook, entry));
    if (keptHooks.length === group.hooks.length) {
      // Nothing recognized in this group — including a group that was
      // already empty. Pass it through untouched, by reference.
      pruned.push(group);
      continue;
    }
    if (keptHooks.length === 0) {
      // Everything in this group was katra's own handler for `entry` — the
      // group is now empty, so it is dropped, and its position recorded so
      // a merge can splice a replacement back in.
      if (emptiedAt === undefined) {
        emptiedAt = pruned.length;
      }
      continue;
    }
    pruned.push({ ...group, hooks: keptHooks });
  }
  return { groups: pruned, emptiedAt };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Rebuilds one touchpoint's matcher-group array: prune any existing katra
 * handler for this entry (wherever it landed, drifted matcher included),
 * then either fold the canonical handler into a pre-existing group sharing
 * the exact same matcher (a coincidental collision with someone else's
 * group, e.g. a user hook already scoped to the identical matcher text), or
 * reinsert a fresh canonical group — at the position pruning just emptied,
 * when pruning emptied one, so re-merging never reorders a user's own
 * groups relative to katra's.
 */
function applyTouchpointMerge(
  existingGroups: readonly HookMatcherGroup[] | undefined,
  entry: HookEntry,
): HookMatcherGroup[] {
  const { groups: pruned, emptiedAt } = existingGroups
    ? pruneKatraHandlers(existingGroups, entry)
    : { groups: [], emptiedAt: undefined };

  const matchIndex = pruned.findIndex((group) => group.matcher === entry.matcher);
  if (matchIndex !== -1) {
    const matched = pruned[matchIndex] as HookMatcherGroup;
    const mergedGroup: HookMatcherGroup = {
      ...matched,
      hooks: [...matched.hooks, buildHandler(entry)],
    };
    return pruned.map((group, index) => (index === matchIndex ? mergedGroup : group));
  }

  const canonicalGroup = buildGroup(entry);
  if (emptiedAt === undefined) {
    return [...pruned, canonicalGroup];
  }
  const result = [...pruned];
  result.splice(emptiedAt, 0, canonicalGroup);
  return result;
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
  return { settings: settings as HookSettings, changed: !isDeepStrictEqual(original, settings) };
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

/** Prunes katra's entries out of every one of `agent`'s three events; an event or the whole `hooks` object that ends up empty is deleted rather than left as inert clutter. Untouched groups and events (nothing of `agent`'s ever present) pass through unchanged. */
function applyRemove(
  existingHooks: HookEventMap | undefined,
  entries: readonly HookEntry[],
): HookEventMap | undefined {
  if (!existingHooks) return undefined;
  const result: Record<string, readonly HookMatcherGroup[]> = { ...existingHooks };
  for (const entry of entries) {
    const groups = result[entry.event];
    if (!groups) continue;
    const { groups: pruned } = pruneKatraHandlers(groups, entry);
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
  return { settings: settings as HookSettings, changed: !isDeepStrictEqual(original, settings) };
}
