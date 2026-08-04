/**
 * Builds and runs the katra command line.
 *
 * The program is constructed by a function rather than at module scope so it
 * can be built and invoked in-process by a test. A top-level `parse()` would
 * consume the real `process.argv` on import.
 */

import { Command, CommanderError } from "commander";
import { KatraException } from "../core/errors.js";
import { VERSION } from "../version.js";
import { readPipedStdin } from "./body.js";
import { registerAdd } from "./commands/add.js";
import { registerDelete } from "./commands/delete.js";
import { registerDep } from "./commands/dep.js";
import { registerInit } from "./commands/init.js";
import { registerLifecycle } from "./commands/lifecycle.js";
import { registerLink } from "./commands/link.js";
import { registerList } from "./commands/list.js";
import { registerNext } from "./commands/next.js";
import { registerShow } from "./commands/show.js";
import { registerUpdate } from "./commands/update.js";
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
  /**
   * Requests a non-zero exit without raising an error.
   *
   * For answers that are legitimate but negative — `next` finding nothing
   * ready is the case that needs it. Throwing would replace the structured
   * answer with an error envelope, and returning zero would read as "all
   * done" when the truth is "everything is stuck".
   */
  setExitCode(code: number): void;
}

export interface CreateProgramOptions {
  readonly cwd?: string;
  readonly streams?: OutputStreams;
  readonly env?: NodeJS.ProcessEnv;
  readonly readStdin?: () => string | undefined;
  readonly onExitCode?: (code: number) => void;
  /**
   * Whether `--json` was asked for.
   *
   * Commander's own help and usage errors are prose, and under `--json` prose
   * must not reach either stream — so the program has to be told before it
   * parses. {@link wantsJson} works this out; do not scan argv by hand.
   */
  readonly json?: boolean;
  /**
   * Where commander's prose goes instead of the real streams.
   *
   * Set by `run` under `--json`. Commander writes help screens and usage
   * errors as sentences; diverting them here keeps stdout parseable and lets
   * `run` re-emit the same text inside a document.
   */
  readonly onProse?: (text: string) => void;
}

/**
 * Whether this invocation asked for `--json`.
 *
 * Parsed rather than string-matched. `argv.includes("--json")` is wrong the
 * moment `--json` appears as an option *value*: `katra add t --assignee --json`
 * assigns the string "--json" to `--assignee`, and a scan would flip the whole
 * error contract to JSON for a caller who never asked for it.
 *
 * Everything after a bare `--` is an operand by convention, so it is ignored
 * too.
 */
export function wantsJson(argv: readonly string[]): boolean {
  const end = argv.indexOf("--");
  const considered = end === -1 ? argv : argv.slice(0, end);

  return considered.some((token, index) => {
    if (token !== "--json") return false;
    // An option's value is the token right after a flag that takes one. katra
    // has no option whose value could legitimately be the string "--json", so
    // any `--json` directly following a value-taking flag is that flag's value.
    const previous = considered[index - 1];
    return previous === undefined || !VALUE_TAKING_FLAGS.has(previous);
  });
}

/**
 * Every katra option that consumes the token after it.
 *
 * Kept here rather than derived from the program because the answer is needed
 * *before* the program parses — and a wrong answer silently changes which
 * stream a failure is written to.
 */
const VALUE_TAKING_FLAGS = new Set([
  "--assignee",
  "--body-file",
  "--blocked-by",
  "--epic",
  "--kind",
  "--lane",
  "--level",
  "--parent",
  "--priority",
  "--reason",
  "--tag",
  "--add-tag",
  "--remove-tag",
  "--title",
]);

/** Builds the program. Registering a command is a one-line call per module. */
export function createProgram(options: CreateProgramOptions = {}): Command {
  const context: CliContext = {
    cwd: options.cwd ?? process.cwd(),
    streams: options.streams ?? processStreams,
    env: options.env ?? process.env,
    readStdin: options.readStdin ?? readPipedStdin,
    setExitCode: options.onExitCode ?? (() => undefined),
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
  //
  // Under --json commander's prose is dropped entirely: `run` catches the same
  // CommanderError and re-emits it as a structured `usage` document, so letting
  // the sentence through as well would put human text on stderr next to it.
  //
  // `writeOut` is diverted too: `--help --json` would otherwise print a help
  // screen to stdout and exit 0, which is worse than a usage error for an
  // agent that always passes --json — it gets unparseable output *and* a
  // success code. `run` re-emits whatever lands in the sink as a document.
  const sink = options.onProse;
  program.configureOutput({
    writeOut: (text) => (sink === undefined ? context.streams.out(text) : sink(text)),
    writeErr: (text) => (sink === undefined ? context.streams.err(text) : sink(text)),
  });

  registerInit(program, context);
  registerAdd(program, context);
  registerShow(program, context);
  registerDep(program, context);
  registerList(program, context);
  registerUpdate(program, context);
  registerLifecycle(program, context);
  registerLink(program, context);
  registerDelete(program, context);
  registerNext(program, context);

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
  const json = wantsJson(argv);
  let requested: number = EXIT.ok;
  let prose = "";
  const program = createProgram({
    ...options,
    streams,
    json,
    ...(json
      ? {
          onProse: (text: string) => {
            prose += text;
          },
        }
      : {}),
    onExitCode: (code) => {
      requested = code;
    },
  });

  try {
    await program.parseAsync([...argv], { from: "user" });
    return requested;
  } catch (error) {
    if (error instanceof CommanderError) {
      // `--help` and `--version` arrive here too and report exit code 0.
      // Under --json their prose went to the sink, so emit it as a document
      // rather than leaving stdout empty on a successful invocation.
      if (error.exitCode === 0) {
        if (json) streams.out(`${JSON.stringify({ help: prose.trimEnd() }, null, 2)}\n`);
        return EXIT.ok;
      }
      // A malformed invocation is still a failure a `--json` caller has to be
      // able to read. Commander's own message went to the sink, so this is the
      // only thing written — as the same error envelope every other failure
      // uses, rather than a bare non-zero exit and an empty stdout.
      if (!json) return EXIT.usage;
      return emitError(new KatraException({ code: "usage", message: error.message }), {
        json,
        streams,
      });
    }
    return emitError(error, { json, streams });
  }
}
