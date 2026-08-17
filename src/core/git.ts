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
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { tmpdir } from "node:os";
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
 * executable on the search path; `runGh` pins its own `cwd` to `tmpdir()`
 * rather than a repository, but the rule is the same regardless — a relative
 * `PATH` entry is a misconfiguration katra has no business honouring, so it
 * is skipped rather than resolved.
 * Worse on Windows: `join(".", "git.exe")` collapses to a bare name with no
 * separator, which is exactly the input that makes libuv probe the current
 * directory first — F1's original finding, reintroduced.
 */
function resolveOnPath(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const path = env.PATH ?? env.Path ?? "";
  if (path === "") return undefined;

  // PATHEXT is Windows' list of extensions an extensionless name can take.
  // Entries are required to start with "." — the format Windows itself
  // documents — so a malformed or hostile PATHEXT cannot make this build a
  // candidate like "gitEXE" (no separator) from an entry with none.
  const suffixes =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext.startsWith("."))
      : [""];

  for (const dir of path.split(delimiter)) {
    if (dir === "" || !isAbsolute(dir)) continue;
    for (const suffix of suffixes) {
      const candidate = join(dir, `${name}${suffix}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * True when `candidate` is a regular file this process can execute.
 *
 * A directory or an unreadable/unexecutable file sitting at the right name
 * is not a "found" the caller should stop searching on: PATH resolution
 * keeps walking past it, the same way a shell's own lookup does, so a
 * mode-000 decoy — or a same-named directory — earlier on `PATH` cannot
 * shadow the real binary later on it.
 */
function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
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

/**
 * `execFileSync`'s `maxBuffer` for `gh` — 1 MiB, Node's own default made
 * deliberate rather than implicit: large enough for any single issue/PR body
 * this ever reads, small enough that a compromised or malfunctioning `gh`
 * cannot make this process buffer an unbounded response.
 */
const GH_MAX_STDOUT_BYTES = 1024 * 1024;

/**
 * Every environment variable `runGh` forwards to `gh`, plus the two
 * overrides {@link buildGhEnv} always forces last — never sourced from this
 * list, so nothing here can shadow them.
 *
 * Probed against this machine's real, keyring-backed `gh auth`: of this
 * entire list, only `PATH`, `HOME`, `LANG`, `XDG_RUNTIME_DIR` and
 * `DBUS_SESSION_BUS_ADDRESS` were actually set in the probing environment,
 * and `gh api repos/cli/cli/issues/1` still authenticated and returned real
 * data through exactly those five. `gh`'s own credential lookup does not need
 * the rest of a caller's environment, so the rest is not forwarded. A full
 * `{ ...env }` spread would hand `gh` — and anything a compromised `gh`
 * install shells out to — every secret already living in this process's
 * environment, `LINEAR_API_KEY` (F8's second provider's own credential)
 * among them, which has no business anywhere near a GitHub CLI invocation.
 *
 * `runGit` takes the opposite choice deliberately, not by oversight: it
 * keeps the caller's full `env` and sets no timeout, because git legitimately
 * needs whatever credential helper, SSH agent or proxy config the user's own
 * environment provides to operate against the user's own repository — there
 * is no untrusted-input boundary there the way there is here, where `gh`'s
 * arguments are built from ref fields (epic risk note 2).
 *
 * `GITHUB_ENTERPRISE_TOKEN` sits beside `GH_ENTERPRISE_TOKEN` — both are
 * documented `gh` credential variables for a non-github.com host, and only
 * forwarding one while claiming to support `GH_HOST` would silently drop
 * whichever form a caller happened to use. `DBUS_SESSION_BUS_ADDRESS` and
 * `XDG_RUNTIME_DIR` are not secrets, only socket paths: `gh`'s keyring
 * backend (`godbus`) needs them to reach the session bus at all off this
 * machine's default socket, and without them a keyring-backed `gh auth`
 * degrades to `gh-unauthenticated` even when the user is, in fact, logged in.
 */
const GH_ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_HOST",
  "GH_CONFIG_DIR",
  "GITHUB_TOKEN",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "LANG",
  "LC_ALL",
  "TZ",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
] as const;

/** Builds the env `runGh` hands to `execFileSync`: the allowlist, then the two forced overrides last. */
function buildGhEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const key of GH_ENV_ALLOWLIST) {
    const value = env[key];
    if (value !== undefined) filtered[key] = value;
  }
  filtered.GH_PROMPT_DISABLED = "1";
  filtered.GH_NO_UPDATE_NOTIFIER = "1";
  return filtered;
}

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
 * `args` is passed through exactly as given — argv array only, never a shell
 * string, the same discipline `runGit` follows — and this function does not
 * inspect or reshape it. The caller (the GitHub provider, T3) is the one that
 * knows a ref's expected `owner`/`repo`/`n` shape and is responsible for
 * refusing anything that does not match before it ever reaches here, and for
 * putting `--` before a positional where the specific `gh` subcommand needs
 * one (epic risk note 3). This runner adds neither.
 *
 * `findGh`'s own miss short-circuits before any spawn: `gh-not-available`,
 * no `execFileSync` call, no timeout to wait out.
 *
 * Every other outcome comes from a real `gh` invocation, hardened well beyond
 * `runGit`:
 *
 * - `cwd: tmpdir()`. `gh api` needs no repository context — T3 calls it with
 *   a fully-qualified `owner/repo` — so this is pinned explicitly rather than
 *   left to inherit whatever directory the katra process happens to be
 *   running in; an ambient `cwd` is not something this call should ever
 *   depend on.
 * - `timeout: 5000` + `killSignal: "SIGKILL"`. `refresh` has no total budget
 *   (epic risk note 12); a single hung call still must not hang the run. The
 *   `SIGKILL` reaches the direct `gh` child only — a grandchild process `gh`
 *   itself spawned and left running is not something this function can clean
 *   up (a `execFileSync`-is-synchronous limit, accepted rather than worked
 *   around; see {@link classifyGhFailure} for the one place that limit is
 *   visible in the result).
 * - `maxBuffer: 1 MiB` ({@link GH_MAX_STDOUT_BYTES}).
 * - An **allowlisted** environment ({@link buildGhEnv}), not a full spread of
 *   `env` — see {@link GH_ENV_ALLOWLIST}. `GH_PROMPT_DISABLED=1` and
 *   `GH_NO_UPDATE_NOTIFIER=1` are forced last, always: `gh` run
 *   non-interactively still checks for an update and would otherwise print a
 *   banner to stderr that has nothing to do with the call that was made.
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
      cwd: tmpdir(),
      env: buildGhEnv(env),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GH_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: GH_MAX_STDOUT_BYTES,
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    return { ok: false, reason: classifyGhFailure(error) };
  }
}

/**
 * `execFileSync`'s `error.code` values meaning `gh` itself never ran — as
 * distinct from `gh` running and failing on its own terms. `ENOENT` is
 * `findGh`'s own TOCTOU (the binary vanished between the check and the
 * exec — the same shape `runGit`'s own `readFailure` already guards
 * against); `EACCES`/`EPERM` are permission failures; `EISDIR` is a
 * same-named directory (some platforms report that as `EACCES` instead —
 * `resolveOnPath`'s own `isExecutableFile` already defends against exactly
 * that shape, so this set covers the case only for whatever slips past a
 * TOCTOU there too); `ENOEXEC` is a file that is not a recognizable
 * executable. Every one of these means `gh` never started, so
 * `gh-not-available` — the same reason `findGh`'s own miss reports — is the
 * honest answer, not a guess at what `gh` would have said.
 */
const GH_UNRUNNABLE_CODES = new Set(["ENOENT", "EACCES", "EPERM", "EISDIR", "ENOEXEC"]);

interface GhFailure {
  readonly code: string | null;
  /** True exactly when `execFileSync`'s own timeout killed the process. */
  readonly timedOut: boolean;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function readGhFailure(error: unknown): GhFailure {
  const err = error as {
    code?: unknown;
    status?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  const code = typeof err.code === "string" ? err.code : null;
  return {
    code,
    timedOut: code === "ETIMEDOUT",
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
 * Turns a caught `runGh` failure into a `RefreshReason` — every branch either
 * a Node/OS-level `error.code` or probed against the real `gh` (epic comment
 * 1, libraries lens), checked in this order:
 *
 * - {@link GH_UNRUNNABLE_CODES} — `gh` itself never ran. `gh-not-available`,
 *   the same reason `findGh`'s own miss reports.
 * - `error.code === "ETIMEDOUT"` — checked directly, never `error.signal`.
 *   `execFileSync`'s timeout can fire and still report a **null** `signal`:
 *   a `gh` invocation whose child backgrounds a grandchild holding the
 *   stdout pipe open (probed real — the immediate child can exit cleanly on
 *   its own, `status: 0`, before the wall-clock timeout needs to kill
 *   anything, while the read on stdout keeps blocking on that grandchild)
 *   still sets `code: "ETIMEDOUT"` with `signal: null`. Keying off `signal`,
 *   as an earlier version of this function did, silently misclassifies that
 *   shape as something other than a timeout.
 * - `error.code === "ENOBUFS"` — `maxBuffer` exceeded. `gh` is technically
 *   still running or ran to completion, but this process refused to keep
 *   reading; there is no response left to classify, so it lands in the same
 *   bucket an unparseable body does: `malformed-response`.
 * - Exit `4` is unauthenticated, unambiguously (probed: no credentials
 *   present at all, distinct from credentials that were sent and rejected).
 * - Exit `1` is overloaded across three shapes, told apart in the order they
 *   were probed to be mutually exclusive: `stderr` containing `"error
 *   connecting"` is a transport failure that never reached GitHub; otherwise
 *   `stdout`'s JSON `status` field settles it — `"404"` is the external
 *   entity not existing, `"401"` is credentials GitHub rejected, read from
 *   the JSON body on stdout, never from gh's own stderr summary line.
 * - Anything else — an exit-1 body this module has not seen probed, or a
 *   `gh` invocation that never reaches the API at all (T3 passing a shape
 *   `gh` itself rejects before making a request is one real, katra-side way
 *   to land here) — lands on the one bucket honestly named for "a response
 *   came back and this could not read it as one of the above":
 *   `malformed-response`, the same defensive catch-all `ENOBUFS` uses, not a
 *   guess at which of the other reasons it most resembles.
 */
function classifyGhFailure(error: unknown): RefreshReason {
  const failure = readGhFailure(error);

  if (failure.code !== null && GH_UNRUNNABLE_CODES.has(failure.code)) return "gh-not-available";
  if (failure.timedOut) return "timeout";
  if (failure.code === "ENOBUFS") return "malformed-response";
  if (failure.status === 4) return "gh-unauthenticated";
  if (failure.stderr.includes("error connecting")) return "network";

  const httpStatus = readJsonHttpStatus(failure.stdout);
  if (httpStatus === "404") return "not-found";
  if (httpStatus === "401") return "bad-credentials";

  return "malformed-response";
}
