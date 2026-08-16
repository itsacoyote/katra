/**
 * The process boundary — the one place katra spawns a subprocess.
 *
 * Started as git alone: {@link ../db/locate.js resolveStoreLocation}, which
 * asks where the store lives, and actor resolution, which asks which branch and
 * worktree is writing. Both needed the same thing from the subprocess layer —
 * an absolutely-resolved binary and katra's own error taxonomy — and the
 * second arrived after the first, which is exactly when a codebase grows a
 * near-identical copy.
 *
 * F8's `refresh` widens it to `gh`: the GitHub provider (T3) shells out the
 * same way git does, for the same Windows PATH-shadowing reason (see
 * {@link findGit}), so it belongs beside git rather than reopening the
 * finding in a second file. `findGh`/`runGh` follow `findGit`/`runGit`'s exact
 * absolute-path discipline; only the failure model differs, and deliberately —
 * see {@link runGh}.
 *
 * That discipline would be a security regression to duplicate, not a style
 * problem: see {@link findGit} for what a bare `"git"` (or `"gh"`) does on
 * Windows. The guard test in `test/core/git.test.ts` asserts no other module
 * under `src/` spawns a process, so a copy — of either — cannot be written
 * without failing the suite.
 *
 * `env` is always an explicit parameter here, never read from `process.env`
 * directly: the CLI resolves `options.env ?? process.env` once, at its own
 * boundary, and threads the result down. Nothing in `core/` reads the process
 * environment on its own.
 *
 * Not re-exported from `src/index.ts`. It takes no store, but it names
 * `NodeJS.ProcessEnv`, and declarations are emitted per file — publishing it
 * would drag `@types/node` into `dist/index.d.ts` and break any consumer
 * compiling without `skipLibCheck`.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { RefreshReason } from "./enums.js";
import { KatraException } from "./errors.js";

/** `--path-format` landed in git 2.31; nothing older can resolve the store. */
export const MINIMUM_GIT_VERSION = "2.31";

interface GitFailure {
  readonly stderr: string;
  readonly spawnFailed: boolean;
  /** The invocation that failed, so an unclassified failure can name itself. */
  readonly args: readonly string[];
}

/**
 * Locates the `git` binary on `PATH`, as an absolute path.
 *
 * **Not just `"git"`.** On Windows, libuv resolves a bare program name by
 * looking in the *current directory first*, then `PATH` — POSIX `execvp` does
 * not. katra's whole premise is running inside arbitrary repositories, so a
 * repo containing `git.exe`, `git.cmd` or `git.bat` would have that file
 * executed with the user's privileges by every katra command. Passing an
 * absolute path makes libuv skip the cwd probe entirely.
 *
 * Relative `PATH` entries are skipped rather than resolved: `join("tools",
 * "git")` is still relative, and `execFileSync` resolves a relative `file`
 * against the `cwd` it is handed — which is the repository.
 *
 * Returns undefined when nothing matches, so the caller raises katra's own
 * "git is not installed" error rather than a Node internals dump.
 */
export function findGit(env: NodeJS.ProcessEnv): string | undefined {
  return resolveOnPath(env, "git");
}

/**
 * Locates `gh` on `PATH`, as an absolute path — `findGit`'s discipline
 * applied to the second binary this module spawns.
 *
 * The Windows PATH-shadowing risk `findGit`'s docstring describes is not
 * specific to git: any bare program name run through libuv probes the
 * current directory first on that platform, so a repository shipping
 * `gh.exe` would have it executed in place of the real GitHub CLI. Same fix,
 * same reason: only an absolute path, found by walking `PATH` ourselves,
 * ever reaches `execFileSync`.
 *
 * Returns undefined rather than throwing so {@link runGh} can report
 * `gh-not-available` as an ordinary classified result — a provider degrading
 * because a tool is missing is expected, not exceptional.
 */
export function findGh(env: NodeJS.ProcessEnv): string | undefined {
  return resolveOnPath(env, "gh");
}

/**
 * The absolute-path PATH walk `findGit` and `findGh` share.
 *
 * Relative `PATH` entries are skipped rather than resolved: `join("tools",
 * name)` is still relative, and `execFileSync` resolves a relative `file`
 * against the `cwd` it is handed. `runGit` sets that `cwd` to the repository
 * it is asked about, so a relative entry would let a repository plant its own
 * executable on the search path; `runGh` never sets a `cwd` at all, but the
 * rule is the same regardless — a relative `PATH` entry is a misconfiguration
 * katra has no business honouring, so it is skipped rather than resolved.
 * Worse on Windows: `join(".", "git.exe")` collapses to a bare name with no
 * separator, which is exactly the input that makes libuv probe the current
 * directory first — F1's original finding, reintroduced.
 */
function resolveOnPath(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const path = env.PATH ?? env.Path ?? "";
  if (path === "") return undefined;

  // PATHEXT is Windows' list of extensions an extensionless name can take.
  const suffixes =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext !== "")
      : [""];

  for (const dir of path.split(delimiter)) {
    if (dir === "" || !isAbsolute(dir)) continue;
    for (const suffix of suffixes) {
      const candidate = join(dir, `${name}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Runs `git` in `cwd`, returning stdout or a classified failure. */
export function runGit(cwd: string, env: NodeJS.ProcessEnv, args: string[]): string {
  const git = findGit(env);
  if (git === undefined) {
    throw explainGitFailure({ stderr: "", spawnFailed: true, args });
  }

  try {
    return execFileSync(git, args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw explainGitFailure(readFailure(error, args));
  }
}

function readFailure(error: unknown, args: readonly string[]): GitFailure {
  const err = error as { stderr?: unknown; code?: unknown };
  const stderr = typeof err.stderr === "string" ? err.stderr : String(err.stderr ?? "");
  // A missing binary never reaches git, so there is no stderr to read — the
  // spawn itself fails. Distinguishing this keeps the user from seeing a Node
  // internals dump where a one-line "install git" belongs.
  const spawnFailed = err.code === "ENOENT";
  return { stderr, spawnFailed, args };
}

/** Turns a git failure into the most specific error we can justify. */
function explainGitFailure(failure: GitFailure): KatraException {
  const { stderr, spawnFailed, args } = failure;

  if (spawnFailed) {
    return new KatraException({
      code: "validation",
      message: "git could not be run: no `git` executable was found on PATH",
      field: "git",
      value: "ENOENT",
    });
  }

  if (/unknown (argument to )?--path-format|unknown option.*path-format/i.test(stderr)) {
    return new KatraException({
      code: "validation",
      message:
        `this git is too old: katra needs git ${MINIMUM_GIT_VERSION} or newer for ` +
        `\`rev-parse --path-format\` — ${stderr.trim()}`,
      field: "git",
      value: "path-format",
    });
  }

  // A broken worktree link and "no repository here" both say "not a git
  // repository", but they are different problems with different fixes, so the
  // more specific one is matched first and git's own text is passed through.
  if (/not a git repository:.*[/\\]worktrees[/\\]/i.test(stderr)) {
    return new KatraException({
      code: "validation",
      message:
        "this worktree's main repository is missing or has moved, so git cannot " +
        `resolve it — ${stderr.trim()}`,
      field: "worktree",
      value: stderr.trim(),
    });
  }

  if (/not a git repository/i.test(stderr)) {
    return new KatraException({
      code: "validation",
      message: `not inside a git repository — ${stderr.trim()}`,
      field: "cwd",
      value: stderr.trim(),
    });
  }

  // Names the invocation rather than guessing at its purpose. This module now
  // serves both store location and actor resolution, so a message asserting
  // either one would be wrong half the time.
  return new KatraException({
    code: "validation",
    message: `\`git ${args.join(" ")}\` failed — ${stderr.trim()}`,
    field: "git",
    value: stderr.trim(),
  });
}

/** `execFileSync`'s `timeout` for `gh` (epic risk note 11, probed real). */
const GH_TIMEOUT_MS = 5000;

/** What `runGh` hands back — never a throw. */
export type GhResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly reason: RefreshReason };

/**
 * Runs `gh` and classifies the result. Never throws.
 *
 * `runGit` throws, because a git failure aborts the one command that asked
 * for it. `runGh` cannot: `refresh` (F8) resolves many refs in one run, and
 * one ref's provider being unauthenticated or offline must degrade that ref
 * alone — {@link GhResult}'s failure arm is a `RefreshReason` (T1's
 * `enums.ts`, imported, never re-declared here), the closed vocabulary
 * `refresh` reports on stdout and in `--json`. Epic risk note 14: a reason is
 * always one of those fixed literals, never `String(error)` or
 * `error.message` — gh's own text can carry nothing katra chose to say.
 *
 * `findGh`'s own miss short-circuits before any spawn: `gh-not-available`,
 * no `execFileSync` call, no timeout to wait out.
 *
 * Every other outcome comes from a real `gh` invocation, hardened the same
 * way `runGit` is — `stdio: ["ignore", "pipe", "pipe"]`, argv array only,
 * never a shell string — plus two things `runGit` does not need:
 *
 * - `timeout: 5000` + `killSignal: "SIGKILL"`. `refresh` has no total budget
 *   (epic risk note 12); a single hung call still must not hang the run.
 * - `GH_PROMPT_DISABLED=1` and `GH_NO_UPDATE_NOTIFIER=1`, merged over
 *   whatever `env` already carries. `gh` run non-interactively still checks
 *   for an update and would otherwise print a banner to stderr that has
 *   nothing to do with the call that was made; disabling both is the
 *   documented, probed way to keep `gh`'s output to exactly the response.
 *
 * `gh`'s own exit codes are read from the caught error, never printed: exit
 * `4` is the one unambiguous code (probed) — no credentials were even
 * presented. Exit `1` is overloaded across not-found, bad-credentials and
 * network failures, so those three are told apart by the shape of stdout and
 * stderr {@link classifyGhFailure} reads — see that function for the probed
 * shapes each one has.
 */
export function runGh(env: NodeJS.ProcessEnv, args: string[]): GhResult {
  const gh = findGh(env);
  if (gh === undefined) {
    return { ok: false, reason: "gh-not-available" };
  }

  try {
    const stdout = execFileSync(gh, args, {
      env: { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GH_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    return { ok: false, reason: classifyGhFailure(error) };
  }
}

interface GhFailure {
  readonly spawnFailed: boolean;
  /** Non-null exactly when `execFileSync`'s own timeout killed the process. */
  readonly signal: string | null;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function readGhFailure(error: unknown): GhFailure {
  const err = error as {
    code?: unknown;
    signal?: unknown;
    status?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  return {
    spawnFailed: err.code === "ENOENT",
    signal: typeof err.signal === "string" ? err.signal : null,
    status: typeof err.status === "number" ? err.status : null,
    stdout: typeof err.stdout === "string" ? err.stdout : "",
    stderr: typeof err.stderr === "string" ? err.stderr : "",
  };
}

/**
 * Reads `"status"` out of a `gh api` JSON error body, as a string.
 *
 * GitHub's own error bodies carry the HTTP status as a *string* field
 * (`{"message":"Not Found",...,"status":"404"}`, probed real, both a compact
 * and a pretty-printed variant) — never coerced to a number here, since the
 * only use is an exact-literal comparison against `"404"`/`"401"`.
 */
function readJsonHttpStatus(stdout: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || !("status" in parsed)) return undefined;
  const status = (parsed as { status: unknown }).status;
  return typeof status === "string" ? status : undefined;
}

/**
 * Turns a caught `runGh` failure into a `RefreshReason` — every branch probed
 * against the real `gh` (epic comment 1, libraries lens):
 *
 * - A spawn-level `ENOENT` (the binary vanished between `findGh`'s check and
 *   the actual exec — the same TOCTOU `runGit`'s own `readFailure` already
 *   guards against) reads as `gh-not-available`, the same reason `findGh`'s
 *   own miss reports.
 * - A non-null `signal` is `execFileSync`'s timeout having fired — the only
 *   signal this module ever configures is its own `killSignal`, so any
 *   signal at all means the call ran the full 5s and was killed.
 * - Exit `4` is unauthenticated, unambiguously (probed: no credentials
 *   present at all, distinct from credentials that were sent and rejected).
 * - Exit `1` is overloaded across three shapes, told apart in the order
 *   they were probed to be mutually exclusive: `stderr` containing
 *   `"error connecting"` is a transport failure that never reached GitHub;
 *   otherwise `stdout`'s JSON `status` field settles it — `"404"` is the
 *   external entity not existing, `"401"` is credentials GitHub rejected.
 * - Anything else on exit `1` — a shape this module has not seen because
 *   nothing in F8's scope produces it (`gh api` returning some other status,
 *   a body that is not JSON at all) — is the one bucket honestly named for
 *   "a response came back and this parser could not read it as one of the
 *   above": `malformed-response`, not a guess at which of the other reasons
 *   it most resembles.
 */
function classifyGhFailure(error: unknown): RefreshReason {
  const failure = readGhFailure(error);

  if (failure.spawnFailed) return "gh-not-available";
  if (failure.signal !== null) return "timeout";
  if (failure.status === 4) return "gh-unauthenticated";
  if (failure.stderr.includes("error connecting")) return "network";

  const httpStatus = readJsonHttpStatus(failure.stdout);
  if (httpStatus === "404") return "not-found";
  if (httpStatus === "401") return "bad-credentials";

  return "malformed-response";
}
