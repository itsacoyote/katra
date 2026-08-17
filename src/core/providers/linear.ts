/**
 * The Linear provider (spec §7, ADR-015) — resolves a `linear` ref's live
 * status with one GraphQL query POSTed to `api.linear.app`, authenticated
 * with `LINEAR_API_KEY` read from the injected `env` (iter-3 HIGH-2 —
 * never `process.env` directly; see `types.ts`'s module doc).
 *
 * **Auth is the raw key, never `Bearer`-prefixed** (epic risk note 14,
 * probed real): Linear's GraphQL endpoint returns HTTP 400 for a
 * `Bearer`-prefixed `Authorization` header, so the key is sent exactly as
 * `env.LINEAR_API_KEY` holds it.
 *
 * **Status is `state.type`, never `state.name`** (epic risk note 10,
 * probed): `state.name` is workspace-customizable free text (a team can
 * rename "In Progress" to anything), while `state.type` is one of Linear's
 * own six `WorkflowStateType` values — the only field stable enough to
 * diff against a cached status.
 *
 * **`fetch` has no default timeout** (Node's own, unlike `execFileSync`'s
 * `timeout` option `runGh` sets): {@link LINEAR_TIMEOUT_MS} is threaded
 * through `AbortSignal.timeout`, the WHATWG-standard way to bound a fetch
 * call, matching the 5 second bound `runGh` uses for `gh` (epic risk note
 * 11).
 */

import type { RefreshReason } from "../enums.js";
import { MAX_CACHED_TITLE_LENGTH } from "../refs/parse.js";
import type { Ref } from "../refs/types.js";
import { CONTROL_CHARS_PATTERN, capText } from "../text.js";
import type { Provider, ProviderResult } from "./types.js";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

/** `AbortSignal.timeout`'s bound for the one Linear fetch this provider makes (epic risk note 11) — the same 5 second bound `core/git.ts`'s `runGh` sets for `gh`. */
const LINEAR_TIMEOUT_MS = 5000;

/**
 * `TEAM-123`, re-derived from `ref.externalId` with this provider's own
 * strict pattern — the same flag-injection discipline the GitHub provider
 * applies against argv (epic risk note 3), aimed here at GraphQL
 * string-literal injection instead: {@link buildQuery} splices `externalId`
 * directly into a double-quoted GraphQL argument, so a charset of letters,
 * digits, and one hyphen is what keeps a quote, backslash, or newline from
 * ever reaching that string and breaking out of the literal.
 */
const LINEAR_EXTERNAL_ID_PATTERN = /^[A-Za-z]+-[0-9]+$/;

/**
 * The six `WorkflowStateType` values Linear's own schema defines (epic risk
 * note 10, probed) — `state.type`, never `state.name`. Order matches
 * Linear's own declared order, not alphabetical.
 */
const LINEAR_STATE_TYPES = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
  "duplicate",
] as const;

/** The GraphQL document this provider sends — `externalId` must already have passed {@link LINEAR_EXTERNAL_ID_PATTERN} before this is called. */
function buildQuery(externalId: string): string {
  return `query { issue(id: "${externalId}") { title url state { type } } }`;
}

/**
 * Bounds a provider-supplied title identically to the GitHub provider's own
 * {@link sanitizeTitle}: screened of every control character via the
 * imported {@link CONTROL_CHARS_PATTERN}, then capped to
 * {@link MAX_CACHED_TITLE_LENGTH} code points with {@link capText}. Never
 * refuses.
 */
function sanitizeTitle(title: unknown): string | null {
  if (typeof title !== "string") return null;
  const screened = title.replaceAll(new RegExp(CONTROL_CHARS_PATTERN.source, "g"), "");
  return capText(screened, MAX_CACHED_TITLE_LENGTH).text;
}

/** The parts of a Linear `issue(id: ...)` query response this provider reads. Every field stays `unknown` until narrowed — untrusted external data, not a value katra produced. */
interface LinearIssueBody {
  readonly title?: unknown;
  readonly state?: { readonly type?: unknown } | null;
}

interface LinearGraphQLBody {
  readonly data?: { readonly issue?: LinearIssueBody | null } | null;
  readonly errors?: unknown;
}

/** Parses `text` as a Linear GraphQL response body, or `undefined` for anything that is not a JSON object — never throws. */
function parseGraphQLBody(text: string): LinearGraphQLBody | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  return parsed as LinearGraphQLBody;
}

async function resolve(ref: Ref, env: NodeJS.ProcessEnv): Promise<ProviderResult> {
  if (!LINEAR_EXTERNAL_ID_PATTERN.test(ref.externalId)) {
    return { resolved: false, reason: "bad-shape" };
  }

  const apiKey = env.LINEAR_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    // No network call at all — an absent key is refused before any request
    // is built, not a rejection Linear itself returned.
    return { resolved: false, reason: "no-key" };
  }

  let response: Response;
  try {
    response = await fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Raw key, never "Bearer "-prefixed — see this module's header.
        Authorization: apiKey,
      },
      body: JSON.stringify({ query: buildQuery(ref.externalId) }),
      signal: AbortSignal.timeout(LINEAR_TIMEOUT_MS),
    });
  } catch (error) {
    // AbortSignal.timeout firing rejects with a DOMException whose `name` is
    // "TimeoutError" (WHATWG standard) — checked directly, the same
    // discipline `core/git.ts`'s classifyGhFailure applies to
    // execFileSync's own timeout signal, never inferred from a generic
    // network-failure shape.
    const reason: RefreshReason =
      error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network";
    return { resolved: false, reason };
  }

  if (response.status === 401) {
    return { resolved: false, reason: "bad-key" };
  }
  if (!response.ok) {
    return { resolved: false, reason: "malformed-response" };
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return { resolved: false, reason: "malformed-response" };
  }

  const parsedBody = parseGraphQLBody(text);
  if (parsedBody === undefined) {
    return { resolved: false, reason: "malformed-response" };
  }

  // Covers both the named dispatch shape (200 + `errors` + `data: null`) and
  // a clean response whose `issue` is simply absent — either way, the
  // external entity itself does not exist, and `data?.issue` collapses both
  // to the same `undefined`/`null` check via optional chaining.
  const issue = parsedBody.data?.issue;
  if (issue === null || issue === undefined) {
    return { resolved: false, reason: "not-found" };
  }

  const stateType = issue.state?.type;
  if (
    typeof stateType !== "string" ||
    !(LINEAR_STATE_TYPES as readonly string[]).includes(stateType)
  ) {
    return { resolved: false, reason: "malformed-response" };
  }

  return {
    resolved: true,
    // No capText here, unlike title: stateType has already passed the
    // vocabulary check above, a strictly stronger guarantee than a length
    // bound for a fixed set of short literals — capping past it would cap
    // nothing real.
    status: stateType,
    title: sanitizeTitle(issue.title),
  };
}

/** The Linear provider — one of the two entries `registry.ts` (ADR-015) enumerates. */
export const linearProvider: Provider = {
  name: "linear",
  match(ref: Ref): boolean {
    return ref.provider === "linear";
  },
  resolve,
};
