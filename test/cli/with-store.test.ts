/**
 * The CLI wiring finding 1 (F4 T2 fix round) exists to pin: `withStore`
 * must forward the context's own `identity`, not just its `actor`, or
 * `store.identity()` builds a second, independent resolver and the
 * "resolve the pair once" guarantee breaks silently on the real CLI path
 * even though every store-level test (test/core/actor.test.ts) stays green.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CliContext } from "../../src/cli/program.js";
import { withStore, withStoreAsync } from "../../src/cli/with-store.js";
import { actorFromIdentity, createIdentityResolver } from "../../src/core/actor.js";
import { findGit } from "../../src/core/git.js";
import { openStore } from "../../src/core/store.js";
import { createGitRepo, createNonRepoDir } from "../helpers/fixture.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const onPosix = process.platform !== "win32";

function repo() {
  const r = createGitRepo();
  cleanups.push(() => r.cleanup());
  return r;
}

/**
 * A `git` that logs every invocation's arguments before delegating to the
 * real one. Same technique as test/core/actor.test.ts's `countingGit` —
 * counting spawns is the only way to observe laziness and memoisation at
 * this layer too.
 */
function countingGit(): { env: NodeJS.ProcessEnv; calls: () => string[] } {
  const dir = createNonRepoDir();
  cleanups.push(() => dir.cleanup());
  const log = join(dir.dir, "calls.log");
  const bin = join(dir.dir, "bin");
  mkdirSync(bin, { recursive: true });

  const real = findGit(process.env);
  if (real === undefined) throw new Error("no git on PATH to wrap");
  const script = join(bin, "git");
  writeFileSync(
    script,
    `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(real)} "$@"\n`,
    "utf8",
  );
  chmodSync(script, 0o755);

  return {
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
    calls: () => {
      try {
        return readFileSync(log, "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

/**
 * Builds a `CliContext` the same way `createProgram` does: one identity
 * resolver, `actor` fused from it. Not a re-implementation of business
 * logic — it is the contract `CliContext.actor`'s own docstring states, and
 * exercising it here is what lets this test reach `withStore` without
 * spawning a real commander program.
 */
function testContext(cwd: string, env: NodeJS.ProcessEnv): CliContext {
  const identity = createIdentityResolver({ cwd, env });
  return {
    cwd,
    env,
    streams: { out: () => undefined, err: () => undefined },
    readStdin: () => undefined,
    identity,
    actor: () => actorFromIdentity(identity()),
    setExitCode: () => undefined,
  };
}

describe("withStore's identity wiring", () => {
  it.runIf(onPosix)(
    "resolves the actor-and-identity pair exactly once for a command that reads both",
    () => {
      // withStore never creates a store, so one must exist first — done
      // through an unwrapped git, so it does not pollute the count below.
      const r = repo();
      const bootstrap = openStore(r.dir, { createIfMissing: true });
      bootstrap.store.close();

      const counting = countingGit();
      const context = testContext(r.dir, counting.env);

      const { result } = withStore(context, (store) => ({
        actor: store.actor(),
        identity: store.identity(),
      }));

      expect(result.actor).toBe(`main @ ${r.dir}`);
      expect(result.identity.worktree).toBe(r.dir);
      expect(result.identity.branch()).toBe("main");
      // One spawn for openStore's own store-location lookup, plus exactly
      // one rev-parse and one symbolic-ref for the identity pair `actor`
      // and `identity` share — not two more, which is what a second,
      // independent resolver for `identity` would have cost before this
      // fix (with-store.ts used to forward only `actor` into openStore).
      expect(counting.calls()).toHaveLength(3);
    },
  );
});

describe("withStoreAsync", () => {
  it("withStoreAsync post-await store access survives", async () => {
    // The exact trap this function exists to avoid (with-store.ts's own
    // docs): `try { return { result: fn(store), warnings }; } finally {
    // store.close(); }` against an async `fn` closes the handle the moment
    // `fn` returns its promise, not when the promise settles — so anything
    // `fn` does after its own first `await` runs against an already-closed
    // connection. A `.prepare()` call on a closed better-sqlite3 handle
    // throws "The database connection is not open"; this proves it does not.
    const r = repo();
    const bootstrap = openStore(r.dir, { createIfMissing: true });
    bootstrap.store.close();

    const context = testContext(r.dir, process.env);

    const { result } = await withStoreAsync(context, async (store) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return store.db.prepare("SELECT 1 AS one").get() as { one: number };
    });

    expect(result.one).toBe(1);
  });
});
