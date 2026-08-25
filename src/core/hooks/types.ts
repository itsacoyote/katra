/**
 * katra's abstract hook-delivery model (F11, `katra-9aw.70.10`, ADR-020): the
 * touchpoints katra wires into an agent's native hooks, and the shapes
 * `merge.ts` and the two adapters (`adapters/claude.ts`, `adapters/codex.ts`)
 * share to describe them. Pure declarations only — nothing here touches a
 * store or the filesystem, mirroring `snapshot/types.ts`'s own scope note
 * for the same reason: this whole feature follows the snapshot module's
 * pure/impure split (epic Research synthesis, reuse map).
 */

/**
 * The two agents katra ships a hook adapter for (ADR-020's fixed-set
 * pattern, `enums.ts`'s own `LEVELS`/`KINDS` precedent). Consumed by
 * `install-hooks` only — `guard` itself carries no per-agent flag (F11
 * locked wire contract v2: the `--hook` flag from wire-contract v1 was
 * removed on purpose, to avoid a hidden code dependency between the guard
 * CLI task and this one).
 */
export const AGENTS = ["claude", "codex"] as const;
export type Agent = (typeof AGENTS)[number];

/**
 * The three abstract delivery points this feature wires (epic Summary).
 * Named for what an agent experiences, not for either agent's own event
 * vocabulary — `session-start`/`before-edit`/`session-end` map onto
 * `SessionStart`/`PreToolUse`/`SessionEnd` for both Claude Code and Codex
 * today, but the touchpoint name is what a future third adapter (the
 * deferred Pi adapter, epic Non-goals) would target, not the event name of
 * whichever agent happens to share it.
 */
export const TOUCHPOINTS = ["session-start", "before-edit", "session-end"] as const;
export type Touchpoint = (typeof TOUCHPOINTS)[number];

/**
 * One hook handler — `{"type":"command","command":...}`, the shape both
 * Claude Code's and Codex's hooks schemas share for a command-type handler
 * (`code.claude.com/docs/en/hooks`; Codex's own
 * `codex-rs/config/src/hook_config.rs`'s `HookHandlerConfig::Command` —
 * see `adapters/codex.ts`'s module docs for the full citation). `timeout`
 * is the wire key both agents use — seconds, optional; each agent applies
 * its own default and its own ceiling when it is absent or too large.
 */
export interface HookHandler {
  readonly type: "command";
  readonly command: string;
  readonly timeout?: number;
}

/**
 * One matcher group: an optional matcher filtering which occurrences of the
 * event fire this group's handlers, plus the handlers themselves. Absent
 * `matcher` means "every occurrence" in both agents' schemas.
 */
export interface HookMatcherGroup {
  readonly matcher?: string;
  readonly hooks: readonly HookHandler[];
}

/**
 * The `hooks` object a settings/hooks file carries, keyed by the agent's
 * own PascalCase event name (`SessionStart`, `PreToolUse`, `SessionEnd`, and
 * whatever other events the file's owner has configured that katra never
 * touches).
 */
export type HookEventMap = Record<string, readonly HookMatcherGroup[]>;

/**
 * A hook settings/config file's shape, as far as `merge.ts` needs to reason
 * about it: an optional `hooks` object, plus whatever else the file holds —
 * every other key is unknown to katra and preserved verbatim (`merge.ts`'s
 * own docs: "everything not katra's preserved").
 */
export interface HookSettings {
  readonly hooks?: HookEventMap;
  readonly [key: string]: unknown;
}

/**
 * One touchpoint's canonical katra entry for a given agent: which of the
 * agent's own events it fires on, the matcher (if any) that scopes it, and
 * the handler it installs. `adapters/claude.ts` and `adapters/codex.ts`
 * each export exactly three of these — one per {@link Touchpoint} — and
 * `merge.ts` is generic over them, keyed only by `event`/`matcher`/command
 * text, never by which agent produced them.
 */
export interface HookEntry {
  readonly touchpoint: Touchpoint;
  readonly event: string;
  readonly matcher?: string;
  readonly handler: HookHandler;
}

/**
 * The prefix `merge.ts` recognizes a hook handler as katra's own by —
 * checked against a handler's `command` string, never a metadata key:
 * neither agent's schema reliably tolerates a foreign key riding along on a
 * handler object (epic Research synthesis, reuse map: "katra's entries are
 * recognized by their command string ... agent settings schemas don't
 * reliably tolerate foreign metadata keys").
 */
export const KATRA_COMMAND_PREFIX = "katra ";
