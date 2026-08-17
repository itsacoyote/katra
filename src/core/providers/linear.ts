/**
 * The Linear provider (spec §7, ADR-015) — resolves a `linear` ref's live
 * status with one GraphQL query POSTed to `api.linear.app`, authenticated
 * with `LINEAR_API_KEY` read from the injected `env` (iter-3 HIGH-2 —
 * never `process.env` directly; see `types.ts`'s module doc).
 *
 * **Auth is the raw key, never `Bearer`-prefixed** (epic risk note 14,
 * probed real): Linear's GraphQL endpoint returns HTTP 400 for a
 * `Bearer`-prefixed `Authorization` header — a malformed-request response,
 * not a credential rejection — so the key is sent exactly as
 * `env.LINEAR_API_KEY` holds it, and a 400 is dispatched the same way a 401
 * is (see {@link resolve}'s status dispatch).
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
 * 11). The same signal bounds the body read too ({@link readBounded}): a
 * stalled read past the timeout rejects through the identical
 * `AbortSignal`, so {@link classifyFetchFailure} is the one place both the
 * connect phase and the read phase get classified.
 */

import type { RefreshReason } from "../enums.js";
import { MAX_EXTERNAL_ID_LENGTH } from "../refs/parse.js";
import type { Ref } from "../refs/types.js";
import { parseJsonObject, sanitizeProviderTitle } from "./shared.js";
import type { Provider, ProviderResult } from "./types.js";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

/** `AbortSignal.timeout`'s bound for the one Linear fetch this provider makes (epic risk note 11) — the same 5 second bound `core/git.ts`'s `runGh` sets for `gh`. */
export const LINEAR_TIMEOUT_MS = 5000;

/**
 * The byte bound {@link readBounded} enforces while streaming a response
 * body — the same `maxBuffer` discipline `core/git.ts`'s `runGh` applies to
 * `gh`'s stdout (1 MiB there too), here for `fetch`, which has no
 * equivalent option of its own: a compromised or malfunctioning Linear
 * endpoint cannot make this process buffer an unbounded response.
 */
export const LINEAR_MAX_BODY_BYTES = 1024 * 1024;

/**
 * `TEAM-123`, re-derived from `ref.externalId` with this provider's own
 * strict pattern — the same flag-injection discipline the GitHub provider
 * applies against argv (epic risk note 3), aimed here at GraphQL
 * string-literal injection instead: {@link buildQuery} splices `externalId`
 * directly into a double-quoted GraphQL argument, so a charset of letters,
 * digits, and one hyphen is what keeps a quote, backslash, brace, or
 * newline from ever reaching that string and breaking out of the literal.
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

/** The parts of a Linear `issue(id: ...)` query response this provider reads. Every field stays `unknown` until narrowed — untrusted external data, not a value katra produced. */
interface LinearIssueBody {
  readonly title?: unknown;
  readonly state?: { readonly type?: unknown } | null;
}

interface LinearGraphQLBody {
  readonly data?: { readonly issue?: LinearIssueBody | null } | null;
  readonly errors?: unknown;
}

/**
 * Distinguishes {@link readBounded}'s own bound-exceeded throw from a
 * genuine stream failure, by name — the same `error.name` discipline
 * {@link classifyFetchFailure} already uses to tell a timeout apart from an
 * ordinary network throw, extended to a third case a large body is not a
 * transport problem, and must not be classified as one.
 */
class ResponseTooLargeError extends Error {
  constructor() {
    super(`response body exceeded ${LINEAR_MAX_BODY_BYTES} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

/**
 * Classifies a rejection from either the `fetch` call itself or
 * {@link readBounded}'s streamed read — the one place both phases are told
 * apart, so neither call site duplicates the `error.name` checks. A body
 * read that stalls past the same `AbortSignal.timeout` `fetch` was given
 * rejects exactly the way the initial connect does (WHATWG: the signal
 * aborts the whole request, not just the phase that was active when it
 * fired), so a stalled read is `timeout`, never the generic
 * `malformed-response` a naive "the body could not be read" reading would
 * produce.
 */
function classifyFetchFailure(error: unknown): RefreshReason {
  if (error instanceof ResponseTooLargeError) return "malformed-response";
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  return "network";
}

/**
 * Reads `response`'s body as UTF-8 text, aborting once the running byte
 * count crosses {@link LINEAR_MAX_BODY_BYTES} rather than buffering an
 * unbounded response — see that constant's docs. The reader is always
 * cancelled in `finally`, on every exit path, so a bound-exceeded or
 * otherwise-interrupted read never leaves the underlying connection
 * half-consumed.
 */
async function readBounded(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) return "";

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > LINEAR_MAX_BODY_BYTES) {
        throw new ResponseTooLargeError();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    void reader.cancel();
  }
}

async function resolve(ref: Ref, env: NodeJS.ProcessEnv): Promise<ProviderResult> {
  if (ref.externalId.length > MAX_EXTERNAL_ID_LENGTH) {
    return { resolved: false, reason: "bad-shape" };
  }
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
    return { resolved: false, reason: classifyFetchFailure(error) };
  }

  // 400 sits beside 401: Linear's GraphQL endpoint answers a
  // Bearer-prefixed key with 400 (a malformed request from its point of
  // view), not 401 (probed real) — both name the same underlying mistake
  // ("wrong key presentation"), so both dispatch to the same reason.
  if (response.status === 401 || response.status === 400) {
    return { resolved: false, reason: "bad-key" };
  }
  // Rate limiting and server-side failure are transport problems, not a
  // shape or credential problem this provider can do anything about.
  if (response.status === 429 || response.status >= 500) {
    return { resolved: false, reason: "network" };
  }
  if (!response.ok) {
    return { resolved: false, reason: "malformed-response" };
  }

  let text: string;
  try {
    text = await readBounded(response);
  } catch (error) {
    return { resolved: false, reason: classifyFetchFailure(error) };
  }

  const raw = parseJsonObject(text);
  if (raw === undefined) {
    return { resolved: false, reason: "malformed-response" };
  }
  const parsedBody = raw as LinearGraphQLBody;

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
    status: stateType,
    title: sanitizeProviderTitle(issue.title),
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
