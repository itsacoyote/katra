/**
 * Builds and runs the katra command line.
 *
 * The program is constructed by a function rather than at module scope so it
 * can be built and invoked in-process by a test. A top-level `parse()` would
 * consume the real `process.argv` on import.
 */

import { Command, CommanderError } from "commander";
import { VERSION } from "../version.js";
import { readPipedStdin } from "./body.js";
import { registerAdd } from "./commands/add.js";
import { registerDep } from "./commands/dep.js";
import { registerInit } from "./commands/init.js";
import { registerList } from "./commands/list.js";
import { registerShow } from "./commands/show.js";
import type { OutputStreams } from "./output.js";
import { EXIT, emitError, processStreams } from "./output.js";

/** Everything a command needs that is not an argument. */
export interface CliContext {
  readonly cwd: string;
  readonly streams: OutputStreams;
  readonly env: NodeJS.ProcessEnv;
  /**
   * Reads piped stdin. Injectable so a test never consumes the runner's own
   * stdin, which would block rather than fail.
   */
  readonly readStdin: () => string | undefined;
}

export interface CreateProgramOptions {
  readonly cwd?: string;
  readonly streams?: OutputStreams;
  readonly env?: NodeJS.ProcessEnv;
  readonly readStdin?: () => string | undefined;
}

/** Builds the program. Registering a command is a one-line call per module. */
export function createProgram(options: CreateProgramOptions = {}): Command {
  const context: CliContext = {
    cwd: options.cwd ?? process.cwd(),
    streams: options.streams ?? processStreams,
    env: options.env ?? process.env,
    readStdin: options.readStdin ?? readPipedStdin,
  };

  const program = new Command();

  program
    .name("katra")
    .description("local, git-native, agent-first project manager")
    .version(VERSION, "-v, --version", "print the katra version");

  // Without exitOverride, commander calls process.exit() itself: usage errors
  // would exit 1 rather than 2 — bypassing the single mapping table entirely —
  // and an in-process test would have its worker killed mid-run.
  program.exitOverride();

  // Route commander's own output through the injected streams so tests capture
  // it and `--json` output never gets help text mixed into stdout.
  program.configureOutput({
    writeOut: (text) => context.streams.out(text),
    writeErr: (text) => context.streams.err(text),
  });

  registerInit(program, context);
  registerAdd(program, context);
  registerShow(program, context);
  registerDep(program, context);
  registerList(program, context);

  return program;
}

/**
 * Runs katra and returns the exit code. Never throws, never calls
 * `process.exit` — the caller decides what to do with the number.
 */
export async function run(
  argv: readonly string[],
  options: CreateProgramOptions = {},
): Promise<number> {
  const streams = options.streams ?? processStreams;
  const program = createProgram({ ...options, streams });

  try {
    await program.parseAsync([...argv], { from: "user" });
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CommanderError) {
      // `--help` and `--version` arrive here too; commander has already
      // written them and reports exit code 0.
      return error.exitCode === 0 ? EXIT.ok : EXIT.usage;
    }
    const json = argv.includes("--json");
    return emitError(error, { json, streams });
  }
}
