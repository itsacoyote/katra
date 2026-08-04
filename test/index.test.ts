/**
 * The published entry point.
 *
 * `package.json` points `main`, `types` and `exports` at this module and ships
 * it in `files`, so it is the one file every consumer of the package touches —
 * and nothing else in the suite imported it. A barrel that failed to resolve,
 * or re-exported a name that no longer existed, would have shipped green.
 */

import { describe, expect, it } from "vitest";
import * as katra from "../src/index.js";

describe("the public barrel", () => {
  it("resolves and exports a usable value from every group it advertises", () => {
    // Runtime values, not types: a type-only barrel compiles even when the
    // module it points at is gone.
    expect(katra.VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(katra.LANES).toContain("Planned");
    expect(katra.TERMINAL_LANES).toEqual(["Done", "Cancelled"]);
    expect(katra.KATRA_ERROR_CODES).toContain("conflict");
    expect(katra.generateId()).toMatch(
      new RegExp(`^${katra.ID_PREFIX}[0-9a-z]{${katra.ID_SUFFIX_LENGTH}}$`),
    );
  });

  it("exports predicates that actually narrow", () => {
    expect(katra.isLane("Planned")).toBe(true);
    expect(katra.isLane("Ready")).toBe(false);
    expect(katra.isTerminal("Cancelled")).toBe(true);
    expect(katra.isTerminal("In Review")).toBe(false);
    expect(katra.isPriority(4)).toBe(true);
    expect(katra.isPriority(5)).toBe(false);
  });

  it("exports the exception class so a consumer can catch and read it", () => {
    const error = new katra.KatraException({
      code: "conflict",
      message: "held",
      reason: "3 children",
    });

    expect(katra.isKatraException(error)).toBe(true);
    if (error.detail.code !== "conflict") throw new Error("unreachable");
    expect(error.detail.reason).toBe("3 children");
  });

  it("keeps the storage handle out of the public surface", () => {
    // The barrel's stated purpose. `openStore` and everything taking an
    // OpenStore would put better-sqlite3's concrete type into katra's API
    // through a parameter or a return value, forcing every consumer to have
    // its types resolvable.
    const withheld = ["openStore", "resolveId", "requireId", "createTask", "listTasks"];
    for (const name of withheld) {
      expect(Object.keys(katra), `${name} must not be published`).not.toContain(name);
    }
  });
});
