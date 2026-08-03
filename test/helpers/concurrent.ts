/**
 * Runs a snippet in several real OS processes at once.
 *
 * katra's contention story is about separate `katra` invocations from separate
 * worktrees — separate processes holding separate SQLite connections. A test
 * runner's worker pool does not reproduce that: workers isolate test files,
 * they do not make two connections fight over one database file. The
 * measurements that matter (deferred transactions losing writes to
 * SQLITE_BUSY, two migrators racing a fresh store) only appear with real
 * processes, so this helper spawns them.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Marks the one line a worker uses to report its result. */
const RESULT_PREFIX = "__KATRA_RESULT__";

/**
 * Lets a worker import katra's TypeScript source directly.
 *
 * Node 24 strips types natively, so a `.ts` file runs as-is — but the project
 * compiles under NodeNext, where source must spell imports with a `.js`
 * extension. Plain Node resolves that literally and fails, because only the
 * `.ts` exists on disk. A test runner supplies its own resolver; a spawned
 * process has none, so this hook maps `./x.js` to `./x.ts` when that is what
 * actually exists.
 *
 * The alternative would be building to `dist/` before every concurrency test,
 * or duplicating the code under test inside the worker — the first is slow and
 * order-dependent, the second tests a copy rather than the real thing.
 */
const RESOLVE_HOOK = `
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, next) {
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    if (isRelative && specifier.endsWith(".js") && context.parentURL) {
      const candidate = specifier.slice(0, -3) + ".ts";
      try {
        if (existsSync(fileURLToPath(new URL(candidate, context.parentURL)))) {
          return next(candidate, context);
        }
      } catch {
        // Fall through to normal resolution.
      }
    }
    return next(specifier, context);
  },
});
`;

/** What one spawned process reported back. */
export interface ProcessOutcome<T> {
  readonly index: number;
  readonly ok: boolean;
  /** Parsed from the last result line the process printed, if any. */
  readonly value: T | undefined;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ConcurrentOptions {
  /** How many processes to run at once. */
  readonly count: number;
  /**
   * ESM module source. It may `import` anything the project can resolve, and
   * two bindings are already in scope:
   *   `INDEX`   — this process's 0-based number
   *   `barrier` — call **after** your imports to sync with the other processes
   *   `report`  — call once with a JSON-serialisable result
   */
  readonly source: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

// Worker files live under node_modules so a bare `import "better-sqlite3"`
// resolves normally. A file in the OS temp directory has no node_modules above
// it and could not import the project's dependencies at all.
const WORKER_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "node_modules",
  ".katra-workers",
);

function buildWorker(source: string): string {
  return `
const INDEX = Number(process.env.KATRA_PROC_INDEX);
const START_AT = Number(process.env.KATRA_START_AT);
const report = (value) => {
  process.stdout.write(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify(value) + "\\n");
};

// Holds every process until one shared instant. The snippet calls this itself,
// **after** its imports: loading TypeScript modules and a native binding takes
// a variable tens-to-hundreds of milliseconds per process, so a barrier placed
// before them disperses the very processes it was meant to align — and the
// contention the test exists to measure quietly stops happening.
const barrier = () => { while (Date.now() < START_AT) { /* spin */ } };

${source}
`;
}

/** Reads the value a worker reported, ignoring any other output it produced. */
function parseReport<T>(stdout: string): T | undefined {
  const last = stdout
    .split("\n")
    .filter((line) => line.startsWith(RESULT_PREFIX))
    .at(-1);
  if (last === undefined) return undefined;
  try {
    return JSON.parse(last.slice(RESULT_PREFIX.length)) as T;
  } catch {
    return undefined;
  }
}

function runOne<T>(
  workerPath: string,
  hookPath: string,
  index: number,
  startAt: number,
  timeoutMs: number,
  cwd: string | undefined,
  env: Readonly<Record<string, string>> | undefined,
): Promise<ProcessOutcome<T>> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", hookPath, workerPath], {
      ...(cwd === undefined ? {} : { cwd }),
      env: {
        ...process.env,
        ...env,
        KATRA_PROC_INDEX: String(index),
        KATRA_START_AT: String(startAt),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        index,
        ok: exitCode === 0,
        value: parseReport<T>(stdout),
        exitCode,
        stdout,
        stderr,
      });
    });
  });
}

/**
 * Spawns `count` processes running `source`, released simultaneously, and
 * resolves once every one has exited.
 *
 * Never rejects when a child fails — a failed child is an outcome to assert
 * on, not an exception. Inspect `ok`, `exitCode`, and `stderr`.
 */
export async function runConcurrent<T>(options: ConcurrentOptions): Promise<ProcessOutcome<T>[]> {
  const { count, source, cwd, env, timeoutMs = 30_000 } = options;

  // Each call gets its own directory, so concurrent test files never collide.
  mkdirSync(WORKER_ROOT, { recursive: true });
  const dir = mkdtempSync(join(WORKER_ROOT, "run-"));
  const workerPath = join(dir, "worker.mjs");
  const hookPath = join(dir, "resolve-ts.mjs");
  writeFileSync(workerPath, buildWorker(source), "utf8");
  writeFileSync(hookPath, RESOLVE_HOOK, "utf8");

  // Enough lead time for every process to boot and reach the barrier.
  const startAt = Date.now() + 300 + count * 40;

  try {
    return await Promise.all(
      Array.from({ length: count }, (_unused, index) =>
        runOne<T>(workerPath, hookPath, index, startAt, timeoutMs, cwd, env),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
