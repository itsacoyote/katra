/**
 * Human-readable renderings.
 *
 * Kept apart from the values commands return, so the `--json` output and the
 * text output are two views of one object rather than two things that can
 * drift. Every function here is pure: value in, string out.
 */

import { nowIso, timeAgoOrNull } from "../core/clock.js";
import type {
  BoardResult,
  BoardTask,
  BriefResult,
  ClaimInfo,
  RecentResult,
  Ref,
  RefResult,
  SearchResult,
  StaleResult,
} from "../core/contract.js";
import { EVENT_TYPES } from "../core/enums.js";
import type { LoggedEvent } from "../core/events/types.js";
import type { Note } from "../core/notes/types.js";
import type { Task, TaskDetail, TaskView } from "../core/tasks/types.js";
import { CONTROL_CHARS_SOURCE, capText, textWidth } from "../core/text.js";

function field(label: string, value: string): string {
  return `  ${label.padEnd(12)}${value}`;
}

/**
 * A stored single-line value, on its way to a terminal.
 *
 * Every field below goes through this or {@link sanitizeBody}. F2 added the
 * sanitizers for note bodies and event fields and left task fields raw, which
 * meant the *same string* was safe on one command and not the next: a
 * `--reason` was collapsed in `log` and rendered raw in `show`. `--body-file`
 * feeds a task's description too, so the untrusted-content path the sanitizers
 * exist for was never note-only.
 */
const text = (value: string): string => oneLine(value);

/**
 * A claim's liveness, in the wording `claims/repo.ts`'s conflict message
 * already established: `last seen <age>` when a presence row backs the
 * holder, `never seen` when it does not.
 *
 * **"last seen", never "active on"** (T4's security scan): `last_seen` is a
 * per-worktree heartbeat any command bumps, not evidence of work on *this*
 * task — a holder polling the board for other work would otherwise read as
 * live on every claim it holds.
 *
 * **`never seen`** is a real, reachable state, not a theoretical one: a
 * holder whose very first heartbeat failed, or a session that crashed before
 * finishing its first `openStore`, has a claim with no presence row behind it
 * (`claims/types.ts`). No age is fabricated from `claimedAt` for that case —
 * `claimedAt` is a `--json`-only fact here (spec req 8, amended), so a text
 * reader sees exactly the two facts a claim renders anywhere: holder and
 * liveness.
 *
 * `timeAgoOrNull`, not `timeAgo`: `lastSeen` is read back out of `presence`,
 * a row this renderer does not control and does not fully trust — the same
 * reason `claims/repo.ts`'s own `describeLiveness` uses the lenient form
 * rather than the strict one. Before this, a malformed stored timestamp made
 * `timeAgo` throw *inside a render*, turning `board`/`brief`/`show` into an
 * exit 1 on the exact claim `release --force` still handled fine — a display
 * bug reported as a bigger failure than the one it was displaying.
 */
function claimLiveness(claim: ClaimInfo, now: string): string {
  const age = claim.lastSeen === null ? null : timeAgoOrNull(claim.lastSeen, now);
  return age === null ? "never seen" : `last seen ${age}`;
}

/**
 * The "claimed" field's value on `brief` and `show`: the frozen claim-time
 * actor, plus its liveness. `claim.actor` is stored text, so it goes through
 * {@link text} like every other rendered field.
 */
function claimedField(claim: ClaimInfo, now: string): string {
  return `${text(claim.actor)} · ${claimLiveness(claim, now)}`;
}

/**
 * One reference, rendered `provider: qualified-id`, plus whatever F8's
 * `refresh` has cached (status, title, a relative sync age) and the url —
 * each shown only when present, so a never-refreshed ref renders **exactly**
 * as it did before F8 (F7's own pin: a ref with every cached field `null`
 * must byte-for-byte match the pre-F8 render). Shared by
 * {@link formatTaskDetail} and {@link formatBrief}'s `refs` blocks and by
 * {@link formatRefResult}'s own line — one rendering, three call sites, `now`
 * threaded into each as the last positional parameter (F7 A5: appended after
 * existing parameters, never inserted before them).
 *
 * `provider`/`externalId`/`url` are all attacker-influenced (F7 risk note
 * 23 — stored via the `--provider/--id/--url` escape hatch with only the
 * control-character screen `validateExplicitRef` applies to all three; bidi
 * and zero-width codepoints ride through by design, which is what `text()`
 * is for here), so
 * every one goes through {@link text} here exactly like a task's own title or
 * description does. `cachedStatus`/`cachedTitle` are provider-sourced —
 * GitHub/Linear response text, sanitized and length-capped once already at
 * the write seam (`refs/repo.ts`'s `sanitizeCachedTitle`) but never trusted
 * a second time less at render — so they go through {@link text} too, the
 * same "sanitize at every hop, not just the one that currently matters"
 * discipline every other field on this line already follows. `--json`
 * carries all of it verbatim per house policy.
 *
 * The url and the cached title are both **width-clamped** at
 * {@link SNIPPET_WIDTH} (validate round 2, finding LOW-2, for the url; the
 * cached title deliberately reuses the same wider bound rather than
 * {@link TITLE_WIDTH} — it is fetched content riding the same line as the
 * url, not a katra task title squeezed between an id and a lane): an
 * unclamped one of those turns a `show`/`brief` block into a single unbroken
 * line that pushes everything below it off screen — the identical failure
 * shape {@link SNIPPET_WIDTH}'s own docs describe for a pathological FTS5
 * excerpt. `--json` still carries `url`/`cachedTitle` verbatim, uncapped,
 * same as every other field here.
 *
 * The synced age reuses `claimLiveness`'s own tool, `timeAgoOrNull`, not the
 * throwing `timeAgo`: `synced_at` is read back out of `refs`, a row this
 * renderer does not fully trust any more than `presence` — a malformed
 * stored timestamp renders with no age shown rather than turning a `show`
 * into an exit 1 (the named regression `claimLiveness`'s own docs describe
 * for the identical shape). No age is fabricated when `syncedAt` is `null`
 * (never refreshed) — that case renders with no synced age at all, same as
 * `cachedStatus`/`cachedTitle` render nothing when they are `null`.
 */
function formatRefLine(ref: Ref, now: string): string {
  const qualified = `${text(ref.provider)}: ${text(ref.externalId)}`;
  const status = ref.cachedStatus === null ? "" : `  ${text(ref.cachedStatus)}`;
  const title = ref.cachedTitle === null ? "" : `  ${clamp(text(ref.cachedTitle), SNIPPET_WIDTH)}`;
  const url = ref.url === null ? "" : `  ${clamp(text(ref.url), SNIPPET_WIDTH)}`;
  const age = ref.syncedAt === null ? null : timeAgoOrNull(ref.syncedAt, now);
  const synced = age === null ? "" : `  · synced ${age}`;
  return `${qualified}${status}${title}${url}${synced}`;
}

/**
 * What `ref add`/`ref remove` print — the task, what happened, and the
 * reference itself via {@link formatRefLine}.
 *
 * `"already-linked"` gets its own wording rather than collapsing into
 * `"linked"`, mirroring the reason {@link RefResult}'s own docs give for
 * keeping it a distinct `action`: an agent re-adding a ref it already
 * recorded needs to read "this was already there" off the text output the
 * same way `--json` already tells it apart.
 *
 * `"url-backfilled"` (validate round 2, finding M1) gets a third, equally
 * distinct wording — "linked · url recorded" — deliberately not reusing
 * "already linked": a caller reading the text output, same as one reading
 * `--json`, must not mistake a real mutation of the shared `refs` row for
 * the no-op `"already-linked"` otherwise reads as.
 *
 * `now` defaults to the real instant, same as every other top-level formatter
 * in this file — `ref add`/`remove` can re-touch a ref that already carries a
 * cache from an earlier `refresh`, so its line needs a live synced age exactly
 * as much as `show`/`brief`'s do.
 */
export function formatRefResult(result: RefResult, now: string = nowIso()): string {
  const line = formatRefLine(result.ref, now);
  switch (result.action) {
    case "linked":
      return `${result.taskId}  linked  ${line}`;
    case "already-linked":
      return `${result.taskId}  already linked  ${line}`;
    case "url-backfilled":
      return `${result.taskId}  linked · url recorded  ${line}`;
    case "unlinked":
      return `${result.taskId}  unlinked  ${line}`;
    default: {
      const exhaustive: never = result.action;
      return exhaustive;
    }
  }
}

/**
 * The full block `show` prints.
 *
 * `claim` is a separate parameter rather than a field on {@link TaskDetail}:
 * `update` also renders this block from a plain `TaskDetail`, which carries
 * no claim (`tasks/types.ts` — the extra query belongs only to the callers
 * that display it). Omitting it renders no "claimed" line, so `update`'s
 * output is unaffected. `now` defaults to the real instant so every ordinary
 * caller gets live ages for free; tests pin it for a deterministic render.
 *
 * `refs` is a separate parameter, not a field read off `detail`, and it comes
 * **after** `now` (F7 T6): {@link TaskDetail} carries no `refs` field — only
 * {@link TaskView} does, for the identical "don't charge `update` for a query
 * it never displays" reason `claim` is a parameter here rather than part of
 * the type. Defaulting to `[]` means `update`'s existing call site
 * (`formatTaskDetail(document.tasks[0])`, a plain `TaskDetail`) renders with
 * no refs block and needs no change.
 */
export function formatTaskDetail(
  detail: TaskDetail,
  claim: ClaimInfo | null = null,
  now: string = nowIso(),
  refs: readonly Ref[] = [],
): string {
  const { task, parent } = detail;
  const lines = [
    `${task.id}  ${text(task.title)}`,
    field("level", task.level),
    field("kind", task.kind),
    field("lane", task.lane),
    field("priority", `P${task.priority}`),
  ];

  if (claim !== null) lines.push(field("claimed", claimedField(claim, now)));
  if (task.assignee !== null) lines.push(field("assignee", text(task.assignee)));
  if (parent !== null) lines.push(field("epic", `${parent.id}  ${text(parent.title)}`));

  // Blockers before links and tags: "can I start this?" is the question `show`
  // is usually asked, and the answer should not be below the fold. Stated
  // explicitly when there are none, because a missing line reads as "this view
  // does not know" — which is exactly what it used to mean.
  if (detail.blockers.length === 0) {
    lines.push(field("blockers", "none"));
  } else {
    for (const [index, blocker] of detail.blockers.entries()) {
      lines.push(
        field(
          index === 0 ? "blockers" : "",
          `${blocker.id}  ${blocker.lane}  ${text(blocker.title)}`,
        ),
      );
    }
  }
  for (const [index, dependent] of detail.blocking.entries()) {
    lines.push(
      field(
        index === 0 ? "blocking" : "",
        `${dependent.id}  ${dependent.lane}  ${text(dependent.title)}`,
      ),
    );
  }

  for (const [index, link] of detail.links.entries()) {
    lines.push(field(index === 0 ? "links" : "", `${link.id}  ${text(link.title)}`));
  }
  // Follows the `links` block's own precedent — one line per entry, blank
  // label after the first (F7 T6).
  for (const [index, ref] of refs.entries()) {
    lines.push(field(index === 0 ? "refs" : "", formatRefLine(ref, now)));
  }
  if (task.tags.length > 0) lines.push(field("tags", text(task.tags.join(", "))));

  lines.push(field("created", task.createdAt));
  if (task.updatedAt !== task.createdAt) lines.push(field("updated", task.updatedAt));
  if (task.closedAt !== null) lines.push(field("closed", task.closedAt));
  if (task.closeReason !== null) lines.push(field("reason", text(task.closeReason)));

  if (task.description !== null && task.description.trim() !== "") {
    // sanitizeBody, not `text`: a description is deliberately multi-line, so
    // its newlines and tabs survive while anything a terminal would act on
    // does not — the same treatment note bodies get, indentation included, so
    // a stored line can never sit at column 0 impersonating a line katra
    // itself prints (ADR-010).
    lines.push("", indent(sanitizeBody(task.description).trimEnd()));
  }

  return lines.join("\n");
}

/**
 * A listing, aligned so ids and lanes line up down the page.
 *
 * An empty result says so rather than printing nothing: a blank response is
 * indistinguishable from a command that failed silently.
 */
export function formatTaskList(tasks: readonly Task[]): string {
  if (tasks.length === 0) return "no tasks match";

  const width = (pick: (task: Task) => string): number => columnWidth(tasks, pick);
  const laneWidth = width((task) => task.lane);
  const kindWidth = width((task) => (task.level === "epic" ? "epic" : task.kind));

  return tasks
    .map((task) =>
      [
        task.id,
        `P${task.priority}`,
        padTo(task.lane, laneWidth),
        padTo(task.level === "epic" ? "epic" : task.kind, kindWidth),
        text(task.title),
      ].join("  "),
    )
    .join("\n");
}

/**
 * A bulk update's result: one line per task, no repeated field block.
 *
 * The single-task case still prints the full detail — one task is worth seeing
 * in full. Ten are not: triaging seven tasks used to emit seventy-seven lines
 * of field blocks whose content the caller had just supplied.
 */
export function formatUpdatedTasks(tasks: readonly TaskDetail[]): string {
  if (tasks.length === 0) return "no tasks updated";

  const width = columnWidth(tasks, ({ task }) => task.lane);
  return [
    `updated ${tasks.length} tasks`,
    ...tasks.map(({ task }) => `  ${task.id}  ${padTo(task.lane, width)}  ${text(task.title)}`),
  ].join("\n");
}

/**
 * Collapses anything that would break a one-line-per-event rendering.
 *
 * `--reason` is a plain command-line argument, never routed through
 * `readBody`, so it can contain newlines — and one embedded newline shifts
 * every following row out of its column. Control characters matter for a
 * second reason: reasons and titles are where fetched content and model output
 * get pasted, and a raw ANSI escape executes on whatever renders it.
 *
 * Note *bodies* are the deliberately-multiline case and are not rendered here.
 *
 * Exported for `cli/output.ts`: `emitError`'s text-mode message is built from
 * `KatraErrorDetail.message`, which F4's claim conflicts populate with a
 * stored actor string — the first core message to carry free-form stored
 * text straight to stderr. Wrapping it here, rather than duplicating this
 * function, keeps every untrusted-text rendering in katra going through one
 * definition.
 */
export function oneLine(value: string): string {
  return value.replaceAll(CONTROLS, " ").replaceAll(BIDI, "").trim();
}

/**
 * C0/C1 control characters, plus the Unicode line separators.
 *
 * `U+2028`/`U+2029` sit outside the control blocks and move no terminal
 * cursor, but any non-terminal consumer of this output — an editor, a web
 * view, an agent's renderer — breaks the line on them, so two readers would
 * disagree about how many rows a table has.
 *
 * Derived from `core/text.ts`'s {@link CONTROL_CHARS_SOURCE} — the shared
 * vocabulary of what a control character *is* — rather than a second
 * hand-written character class: this file and `core/refs/parse.ts` each
 * carried their own copy of the identical set before that export existed,
 * and a third would have been the same drift risk again. `+`/`g` stay local
 * to this declaration, exactly the design {@link CONTROL_CHARS_SOURCE}'s own
 * docs describe: the source is unflagged, unquantified regex-class text, and
 * each consumer picks the flags/quantifier its own use needs — `oneLine`'s
 * `replaceAll` needs both, the exported `CONTROL_CHARS_PATTERN` itself
 * (a `.test()`-only, `parse.ts`-shaped use) needs neither.
 */
const CONTROLS = new RegExp(`[${CONTROL_CHARS_SOURCE}]+`, "g");

/**
 * The same set minus newline and tab, for text rendered across several lines.
 *
 * **Deliberately not derived from {@link CONTROL_CHARS_SOURCE}.** This is a
 * different, narrower character class — tab and newline survive here so a
 * multi-line body keeps its own layout — not a flags/quantifier variant of
 * the shared set the way `CONTROLS` above is. Hand-written for that reason:
 * there is no "subtract two characters from a source string" export to
 * derive it from without `core/text.ts` growing a second vocabulary just for
 * this one caller.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CONTROLS_KEEPING_LAYOUT = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]+/g;

/**
 * Characters that reorder text without being visible.
 *
 * Trojan Source (CVE-2021-42574) applied to a backlog: an override or isolate
 * inside a title or a note body makes the rendered line read in an order that
 * misstates what it says. Stripping control characters does not catch these \u2014
 * they are ordinary printable codepoints \u2014 and neither does `JSON.stringify`,
 * so they survived every other guard in this file. `U+061C` is the one mark
 * in the CVE's own list the first version of this class omitted.
 *
 * Removed rather than replaced with a marker: a marker in the middle of a line
 * is itself a rendering change, and katra has no styling vocabulary to make it
 * legible.
 */
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** What an event says happened, beyond its type and what it is about. */
function describeEvent(event: LoggedEvent): string {
  const parts: string[] = [];
  if (event.fromLane !== null && event.toLane !== null) {
    parts.push(`${event.fromLane} -> ${event.toLane}`);
  }
  if (event.reason !== null) parts.push(oneLine(event.reason));
  // `events.ref` has no CHECK constraint: it carries generated note ids and,
  // since F7, external-ref qualified ids — stored text a hostile `--id` can
  // shape, so the one-line here is load-bearing, not defensive.
  if (event.ref !== null) parts.push(oneLine(event.ref));
  // Set only on a forced release (`claims/repo.ts`'s `settleClaim`): the
  // holder it displaced. Without this the column's whole justification —
  // "the takeover reads straight off the event" — is write-only: the fact is
  // stored and never shown. `priorActor` is a frozen actor string, the same
  // stored-text shape `reason`/`ref` are, so it gets the same one-lining.
  if (event.priorActor !== null) parts.push(`from ${oneLine(event.priorActor)}`);
  return parts.join("  ");
}

/**
 * How much room a title gets before it is cut.
 *
 * Titles are prose and the rest of a row is structured, so an uncapped column
 * pushes the lanes and reasons of every other row off to the right. `--json`
 * carries the whole thing for anything that needs it.
 */
const TITLE_WIDTH = 44;

/**
 * The event-type column's fixed width in `formatBrief`'s activity block and
 * `formatBoard`'s recent block — the two single-row-at-a-time event renders
 * that pad every row to one shared width regardless of which types actually
 * appear in this particular render. `formatEventLog` needs no such constant:
 * it sizes its own type column per render via {@link columnWidth} over the
 * exact events it is showing, so it can never fall behind a type it does not
 * print.
 *
 * Derived from {@link EVENT_TYPES} (T1's `enums.ts`) rather than a literal —
 * F8 added `ref-status-changed`, at 18 characters the widest type today and
 * four past the `14` this used to be hardcoded to, which let a row holding
 * one push its own subsequent columns four characters further right than
 * every other row's. A literal bump to `18` would fix today's overflow and
 * silently reopen the identical misalignment the next time `EVENT_TYPES`
 * grows a longer entry; deriving it makes that a compile-time-adjacent fact
 * instead of something only a render catches.
 */
const EVENT_TYPE_WIDTH = columnWidth(EVENT_TYPES, (type) => type);

/**
 * How much room `search`'s snippet line gets before it is cut.
 *
 * Wider than {@link TITLE_WIDTH} on purpose — the snippet owns its own
 * indented line, not a shared row, so it can afford more room than a column
 * squeezed between an id and a lane. It still needs a bound: FTS5's
 * `snippet()` caps its excerpt at {@link SNIPPET_MAX_TOKENS} *tokens*
 * (`search.ts`), not characters, and a single token has no length limit of
 * its own — a note body that is one 800,000-character run with no whitespace
 * (probe-verified) produces a "snippet" of the same length, unclamped. This
 * is the render-side bound that stops that from reaching a terminal as one
 * unbroken line; `--json` still carries `snippet` verbatim.
 */
export const SNIPPET_WIDTH = 200;

/**
 * Cuts a title to `width`, marking the cut with an ellipsis.
 *
 * Measured in code points, via `capText`, not in UTF-16 code units. The
 * previous `text.slice()` could split a surrogate pair and emit a lone
 * surrogate — unlikely at 44 characters, but the same bug class `brief`'s
 * handoff cap makes routine, and worth fixing in one place rather than two.
 *
 * The ellipsis costs one of the `width` characters, so a clamped string still
 * occupies exactly `width` columns and {@link columnWidth} agrees with it.
 */
export function clamp(text: string, width: number): string {
  // Only zero is degenerate. An earlier version guarded `width <= 1` on the
  // claim that a one-character result would be too wide — but "…" *is* one
  // character, and returning the first character bare made the bound stop
  // reporting itself, which is the one thing a truncation must never do.
  if (width <= 0) return "";
  // Two calls, deliberately. Capping at `width - 1` and asking *that* whether
  // it truncated ellipsizes a string of exactly `width`, which used to render
  // whole — the boundary title silently loses its last character. Ask the full
  // width whether a cut is needed, then cut one shorter to make room.
  if (!capText(text, width).truncated) return text;
  return `${capText(text, width - 1).text}…`;
}

/**
 * The widest rendering of `pick` across `rows`, in the unit {@link clamp} cuts
 * in.
 *
 * Extracted rather than written a fourth time — `formatTaskList` and
 * `formatEventLog` each had their own copy of this closure with the same
 * explanatory comment, and `board` adds two more tabular sections.
 *
 * Reduced rather than `Math.max(...rows.map(…))`: spreading the result set as
 * arguments blows the stack somewhere past a hundred thousand rows, `list` has
 * no limit, and nothing prunes the events table by design (ADR-008).
 *
 * `textWidth`, never `.length`. Code units would size a column of emoji at
 * twice its visible width and pad every ASCII row beside it to match.
 */
export function columnWidth<T>(rows: readonly T[], pick: (row: T) => string): number {
  return rows.reduce((widest, row) => Math.max(widest, textWidth(pick(row))), 0);
}

/**
 * Pads `text` to `width` visible characters.
 *
 * `String.padEnd` is the third place this file measured in UTF-16 code units,
 * and the one that survives fixing the other two: a title of four emoji is
 * eight code units, so `padEnd(5)` decides it is already wide enough and adds
 * nothing, while the ASCII row beside it pads to five. The columns after it
 * then start one character apart.
 *
 * Any column sized by {@link columnWidth} must be padded by this, never by
 * `padEnd` — the two have to count the same things.
 */
export function padTo(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - textWidth(text)));
}

/**
 * The bound-cut-it-short line the three chronological, `--limit`-bounded
 * reads share: `formatEventLog`, `formatRecent` and `formatStale` all
 * over-fetch by one and report the cut the identical way. One spelling
 * rather than three near-identical literals drifting from each other.
 *
 * `formatSearch` does **not** reuse this one — see
 * {@link RAISE_SEARCH_LIMIT_LINE}.
 */
const RAISE_LIMIT_LINE = "  … more; raise --limit to see further back";

/**
 * {@link RAISE_LIMIT_LINE}'s sibling for `formatSearch` alone (senior review
 * MEDIUM). `RAISE_LIMIT_LINE`'s wording — "see further back" — is
 * chronological: right for `log`/`recent`/`stale`, which all walk the event
 * stream in time order and truncate a *time window*. `search`'s bound
 * truncates a *relevance ranking* instead; there is no "further back" to see,
 * only more matches outside the top `--limit`.
 */
const RAISE_SEARCH_LIMIT_LINE = "  … more; raise --limit to see more matches";

/**
 * The event stream, newest first, one physical line per event.
 *
 * The actor column appears only when the log holds more than one — in a
 * single-agent repository it is the same string on every row, which is pure
 * noise; across worktrees it is the whole reason ADR-007 records it.
 */
export function formatEventLog(events: readonly LoggedEvent[], truncated: boolean): string {
  // `--limit 0` is a real request, and it is the one input where truncation is
  // total — reporting "nothing has happened yet" there would be a claim of
  // completeness in exactly the case the flag exists to prevent.
  if (events.length === 0) {
    return truncated ? RAISE_LIMIT_LINE : "nothing has happened yet";
  }

  const width = (pick: (event: LoggedEvent) => string): number => columnWidth(events, pick);

  const title = (event: LoggedEvent): string =>
    event.entityTitle === null ? "" : clamp(oneLine(event.entityTitle), TITLE_WIDTH);

  // The actor is elided when every row shares one: in a single-agent
  // repository it is the same string repeated down the page, and it is always
  // recoverable from `--json`.
  //
  // The title is **not** elided the same way, though a scoped log repeats it
  // just as much. The asymmetry is deliberate: for a task that still exists
  // the title is recoverable with `show`, but for a deleted one this log is
  // the only place it survives (ADR-008) — so the case where eliding looks
  // most justified is exactly the case where it destroys the answer.
  const showActor = new Set(events.map((event) => event.actor)).size > 1;
  const showTitle = events.some((event) => event.entityTitle !== null);

  const typeWidth = width((event) => event.type);
  const idWidth = width((event) => event.entityId);
  const actorWidth = showActor ? width((event) => oneLine(event.actor)) : 0;
  const titleWidth = showTitle ? width(title) : 0;

  const rows = events
    .map((event) => {
      const columns = [
        // Minutes, not seconds: a log spanning weeks needs the date, and the
        // second an event landed has never answered anyone's question.
        event.createdAt.slice(0, 16).replace("T", " "),
        padTo(event.type, typeWidth),
        padTo(event.entityId, idWidth),
        ...(showActor ? [padTo(oneLine(event.actor), actorWidth)] : []),
        ...(showTitle ? [padTo(title(event), titleWidth)] : []),
        describeEvent(event),
      ];
      return columns.join("  ").trimEnd();
    })
    .join("\n");

  // A bound that cannot report itself is indistinguishable from the end of the
  // history — and this is the read a session digest is built on.
  return truncated ? `${rows}\n${RAISE_LIMIT_LINE}` : rows;
}

/**
 * Removes control characters a terminal would act on, keeping the two that
 * carry meaning.
 *
 * Notes are where fetched content and model output get pasted, and F3's
 * `brief` will surface handoff notes to *other agents* as their first context.
 * A raw ANSI escape in a body executes on whatever renders it — it can repaint
 * the screen, hide what follows, or misreport what a task says.
 *
 * Newline and tab survive, so indentation and line structure — the reason
 * pasted code is in a note at all — come through intact. `--json` is
 * deliberately not sanitised: it is the programmatic path, its consumer is not
 * a terminal, and a value altered on the way out would no longer be what was
 * stored.
 */
function sanitizeBody(value: string): string {
  return value.replaceAll(CONTROLS_KEEPING_LAYOUT, "").replaceAll(BIDI, "");
}

/**
 * A note reduced to a single line, for a summary that has no room for the body.
 *
 * The first line only, then the full control-character collapse — a preview
 * has no use for the newline and tab {@link sanitizeBody} keeps, and either
 * would break the row.
 */
function previewBody(text: string, width: number): string {
  const [first = ""] = text.split("\n");
  return clamp(oneLine(first), width);
}

/**
 * One note's header line: everything about it except the body.
 *
 * The actor is always shown here, unlike in the log. A note is something
 * somebody wrote, and "who wrote this handoff" is the first question its
 * reader has — a log row is a mechanical record, a note is authorship.
 */
function noteHeader(note: Note): string {
  return `${note.id}  ${note.kind}  ${note.createdAt.slice(0, 16).replace("T", " ")}  ${text(note.actor)}`;
}

/** A single note, header then body. What `note add` prints back. */
export function formatNote(note: Note): string {
  return `${noteHeader(note)}\n\n${indent(sanitizeBody(note.body).trimEnd())}`;
}

/**
 * Notes, newest first, each as a header and its body.
 *
 * **Not one line per note**, unlike every other listing katra prints. A note's
 * body is the reason to read it, so truncating to a row would leave the
 * command answering a question nobody asked. `--limit` is how the output is
 * bounded instead.
 *
 * Bodies keep their newlines and tabs — the one place in the CLI where
 * multi-line content is the point rather than a hazard — but everything else a
 * terminal would act on is removed. Keeping indentation was the whole
 * objection to sanitising, and {@link sanitizeBody} keeps it, so the objection
 * does not survive: an ANSI escape pasted into a note would otherwise execute
 * on whoever read it back. `--json` stays verbatim.
 */
export function formatNoteList(notes: readonly Note[]): string {
  if (notes.length === 0) return "no notes";

  return notes
    .map((note) => `${noteHeader(note)}\n${indent(sanitizeBody(note.body).trimEnd())}`)
    .join("\n\n");
}

/** Indents a body so it reads as belonging to the header above it. */
function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? "" : `  ${line}`))
    .join("\n");
}

/** How much of a note's body a `show` preview carries. */
const PREVIEW_WIDTH = 56;

/**
 * The full `show` block: the task detail, then its notes and recent activity.
 *
 * Notes appear as **metadata plus a one-line preview**, not as bodies. `show`
 * is a compact summary of one task, and a long-lived task accumulates notes
 * without bound — inlining them turns the summary into a dump on exactly the
 * tasks most worth summarising. `katra note list <id>` prints whole bodies and
 * `katra log <id>` the whole history; both sections here name the command that
 * shows the rest.
 *
 * A task with no notes and no activity gets neither heading: an empty section
 * is a line that says nothing happened, which the absence already says.
 *
 * `now` defaults to the real instant — see {@link formatTaskDetail} — and
 * feeds the claim line's age alone. Notes and activity rows below render
 * absolute timestamps and do not depend on it.
 */
export function formatTaskView(view: TaskView, now: string = nowIso()): string {
  const lines = [formatTaskDetail(view, view.claim, now, view.refs)];

  if (view.notes.length > 0) {
    lines.push("", `notes (${view.notes.length}, newest first — \`katra note list\` for bodies)`);
    for (const note of view.notes) {
      lines.push(
        `  ${note.id}  ${note.kind.padEnd(10)}  ${note.createdAt.slice(0, 16).replace("T", " ")}  ${previewBody(note.body, PREVIEW_WIDTH)}`,
      );
    }
  }

  if (view.activity.length > 0) {
    lines.push("", `activity (newest first — \`katra log\` for the rest)`);
    for (const event of view.activity) {
      const when = event.createdAt.slice(0, 16).replace("T", " ");
      // An epic's view carries its children's events too, so a row about
      // something other than this task has to name it — three bare `created`
      // rows under an epic are otherwise indistinguishable from each other.
      const subject =
        event.entityId === view.task.id
          ? ""
          : `  ${oneLine(event.entityId)}  ${previewBody(event.entityTitle ?? "", TITLE_WIDTH)}`;
      lines.push(
        `  ${when}  ${padTo(event.type, EVENT_TYPE_WIDTH)}${subject}  ${describeEvent(event)}`.trimEnd(),
      );
    }
  }

  return lines.join("\n");
}

/**
 * The `brief` block: what a session needs to pick this up again.
 *
 * Deliberately not `formatTaskView` with more rows. `show` prints note
 * *previews* and never a body; this leads with a handoff in full, because that
 * is the one thing a resuming session cannot reconstruct from the code. If a
 * change ever makes these two renderings converge, `brief` has stopped earning
 * its place.
 *
 * Every stored string goes through `text` or `sanitizeBody` — titles, kinds,
 * blocker titles, event fields, and above all the handoff body, which is the
 * largest untrusted-text surface katra has. `--json` stays verbatim; these are
 * two renderings of one value, not one string built once and printed twice.
 *
 * `now` defaults to the real instant — see {@link formatTaskDetail} — for the
 * claim line's age.
 */
export function formatBrief(brief: BriefResult, now: string = nowIso()): string {
  const lines = [
    `${brief.task.id}  ${text(brief.task.title)}`,
    field("level", brief.task.level),
    field("lane", brief.task.lane),
    field("priority", `P${brief.task.priority}`),
  ];
  // Task arm only — an epic can never hold a claim (AC6), and `claim` is not
  // a field the epic arm even carries (`contract.ts`).
  if (brief.level === "task" && brief.claim !== null) {
    lines.push(field("claimed", claimedField(brief.claim, now)));
  }
  if (brief.epic !== null) {
    lines.push(field("epic", `${brief.epic.id}  ${text(brief.epic.title)}`));
  }

  // Blockers first, on both shapes, and stated even when empty: "can I start
  // this?" is the question a resuming session asks before any other, and a
  // missing line reads as "this view does not know". An epic can carry a
  // dependency like anything else — `addDependency` has no level check and
  // `show <epic>` prints them — so an epic brief that omitted this answered the
  // question by silence.
  if (brief.blockers.length === 0) {
    // Qualified on an epic. Everything else in this feature treats an epic as
    // not-work — `next` will not offer one, `board` excludes them from every
    // section — so a bare "none" here reads as "nothing under this is blocked",
    // which is a claim about the children that was never checked.
    lines.push(
      field(
        "blockers",
        brief.level === "epic" ? "none on the epic itself — children not checked" : "none",
      ),
    );
  } else {
    for (const [index, blocker] of brief.blockers.entries()) {
      lines.push(
        field(
          index === 0 ? "blockers" : "",
          `${blocker.id}  ${blocker.lane}  ${clamp(text(blocker.title), TITLE_WIDTH)}`,
        ),
      );
    }
  }
  for (const [index, dependent] of brief.blocking.entries()) {
    lines.push(
      field(
        index === 0 ? "blocking" : "",
        `${dependent.id}  ${dependent.lane}  ${clamp(text(dependent.title), TITLE_WIDTH)}`,
      ),
    );
  }

  // On both shapes, like `blockers`/`blocking` above — `BriefResult.refs`'s
  // own docs: scoped to this entity's own `task_refs`, never rolled up from
  // an epic's children.
  for (const [index, ref] of brief.refs.entries()) {
    lines.push(field(index === 0 ? "refs" : "", formatRefLine(ref, now)));
  }

  if (brief.level === "epic") {
    for (const group of brief.children) {
      // `showing 8 of 40`, the same wording board uses for a capped section.
      // "more not shown" hides the backlog size, and two conventions inside one
      // feature is one too many.
      const heading = group.truncated
        ? `showing ${group.tasks.length} of ${group.total}`
        : String(group.tasks.length);
      lines.push("", `${group.lane} (${heading})`);
      for (const child of group.tasks) {
        lines.push(`  ${child.id}  ${clamp(text(child.title), TITLE_WIDTH)}`);
      }
    }
  }

  if (brief.task.description !== null && brief.task.description.trim() !== "") {
    lines.push("", indent(sanitizeBody(brief.task.description).trimEnd()));
  }

  if (brief.handoff !== null) {
    const { note, truncated } = brief.handoff;
    const when = note.createdAt.slice(0, 16).replace("T", " ");
    // "last touch", never "owner" or "assignee". katra has no concept of
    // ownership until claims land, and a heading that implied one would have a
    // reader believe somebody currently holds this.
    lines.push("", `handoff — last touch ${text(note.actor)}, ${when}`);
    lines.push(indent(sanitizeBody(note.body).trimEnd()));
    if (truncated) {
      // Names the command, with the resolved id: a reader who needs the rest
      // should not have to work out how to ask for it.
      // The note's **own** task, not the entity briefed. On an epic the handoff
      // comes from the epic *or any child*, so naming the epic sends the reader
      // to `note list <epic>` — which filters `task_id = ?` and prints nothing.
      // A hint that misleads is worse than no hint.
      lines.push(`  … truncated — \`katra note list ${note.taskId}\` for the whole note`);
    }
  }

  // `handoff` is filtered out unconditionally and re-added below, so exactly one
  // mechanism owns that kind. Filtering it only when a handoff was *shown* let
  // both fire when the scope held one and `handoff` was null — the skew
  // `briefEntity` documents as safe — printing "1 handoff, 1 more handoff" and
  // claiming two where one exists.
  const others = Object.entries(brief.noteCounts)
    .filter(([kind]) => kind !== "handoff")
    .map(([kind, count]) => `${count} ${kind}`);
  const shownHandoff = brief.handoff === null ? 0 : 1;
  const remaining = (brief.noteCounts.handoff ?? 0) - shownHandoff;
  // "more" only when one was already displayed above.
  if (remaining > 0) others.push(`${remaining}${shownHandoff === 0 ? "" : " more"} handoff`);
  if (others.length > 0) {
    // No command answers this on an epic: the tally aggregates across children
    // and `note list` is task-scoped, so naming it would assert notes exist and
    // then point at something that says they do not. State the scope instead.
    const where =
      brief.level === "task"
        ? ` — \`katra note list ${brief.task.id}\``
        : " — across this epic and its children";
    lines.push("", `notes: ${others.join(", ")}${where}`);
  }

  if (brief.activity.length > 0) {
    lines.push("", "activity (newest first — `katra log` for the rest)");
    for (const event of brief.activity) {
      const when = event.createdAt.slice(0, 16).replace("T", " ");
      const subject =
        event.entityId === brief.task.id
          ? ""
          : `  ${oneLine(event.entityId)}  ${previewBody(event.entityTitle ?? "", TITLE_WIDTH)}`;
      lines.push(
        `  ${when}  ${padTo(event.type, EVENT_TYPE_WIDTH)}${subject}  ${describeEvent(event)}`.trimEnd(),
      );
    }
    if (brief.activityTruncated) lines.push("  … more; `katra log` for the rest");
  }

  return lines.join("\n");
}

/** How many blocker ids a blocked row names before deferring to `show`. */
const BLOCKERS_SHOWN = 3;

/**
 * A board row's trailing "claimed by" marker — empty for every row but a
 * `claimedElsewhere` one (ADR-012: claimed-by-me is deliberately not a
 * marker, so an own claim renders no differently from unclaimed here; `brief`
 * and `show` still show it in full). The bit rides on the row itself
 * (`BoardTask.claimedElsewhere`) rather than being derived here by comparing
 * identities — this formatter has no caller identity to compare against.
 *
 * `branch` comes from `ClaimInfo.branch` — presence-sourced, never parsed out
 * of `actor` — falling back to the full frozen actor string when the holder
 * has no presence row, the same "nothing to show" state {@link claimLiveness}
 * renders as `never seen`.
 */
function claimedMarker(task: BoardTask, now: string): string {
  if (!task.claimedElsewhere || task.claim === null) return "";
  const branch = task.claim.branch === null ? text(task.claim.actor) : text(task.claim.branch);
  return `  claimed by ${branch} · ${claimLiveness(task.claim, now)}`;
}

/**
 * The board: where the repository stands, in five parts.
 *
 * Actionable first, activity last. An agent that reads only the header and the
 * first two sections has still been oriented and knows what to pick up.
 *
 * The counts are totals and the sections are capped, so a section saying
 * `showing 2 of 14` is the normal case rather than an error — a header that
 * shrank to match the cap would state a backlog size that is not true.
 *
 * `now` defaults to the real instant — see {@link formatTaskDetail} — for
 * every claimed row's age.
 */
export function formatBoard(board: BoardResult, now: string = nowIso()): string {
  const { counts } = board;
  const lines: string[] = [];

  if (board.digest !== null) {
    const { note, taskId, taskTitle, taskLane, truncated } = board.digest;
    const when = note.createdAt.slice(0, 16).replace("T", " ");
    // The lane is in the heading, not buried below: a handoff on a `Done` task
    // is legitimately the newest one, and a session must not read it as live
    // work. "last touch" for the same reason it appears in `brief` — katra has
    // no notion of ownership until claims land.
    lines.push(
      `handoff  ${taskId}  ${taskLane}  ${text(taskTitle)}`,
      `  last touch ${text(note.actor)}, ${when}`,
      "",
      indent(sanitizeBody(note.body).trimEnd()),
    );
    if (truncated) {
      lines.push(`  … truncated — \`katra note list ${taskId}\` for the whole note`);
    }
    lines.push("");
  }

  lines.push(
    `${counts.open} open · ${counts.inFlight} in flight · ${counts.ready} ready · ` +
      `${counts.blocked} blocked · ${counts.untriaged} untriaged`,
  );

  const rows = (section: BoardResult["inFlight"], showBlockers: boolean): string[] => {
    const idWidth = columnWidth(section.tasks, (task) => task.id);
    const laneWidth = columnWidth(section.tasks, (task) => task.lane);
    return section.tasks.map((task) => {
      const marker = task.blocked && !showBlockers ? "  (blocked)" : "";
      // The first few blockers, not all of them: the row is bounded and the
      // list is not — the rest are one `show` or `--json` away. The title gets
      // the clamp `log` already applies to the same column; the schema puts no
      // length on it.
      const shown = task.blockers.slice(0, BLOCKERS_SHOWN).map((blocker) => blocker.id);
      const rest = task.blockers.length - shown.length;
      const blockers = showBlockers
        ? `  blocked by ${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""}`
        : "";
      return `  ${padTo(task.id, idWidth)}  P${task.priority}  ${padTo(task.lane, laneWidth)}  ${clamp(text(task.title), TITLE_WIDTH)}${marker}${blockers}${claimedMarker(task, now)}`;
    });
  };

  const push = (
    title: string,
    section: BoardResult["inFlight"],
    total: number,
    showBlockers = false,
  ): void => {
    if (section.tasks.length === 0) return;
    // Names the true total whenever the cap bit, so a capped section can never
    // be mistaken for the whole answer.
    const shown = section.truncated ? ` (showing ${section.tasks.length} of ${total})` : "";
    lines.push("", `${title}${shown}`, ...rows(section, showBlockers));
  };

  push("in flight", board.inFlight, counts.inFlight);
  push("ready", board.ready, counts.ready);
  push("blocked", board.blocked, counts.blocked, true);

  if (board.pointer !== null) lines.push("", board.pointer);

  // `|| recentTruncated`, so `--limit 0` still reports that activity exists.
  // The task sections can be recovered from the counts header; this one cannot,
  // so an empty-and-silent activity section is the only place on the board where
  // truncation is unrecoverable. `formatEventLog` handles the identical case.
  if (board.recent.length > 0 || board.recentTruncated) {
    lines.push("", "recent (newest first — `katra log` for the rest)");
    for (const event of board.recent) {
      const when = event.createdAt.slice(0, 16).replace("T", " ");
      const title = event.entityTitle === null ? "" : previewBody(event.entityTitle, TITLE_WIDTH);
      lines.push(
        `  ${when}  ${padTo(event.type, EVENT_TYPE_WIDTH)}  ${oneLine(event.entityId)}  ${title}  ${describeEvent(event)}`.trimEnd(),
      );
    }
    // The section owes the same report every other bound in katra owes. It was
    // computed and published and never rendered, which is the one failure mode
    // a truncation flag exists to prevent.
    if (board.recentTruncated) lines.push("  … more; `katra log` for the rest");
  }

  // An empty store still says something. A blank response is indistinguishable
  // from a command that failed silently, and this is the read a session opens
  // with.
  //
  // `recentTruncated` is part of the test because `recent.length` became a
  // function of `--limit`. Without it, `board --limit 0` on a store whose work
  // is all closed printed "the backlog is empty" — a false statement, and one
  // that discarded a digest the command had correctly assembled. Key it off
  // what the store holds, never off what the cap rendered, exactly as
  // `pointerFor` does.
  if (counts.open === 0 && board.recent.length === 0 && !board.recentTruncated) {
    return 'the backlog is empty — `katra add "a title"` to start';
  }

  return lines.join("\n").trimStart();
}

/**
 * `search`'s results: one aligned row per hit, an indented sanitized snippet
 * line beneath it when there is one to show.
 *
 * Empty has two readings, same shape as {@link formatRecent}/
 * {@link formatStale}: a genuine zero-hit search reads "no matches" (or "no
 * matches for `<query>`"), but `--limit 0` can cut a non-empty ranking down
 * to zero rows, and that case reads {@link RAISE_SEARCH_LIMIT_LINE} instead
 * — silence there would claim completeness in exactly the case the flag
 * exists to prevent.
 *
 * Columns mirror {@link formatTaskList} — id, priority, lane, kind (or
 * `epic`, `formatTaskList`'s own convention for a hit at that level) — plus
 * the clamped title. `snippet` is FTS5's raw output (`search.ts`'s docs: not
 * sanitized until render), so it goes through {@link oneLine} here exactly
 * like every other stored-text surface in this file, then {@link clamp} to
 * {@link SNIPPET_WIDTH} — FTS5 bounds its excerpt by token count, not
 * character count, so one pathological token can otherwise produce an
 * unbounded line ({@link SNIPPET_WIDTH}'s docs). `--json` carries `snippet`
 * verbatim regardless. The note-match marker is prefixed to the snippet line
 * rather than the row above it, because the row's own columns describe the
 * *task*, and "this hit came from a note, not the task's own text" is a fact
 * about the snippet, not the task — and, like the marker text `snippet()`
 * itself embeds, this prefix is display-best-effort only: see `SearchHit`'s
 * `snippet` field docs (contract.ts) for why `matchedIn` is the field a
 * consumer should actually trust.
 *
 * An id-only match or a filter-only-path hit carries no snippet at all
 * (`SearchHit`'s docs) — those rows print with no second line.
 */
export function formatSearch(result: SearchResult): string {
  if (result.hits.length === 0) {
    // `--limit 0` can cut a genuinely non-empty ranking down to zero rows
    // (req 11) — the same shape formatEventLog/formatRecent/formatStale
    // already guard against, and search was the one place it went
    // unguarded: "no matches" would be a false claim of completeness in
    // exactly the case the flag exists to prevent (senior review MEDIUM).
    if (result.truncated) return RAISE_SEARCH_LIMIT_LINE;
    // The query is echoed even when it routed through the filter-only path
    // (`SearchResult.query`'s docs), but an empty echo for a genuine
    // filter-only search would read as "no matches for nothing" — so a blank
    // query gets the same plain phrasing `formatTaskList` uses instead.
    //
    // The non-empty echo is clamped like every other rendered field in this
    // file (security scan LOW): the query is stored, untrusted input with no
    // length bound of its own, and every sibling render already caps what it
    // prints — an unclamped echo here was the one place that bound was
    // missing.
    return result.query === ""
      ? "no matches"
      : `no matches for ${clamp(oneLine(result.query), TITLE_WIDTH)}`;
  }

  const width = (pick: (hit: SearchResult["hits"][number]) => string): number =>
    columnWidth(result.hits, pick);
  const laneWidth = width((hit) => hit.lane);
  const kindWidth = width((hit) => (hit.level === "epic" ? "epic" : hit.kind));

  const rows = result.hits.flatMap((hit) => {
    const header = [
      hit.id,
      `P${hit.priority}`,
      padTo(hit.lane, laneWidth),
      padTo(hit.level === "epic" ? "epic" : hit.kind, kindWidth),
      clamp(text(hit.title), TITLE_WIDTH),
    ].join("  ");

    if (hit.snippet === null) return [header];
    const provenance = hit.matchedIn === "note" ? "note match — " : "";
    return [header, `    ${provenance}${clamp(oneLine(hit.snippet), SNIPPET_WIDTH)}`];
  });

  return result.truncated ? [...rows, RAISE_SEARCH_LIMIT_LINE].join("\n") : rows.join("\n");
}

/**
 * `recent`'s results: the entities with the most recent activity, newest
 * first, one aligned row each with its age.
 *
 * Empty and truncated-and-empty read exactly like {@link formatEventLog}'s
 * own two cases for the same shape: "nothing has happened yet" when the store
 * genuinely holds nothing, and the raise-the-limit line alone when `--limit
 * 0` cut a non-empty history down to zero rows — silence there would be a
 * false claim of an empty store.
 */
export function formatRecent(result: RecentResult, now: string = nowIso()): string {
  if (result.hits.length === 0) {
    return result.truncated ? RAISE_LIMIT_LINE : "nothing has happened yet";
  }

  const idWidth = columnWidth(result.hits, (hit) => hit.id);
  const laneWidth = columnWidth(result.hits, (hit) => hit.lane);

  const rows = result.hits.map((hit) => {
    // `recent` joins activity INNER (`activity.ts`'s docs), so every hit here
    // truly has one — the null branch exists only because `ActivityHit` is
    // shared with search's outer-joined path, not because it is reachable
    // from this command.
    const age = hit.lastActivity === null ? "" : (timeAgoOrNull(hit.lastActivity, now) ?? "");
    return `${padTo(hit.id, idWidth)}  P${hit.priority}  ${padTo(hit.lane, laneWidth)}  ${clamp(text(hit.title), TITLE_WIDTH)}  ${age}`.trimEnd();
  });

  return result.truncated ? [...rows, RAISE_LIMIT_LINE].join("\n") : rows.join("\n");
}

/**
 * `stale`'s results: open items untouched since before the window, oldest
 * first.
 *
 * The window is echoed on its own header line — `StaleResult.olderThan`'s
 * docs: the cutoff actually applied, default or explicit, so a caller never
 * has to guess which one produced this list. It appears whether or not any
 * hits came back, so an empty result still says what it checked, not just
 * that it found nothing.
 */
export function formatStale(result: StaleResult, now: string = nowIso()): string {
  const header = `stale — untouched since before ${result.olderThan}`;

  if (result.hits.length === 0) {
    return result.truncated ? `${header}\n${RAISE_LIMIT_LINE}` : `${header}\n  nothing is stale`;
  }

  const idWidth = columnWidth(result.hits, (hit) => hit.id);
  const laneWidth = columnWidth(result.hits, (hit) => hit.lane);

  const rows = result.hits.map((hit) => {
    // Every `stale` hit joins activity INNER, same as `recent` above — never
    // null in practice, but `ActivityHit` carries the wider, nullable type.
    const age =
      hit.lastActivity === null
        ? "no activity"
        : (timeAgoOrNull(hit.lastActivity, now) ?? "unknown");
    return `  ${padTo(hit.id, idWidth)}  P${hit.priority}  ${padTo(hit.lane, laneWidth)}  ${clamp(text(hit.title), TITLE_WIDTH)}  ${age}`.trimEnd();
  });

  return [header, ...rows, ...(result.truncated ? [RAISE_LIMIT_LINE] : [])].join("\n");
}
