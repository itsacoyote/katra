/**
 * Everything katra writes out, and the one place a failure becomes an exit code.
 *
 * The core throws structured errors and never mentions exit codes; this module
 * is the only thing that knows the mapping. That is what keeps a later MCP
 * surface a wrapper rather than a rewrite — it catches the same exceptions and
 * maps them to whatever shape it needs.
 */

import type { StoreWarning } from "../core/db/locate.js";
import type { KatraErrorCode, KatraErrorDetail } from "../core/errors.js";
import { isKatraException } from "../core/errors.js";

/** Process exit codes, per requirement 49. */
export const EXIT = {
  ok: 0,
  /** The request was understood and refused: not found, invalid, ambiguous. */
  user: 1,
  /** The invocation itself was malformed. */
  usage: 2,
  /** Legal request, but the current state refuses it. */
  conflict: 3,
} as const;

/**
 * The single failure-to-exit-code table.
 *
 * `satisfies` rather than a cast, so adding a `KatraErrorCode` without a
 * mapping is a compile error rather than a silent fall-through to 1.
 */
const EXIT_FOR_ERROR = {
  not_found: EXIT.user,
  ambiguous_id: EXIT.user,
  validation: EXIT.user,
  // A cycle is a conflict, not a malformed request: both ids exist, the edge is
  // well-formed, and the refusal comes entirely from the shape of the graph as
  // it stands. Delete one of the existing edges and the identical command
  // succeeds — which is what separates 3 from 1.
  cycle: EXIT.conflict,
  conflict: EXIT.conflict,
  usage: EXIT.usage,
} satisfies Record<KatraErrorCode, number>;

/** Where output goes. Injectable so tests never hijack the real streams. */
export interface OutputStreams {
  out(text: string): void;
  err(text: string): void;
}

export const processStreams: OutputStreams = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

export interface EmitOptions {
  readonly json: boolean;
  readonly warnings?: readonly StoreWarning[];
  readonly streams?: OutputStreams;
}

/**
 * Writes a command's result.
 *
 * Under `--json` the output *is* `JSON.stringify` of the value the command
 * returned — there is no second serialisation step that could drift from the
 * type. The human renderer is a separate pure function over the same value.
 */
export function emit<T>(result: T, options: EmitOptions, formatText: (value: T) => string): void {
  const streams = options.streams ?? processStreams;
  const warnings = options.warnings ?? [];

  if (options.json) {
    const payload =
      warnings.length > 0 && isPlainObject(result)
        ? { ...result, warnings }
        : warnings.length > 0
          ? { result, warnings }
          : result;
    streams.out(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  // In text mode warnings go to stderr, so piping stdout into another tool
  // never picks them up.
  for (const warning of warnings) streams.err(`warning: ${warning.message}\n`);
  streams.out(`${formatText(result)}\n`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The exit code a given failure maps to. */
export function exitCodeFor(detail: KatraErrorDetail): number {
  return EXIT_FOR_ERROR[detail.code];
}

/**
 * Writes a failure and returns its exit code.
 *
 * Under `--json` this emits a structured error document rather than prose,
 * because a caller that asked for JSON must not have to parse a sentence to
 * discover what went wrong.
 */
export function emitError(error: unknown, options: EmitOptions): number {
  const streams = options.streams ?? processStreams;

  if (!isKatraException(error)) {
    // Not a deliberate refusal — a genuine fault. Say so distinctly rather
    // than dressing it up as a katra error.
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      streams.out(`${JSON.stringify({ error: { code: "internal", message } }, null, 2)}\n`);
    } else {
      streams.err(`katra: internal error: ${message}\n`);
    }
    return EXIT.user;
  }

  const { detail } = error;
  if (options.json) {
    streams.out(`${JSON.stringify({ error: detail }, null, 2)}\n`);
  } else {
    streams.err(`katra: ${detail.message}\n`);
    streams.err(formatErrorHint(detail));
  }
  return exitCodeFor(detail);
}

/**
 * The "what would unblock this" half of a refusal.
 *
 * A refusal that only says no forces the reader to guess; every structured
 * payload katra carries exists to be printed here.
 */
function formatErrorHint(detail: KatraErrorDetail): string {
  switch (detail.code) {
    case "ambiguous_id":
      return detail.candidates.map((candidate) => `  ${candidate}\n`).join("");
    case "cycle":
      return `  cycle: ${detail.path.join(" -> ")}\n`;
    case "not_found":
    case "validation":
    case "conflict":
    case "usage":
      return "";
    default: {
      const exhaustive: never = detail;
      return exhaustive;
    }
  }
}
