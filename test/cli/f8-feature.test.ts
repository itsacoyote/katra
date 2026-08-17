/**
 * F8's end-to-end story (T6): link a shared GitHub ref and a keyless Linear
 * ref, refresh through a PATH-stubbed `gh` returning a probed-shape
 * response, and prove the whole rendering chain T6 built actually shows
 * what `refresh` (T5) wrote — `show`/`brief` render the cached status,
 * title, and synced age; `log` carries `ref-status-changed` once per
 * holder; a second refresh is quiet; the Linear ref's degraded outcome is
 * reported honestly in both `--json` and text. `refresh.test.ts` (T5) already
 * proves the orchestration/`--json` contract in isolation with no rendering
 * assertions; this is the rendering-layer complement, through the real CLI,
 * one store.
 */

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import type { RefreshResult } from "../../src/core/contract.js";
import { runCli } from "../helpers/cli.js";
import type { GitFixture } from "../helpers/fixture.js";
import { createGitRepo, createNonRepoDir, writeGitWrapper } from "../helpers/fixture.js";

/**
 * A `gh api repos/{owner}/{repo}/issues/{n}` body for a merged PR — the same
 * probed shape `refresh.test.ts`'s own `MERGED_BODY` uses (`github.ts`'s own
 * precedence: `pull_request.merged_at` wins).
 */
const MERGED_BODY = JSON.stringify({
  title: "Fix the dark-mode toggle",
  state: "closed",
  draft: false,
  pull_request: { merged_at: "2026-01-01T00:00:00Z" },
});

/**
 * A `gh` on an isolated PATH that always answers `responseBody`, with no
 * `LINEAR_API_KEY` — the identical technique `refresh.test.ts`'s own
 * `stubbedGhEnv` uses, including the reason it is a Node script rather than
 * a shell one: the narrow PATH this hands the child has no `cat`/`dirname`
 * either, so a script that shelled out to read its own response back from a
 * sibling file would fail to run at all. Kept local rather than imported:
 * only the genuinely shared primitive (`writeGitWrapper`) lives in
 * `fixture.ts` — a story-shaped double like this one stays with the story
 * that needs it, the same way `refresh.test.ts`'s own copy does.
 */
function stubbedGhEnv(responseBody: string): { readonly env: NodeJS.ProcessEnv; cleanup(): void } {
  const bin = createNonRepoDir();
  writeGitWrapper(bin.dir);

  const ghScript = join(bin.dir, "gh");
  writeFileSync(
    ghScript,
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(responseBody)});\n`,
    "utf8",
  );
  chmodSync(ghScript, 0o755);

  const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin.dir };
  delete env.LINEAR_API_KEY;

  return { env, cleanup: bin.cleanup };
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
});

async function add(args: readonly string[]): Promise<string> {
  return (await runCli(["add", ...args], { cwd: repo.dir })).stdout.trim();
}

describe("F8 story: refresh fills caches, T6's rendering shows them", () => {
  it("refreshes a shared github ref and a keyless linear ref, rendering both honestly", async () => {
    const stubbed = stubbedGhEnv(MERGED_BODY);
    cleanups.push(stubbed.cleanup);

    const taskA = await add(["task a"]);
    const taskB = await add(["task b"]);
    // Shared: both tasks link the same GitHub PR, the identical url — the
    // fan-out case epic risk note 9 describes, so one status transition
    // must produce one ref-status-changed event per holder, not one total.
    await runCli(["ref", "add", taskA, "https://github.com/acme/widgets/pull/7"], {
      cwd: repo.dir,
    });
    await runCli(["ref", "add", taskB, "https://github.com/acme/widgets/pull/7"], {
      cwd: repo.dir,
    });
    // Keyless: stubbed.env carries no LINEAR_API_KEY, so this ref degrades
    // rather than making a real network call.
    await runCli(["ref", "add", taskA, "ENG-451"], { cwd: repo.dir });

    // --- refresh fills github caches, reports linear honestly (--json) ---
    const refreshed = await runCli(["refresh", "--json"], { cwd: repo.dir, env: stubbed.env });
    expect(refreshed.exitCode, refreshed.stderr).toBe(EXIT.ok);
    const doc = refreshed.json() as RefreshResult;
    expect(doc.updated.items).toEqual([
      { provider: "github", externalId: "acme/widgets#7", from: null, to: "merged" },
    ]);
    expect(doc.unresolved.items).toEqual([
      { provider: "linear", externalId: "ENG-451", reason: "no-key" },
    ]);

    // --- show renders status + title + a synced age for the github ref ---
    const shownA = await runCli(["show", taskA], { cwd: repo.dir });
    expect(shownA.exitCode, shownA.stderr).toBe(EXIT.ok);
    expect(shownA.stdout).toContain("merged");
    expect(shownA.stdout).toContain("Fix the dark-mode toggle");
    expect(shownA.stdout).toContain("synced");
    // The keyless linear ref never got cached fields — renders exactly as an
    // unrefreshed ref always has, alongside the refreshed github one.
    expect(shownA.stdout).toContain("linear: ENG-451");

    // --- brief renders the identical cached fields ---
    const briefedA = await runCli(["brief", taskA], { cwd: repo.dir });
    expect(briefedA.exitCode, briefedA.stderr).toBe(EXIT.ok);
    expect(briefedA.stdout).toContain("merged");
    expect(briefedA.stdout).toContain("Fix the dark-mode toggle");

    // --- log shows ref-status-changed once per holder ---
    const logAJson = await runCli(["log", taskA, "--json"], { cwd: repo.dir });
    const logBJson = await runCli(["log", taskB, "--json"], { cwd: repo.dir });
    const eventsA = (logAJson.json() as { events: ReadonlyArray<{ type: string }> }).events;
    const eventsB = (logBJson.json() as { events: ReadonlyArray<{ type: string }> }).events;
    expect(eventsA.filter((event) => event.type === "ref-status-changed")).toHaveLength(1);
    expect(eventsB.filter((event) => event.type === "ref-status-changed")).toHaveLength(1);
    // Text log renders it too — the wider event-type column
    // ref-status-changed needs, and the "none -> merged" transition text
    // (F7's own "from null reads none" convention).
    const logAText = await runCli(["log", taskA], { cwd: repo.dir });
    expect(logAText.stdout).toContain("ref-status-changed");
    expect(logAText.stdout).toContain("none -> merged");

    // --- a second refresh is quiet: no new events, unresolved still honest ---
    const second = await runCli(["refresh", "--json"], { cwd: repo.dir, env: stubbed.env });
    const secondDoc = second.json() as RefreshResult;
    expect(secondDoc.updated.count).toBe(0);
    expect(secondDoc.unchanged.items).toEqual([
      { provider: "github", externalId: "acme/widgets#7" },
    ]);
    expect(secondDoc.unresolved.items).toEqual([
      { provider: "linear", externalId: "ENG-451", reason: "no-key" },
    ]);

    const logAAfterSecond = await runCli(["log", taskA, "--json"], { cwd: repo.dir });
    const eventsAAfterSecond = (
      logAAfterSecond.json() as { events: ReadonlyArray<{ type: string }> }
    ).events;
    expect(eventsAAfterSecond.filter((event) => event.type === "ref-status-changed")).toHaveLength(
      1,
    );

    // --- unresolved reported honestly in text output too, not just --json ---
    const secondText = await runCli(["refresh"], { cwd: repo.dir, env: stubbed.env });
    expect(secondText.exitCode, secondText.stderr).toBe(EXIT.ok);
    expect(secondText.stdout).toContain("LINEAR_API_KEY not set");

    // --- title-only change (T4/T5 review note): status unchanged, so the
    // event's reason renders "merged -> merged" -- refs/repo.ts's own docs
    // flag this as worth T6's rendering layer treating distinctly "when it
    // gets there", nothing more. The call made here: leave describeEvent's
    // generic reason rendering alone rather than adding type-specific string
    // parsing for one event kind, and prove instead that the shape it
    // produces is honest and does not break anything -- the transition is
    // real (a title changed) even though the status half of it reads as a
    // no-op, and a reader already has the new title on the very same line.
    const retitled = stubbedGhEnv(
      JSON.stringify({
        title: "Fix the dark-mode toggle, take two",
        state: "closed",
        draft: false,
        pull_request: { merged_at: "2026-01-01T00:00:00Z" },
      }),
    );
    cleanups.push(retitled.cleanup);

    const third = await runCli(["refresh", "--json"], { cwd: repo.dir, env: retitled.env });
    expect(third.exitCode, third.stderr).toBe(EXIT.ok);
    const thirdDoc = third.json() as RefreshResult;
    expect(thirdDoc.updated.items).toEqual([
      { provider: "github", externalId: "acme/widgets#7", from: "merged", to: "merged" },
    ]);

    const shownAfterRetitle = await runCli(["show", taskA], { cwd: repo.dir });
    expect(shownAfterRetitle.exitCode, shownAfterRetitle.stderr).toBe(EXIT.ok);
    expect(shownAfterRetitle.stdout).toContain("Fix the dark-mode toggle, take two");

    const logAfterRetitle = await runCli(["log", taskA], { cwd: repo.dir });
    expect(logAfterRetitle.exitCode, logAfterRetitle.stderr).toBe(EXIT.ok);
    // Reads as a single, well-formed line — no thrown error, no broken
    // column, just a status transition that happens to read as a no-op.
    expect(logAfterRetitle.stdout).toContain("ref-status-changed");
    expect(logAfterRetitle.stdout).toContain("merged -> merged");
    expect(logAfterRetitle.stdout).not.toMatch(/undefined|NaN|\[object/);
  });
});
