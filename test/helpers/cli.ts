/**
 * Runs katra's CLI in-process and captures everything it produced.
 *
 * In-process rather than spawned: a subprocess per assertion would dominate
 * the suite's runtime, and `run` is written to return an exit code rather than
 * call `process.exit`, precisely so this is possible.
 */

import { run } from "../../src/cli/program.js";

export interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout parsed as JSON. Throws if it was not valid JSON. */
  json(): unknown;
}

export interface RunCliOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Invokes katra with `args`, as a user would type them after `katra`. */
export async function runCli(args: readonly string[], options: RunCliOptions): Promise<CliRun> {
  let stdout = "";
  let stderr = "";

  const exitCode = await run(args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    streams: {
      out: (text) => {
        stdout += text;
      },
      err: (text) => {
        stderr += text;
      },
    },
  });

  return {
    exitCode,
    stdout,
    stderr,
    json: () => JSON.parse(stdout) as unknown,
  };
}
