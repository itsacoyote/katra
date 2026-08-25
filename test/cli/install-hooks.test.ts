/**
 * `katra install-hooks <agent>` — the CLI's own contract (F11 T7,
 * `katra-9aw.70.11`), exercised end to end through the real CLI against real
 * git repositories. `core/hooks/merge.ts`'s merge/remove algorithm is
 * covered by `test/core/hooks.test.ts`; these tests are about the shell
 * around it — target resolution, the store-presence warning, `--print`,
 * `--local`, `--remove`, and refusal shapes — not about re-proving the pure
 * merge.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import { runCli } from "../helpers/cli.js";
import { createGitRepo, createNonRepoDir } from "../helpers/fixture.js";

/** `symlinkSync` needs real symlink support; unreliable on Windows CI without elevation. */
const onPosix = process.platform !== "win32";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function repo() {
  const r = createGitRepo();
  cleanups.push(() => r.cleanup());
  return r;
}

const CLAUDE_SETTINGS = (dir: string) => join(dir, ".claude", "settings.json");
const CLAUDE_LOCAL_SETTINGS = (dir: string) => join(dir, ".claude", "settings.local.json");
const CODEX_HOOKS = (dir: string) => join(dir, ".codex", "hooks.json");

describe("katra install-hooks", () => {
  it("creates .claude/settings.json with the three katra hooks when none exists", async () => {
    const r = repo();
    await runCli(["init"], { cwd: r.dir });

    const result = await runCli(["install-hooks", "claude"], { cwd: r.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    const target = CLAUDE_SETTINGS(r.dir);
    expect(existsSync(target)).toBe(true);
    const settings = JSON.parse(readFileSync(target, "utf8")) as {
      hooks: { SessionStart: unknown; PreToolUse: unknown; SessionEnd: unknown };
    };
    const dump = JSON.stringify(settings.hooks);
    expect(dump).toContain("katra board --digest");
    expect(dump).toContain("katra guard");
    expect(dump).toContain("katra release --mine");
  });

  // Owner-only permissions cost multi-uid setups (containers, shared build
  // hosts) real usability for zero secrecy benefit — this file holds only
  // hook command strings and the install report tells the user to commit
  // and share it. Compared against a sibling file written by a plain
  // `writeFileSync` in the same process rather than a hardcoded literal
  // (e.g. 0o644), since the actual bits depend on this process's umask.
  it.runIf(onPosix)(
    "creates a fresh settings file at the default (umask-derived) mode",
    async () => {
      const r = repo();
      await runCli(["init"], { cwd: r.dir });

      await runCli(["install-hooks", "claude"], { cwd: r.dir });

      const sibling = join(r.dir, "sibling-for-mode-comparison.txt");
      writeFileSync(sibling, "x");

      expect(statSync(CLAUDE_SETTINGS(r.dir)).mode & 0o777).toBe(statSync(sibling).mode & 0o777);
    },
  );

  it("leaves the file byte-identical on a second run", async () => {
    const r = repo();
    await runCli(["init"], { cwd: r.dir });
    await runCli(["install-hooks", "claude"], { cwd: r.dir });
    const target = CLAUDE_SETTINGS(r.dir);
    const first = readFileSync(target, "utf8");
    expect(first.endsWith("\n")).toBe(true);

    const second = await runCli(["install-hooks", "claude", "--json"], { cwd: r.dir });

    expect(second.exitCode).toBe(EXIT.ok);
    expect(readFileSync(target, "utf8")).toBe(first);
    const payload = second.json() as { action: string; changed: boolean };
    expect(payload.action).toBe("unchanged");
    expect(payload.changed).toBe(false);

    // A second, independent clone must not fight the first: two fresh repos
    // installing the identical agent produce byte-identical files, not just
    // a stable file within one repo's own history.
    const r2 = repo();
    await runCli(["init"], { cwd: r2.dir });
    await runCli(["install-hooks", "claude"], { cwd: r2.dir });
    expect(readFileSync(CLAUDE_SETTINGS(r2.dir), "utf8")).toBe(first);
  });

  it("preserves pre-existing hooks and unrelated settings on install", async () => {
    const r = repo();
    await runCli(["init"], { cwd: r.dir });
    const dir = join(r.dir, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      CLAUDE_SETTINGS(r.dir),
      JSON.stringify({
        model: "opus",
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./lint.sh" }] }],
        },
      }),
    );

    const result = await runCli(["install-hooks", "claude"], { cwd: r.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS(r.dir), "utf8")) as {
      model: string;
      hooks: { PreToolUse: ReadonlyArray<{ matcher?: string; hooks: unknown[] }> };
    };
    expect(settings.model).toBe("opus");
    expect(settings.hooks.PreToolUse).toContainEqual({
      matcher: "Bash",
      hooks: [{ type: "command", command: "./lint.sh" }],
    });
    expect(JSON.stringify(settings.hooks.PreToolUse)).toContain("katra guard");
  });

  it("--print emits the hook block and leaves the filesystem untouched", async () => {
    const r = repo();
    await runCli(["init"], { cwd: r.dir });

    const result = await runCli(["install-hooks", "claude", "--print"], { cwd: r.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("katra board --digest");
    expect(result.stdout).toContain("katra guard");
    expect(result.stdout).toContain("katra release --mine");
    expect(existsSync(join(r.dir, ".claude"))).toBe(false);
  });

  it("--remove strips katra's entries and keeps user hooks intact", async () => {
    const r = repo();
    await runCli(["init"], { cwd: r.dir });
    await runCli(["install-hooks", "claude"], { cwd: r.dir });
    const target = CLAUDE_SETTINGS(r.dir);
    const installed = JSON.parse(readFileSync(target, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    installed.hooks.Notification = [{ hooks: [{ type: "command", command: "./notify.sh" }] }];
    writeFileSync(target, JSON.stringify(installed, null, 2));

    const result = await runCli(["install-hooks", "claude", "--remove"], { cwd: r.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    const settings = JSON.parse(readFileSync(target, "utf8")) as {
      hooks: { Notification: unknown; PreToolUse?: unknown };
    };
    expect(JSON.stringify(settings)).not.toContain("katra guard");
    expect(settings.hooks.Notification).toEqual([
      { hooks: [{ type: "command", command: "./notify.sh" }] },
    ]);
  });

  it("--remove against a never-installed repo is a clean no-op", async () => {
    const r = repo();
    await runCli(["init"], { cwd: r.dir });

    const result = await runCli(["install-hooks", "claude", "--remove", "--json"], {
      cwd: r.dir,
    });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(existsSync(CLAUDE_SETTINGS(r.dir))).toBe(false);
    const payload = result.json() as { action: string; changed: boolean; mode: string };
    expect(payload.action).toBe("unchanged");
    expect(payload.changed).toBe(false);
    expect(payload.mode).toBe("remove");

    // The one sentence this scenario is the sole way to reach: "installed"
    // and a plain --remove-with-something-to-strip both read differently.
    const text = await runCli(["install-hooks", "claude", "--remove"], { cwd: r.dir });
    expect(text.stdout).toMatch(/no katra hooks to remove/);
  });

  it("writes .codex/hooks.json with the same touchpoints for codex", async () => {
    const r = repo();
    await runCli(["init"], { cwd: r.dir });

    const result = await runCli(["install-hooks", "codex"], { cwd: r.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    const target = CODEX_HOOKS(r.dir);
    expect(existsSync(target)).toBe(true);
    const settings = JSON.parse(readFileSync(target, "utf8")) as {
      hooks: { PreToolUse: ReadonlyArray<{ matcher?: string }> };
    };
    const dump = JSON.stringify(settings.hooks);
    expect(dump).toContain("katra board --digest");
    expect(dump).toContain("katra guard");
    expect(dump).toContain("katra release --mine");
    expect(settings.hooks.PreToolUse[0]?.matcher).toBe("apply_patch");
  });

  it("refuses an unknown agent with a usage error", async () => {
    const r = repo();
    await runCli(["init"], { cwd: r.dir });

    const result = await runCli(["install-hooks", "chatgpt"], { cwd: r.dir });

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toMatch(/agent/i);
    expect(existsSync(join(r.dir, ".claude"))).toBe(false);
  });

  it("--local targets .claude/settings.local.json", async () => {
    const r = repo();
    await runCli(["init"], { cwd: r.dir });

    const result = await runCli(["install-hooks", "claude", "--local"], { cwd: r.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(existsSync(CLAUDE_LOCAL_SETTINGS(r.dir))).toBe(true);
    expect(existsSync(CLAUDE_SETTINGS(r.dir))).toBe(false);
  });

  it("refuses to modify a malformed settings file", async () => {
    const r = repo();
    await runCli(["init"], { cwd: r.dir });
    const dir = join(r.dir, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(CLAUDE_SETTINGS(r.dir), "{not valid json");

    const result = await runCli(["install-hooks", "claude"], { cwd: r.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(readFileSync(CLAUDE_SETTINGS(r.dir), "utf8")).toBe("{not valid json");
  });

  it("writes into the git toplevel even when run from a subdirectory", async () => {
    const r = repo();
    await runCli(["init"], { cwd: r.dir });
    const sub = join(r.dir, "src", "nested");
    mkdirSync(sub, { recursive: true });

    const result = await runCli(["install-hooks", "claude"], { cwd: sub });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(existsSync(CLAUDE_SETTINGS(r.dir))).toBe(true);
    expect(existsSync(join(sub, ".claude"))).toBe(false);
  });

  it("warns that katra init has not run when installing into a repo with no store", async () => {
    const r = repo();

    const textResult = await runCli(["install-hooks", "claude"], { cwd: r.dir });

    expect(textResult.exitCode).toBe(EXIT.ok);
    expect(textResult.stderr).toMatch(/warning:.*katra init/i);
    expect(existsSync(CLAUDE_SETTINGS(r.dir))).toBe(true);

    const r2 = repo();
    const jsonResult = await runCli(["install-hooks", "codex", "--json"], { cwd: r2.dir });
    const payload = jsonResult.json() as {
      warnings?: ReadonlyArray<{ code: string; message: string }>;
    };
    expect(payload.warnings?.some((warning) => /katra init/.test(warning.message))).toBe(true);
  });

  it("names the target file and its committed visibility in the install report", async () => {
    const r = repo();
    await runCli(["init"], { cwd: r.dir });

    const shared = await runCli(["install-hooks", "claude"], { cwd: r.dir });
    expect(shared.stdout).toContain(join(".claude", "settings.json"));
    // Distinguishing phrases, not a bare /commit/i or /local/i — the local
    // note itself says "not committed" (would match /commit/i) and the
    // shared filename above contains "settings.json" (would match /local/i
    // by coincidence with "settings.local.json" if it weren't asserted
    // precisely), so either loose regex would pass even if the two messages
    // were swapped.
    expect(shared.stdout).toMatch(/shared with your team/);
    expect(shared.stdout).not.toMatch(/not committed/);

    const local = await runCli(["install-hooks", "claude", "--local"], { cwd: r.dir });
    expect(local.stdout).toContain(join(".claude", "settings.local.json"));
    expect(local.stdout).toMatch(/not committed, not shared/);
  });

  it.runIf(onPosix)("refuses a symlinked .claude directory", async () => {
    const r = repo();
    await runCli(["init"], { cwd: r.dir });
    const outside = mkdtempSync(join(tmpdir(), "katra-outside-"));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    symlinkSync(outside, join(r.dir, ".claude"));

    const result = await runCli(["install-hooks", "claude"], { cwd: r.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/symlink/i);
    // The install never followed the link: nothing was written outside the
    // worktree, and the symlink itself was never replaced.
    expect(existsSync(join(outside, "settings.json"))).toBe(false);
  });

  it.runIf(onPosix)("refuses a symlinked settings file", async () => {
    const r = repo();
    await runCli(["init"], { cwd: r.dir });
    mkdirSync(join(r.dir, ".claude"), { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), "katra-outside-"));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    const secrets = join(outside, "credentials.json");
    writeFileSync(secrets, JSON.stringify({ aws_secret_access_key: "leaked-if-this-fails" }));
    symlinkSync(secrets, CLAUDE_SETTINGS(r.dir));

    const result = await runCli(["install-hooks", "claude"], { cwd: r.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/symlink/i);
    // The secret file was never read into a merge, and the link was never
    // replaced by a real file that would have exposed its contents.
    expect(readFileSync(secrets, "utf8")).not.toContain("katra");
  });

  it("refuses to write anything outside a git repository", async () => {
    const plain = createNonRepoDir();
    cleanups.push(() => plain.cleanup());

    const result = await runCli(["install-hooks", "claude"], { cwd: plain.dir });

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toMatch(/git repository/i);
    expect(existsSync(join(plain.dir, ".claude"))).toBe(false);
  });
});
