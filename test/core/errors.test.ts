import { describe, expect, it } from "vitest";
import { EXIT, exitCodeFor } from "../../src/cli/output.js";
import { isKatraException, KATRA_ERROR_CODES, KatraException } from "../../src/core/errors.js";

describe("KatraException", () => {
  it("carries the structured detail payload on a KatraException", () => {
    const err = new KatraException({
      code: "ambiguous_id",
      message: "prefix 5c4 matches 3 tasks",
      input: "5c4",
      candidates: ["kt-5c4a1b", "kt-5c4f09", "kt-5c4zz2"],
      truncated: false,
    });

    expect(err.detail.code).toBe("ambiguous_id");
    expect(err.message).toBe("prefix 5c4 matches 3 tasks");
    if (err.detail.code !== "ambiguous_id") throw new Error("unreachable");
    expect(err.detail.candidates).toHaveLength(3);
    expect(err.detail.input).toBe("5c4");
    expect(err.detail.truncated).toBe(false);
  });

  it("narrows a KatraException detail by its code discriminant", () => {
    // The union must narrow on `code` alone — this is what lets the CLI
    // render each error's payload without casting.
    const cases: KatraException[] = [
      new KatraException({ code: "not_found", message: "no such task", id: "kt-abc123" }),
      new KatraException({ code: "cycle", message: "cycle", path: ["kt-a", "kt-b", "kt-a"] }),
      new KatraException({
        code: "validation",
        message: "bad lane",
        field: "lane",
        value: "Bogus",
      }),
      new KatraException({ code: "conflict", message: "held", reason: "epic has 3 children" }),
      new KatraException({ code: "usage", message: "unknown option --nope" }),
    ];

    const rendered = cases.map((e) => {
      switch (e.detail.code) {
        case "not_found":
          return e.detail.id;
        case "ambiguous_id":
          return e.detail.candidates.join(",");
        case "cycle":
          return e.detail.path.join("->");
        case "validation":
          return `${e.detail.field}=${String(e.detail.value)}`;
        case "conflict":
          return e.detail.reason;
        case "usage":
        case "internal":
          return e.detail.message;
        default: {
          const exhaustive: never = e.detail;
          return exhaustive;
        }
      }
    });

    expect(rendered).toEqual([
      "kt-abc123",
      "kt-a->kt-b->kt-a",
      "lane=Bogus",
      "epic has 3 children",
      "unknown option --nope",
    ]);
  });

  it("is catchable as an Error and reports its own name", () => {
    // Subclassing Error is prototype-fragile when downlevelled; assert it holds.
    const thrown = (() => {
      try {
        throw new KatraException({ code: "usage", message: "boom" });
      } catch (e) {
        return e;
      }
    })();

    expect(thrown).toBeInstanceOf(KatraException);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("KatraException");
    // `.stack` is truthy on every V8 Error, so asserting only that proves
    // nothing. What matters is that the trace is labelled with the subclass's
    // own name — which it only is when `this.name` is set before it is read.
    expect((thrown as Error).stack).toContain("KatraException: boom");
  });

  it("identifies its own exceptions and rejects foreign errors", () => {
    expect(isKatraException(new KatraException({ code: "usage", message: "x" }))).toBe(true);
    expect(isKatraException(new Error("plain"))).toBe(false);
    expect(isKatraException("not an error")).toBe(false);
    expect(isKatraException(null)).toBe(false);
    expect(isKatraException({ detail: { code: "usage" } })).toBe(false);
  });
});

describe("the exit-code mapping", () => {
  it("maps every deliberate failure code to the exit code the spec names", () => {
    // Exported and, until now, never called directly by a test — every
    // assertion reached it through the CLI, so a wrong entry could only be
    // caught where a command happened to produce that code.
    const mapping = Object.fromEntries(KATRA_ERROR_CODES.map((code) => [code, exitCodeFor(code)]));

    expect(mapping).toEqual({
      not_found: EXIT.user,
      ambiguous_id: EXIT.user,
      validation: EXIT.user,
      // A conflict, not a user error: both ids exist and the command is well
      // formed — only the current shape of the graph refuses it.
      cycle: EXIT.conflict,
      conflict: EXIT.conflict,
      usage: EXIT.usage,
    });
  });

  it("never maps a deliberate failure to the fault code", () => {
    // ADR-005: 4 means katra broke and the caller should retry or escalate.
    // A refusal reaching it would tell an agent to retry work already refused.
    for (const code of KATRA_ERROR_CODES) {
      expect(exitCodeFor(code), `${code} must not be a fault`).not.toBe(EXIT.internal);
    }
  });
});
