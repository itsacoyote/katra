import { describe, expect, it } from "vitest";
import { describe as describeKatra, VERSION } from "../src/index.js";

describe("katra package skeleton", () => {
  it("exposes a version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("describes itself", () => {
    expect(describeKatra()).toContain("katra");
  });
});
