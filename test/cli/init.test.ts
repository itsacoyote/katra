import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import { runCli } from "../helpers/cli.js";
import { createGitRepo, createNonRepoDir, git } from "../helpers/fixture.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function repo() {
  const r = createGitRepo();
  cleanups.push(() => r.cleanup());
  return r;
}

function storePath(dir: string): string {
  return join(
    git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    "katra",
    "katra.db",
  );
}

describe("katra init", () => {
  it("creates the store and reports it as newly created", async () => {
    const r = repo();

    const result = await runCli(["init"], { cwd: r.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toMatch(/^Created katra store at /);
    expect(existsSync(storePath(r.dir))).toBe(true);
  });

  it("reports the existing store and exits zero when run a second time", async () => {
    const r = repo();
    await runCli(["init"], { cwd: r.dir });

    const second = await runCli(["init"], { cwd: r.dir });

    expect(second.exitCode).toBe(EXIT.ok);
    expect(second.stdout).toMatch(/^Found existing katra store at /);
  });

  it("modifies no tracked file in the working tree", async () => {
    // Replaces an earlier criterion asserting the database is invisible to
    // `git status`, which was vacuously true — the store lives inside .git/,
    // which git cannot track at all, so that test could never fail. The real
    // risk is katra dirtying the user's tree, so that is what is asserted.
    // See ADR-004.
    const r = repo();
    writeFileSync(join(r.dir, "tracked.txt"), "content");
    git(r.dir, "add", "tracked.txt");
    git(r.dir, "commit", "-q", "-m", "add a tracked file");
    const before = git(r.dir, "status", "--porcelain");

    await runCli(["init"], { cwd: r.dir });

    expect(git(r.dir, "status", "--porcelain")).toBe(before);
    expect(existsSync(join(r.dir, ".gitignore"))).toBe(false);
  });

  it("works from a subdirectory and from a linked worktree", async () => {
    const r = repo();
    const worktree = r.addWorktree("feature/init");

    const first = await runCli(["init"], { cwd: r.dir });
    const fromWorktree = await runCli(["init", "--json"], { cwd: worktree });

    expect(first.exitCode).toBe(EXIT.ok);
    expect(fromWorktree.exitCode).toBe(EXIT.ok);
    expect(fromWorktree.json()).toEqual({ path: storePath(r.dir), created: false });
  });

  it("exits non-zero with a not-a-repository message outside a git repo", async () => {
    const plain = createNonRepoDir();
    cleanups.push(() => plain.cleanup());

    const result = await runCli(["init"], { cwd: plain.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/not inside a git repository/i);
    expect(result.stdout).toBe("");
  });

  it("emits a structured JSON error object rather than prose when --json is set", async () => {
    const plain = createNonRepoDir();
    cleanups.push(() => plain.cleanup());

    const result = await runCli(["init", "--json"], { cwd: plain.dir });

    expect(result.exitCode).toBe(EXIT.user);
    const payload = result.json() as { error: { code: string; message: string } };
    expect(payload.error.code).toBe("validation");
    expect(payload.error.message).toMatch(/not inside a git repository/i);
    // Nothing human-readable may reach either stream under --json. Re-parsing
    // stdout, as this used to, only repeats what `result.json()` above already
    // did; the untested half was stderr.
    expect(result.stderr).toBe("");
  });

  it("emits valid JSON with no prose on success", async () => {
    const r = repo();

    const result = await runCli(["init", "--json"], { cwd: r.dir });

    expect(result.json()).toEqual({ path: storePath(r.dir), created: true });
  });

  it("reports a corrupt store without a stack trace", async () => {
    const r = repo();
    await runCli(["init"], { cwd: r.dir });
    writeFileSync(storePath(r.dir), "not a database at all");

    const result = await runCli(["init"], { cwd: r.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/not a readable database/i);
    // F1 has no restore, so the message must say the store has to be recreated.
    expect(result.stderr).toMatch(/re-initialised|reinitialised/i);
    expect(result.stderr).not.toMatch(/\bat .*\.(ts|js):\d+/);
  });

  it("carries an ambient GIT_COMMON_DIR warning to stderr, not stdout", async () => {
    const r = repo();
    const other = repo();

    const result = await runCli(["init"], {
      cwd: r.dir,
      env: { ...process.env, GIT_COMMON_DIR: join(other.dir, ".git") },
    });

    expect(result.stderr).toMatch(/GIT_COMMON_DIR/);
    expect(result.stdout).not.toMatch(/GIT_COMMON_DIR/);
  });

  it("puts warnings inside the JSON document rather than on stderr under --json", async () => {
    const r = repo();
    const other = repo();

    const result = await runCli(["init", "--json"], {
      cwd: r.dir,
      env: { ...process.env, GIT_COMMON_DIR: join(other.dir, ".git") },
    });

    const payload = result.json() as { warnings: Array<{ code: string }> };
    expect(payload.warnings).toHaveLength(1);
    expect(payload.warnings[0]?.code).toBe("ambient-git-dir");
    expect(result.stderr).toBe("");
  });
});

describe("exit codes", () => {
  it("maps an unknown option to the usage code", async () => {
    // Verified: without exitOverride commander calls process.exit itself, so
    // this would be exit 1 and would also kill the test worker outright.
    const r = repo();

    const result = await runCli(["init", "--nonsense"], { cwd: r.dir });

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.exitCode).toBe(2);
  });

  it("maps an unknown command to the usage code", async () => {
    const r = repo();

    const result = await runCli(["nonsense"], { cwd: r.dir });

    expect(result.exitCode).toBe(EXIT.usage);
  });

  it("exits zero for --help and --version", async () => {
    const r = repo();

    expect((await runCli(["--help"], { cwd: r.dir })).exitCode).toBe(EXIT.ok);
    expect((await runCli(["--version"], { cwd: r.dir })).exitCode).toBe(EXIT.ok);
  });
});

describe("the built binary", () => {
  const builtCli = join(process.cwd(), "dist", "cli.js");

  // Skipped rather than built here. Running `pnpm build` inside the suite made
  // `pnpm test` rewrite dist/ as a side effect, cost up to two minutes, and
  // failed wherever pnpm could not run from process.cwd(). CI builds before it
  // tests, so the check runs there; locally it runs whenever dist/ is present.
  it.skipIf(!existsSync(builtCli))("runs end to end from dist", () => {
    // The in-process harness cannot catch a broken shebang, a bad bin entry, or
    // an import that only fails once bundled.
    const r = repo();

    const out = execFileSync(process.execPath, [builtCli, "init"], {
      cwd: r.dir,
      encoding: "utf8",
    });

    expect(out).toMatch(/^Created katra store at /);
  });
});
