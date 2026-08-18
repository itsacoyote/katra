/**
 * The provider seam (spec §7, F8 T3): the registry, the GitHub provider, and
 * the Linear provider.
 *
 * `runGh` and global `fetch` are both mocked at the module/global boundary —
 * this suite proves the providers' own shape re-derivation, status
 * derivation, and reason dispatch, never a real `gh` or a real network call.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GhResult } from "../../src/core/git.js";
import { githubProvider } from "../../src/core/providers/github.js";
import {
  LINEAR_MAX_BODY_BYTES,
  LINEAR_TIMEOUT_MS,
  linearProvider,
} from "../../src/core/providers/linear.js";
import { PROVIDERS, providerFor } from "../../src/core/providers/registry.js";
import type { ProviderResult } from "../../src/core/providers/types.js";
import { MAX_CACHED_TITLE_LENGTH, MAX_EXTERNAL_ID_LENGTH } from "../../src/core/refs/parse.js";
import type { Ref } from "../../src/core/refs/types.js";

/** A raw BEL control byte, built via `fromCharCode` — house rule: no raw control bytes as literals in a committed file. */
const BEL = String.fromCharCode(7);
/** A literal double quote, built via `fromCharCode` to avoid escaping it inside double-quoted source. */
const DQUOTE = String.fromCharCode(34);
/** A literal backslash, built via `fromCharCode` for the same reason. */
const BACKSLASH = String.fromCharCode(92);

/** A fake key, obviously not a real one — house rule: tests use sentinel strings only, never a real credential. */
const LINEAR_KEY_SENTINEL = "lin_test_sentinel_not_a_real_key_000000";

function buildRef(overrides: Partial<Ref> & Pick<Ref, "provider" | "externalId">): Ref {
  return {
    url: null,
    cachedStatus: null,
    cachedTitle: null,
    syncedAt: null,
    ...overrides,
  };
}

// --- runGh mock (github.ts's only external call) ---------------------------

const runGhHook = vi.hoisted(() => ({
  impl: null as ((env: NodeJS.ProcessEnv, args: string[]) => GhResult) | null,
  calls: [] as string[][],
}));
vi.mock("../../src/core/git.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/core/git.js")>();
  const runGh: typeof original.runGh = (env, args) => {
    runGhHook.calls.push(args);
    if (runGhHook.impl === null) {
      throw new Error("runGh called with no stub installed for this test");
    }
    return runGhHook.impl(env, args);
  };
  return { ...original, runGh };
});

beforeEach(() => {
  runGhHook.impl = null;
  runGhHook.calls = [];
});

// --- fetch mock (linear.ts's only external call) ----------------------------

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

let fetchCalls: FetchCall[] = [];
let fetchImpl: ((url: string, init: RequestInit | undefined) => Promise<Response>) | null = null;

beforeEach(() => {
  fetchCalls = [];
  fetchImpl = null;
  vi.stubGlobal("fetch", (url: string, init: RequestInit | undefined) => {
    fetchCalls.push({ url, init });
    if (fetchImpl === null) {
      throw new Error("fetch called with no stub installed for this test");
    }
    return fetchImpl(url, init);
  });
});
afterEach(() => vi.unstubAllGlobals());

/** A real `ReadableStream` yielding `text` as UTF-8 bytes in one chunk — `readBounded` reads a genuine stream, so the fixture is a genuine stream too, not a `.text()` stand-in. */
function textStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** A real `ReadableStream` yielding a single all-zero chunk of `byteLength` bytes — for proving `readBounded`'s size bound fires on a real streamed read, not a pre-materialized string. */
function oversizedStream(byteLength: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(byteLength));
      controller.close();
    },
  });
}

/** Builds a fake `Response` carrying just what `linear.ts` reads: `status`, `ok`, and a real streamed `body`. */
function fakeResponse(status: number, body: ReadableStream<Uint8Array>): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    body,
  } as unknown as Response;
}

// --- structural: no provider file reads process.env directly ---------------

describe("env injection", () => {
  /**
   * Strips block comments entirely, and strips a `//` line comment only
   * when `//` is the first non-whitespace content on its line — never a
   * `//` appearing later in the line, which would otherwise treat the rest
   * of a string literal (a `https://...` URL, most notably) as a comment
   * and silently hide real code from the scan below.
   */
  function stripComments(source: string): string {
    const withoutBlockComments = source.replaceAll(/\/\*[\s\S]*?\*\//g, "");
    return withoutBlockComments
      .split("\n")
      .map((line) => (/^\s*\/\//.test(line) ? "" : line))
      .join("\n");
  }

  function providerSourceFiles(): { readonly root: string; readonly files: readonly string[] } {
    const root = fileURLToPath(new URL("../../src/core/providers", import.meta.url));
    const files = readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"),
      )
      .map((entry) => entry.name);
    return { root, files };
  }

  it("no provider source file references the process global, directly or via node:process", () => {
    const { root, files } = providerSourceFiles();
    // Globbed, not a hardcoded list — a new file under providers/ (shared.ts
    // today, anything added later) is covered automatically.
    expect(files.length).toBeGreaterThanOrEqual(4);

    for (const file of files) {
      const source = stripComments(readFileSync(join(root, file), "utf8"));
      // The whole `process` token, not just `process.env`: a destructuring
      // read (`const { env } = process`) or `node:process` import specifier
      // never contains the substring "process.env" at all, and a narrower
      // pattern would miss both.
      expect(source, `${file} must not reference process`).not.toMatch(/\bprocess\b/);
    }
  });

  it("strips only full-line comments, leaving a URL literal containing // intact", () => {
    const { root } = providerSourceFiles();
    const source = readFileSync(join(root, "linear.ts"), "utf8");

    const stripped = stripComments(source);

    expect(stripped).toContain("https://api.linear.app/graphql");
  });
});

// --- registry ---------------------------------------------------------------

describe("providerFor", () => {
  it("has exactly two providers", () => {
    expect(PROVIDERS).toHaveLength(2);
  });

  it("returns the provider whose match() claims the ref", () => {
    expect(providerFor(buildRef({ provider: "github", externalId: "acme/app#1" }))).toBe(
      githubProvider,
    );
    expect(providerFor(buildRef({ provider: "linear", externalId: "ABC-1" }))).toBe(linearProvider);
  });

  it("returns undefined for a provider it does not ship (the escape hatch)", () => {
    expect(providerFor(buildRef({ provider: "jira", externalId: "PROJ-1" }))).toBeUndefined();
  });
});

// --- github: strict shape re-derivation -------------------------------------

describe("github provider: strict-shape refusals", () => {
  const hostileIds = [
    // Structurally mismatched — no amount of charset tuning matters, these
    // never look like owner/repo#n at all.
    "-R evil/repo",
    "--jq .token",
    "a b#1",
    "owner/repo#1x",
    // Skeleton-CONFORMING — each of these has the owner/repo#n shape (a
    // '/', a '#', trailing digits) and is refused only because a
    // character inside a segment falls outside the allowed charset. These
    // are what actually prove the charset restriction is doing work, not
    // just the overall anchored shape.
    "-R evil/repo#1",
    "a b/c#1",
    "own;er/repo#1",
    "owner/re$(id)po#1",
    // '.'/'..' segments: charset-legal on their own, refused separately by
    // isDotSegment.
    "-foo/bar#1",
    "../..#1",
    "own/..#1",
  ];

  it.each(hostileIds)("refuses %s as bad-shape with zero gh spawns", async (externalId) => {
    const ref = buildRef({ provider: "github", externalId });

    const result = await githubProvider.resolve(ref, {});

    expect(result).toEqual({ resolved: false, reason: "bad-shape" });
    expect(runGhHook.calls).toEqual([]);
  });
});

describe("github provider: externalId length precheck", () => {
  it("refuses an externalId over MAX_EXTERNAL_ID_LENGTH as bad-shape before any spawn", async () => {
    // Otherwise pattern-legal (a valid owner, a valid repo, digits) — only
    // its length is the problem, so this fails only if the length precheck
    // itself is missing, not because the shape check would also catch it.
    const longId = `${"a".repeat(MAX_EXTERNAL_ID_LENGTH)}/repo#1`;
    const ref = buildRef({ provider: "github", externalId: longId });

    const result = await githubProvider.resolve(ref, {});

    expect(result).toEqual({ resolved: false, reason: "bad-shape" });
    expect(runGhHook.calls).toEqual([]);
  });
});

// --- github: exact request shape --------------------------------------------

describe("github provider: exact request shape", () => {
  it("calls gh with exactly one argv element, repos/{owner}/{repo}/issues/{n}", async () => {
    const ref = buildRef({ provider: "github", externalId: "acme/app#128" });
    runGhHook.impl = () => ({
      ok: true,
      stdout: JSON.stringify({ state: "open", title: "x", draft: false, pull_request: null }),
    });

    await githubProvider.resolve(ref, {});

    expect(runGhHook.calls).toEqual([["api", "repos/acme/app/issues/128"]]);
  });
});

// --- github: status derivation -----------------------------------------------

describe("github provider: status derivation", () => {
  const ref = buildRef({ provider: "github", externalId: "acme/app#128" });

  function stubIssue(body: unknown): void {
    runGhHook.impl = () => ({ ok: true, stdout: JSON.stringify(body) });
  }

  it("derives open from a plain issue with pull_request null", async () => {
    stubIssue({ state: "open", title: "Fix bug", draft: false, pull_request: null });

    const result = await githubProvider.resolve(ref, {});

    expect(result).toEqual({ resolved: true, status: "open", title: "Fix bug" });
  });

  it("derives closed from a plain closed issue", async () => {
    stubIssue({ state: "closed", title: "Old bug", draft: false, pull_request: null });

    const result = await githubProvider.resolve(ref, {});

    expect(result).toEqual({ resolved: true, status: "closed", title: "Old bug" });
  });

  it("derives draft from an open, non-merged, draft PR", async () => {
    stubIssue({
      state: "open",
      title: "WIP feature",
      draft: true,
      pull_request: { merged_at: null },
    });

    const result = await githubProvider.resolve(ref, {});

    expect(result).toEqual({ resolved: true, status: "draft", title: "WIP feature" });
  });

  it("derives merged from a closed PR with merged_at set, outranking draft/state", async () => {
    stubIssue({
      state: "closed",
      title: "Ship it",
      draft: true,
      pull_request: { merged_at: "2026-01-01T00:00:00Z" },
    });

    const result = await githubProvider.resolve(ref, {});

    expect(result).toEqual({ resolved: true, status: "merged", title: "Ship it" });
  });

  it("derives open from an open, non-draft, non-merged PR", async () => {
    stubIssue({
      state: "open",
      title: "Ready for review",
      draft: false,
      pull_request: { merged_at: null },
    });

    const result = await githubProvider.resolve(ref, {});

    expect(result).toEqual({ resolved: true, status: "open", title: "Ready for review" });
  });

  it("does not derive merged when merged_at is an empty string", async () => {
    stubIssue({
      state: "open",
      title: "Not actually merged",
      draft: false,
      pull_request: { merged_at: "" },
    });

    const result = await githubProvider.resolve(ref, {});

    expect(result).toEqual({ resolved: true, status: "open", title: "Not actually merged" });
  });

  it("caps a title over MAX_CACHED_TITLE_LENGTH to exactly the constant", async () => {
    const longTitle = "x".repeat(MAX_CACHED_TITLE_LENGTH + 50);
    stubIssue({ state: "open", title: longTitle, draft: false, pull_request: null });

    const result = await githubProvider.resolve(ref, {});

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.title).toHaveLength(MAX_CACHED_TITLE_LENGTH);
      expect(longTitle.startsWith(result.title ?? "")).toBe(true);
    }
  });

  it("screens control characters out of the title", async () => {
    stubIssue({
      state: "open",
      title: `bad${BEL}title`,
      draft: false,
      pull_request: null,
    });

    const result = await githubProvider.resolve(ref, {});

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.title).toBe("badtitle");
      expect(result.title).not.toContain(BEL);
    }
  });

  it("degrades to malformed-response for an unrecognized state value", async () => {
    stubIssue({ state: "merging", title: "x", draft: false, pull_request: null });

    const result = await githubProvider.resolve(ref, {});

    expect(result).toEqual({ resolved: false, reason: "malformed-response" });
  });

  it("degrades to malformed-response for unparseable JSON", async () => {
    runGhHook.impl = () => ({ ok: true, stdout: "not json" });

    const result = await githubProvider.resolve(ref, {});

    expect(result).toEqual({ resolved: false, reason: "malformed-response" });
  });
});

// --- github: runGh failure reasons pass through 1:1 -------------------------

describe("github provider: runGh failure reasons map 1:1", () => {
  const reasons: Array<Extract<ProviderResult, { resolved: false }>["reason"]> = [
    "gh-not-available",
    "gh-unauthenticated",
    "not-found",
    "bad-credentials",
    "network",
    "timeout",
    "malformed-response",
  ];

  it.each(reasons)("propagates runGh's %s reason unchanged", async (reason) => {
    const ref = buildRef({ provider: "github", externalId: "acme/app#1" });
    runGhHook.impl = () => ({ ok: false, reason });

    const result = await githubProvider.resolve(ref, {});

    expect(result).toEqual({ resolved: false, reason });
  });
});

// --- linear: strict shape re-derivation -------------------------------------

describe("linear provider: strict-shape refusals", () => {
  const hostileIds = [
    `TEAM${BEL}-123`,
    // Skeleton-CONFORMING: each still looks close to LETTERS-DIGITS, and is
    // refused only because a character falls outside the allowed charset —
    // exactly the characters that matter for GraphQL string-literal
    // injection (a quote or a backslash breaking out of the embedded
    // string, braces reshaping the query itself).
    `ABC${DQUOTE}-1`,
    `AB${BACKSLASH}C-1`,
    `ABC-1${DQUOTE}) { x } #-1`,
  ];

  it.each(hostileIds)("refuses %s as bad-shape with zero fetch calls", async (externalId) => {
    const ref = buildRef({ provider: "linear", externalId });

    const result = await linearProvider.resolve(ref, { LINEAR_API_KEY: LINEAR_KEY_SENTINEL });

    expect(result).toEqual({ resolved: false, reason: "bad-shape" });
    expect(fetchCalls).toEqual([]);
  });
});

describe("linear provider: externalId length precheck", () => {
  it("refuses an externalId over MAX_EXTERNAL_ID_LENGTH as bad-shape before any fetch", async () => {
    // Otherwise pattern-legal (letters, a hyphen, digits) — only its length
    // is the problem.
    const longId = `${"A".repeat(MAX_EXTERNAL_ID_LENGTH)}-1`;
    const ref = buildRef({ provider: "linear", externalId: longId });

    const result = await linearProvider.resolve(ref, { LINEAR_API_KEY: LINEAR_KEY_SENTINEL });

    expect(result).toEqual({ resolved: false, reason: "bad-shape" });
    expect(fetchCalls).toEqual([]);
  });
});

// --- linear: no-key short circuit -------------------------------------------

describe("linear provider: no-key short circuit", () => {
  it("refuses with no-key and makes zero fetch calls when LINEAR_API_KEY is absent", async () => {
    const ref = buildRef({ provider: "linear", externalId: "ABC-1" });

    const result = await linearProvider.resolve(ref, {});

    expect(result).toEqual({ resolved: false, reason: "no-key" });
    expect(fetchCalls).toEqual([]);
  });
});

// --- linear: exact request shape, raw-key auth ------------------------------

describe("linear provider: exact request shape", () => {
  it("POSTs to the literal endpoint, raw key, expected query, and a real AbortSignal", async () => {
    const ref = buildRef({ provider: "linear", externalId: "ABC-1" });
    fetchImpl = () =>
      Promise.resolve(
        fakeResponse(
          200,
          textStream(
            JSON.stringify({ data: { issue: { title: "x", state: { type: "started" } } } }),
          ),
        ),
      );

    await linearProvider.resolve(ref, { LINEAR_API_KEY: LINEAR_KEY_SENTINEL });

    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0];
    expect(call).toBeDefined();

    // The literal endpoint, never re-derived from the module under test —
    // an independent expected value, so a url swap in the source fails
    // this assertion rather than silently agreeing with itself.
    expect(call?.url).toBe("https://api.linear.app/graphql");
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.signal).toBeInstanceOf(AbortSignal);

    const headers = call?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(LINEAR_KEY_SENTINEL);
    expect(headers.Authorization?.startsWith("Bearer")).toBe(false);

    const parsedBody = JSON.parse(call?.init?.body as string) as { query: string };
    expect(parsedBody.query).toContain('issue(id: "ABC-1")');
    expect(parsedBody.query).toContain("state { type }");
  });
});

// --- linear: state.type used, state.name ignored ----------------------------

describe("linear provider: status source", () => {
  it("uses state.type and ignores state.name", async () => {
    const ref = buildRef({ provider: "linear", externalId: "ABC-1" });
    fetchImpl = () =>
      Promise.resolve(
        fakeResponse(
          200,
          textStream(
            JSON.stringify({
              data: {
                issue: {
                  title: "x",
                  state: { type: "started", name: "In Progress (custom label)" },
                },
              },
            }),
          ),
        ),
      );

    const result = await linearProvider.resolve(ref, { LINEAR_API_KEY: LINEAR_KEY_SENTINEL });

    expect(result).toEqual({ resolved: true, status: "started", title: "x" });
  });

  it("degrades to malformed-response when state.type is not one of the six values", async () => {
    const ref = buildRef({ provider: "linear", externalId: "ABC-1" });
    fetchImpl = () =>
      Promise.resolve(
        fakeResponse(
          200,
          textStream(
            JSON.stringify({ data: { issue: { title: "x", state: { type: "In Progress" } } } }),
          ),
        ),
      );

    const result = await linearProvider.resolve(ref, { LINEAR_API_KEY: LINEAR_KEY_SENTINEL });

    expect(result).toEqual({ resolved: false, reason: "malformed-response" });
  });
});

// --- linear: dispatch table --------------------------------------------------

describe("linear provider: dispatch table", () => {
  const ref = buildRef({ provider: "linear", externalId: "ABC-1" });
  const env = { LINEAR_API_KEY: LINEAR_KEY_SENTINEL };

  it("an errored body stream leaves no unhandled rejection", async () => {
    // reader.cancel() REJECTS on an already-errored stream; an unhandled copy
    // of that rejection crashes the real binary (vitest's own handler masks
    // it, which is why this test registers its own) and Node's default dump
    // can carry the Authorization header to stderr. Security round-2 HIGH.
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => void unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const erroring = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          controller.error(new TypeError("terminated"));
        },
      });
      fetchImpl = () => Promise.resolve(fakeResponse(200, erroring));

      const result = await linearProvider.resolve(ref, env);
      await new Promise((done) => setTimeout(done, 50));

      expect(result).toEqual({ resolved: false, reason: "network" });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("401 dispatches to bad-key", async () => {
    fetchImpl = () => Promise.resolve(fakeResponse(401, textStream("{}")));

    const result = await linearProvider.resolve(ref, env);

    expect(result).toEqual({ resolved: false, reason: "bad-key" });
  });

  it("400 dispatches to bad-key (the Bearer-prefixed-key mistake)", async () => {
    fetchImpl = () => Promise.resolve(fakeResponse(400, textStream("{}")));

    const result = await linearProvider.resolve(ref, env);

    expect(result).toEqual({ resolved: false, reason: "bad-key" });
  });

  it("429 dispatches to network", async () => {
    fetchImpl = () => Promise.resolve(fakeResponse(429, textStream("{}")));

    const result = await linearProvider.resolve(ref, env);

    expect(result).toEqual({ resolved: false, reason: "network" });
  });

  it("503 dispatches to network", async () => {
    fetchImpl = () => Promise.resolve(fakeResponse(503, textStream("{}")));

    const result = await linearProvider.resolve(ref, env);

    expect(result).toEqual({ resolved: false, reason: "network" });
  });

  it("a generic non-ok status dispatches to malformed-response", async () => {
    fetchImpl = () => Promise.resolve(fakeResponse(403, textStream("{}")));

    const result = await linearProvider.resolve(ref, env);

    expect(result).toEqual({ resolved: false, reason: "malformed-response" });
  });

  it("200 with errors and null data dispatches to not-found", async () => {
    fetchImpl = () =>
      Promise.resolve(
        fakeResponse(
          200,
          textStream(JSON.stringify({ data: null, errors: [{ message: "Entity not found" }] })),
        ),
      );

    const result = await linearProvider.resolve(ref, env);

    expect(result).toEqual({ resolved: false, reason: "not-found" });
  });

  it("a plain network throw dispatches to network", async () => {
    fetchImpl = () => Promise.reject(new TypeError("fetch failed"));

    const result = await linearProvider.resolve(ref, env);

    expect(result).toEqual({ resolved: false, reason: "network" });
  });

  it("unparseable JSON dispatches to malformed-response", async () => {
    fetchImpl = () => Promise.resolve(fakeResponse(200, textStream("not json")));

    const result = await linearProvider.resolve(ref, env);

    expect(result).toEqual({ resolved: false, reason: "malformed-response" });
  });

  it("a body over LINEAR_MAX_BODY_BYTES dispatches to malformed-response", async () => {
    fetchImpl = () =>
      Promise.resolve(fakeResponse(200, oversizedStream(LINEAR_MAX_BODY_BYTES + 1)));

    const result = await linearProvider.resolve(ref, env);

    expect(result).toEqual({ resolved: false, reason: "malformed-response" });
  });

  // Real time, not faked: AbortSignal.timeout's internal timer is not
  // guaranteed to be driven by vitest's fake-timer patching of the global
  // setTimeout, so this proves the actual wiring end to end — the mock
  // fetch waits on the real signal firing, exactly as real undici would.
  // A signal-deletion mutation makes this fail fast (no signal reaches the
  // mock at all) rather than after the wait.
  it(
    "a fetch that stalls past AbortSignal.timeout reaches the timeout branch",
    async () => {
      fetchImpl = (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal === undefined || signal === null) {
            reject(new Error("expected an AbortSignal on init.signal"));
            return;
          }
          if (signal.aborted) {
            const err = new Error("The operation was aborted due to timeout");
            err.name = "TimeoutError";
            reject(err);
            return;
          }
          signal.addEventListener("abort", () => {
            const err = new Error("The operation was aborted due to timeout");
            err.name = "TimeoutError";
            reject(err);
          });
        });

      const result = await linearProvider.resolve(ref, env);

      expect(result).toEqual({ resolved: false, reason: "timeout" });
    },
    LINEAR_TIMEOUT_MS + 5000,
  );
});

// --- linear: title bounding, matching github's ------------------------------

describe("linear provider: title bounding", () => {
  const ref = buildRef({ provider: "linear", externalId: "ABC-1" });
  const env = { LINEAR_API_KEY: LINEAR_KEY_SENTINEL };

  it("strips before capping — a screened character never eats the visible budget", async () => {
    // Cap-then-strip would remove the BEL after the cut, leaving one short of
    // the constant; strip-then-cap yields exactly the constant. Pins the
    // ordering sanitizeProviderTitle promises (senior round-2 residual).
    const title = `abc${BEL}def${"y".repeat(MAX_CACHED_TITLE_LENGTH + 50)}`;
    fetchImpl = () =>
      Promise.resolve(
        fakeResponse(
          200,
          textStream(JSON.stringify({ data: { issue: { title, state: { type: "backlog" } } } })),
        ),
      );

    const result = await linearProvider.resolve(ref, env);

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.title).toHaveLength(MAX_CACHED_TITLE_LENGTH);
      expect(result.title?.startsWith("abcdef")).toBe(true);
    }
  });

  it("caps a title over MAX_CACHED_TITLE_LENGTH to exactly the constant", async () => {
    const longTitle = "y".repeat(MAX_CACHED_TITLE_LENGTH + 50);
    fetchImpl = () =>
      Promise.resolve(
        fakeResponse(
          200,
          textStream(
            JSON.stringify({
              data: { issue: { title: longTitle, state: { type: "backlog" } } },
            }),
          ),
        ),
      );

    const result = await linearProvider.resolve(ref, env);

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.title).toHaveLength(MAX_CACHED_TITLE_LENGTH);
    }
  });

  it("screens control characters out of the title", async () => {
    fetchImpl = () =>
      Promise.resolve(
        fakeResponse(
          200,
          textStream(
            JSON.stringify({
              data: { issue: { title: `bad${BEL}title`, state: { type: "backlog" } } },
            }),
          ),
        ),
      );

    const result = await linearProvider.resolve(ref, env);

    expect(result).toEqual({ resolved: true, status: "backlog", title: "badtitle" });
  });
});

// --- key hygiene -------------------------------------------------------------

describe("key hygiene", () => {
  it("the LINEAR_API_KEY sentinel never appears in JSON.stringify of any result, across every failure path", async () => {
    const ref = buildRef({ provider: "linear", externalId: "ABC-1" });
    const env = { LINEAR_API_KEY: LINEAR_KEY_SENTINEL };

    const scenarios: Array<() => Promise<ProviderResult>> = [
      () => {
        fetchImpl = () => Promise.resolve(fakeResponse(401, textStream("{}")));
        return linearProvider.resolve(ref, env);
      },
      () => {
        fetchImpl = () =>
          Promise.resolve(
            fakeResponse(200, textStream(JSON.stringify({ data: null, errors: [] }))),
          );
        return linearProvider.resolve(ref, env);
      },
      () => {
        fetchImpl = () => Promise.reject(new TypeError("fetch failed"));
        return linearProvider.resolve(ref, env);
      },
      () => {
        fetchImpl = () => Promise.resolve(fakeResponse(200, textStream("not json")));
        return linearProvider.resolve(ref, env);
      },
    ];

    for (const scenario of scenarios) {
      const result = await scenario();
      expect(JSON.stringify(result)).not.toContain(LINEAR_KEY_SENTINEL);
    }

    // The key must also never have ridden along in the request itself beyond
    // the Authorization header — never appended to the URL, never folded
    // into the query body as anything but what buildQuery puts there.
    for (const call of fetchCalls) {
      expect(call.url).not.toContain(LINEAR_KEY_SENTINEL);
    }
  });
});
