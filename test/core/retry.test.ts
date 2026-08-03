import { describe, expect, it } from "vitest";
import { isBusyError, withBusyRetry } from "../../src/core/db/retry.js";

function busyError(code = "SQLITE_BUSY"): Error & { code: string } {
  return Object.assign(new Error("database is locked"), { code });
}

describe("isBusyError", () => {
  it("recognises every SQLITE_BUSY variant", () => {
    expect(isBusyError(busyError("SQLITE_BUSY"))).toBe(true);
    expect(isBusyError(busyError("SQLITE_BUSY_SNAPSHOT"))).toBe(true);
    expect(isBusyError(busyError("SQLITE_BUSY_TIMEOUT"))).toBe(true);
  });

  it("rejects other SQLite errors and non-errors", () => {
    expect(isBusyError(busyError("SQLITE_CONSTRAINT_CHECK"))).toBe(false);
    expect(isBusyError(new Error("plain"))).toBe(false);
    // A thrown null must not become a TypeError that masks the original.
    expect(isBusyError(null)).toBe(false);
    expect(isBusyError(undefined)).toBe(false);
    expect(isBusyError("SQLITE_BUSY")).toBe(false);
  });
});

describe("withBusyRetry", () => {
  it("returns immediately when the operation succeeds", () => {
    let calls = 0;
    const result = withBusyRetry(() => {
      calls += 1;
      return "done";
    });

    expect(result).toBe("done");
    expect(calls).toBe(1);
  });

  it("retries a busy operation until it succeeds", () => {
    let calls = 0;
    const result = withBusyRetry(
      () => {
        calls += 1;
        if (calls < 4) throw busyError();
        return calls;
      },
      { baseDelayMs: 0 },
    );

    expect(result).toBe(4);
    expect(calls).toBe(4);
  });

  it("propagates a non-busy error immediately without retrying", () => {
    // Retrying a genuine fault turns a clear failure into a slow one.
    let calls = 0;
    expect(() =>
      withBusyRetry(
        () => {
          calls += 1;
          throw busyError("SQLITE_CONSTRAINT_CHECK");
        },
        { baseDelayMs: 0 },
      ),
    ).toThrowError(/database is locked/);

    expect(calls).toBe(1);
  });

  it("gives up after the configured number of attempts", () => {
    let calls = 0;
    expect(() =>
      withBusyRetry(
        () => {
          calls += 1;
          throw busyError();
        },
        { attempts: 3, baseDelayMs: 0 },
      ),
    ).toThrowError(/database is locked/);

    // One initial call plus three retries.
    expect(calls).toBe(4);
  });

  it("rethrows the original busy error rather than a wrapper", () => {
    const original = busyError();
    try {
      withBusyRetry(
        () => {
          throw original;
        },
        { attempts: 1, baseDelayMs: 0 },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBe(original);
    }
  });
});
