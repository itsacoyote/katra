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

/**
 * Resolves the body for a write command, or undefined when none was supplied.
 *
 * `--body-file` is resolved against the **invoking directory**, not the
 * repository root. That is the opposite of how katra resolves its store — the
 * store must be identical from anywhere, whereas a relative file path means
 * what it would mean to any other command the user typed in that directory.
 */
export function readBody(options: BodyOptions): string | undefined {
  const { bodyFile, cwd } = options;

  if (bodyFile !== undefined) {
    const path = isAbsolute(bodyFile) ? bodyFile : resolve(cwd, bodyFile);
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      throw new KatraException({
        code: "validation",
        message: `could not read --body-file ${path}: ${(error as Error).message}`,
        field: "body-file",
        value: bodyFile,
      });
    }
  }

  const piped = (options.readStdin ?? readPipedStdin)();
  return piped === undefined || piped.trim() === "" ? undefined : piped;
}
