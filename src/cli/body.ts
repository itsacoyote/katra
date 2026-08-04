/**
 * Reading long text without putting it on the command line.
 *
 * Descriptions contain quotes, backticks, newlines and `$` — the things shell
 * escaping gets wrong. Passing them as an argument is the single most common
 * way a CLI write goes subtly wrong, so katra reads them from a file or from
 * piped stdin instead.
 */

import { fstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { KatraException } from "../core/errors.js";

export interface BodyOptions {
  /** Path from `--body-file`, if given. */
  readonly bodyFile?: string | undefined;
  /** The directory katra was invoked from. */
  readonly cwd: string;
  /** Reads piped stdin, or returns undefined when stdin is a terminal. */
  readonly readStdin?: () => string | undefined;
}

/**
 * Reads stdin only when something is genuinely piped in.
 *
 * Guarded by a stat rather than by `isTTY` alone: when stdin is an interactive
 * terminal, or a socket nothing ever writes to, a blind read blocks forever
 * instead of failing. Only a pipe or a redirected file is safe to consume.
 */
export function readPipedStdin(): string | undefined {
  try {
    const stats = fstatSync(0);
    if (!stats.isFIFO() && !stats.isFile()) return undefined;
    return readFileSync(0, "utf8");
  } catch {
    return undefined;
  }
}

/** The conventional argument asking a tool to read stdin. */
export const STDIN_ARGUMENT = "-";

/**
 * Resolves the body for a write command, or undefined when none was supplied.
 *
 * **stdin is read only on the explicit `--body-file -`.** Consuming whatever
 * happens to be on fd 0 made every redirect a silent write: `katra update <id>
 * --priority 0` inside `bash script.sh < data.txt` replaced the task's
 * description with the contents of `data.txt`, with nothing said and no undo
 * until snapshots land. A command that never mentions the description must not
 * change it, and the caller's shell plumbing is not consent.
 *
 * `--body-file` is otherwise resolved against the **invoking directory**, not
 * the repository root. That is the opposite of how katra resolves its store —
 * the store must be identical from anywhere, whereas a relative file path means
 * what it would mean to any other command the user typed in that directory.
 */
export function readBody(options: BodyOptions): string | undefined {
  const { bodyFile, cwd } = options;
  if (bodyFile === undefined) return undefined;

  if (bodyFile === STDIN_ARGUMENT) {
    const piped = (options.readStdin ?? readPipedStdin)();
    return piped === undefined || piped.trim() === "" ? undefined : piped;
  }

  const path = isAbsolute(bodyFile) ? bodyFile : resolve(cwd, bodyFile);
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    throw new KatraException({
      code: "validation",
      message: `could not read --body-file ${path}: ${(error as Error).message}`,
      field: "body-file",
      value: bodyFile,
    });
  }

  // Trimmed to nothing means no body, on both branches. An empty file used to
  // set the description to "" while an empty pipe correctly left it alone.
  return contents.trim() === "" ? undefined : contents;
}
