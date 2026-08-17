/**
 * The provider seam (spec §7, F8 T3): the registry, the GitHub provider, and
 * the Linear provider.
 *
 * `runGh` and global `fetch` are both mocked at the module/global boundary —
 * this suite proves the providers' own shape re-derivation, status
 * derivation, and reason dispatch, never a real `gh` or a real network call.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GhResult } from "../../src/core/git.js";
import { githubProvider } from "../../src/core/providers/github.js";
import { linearProvider } from "../../src/core/providers/linear.js";
import { PROVIDERS, providerFor } from "../../src/core/providers/registry.js";
import type { ProviderResult } from "../../src/core/providers/types.js";
import { MAX_CACHED_TITLE_LENGTH } from "../../src/core/refs/parse.js";
import type { Ref } from "../../src/core/refs/types.js";

/** A raw BEL control byte, built via `fromCharCode` — house rule: no raw control bytes as literals in a committed file. */
const BEL = String.fromCharCode(7);

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

/** Builds a fake `Response` carrying just what `linear.ts` reads: `status`, `ok`, `text()`. */
function fakeResponse(status: number, body: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

// --- structural: no provider file reads process.env directly ---------------

describe("env injection", () => {
  it("neither provider file references process.env", () => {
    const root = fileURLToPath(new URL("../../src/core/providers", import.meta.url));
    const stripComments = (source: string): string =>
      source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/[^\n]*/g, "");

    for (const file of ["github.ts", "linear.ts", "registry.ts", "types.ts"]) {
      const source = stripComments(readFileSync(join(root, file), "utf8"));
      expect(source, `${file} must not reference process.env`).not.toMatch(/\bprocess\.env\b/);
    }
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
  const hostileIds = ["-R evil/repo", "--jq .token", "a b#1", "owner/repo#1x"];

  it.each(hostileIds)("refuses %s as bad-shape with zero gh spawns", async (externalId) => {
    const ref = buildRef({ provider: "github", externalId });

    const result = await githubProvider.resolve(ref, {});

    expect(result).toEqual({ resolved: false, reason: "bad-shape" });
    expect(runGhHook.calls).toEqual([]);
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
  it("refuses a malformed external id as bad-shape with zero fetch calls", async () => {
    const ref = buildRef({ provider: "linear", externalId: `TEAM${BEL}-123` });

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

// --- linear: raw-key auth header --------------------------------------------

describe("linear provider: raw-key auth", () => {
  it("sends the raw key with no Bearer prefix", async () => {
    const ref = buildRef({ provider: "linear", externalId: "ABC-1" });
    fetchImpl = () =>
      Promise.resolve(
        fakeResponse(
          200,
          JSON.stringify({ data: { issue: { title: "x", state: { type: "started" } } } }),
        ),
      );

    await linearProvider.resolve(ref, { LINEAR_API_KEY: LINEAR_KEY_SENTINEL });

    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0];
    expect(call).toBeDefined();
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(LINEAR_KEY_SENTINEL);
    expect(headers.Authorization?.startsWith("Bearer")).toBe(false);
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
          JSON.stringify({
            data: {
              issue: {
                title: "x",
                state: { type: "started", name: "In Progress (custom label)" },
              },
            },
          }),
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
          JSON.stringify({ data: { issue: { title: "x", state: { type: "In Progress" } } } }),
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

  it("401 dispatches to bad-key", async () => {
    fetchImpl = () => Promise.resolve(fakeResponse(401, JSON.stringify({})));

    const result = await linearProvider.resolve(ref, env);

    expect(result).toEqual({ resolved: false, reason: "bad-key" });
  });

  it("200 with errors and null data dispatches to not-found", async () => {
    fetchImpl = () =>
      Promise.resolve(
        fakeResponse(
          200,
          JSON.stringify({ data: null, errors: [{ message: "Entity not found" }] }),
        ),
      );

    const result = await linearProvider.resolve(ref, env);

    expect(result).toEqual({ resolved: false, reason: "not-found" });
  });

  it("an aborting fetch dispatches to timeout", async () => {
    fetchImpl = () => {
      const timeoutError = new Error("The operation timed out");
      timeoutError.name = "TimeoutError";
      return Promise.reject(timeoutError);
    };

    const result = await linearProvider.resolve(ref, env);

    expect(result).toEqual({ resolved: false, reason: "timeout" });
  });

  it("a plain network throw dispatches to network", async () => {
    fetchImpl = () => Promise.reject(new TypeError("fetch failed"));

    const result = await linearProvider.resolve(ref, env);

    expect(result).toEqual({ resolved: false, reason: "network" });
  });

  it("unparseable JSON dispatches to malformed-response", async () => {
    fetchImpl = () => Promise.resolve(fakeResponse(200, "not json"));

    const result = await linearProvider.resolve(ref, env);

    expect(result).toEqual({ resolved: false, reason: "malformed-response" });
  });
});

// --- linear: title bounding, matching github's ------------------------------

describe("linear provider: title bounding", () => {
  const ref = buildRef({ provider: "linear", externalId: "ABC-1" });
  const env = { LINEAR_API_KEY: LINEAR_KEY_SENTINEL };

  it("caps a title over MAX_CACHED_TITLE_LENGTH to exactly the constant", async () => {
    const longTitle = "y".repeat(MAX_CACHED_TITLE_LENGTH + 50);
    fetchImpl = () =>
      Promise.resolve(
        fakeResponse(
          200,
          JSON.stringify({
            data: { issue: { title: longTitle, state: { type: "backlog" } } },
          }),
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
          JSON.stringify({
            data: { issue: { title: `bad${BEL}title`, state: { type: "backlog" } } },
          }),
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
        fetchImpl = () => Promise.resolve(fakeResponse(401, "{}"));
        return linearProvider.resolve(ref, env);
      },
      () => {
        fetchImpl = () =>
          Promise.resolve(fakeResponse(200, JSON.stringify({ data: null, errors: [] })));
        return linearProvider.resolve(ref, env);
      },
      () => {
        fetchImpl = () => Promise.reject(new TypeError("fetch failed"));
        return linearProvider.resolve(ref, env);
      },
      () => {
        fetchImpl = () => Promise.resolve(fakeResponse(200, "not json"));
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
