/**
 * Atomic file writes (`writeAtomic`, extracted from `snapshot/export.ts` into
 * shared `core/fs.ts` — katra-9aw.70.9): temp-file-beside-target + `fsync` +
 * plain `renameSync`, no retry logic. The two behaviors this suite pins:
 * the target's content is replaced atomically, and a forced write failure
 * leaves no temp file behind.
 */

import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeAtomic } from "../../src/core/fs.js";

/**
 * A single toggle, not `vi.spyOn` — Vitest cannot redefine a property on a
 * real ESM module's namespace object (Node's own "node:fs", frozen and
 * non-configurable), only replace the whole module via `vi.mock`
 * (`test/core/snapshot.test.ts`'s own precedent for forcing a real
 * filesystem failure). Every other `node:fs` function passes straight
 * through to the real implementation; only `writeFileSync` is
 * interceptable, and only while `writeShouldFail` is true — off by default
 * so the first test in this file sees the genuine filesystem.
 */
let writeShouldFail = false;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (writeShouldFail) throw new Error("simulated write failure");
      return actual.writeFileSync(...args);
    },
  };
});

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "katra-fs-test-"));
}

/** `chmodSync`/exact-mode assertions are meaningless on Windows, which has no POSIX permission bits. */
const onPosix = process.platform !== "win32";

describe("writeAtomic", () => {
  it("replaces the target file's content atomically", () => {
    const dir = makeTempDir();
    const target = join(dir, "target.txt");
    writeFileSync(target, "original content", "utf8");

    writeAtomic(target, "replaced content");

    expect(readFileSync(target, "utf8")).toBe("replaced content");
    // Nothing but the target itself survives in the directory — no stray
    // temp file left beside it.
    expect(readdirSync(dir)).toEqual(["target.txt"]);

    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves no temp file behind when the write fails", () => {
    const dir = makeTempDir();
    const target = join(dir, "target.txt");
    writeFileSync(target, "original content", "utf8");

    writeShouldFail = true;
    let caught: unknown;
    try {
      writeAtomic(target, "never lands");
    } catch (err) {
      caught = err;
    } finally {
      writeShouldFail = false;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("simulated write failure");

    // The target is untouched, and no temp file survives beside it.
    expect(readFileSync(target, "utf8")).toBe("original content");
    expect(readdirSync(dir)).toEqual(["target.txt"]);

    rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(onPosix)("preserves the target file's mode across a rewrite", () => {
    const dir = makeTempDir();
    const target = join(dir, "target.txt");
    writeFileSync(target, "original content", "utf8");
    // Deliberately narrower than the umask-default create mode this
    // process's `openSync` calls would otherwise produce (typically
    // 0o644/0o664) — the shape a caller narrowing a sensitive file's
    // permissions ahead of time would leave behind.
    chmodSync(target, 0o600);

    writeAtomic(target, "replaced content");

    expect(readFileSync(target, "utf8")).toBe("replaced content");
    expect(statSync(target).mode & 0o777).toBe(0o600);

    rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(onPosix)("applies options.mode only when the target does not exist yet", () => {
    const dir = makeTempDir();
    const target = join(dir, "fresh.txt");

    writeAtomic(target, "brand new", { mode: 0o600 });
    expect(statSync(target).mode & 0o777).toBe(0o600);

    // A second write over the now-existing file preserves ITS mode (0o600),
    // ignoring a different options.mode passed this time — existing-mode
    // preservation always wins over the option, per this function's docs.
    writeAtomic(target, "rewritten", { mode: 0o644 });
    expect(statSync(target).mode & 0o777).toBe(0o600);

    rmSync(dir, { recursive: true, force: true });
  });
});
