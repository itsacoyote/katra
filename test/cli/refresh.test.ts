/**
 * `katra refresh` (F8 T5) — orchestration, exit codes, and the `--json`
 * contract, exercised through the real CLI. Every scenario here runs with
 * `gh` stripped from `PATH` and `LINEAR_API_KEY` unset (`isolatedNoGhEnv`,
 * `test/helpers/fixture.ts`) or a stubbed `gh` script — this suite never
 * makes a real network call; the live-API dogfood run is T7's job.
 */

import { chmodSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRefreshSection,
  MAX_REFRESH_SECTION_ITEMS,
  REASON_SENTENCES,
} from "../../src/cli/commands/refresh.js";
import { EXIT } from "../../src/cli/output.js";
import type { RefreshResult } from "../../src/core/contract.js";
import { DB_FILE_NAME, STORE_DIR_NAME } from "../../src/core/db/locate.js";
import { openStore } from "../../src/core/store.js";
import { runCli } from "../helpers/cli.js";
import type { GitFixture } from "../helpers/fixture.js";
import {
  createGitRepo,
  createNonRepoDir,
  isolatedNoGhEnv,
  stubbedGhEnv,
  writeGitWrapper,
} from "../helpers/fixture.js";

/** Absolute path to better-sqlite3's own entry point — resolved from this file, then embedded verbatim into a generated script that lives outside the project tree and cannot resolve the bare specifier itself. */
const BETTER_SQLITE3_PATH = createRequire(import.meta.url).resolve("better-sqlite3");

/**
 * `stubbedGhEnv`, except the `gh` double first deletes the ref's own
 * `task_refs`/`refs` rows — through a **second** better-sqlite3 connection
 * to the same store file, opened from inside the generated script itself —
 * and only then answers with `responseBody`. Simulates the real TOCTOU
 * `applyRefreshWithin` re-`SELECT`s to catch: the ref vanishes in the gap
 * between `resolve`'s network round trip and this run's own write.
 *
 * `require(${BETTER_SQLITE3_PATH})` rather than a bare
 * `require("better-sqlite3")`: the script lives in a throwaway temp
 * directory outside the project tree, so Node's own module resolution,
 * walking up from the script's location, would never find the project's
 * `node_modules` — the absolute path resolved once here (via
 * `createRequire`) sidesteps that lookup entirely.
 */
function vanishingGhEnv(
  responseBody: string,
  repoDir: string,
): { readonly env: NodeJS.ProcessEnv; cleanup(): void } {
  const bin = createNonRepoDir();
  writeGitWrapper(bin.dir);

  const dbPath = join(repoDir, ".git", STORE_DIR_NAME, DB_FILE_NAME);
  const ghScript = join(bin.dir, "gh");
  writeFileSync(
    ghScript,
    [
      `#!${process.execPath}`,
      `const Database = require(${JSON.stringify(BETTER_SQLITE3_PATH)});`,
      `const db = new Database(${JSON.stringify(dbPath)});`,
      `db.prepare("DELETE FROM task_refs").run();`,
      `db.prepare("DELETE FROM refs").run();`,
      `db.close();`,
      `process.stdout.write(${JSON.stringify(responseBody)});`,
    ].join("\n"),
    "utf8",
  );
  chmodSync(ghScript, 0o755);

  const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin.dir };
  delete env.LINEAR_API_KEY;

  return { env, cleanup: bin.cleanup };
}

/** The same PR while still open — `MERGED_BODY`'s sibling, for the real-transition test. */
const OPEN_BODY = JSON.stringify({
  title: "Fix the bug",
  state: "open",
  draft: false,
  pull_request: { merged_at: null },
});

/** A `gh api repos/{owner}/{repo}/issues/{n}` body for a merged PR (`github.ts`'s own precedence: `pull_request.merged_at` wins). */
const MERGED_BODY = JSON.stringify({
  title: "Fix the bug",
  state: "closed",
  draft: false,
  pull_request: { merged_at: "2026-01-01T00:00:00Z" },
});

/** Reads one `refs` row directly, bypassing every application read path — the "(DB read)" the no-provider named test calls for. */
function readRefRow(
  repoDir: string,
  externalId: string,
): { cached_status: unknown; cached_title: unknown; synced_at: unknown } | undefined {
  const { store } = openStore(repoDir, {});
  try {
    return store.db
      .prepare("SELECT cached_status, cached_title, synced_at FROM refs WHERE external_id = ?")
      .get(externalId) as
      | { cached_status: unknown; cached_title: unknown; synced_at: unknown }
      | undefined;
  } finally {
    store.close();
  }
}

let repo: GitFixture;
const cleanups: Array<() => void> = [];
beforeEach(async () => {
  repo = createGitRepo();
  await runCli(["init"], { cwd: repo.dir });
});
afterEach(() => {
  repo.cleanup();
  while (cleanups.length > 0) cleanups.pop()?.();
  vi.unstubAllGlobals();
});

async function add(args: readonly string[]): Promise<string> {
  return (await runCli(["add", ...args], { cwd: repo.dir })).stdout.trim();
}

describe("REASON_SENTENCES", () => {
  it("every reason token renders its exact documented sentence", () => {
    // The satisfies clause guarantees a sentence EXISTS per token; this pins
    // the wording itself — a typo in any of the twelve shipped green before
    // (QA round-1 gap). Update deliberately when wording changes.
    expect(REASON_SENTENCES).toEqual({
      "gh-not-available": "gh not available",
      "gh-unauthenticated": "gh not authenticated",
      "not-found": "not found",
      "bad-credentials": "bad credentials",
      network: "network error",
      timeout: "timed out",
      "no-key": "LINEAR_API_KEY not set",
      "bad-key": "bad LINEAR_API_KEY",
      "malformed-response": "malformed response",
      "bad-shape": "not a valid reference for its provider",
      "no-provider": "no provider",
      gone: "ref no longer exists",
    });
  });
});

describe("buildRefreshSection", () => {
  it("truncation-honest when a bound empties a category", () => {
    const section = buildRefreshSection(["a", "b", "c"], 0);

    expect(section).toEqual({ count: 3, items: [], truncated: true });
  });

  it("over MAX_REFRESH_SECTION_ITEMS caps to exactly that many, reporting the true count", () => {
    const items = Array.from({ length: MAX_REFRESH_SECTION_ITEMS + 1 }, (_, i) => i);

    const section = buildRefreshSection(items);

    expect(section.count).toBe(MAX_REFRESH_SECTION_ITEMS + 1);
    expect(section.items).toHaveLength(MAX_REFRESH_SECTION_ITEMS);
    expect(section.items).toEqual(items.slice(0, MAX_REFRESH_SECTION_ITEMS));
    expect(section.truncated).toBe(true);
  });
});

// Stub executables are POSIX shebang scripts — unexecutable on Windows, the
// same platform trade test/core/git.test.ts already makes for its own stub
// tests (it.runIf(onPosix) there). The behavior stays covered on Windows by
// the mocked unit layers (providers.test.ts, git.test.ts's classification).
const onPosix = process.platform !== "win32";

describe.runIf(onPosix)("katra refresh", () => {
  it("no-provider ref -> unresolved no-provider, exit 0, nothing written (DB read)", async () => {
    const isolated = isolatedNoGhEnv();
    cleanups.push(isolated.cleanup);

    const task = await add(["a task"]);
    const linked = await runCli(
      ["ref", "add", task, "--provider", "jira", "--id", "FOO-1", "--json"],
      { cwd: repo.dir },
    );
    expect(linked.exitCode, linked.stderr).toBe(EXIT.ok);

    const result = await runCli(["refresh", "--json"], { cwd: repo.dir, env: isolated.env });

    expect(result.exitCode, result.stderr).toBe(EXIT.ok);
    const doc = result.json() as RefreshResult;
    expect(doc.unresolved.items).toEqual([
      { provider: "jira", externalId: "FOO-1", reason: "no-provider" },
    ]);
    expect(doc.updated.count).toBe(0);
    expect(doc.unchanged.count).toBe(0);

    const row = readRefRow(repo.dir, "FOO-1");
    expect(row).toEqual({ cached_status: null, cached_title: null, synced_at: null });
  });

  it("gh absent -> unresolved gh-not-available, exit 0", async () => {
    const isolated = isolatedNoGhEnv();
    cleanups.push(isolated.cleanup);

    const task = await add(["a task"]);
    await runCli(["ref", "add", task, "https://github.com/acme/widgets/pull/7"], {
      cwd: repo.dir,
    });

    const result = await runCli(["refresh", "--json"], { cwd: repo.dir, env: isolated.env });

    expect(result.exitCode, result.stderr).toBe(EXIT.ok);
    const doc = result.json() as RefreshResult;
    expect(doc.unresolved.items).toEqual([
      { provider: "github", externalId: "acme/widgets#7", reason: "gh-not-available" },
    ]);
    // AC3's named proof: nothing written — by direct DB read, not the report.
    const row = readRefRow(repo.dir, "acme/widgets#7");
    expect(row).toMatchObject({ cached_status: null, cached_title: null, synced_at: null });
  });

  it("linear no-key -> unresolved no-key, zero network", async () => {
    const isolated = isolatedNoGhEnv();
    cleanups.push(isolated.cleanup);

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const task = await add(["a task"]);
    await runCli(["ref", "add", task, "ENG-451"], { cwd: repo.dir });

    const result = await runCli(["refresh", "--json"], { cwd: repo.dir, env: isolated.env });

    expect(result.exitCode, result.stderr).toBe(EXIT.ok);
    const doc = result.json() as RefreshResult;
    expect(doc.unresolved.items).toEqual([
      { provider: "linear", externalId: "ENG-451", reason: "no-key" },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    // AC3's named proof for the no-key path too: direct DB read.
    const row = readRefRow(repo.dir, "ENG-451");
    expect(row).toMatchObject({ cached_status: null, cached_title: null, synced_at: null });
  });

  it("ref vanishes mid-flight (deleted while gh is answering) -> unresolved gone, exit 0", async () => {
    const task = await add(["a task"]);
    await runCli(["ref", "add", task, "https://github.com/acme/widgets/pull/7"], {
      cwd: repo.dir,
    });

    const vanishing = vanishingGhEnv(MERGED_BODY, repo.dir);
    cleanups.push(vanishing.cleanup);

    const result = await runCli(["refresh", "--json"], { cwd: repo.dir, env: vanishing.env });

    expect(result.exitCode, result.stderr).toBe(EXIT.ok);
    const doc = result.json() as RefreshResult;
    expect(doc.unresolved.items).toEqual([
      { provider: "github", externalId: "acme/widgets#7", reason: "gone" },
    ]);
    expect(doc.updated.count).toBe(0);
    expect(doc.unchanged.count).toBe(0);
  });

  it("a real transition (open -> merged across two runs) reports updated with both values", async () => {
    // AC2 at the CLI layer: first run caches open, second run's stub answers
    // merged — the report must carry the genuine two-value transition, not a
    // first-sync (none -> X) shape (QA round-1 gap).
    const task = await add(["a task"]);
    await runCli(["ref", "add", task, "https://github.com/acme/widgets/pull/7"], {
      cwd: repo.dir,
    });

    const openStub = stubbedGhEnv(OPEN_BODY);
    cleanups.push(openStub.cleanup);
    const first = await runCli(["refresh", "--json"], { cwd: repo.dir, env: openStub.env });
    expect(first.exitCode, first.stderr).toBe(EXIT.ok);
    expect((first.json() as RefreshResult).updated.items).toEqual([
      { provider: "github", externalId: "acme/widgets#7", from: null, to: "open" },
    ]);

    const mergedStub = stubbedGhEnv(MERGED_BODY);
    cleanups.push(mergedStub.cleanup);
    const second = await runCli(["refresh"], { cwd: repo.dir, env: mergedStub.env });
    expect(second.exitCode, second.stderr).toBe(EXIT.ok);
    expect(second.stdout).toContain("open -> merged");

    const row = readRefRow(repo.dir, "acme/widgets#7");
    expect(row?.cached_status).toBe("merged");
  });

  it("stubbed gh merged fills caches, show renders", async () => {
    const stubbed = stubbedGhEnv(MERGED_BODY);
    cleanups.push(stubbed.cleanup);

    const task = await add(["a task"]);
    await runCli(["ref", "add", task, "https://github.com/acme/widgets/pull/7"], {
      cwd: repo.dir,
    });

    const result = await runCli(["refresh", "--json"], { cwd: repo.dir, env: stubbed.env });

    expect(result.exitCode, result.stderr).toBe(EXIT.ok);
    const doc = result.json() as RefreshResult;
    expect(doc.updated.items).toEqual([
      { provider: "github", externalId: "acme/widgets#7", from: null, to: "merged" },
    ]);

    const shown = await runCli(["show", task, "--json"], { cwd: repo.dir });
    expect(shown.exitCode, shown.stderr).toBe(EXIT.ok);
    const view = shown.json() as { refs: ReadonlyArray<Record<string, unknown>> };
    expect(view.refs).toHaveLength(1);
    expect(view.refs[0]).toMatchObject({
      externalId: "acme/widgets#7",
      cachedStatus: "merged",
      cachedTitle: "Fix the bug",
    });
    expect(view.refs[0]?.syncedAt).not.toBeNull();
  });

  it("second run unchanged, zero events", async () => {
    const stubbed = stubbedGhEnv(MERGED_BODY);
    cleanups.push(stubbed.cleanup);

    const task = await add(["a task"]);
    await runCli(["ref", "add", task, "https://github.com/acme/widgets/pull/7"], {
      cwd: repo.dir,
    });

    const first = await runCli(["refresh", "--json"], { cwd: repo.dir, env: stubbed.env });
    expect((first.json() as RefreshResult).updated.count).toBe(1);

    const second = await runCli(["refresh", "--json"], { cwd: repo.dir, env: stubbed.env });
    expect(second.exitCode, second.stderr).toBe(EXIT.ok);
    const doc = second.json() as RefreshResult;
    expect(doc.updated.count).toBe(0);
    expect(doc.unchanged.items).toEqual([{ provider: "github", externalId: "acme/widgets#7" }]);

    const log = await runCli(["log", task, "--json"], { cwd: repo.dir });
    const events = (log.json() as { events: ReadonlyArray<{ type: string }> }).events;
    expect(events.filter((event) => event.type === "ref-status-changed")).toHaveLength(1);
  });

  it("explicit ids scope", async () => {
    const stubbed = stubbedGhEnv(MERGED_BODY);
    cleanups.push(stubbed.cleanup);

    const taskX = await add(["task x"]);
    const taskY = await add(["task y"]);
    await runCli(["ref", "add", taskX, "https://github.com/acme/widgets/pull/1"], {
      cwd: repo.dir,
    });
    await runCli(["ref", "add", taskY, "https://github.com/acme/widgets/pull/2"], {
      cwd: repo.dir,
    });

    const result = await runCli(["refresh", taskX, "--json"], { cwd: repo.dir, env: stubbed.env });

    expect(result.exitCode, result.stderr).toBe(EXIT.ok);
    const doc = result.json() as RefreshResult;
    expect(doc.totals.refs).toBe(1);
    expect(doc.updated.items).toEqual([
      { provider: "github", externalId: "acme/widgets#1", from: null, to: "merged" },
    ]);

    const untouched = readRefRow(repo.dir, "acme/widgets#2");
    expect(untouched).toEqual({ cached_status: null, cached_title: null, synced_at: null });
  });

  it("bogus id refuses", async () => {
    const isolated = isolatedNoGhEnv();
    cleanups.push(isolated.cleanup);

    const result = await runCli(["refresh", "kt-zzzzzz"], { cwd: repo.dir, env: isolated.env });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/no task matches "kt-zzzzzz"/);
  });

  it("--json round-trips RefreshResult with kebab tokens while text renders sentences", async () => {
    const isolated = isolatedNoGhEnv();
    cleanups.push(isolated.cleanup);

    const task = await add(["a task"]);
    await runCli(["ref", "add", task, "--provider", "jira", "--id", "FOO-1"], { cwd: repo.dir });

    const json = await runCli(["refresh", "--json"], { cwd: repo.dir, env: isolated.env });
    expect((json.json() as RefreshResult).unresolved.items[0]?.reason).toBe("no-provider");

    const text = await runCli(["refresh"], { cwd: repo.dir, env: isolated.env });
    expect(text.exitCode, text.stderr).toBe(EXIT.ok);
    expect(text.stdout).toContain("no provider");
    expect(text.stdout).not.toContain("no-provider");
  });

  it("mixed outcomes render per-category report with totals", async () => {
    const stubbed = stubbedGhEnv(MERGED_BODY);
    cleanups.push(stubbed.cleanup);

    const taskA = await add(["task a"]);
    const taskC = await add(["task c"]);
    await runCli(["ref", "add", taskA, "https://github.com/acme/widgets/pull/1"], {
      cwd: repo.dir,
    });
    await runCli(["ref", "add", taskC, "--provider", "jira", "--id", "FOO-1"], {
      cwd: repo.dir,
    });

    // First run: A's ref syncs for the first time (updated), C stays
    // unresolved. A second task's ref is added only after this run, so the
    // second run below sees it as a fresh sync (updated) alongside A's own
    // now-unchanged one — all three categories land in that one report.
    const first = await runCli(["refresh", "--json"], { cwd: repo.dir, env: stubbed.env });
    expect((first.json() as RefreshResult).updated.count).toBe(1);

    const taskB = await add(["task b"]);
    await runCli(["ref", "add", taskB, "https://github.com/acme/widgets/pull/2"], {
      cwd: repo.dir,
    });

    const second = await runCli(["refresh"], { cwd: repo.dir, env: stubbed.env });

    expect(second.exitCode, second.stderr).toBe(EXIT.ok);
    expect(second.stdout).toContain("3 ref(s) checked — 1 updated, 1 unchanged, 1 unresolved");
    expect(second.stdout).toContain("updated (1)");
    expect(second.stdout).toContain("unchanged (1)");
    expect(second.stdout).toContain("unresolved (1)");
    expect(second.stdout).toContain("acme/widgets#2");
    expect(second.stdout).toContain("acme/widgets#1");
    expect(second.stdout).toContain("no provider");
  });
});
