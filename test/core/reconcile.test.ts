/**
 * The pure reconcile policy engine (F9 T2): `planReconcile`'s pinned
 * precedence, `DEFAULT_POLICY`'s mapping, and the structural "no store
 * import" discipline `core/providers/types.ts` set the precedent for.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { planReconcile } from "../../src/core/reconcile/engine.js";
import { DEFAULT_POLICY } from "../../src/core/reconcile/policy.js";
import type { Candidate, PolicyTable } from "../../src/core/reconcile/types.js";
import { buildRef } from "../helpers/refs.js";

let candidateCounter = 0;

function candidate(overrides: Partial<Candidate> & Pick<Candidate, "refs">): Candidate {
  candidateCounter += 1;
  return {
    id: `kt-${String(candidateCounter).padStart(6, "0")}`,
    title: "a task",
    lane: "In Review",
    level: "task",
    claimHolder: null,
    ...overrides,
  };
}

describe("planReconcile: precedence", () => {
  it("a task whose every ref maps to Done yields advance citing every ref", () => {
    const refA = buildRef({ provider: "github", externalId: "acme/app#1", cachedStatus: "merged" });
    const refB = buildRef({ provider: "github", externalId: "acme/app#2", cachedStatus: "merged" });
    const c = candidate({ refs: [refA, refB] });

    const [result] = planReconcile([c], DEFAULT_POLICY);

    expect(result?.verdict).toEqual({
      kind: "advance",
      target: "Done",
      triggeringRefs: [refA, refB],
    });
  });

  it("one merged and one open PR yields blocked-by-ref naming the open ref", () => {
    const merged = buildRef({
      provider: "github",
      externalId: "acme/app#1",
      cachedStatus: "merged",
    });
    const open = buildRef({ provider: "github", externalId: "acme/app#2", cachedStatus: "open" });
    const c = candidate({ refs: [merged, open] });

    const [result] = planReconcile([c], DEFAULT_POLICY);

    expect(result?.verdict).toEqual({ kind: "blocked-by-ref", blockingRefs: [open] });
  });

  it("a merged PR plus a never-refreshed ref yields blocked-by-ref", () => {
    const merged = buildRef({
      provider: "github",
      externalId: "acme/app#1",
      cachedStatus: "merged",
    });
    const neverRefreshed = buildRef({
      provider: "github",
      externalId: "acme/app#2",
      cachedStatus: null,
    });
    const c = candidate({ refs: [merged, neverRefreshed] });

    const [result] = planReconcile([c], DEFAULT_POLICY);

    expect(result?.verdict).toEqual({ kind: "blocked-by-ref", blockingRefs: [neverRefreshed] });
  });

  it("a task whose refs are all unmapped yields no-op, not blocked-by-ref", () => {
    const open = buildRef({ provider: "github", externalId: "acme/app#1", cachedStatus: "open" });
    const c = candidate({ refs: [open] });

    const [result] = planReconcile([c], DEFAULT_POLICY);

    expect(result?.verdict).toEqual({ kind: "no-op" });
  });

  it("refs mapping to Done and Cancelled yield conflict naming both targets", () => {
    const done = buildRef({ provider: "github", externalId: "acme/app#1", cachedStatus: "merged" });
    const cancelled = buildRef({
      provider: "linear",
      externalId: "ENG-1",
      cachedStatus: "canceled",
    });
    const c = candidate({ refs: [done, cancelled] });

    const [result] = planReconcile([c], DEFAULT_POLICY);

    expect(result?.verdict).toEqual({
      kind: "conflict",
      targets: [
        { target: "Done", refs: [done] },
        { target: "Cancelled", refs: [cancelled] },
      ],
    });
  });

  it("conflict wins over blocked-by-ref when both apply", () => {
    // Three refs on one task: one -> Done, one -> Cancelled (the conflict),
    // and one unmapped (open, which alone would make the task blocked-by-ref).
    // Precedence pins conflict first regardless.
    const done = buildRef({ provider: "github", externalId: "acme/app#1", cachedStatus: "merged" });
    const cancelled = buildRef({
      provider: "linear",
      externalId: "ENG-1",
      cachedStatus: "canceled",
    });
    const blocking = buildRef({
      provider: "github",
      externalId: "acme/app#2",
      cachedStatus: "open",
    });
    const c = candidate({ refs: [done, cancelled, blocking] });

    const [result] = planReconcile([c], DEFAULT_POLICY);

    expect(result?.verdict.kind).toBe("conflict");
  });
});

describe("planReconcile: claim safety", () => {
  it("a would-advance task claimed by another worktree yields skip-claimed", () => {
    const merged = buildRef({
      provider: "github",
      externalId: "acme/app#1",
      cachedStatus: "merged",
    });
    const c = candidate({ refs: [merged], claimHolder: "feature/other @ /repo/wt-other" });

    const [result] = planReconcile([c], DEFAULT_POLICY);

    expect(result?.verdict).toEqual({
      kind: "skip-claimed",
      holder: "feature/other @ /repo/wt-other",
    });
  });

  it("a blocked task claimed by another worktree stays blocked-by-ref", () => {
    const merged = buildRef({
      provider: "github",
      externalId: "acme/app#1",
      cachedStatus: "merged",
    });
    const open = buildRef({ provider: "github", externalId: "acme/app#2", cachedStatus: "open" });
    const c = candidate({ refs: [merged, open], claimHolder: "feature/other @ /repo/wt-other" });

    const [result] = planReconcile([c], DEFAULT_POLICY);

    expect(result?.verdict).toEqual({ kind: "blocked-by-ref", blockingRefs: [open] });
  });
});

describe("planReconcile: policy", () => {
  it("a single canceled linear ref yields advance to Cancelled", () => {
    const cancelled = buildRef({
      provider: "linear",
      externalId: "ENG-1",
      cachedStatus: "canceled",
    });
    const c = candidate({ refs: [cancelled] });

    const [result] = planReconcile([c], DEFAULT_POLICY);

    expect(result?.verdict).toEqual({
      kind: "advance",
      target: "Cancelled",
      triggeringRefs: [cancelled],
    });
  });

  it("an injected non-default policy changes the verdicts", () => {
    // Proves ADR-016's own point: the policy is data the engine consults,
    // never a hardcoded branch — an "open" -> Cancelled table the default
    // policy does not have produces a different verdict for the identical
    // candidate.
    const open = buildRef({ provider: "github", externalId: "acme/app#1", cachedStatus: "open" });
    const c = candidate({ refs: [open] });
    const customPolicy: PolicyTable = { github: { open: "Cancelled" } };

    const defaultResult = planReconcile([c], DEFAULT_POLICY);
    const customResult = planReconcile([c], customPolicy);

    expect(defaultResult[0]?.verdict).toEqual({ kind: "no-op" });
    expect(customResult[0]?.verdict).toEqual({
      kind: "advance",
      target: "Cancelled",
      triggeringRefs: [open],
    });
  });
});

describe("structural: no store import", () => {
  /**
   * Strips block comments entirely, and strips a `//` line comment only
   * when `//` is the first non-whitespace content on its line — the same
   * technique `test/core/providers.test.ts`'s own structural env-injection
   * scan uses, reused here rather than re-derived: a naive strip-to-end-of-line
   * would treat the rest of any line holding a `https://...` literal (or any
   * other mid-line `//`) as a comment and hide real code from the scan below.
   */
  function stripComments(source: string): string {
    const withoutBlockComments = source.replaceAll(/\/\*[\s\S]*?\*\//g, "");
    return withoutBlockComments
      .split("\n")
      .map((line) => (/^\s*\/\//.test(line) ? "" : line))
      .join("\n");
  }

  function reconcileSourceFiles(): { readonly root: string; readonly files: readonly string[] } {
    const root = fileURLToPath(new URL("../../src/core/reconcile", import.meta.url));
    const files = readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"),
      )
      .map((entry) => entry.name);
    return { root, files };
  }

  it("the engine imports no store module (structural)", () => {
    const { root, files } = reconcileSourceFiles();
    // Globbed, not a hardcoded list — a new file under reconcile/ (repo.ts,
    // F9 T3, will live here too, but as a store-touching module a future
    // scan should exclude, not this one) is covered automatically for now.
    expect(files.length).toBeGreaterThanOrEqual(3);

    // The npm package name directly, the `OpenStore` type doing the same job
    // `process` does in the providers.test.ts precedent, and the relative
    // import specifier every store-touching module in this codebase uses
    // (`refs/repo.ts`'s own `from "../store.js"`).
    const storeImport = /\bbetter-sqlite3\b|\bOpenStore\b|\bstore\.js\b/;
    for (const file of files) {
      const source = stripComments(readFileSync(join(root, file), "utf8"));
      expect(source, `${file} must not import a store module`).not.toMatch(storeImport);
    }
  });
});
