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
   *   `INDEX`  — this process's 0-based number
   *   `report` — call once with a JSON-serialisable result
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

// Hold every process at one instant before releasing them. Without this
// barrier the first process routinely finishes before the last has started,
// and the contention the test exists to measure never happens.
while (Date.now() < START_AT) { /* spin */ }

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
  index: number,
  startAt: number,
  timeoutMs: number,
  cwd: string | undefined,
  env: Readonly<Record<string, string>> | undefined,
): Promise<ProcessOutcome<T>> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [workerPath], {
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
  writeFileSync(workerPath, buildWorker(source), "utf8");

  // Enough lead time for every process to boot and reach the barrier.
  const startAt = Date.now() + 300 + count * 40;

  try {
    return await Promise.all(
      Array.from({ length: count }, (_unused, index) =>
        runOne<T>(workerPath, index, startAt, timeoutMs, cwd, env),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
