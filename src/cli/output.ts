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
import { oneLine } from "./format.js";

/** Process exit codes, per requirement 49. */
export const EXIT = {
  ok: 0,
  /** The request was understood and refused: not found, invalid, ambiguous. */
  user: 1,
  /** The invocation itself was malformed. */
  usage: 2,
  /** Legal request, but the current state refuses it. */
  conflict: 3,
  /**
   * katra broke — an unwritable store, a corrupt file, a bug.
   *
   * Separate from `user` (ADR-005). Both used to be 1, so an agent branching
   * on the exit code could not tell "your request was refused, do not retry"
   * from "the disk is read-only, escalate".
   */
  internal: 4,
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
    // Every command returns a plain object, so warnings merge into the top
    // level — see `JsonDocument` in core/contract.ts, which is the published
    // shape of exactly this.
    const payload = warnings.length > 0 && isPlainObject(result) ? { ...result, warnings } : result;
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

/**
 * The exit code a deliberate failure maps to.
 *
 * Takes a `KatraErrorCode`, not a whole `KatraErrorDetail`: `internal` is the
 * one member of that union nothing in the core ever throws — it is built at
 * the CLI boundary from a caught non-KatraException, where `emitError` returns
 * `EXIT.internal` directly. A branch for it here would be unreachable, and an
 * unreachable branch that an ADR cites as a safety property is worse than none.
 */
export function exitCodeFor(code: KatraErrorCode): number {
  return EXIT_FOR_ERROR[code];
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
    // Not a deliberate refusal — a genuine fault. Reported distinctly, and
    // with its own exit code: an agent must be able to tell a refusal it
    // should not retry from a fault it should escalate (ADR-005).
    const message = error instanceof Error ? error.message : String(error);
    const detail: KatraErrorDetail = { code: "internal", message };
    if (options.json) {
      streams.out(`${JSON.stringify({ error: detail }, null, 2)}\n`);
    } else {
      streams.err(`katra: internal error: ${message}\n`);
    }
    return EXIT.internal;
  }

  const { detail } = error;
  if (options.json) {
    streams.out(`${JSON.stringify({ error: detail }, null, 2)}\n`);
  } else {
    // `oneLine`: a KatraException's message is no longer built only from
    // literal strings and ids — F4's claim conflicts interpolate a stored
    // actor string, which nothing upstream sanitizes. Left raw, an ESC
    // sequence or an embedded newline in that string would execute on, or
    // reflow, whatever terminal renders the refusal.
    streams.err(`katra: ${oneLine(detail.message)}\n`);
    streams.err(formatErrorHint(detail));
  }
  // `internal` is a member of the detail union because the envelope above can
  // carry it, but nothing in the core throws it on purpose — so it is handled
  // here, at the one place a KatraException becomes an exit code, rather than
  // inside `exitCodeFor`, where the branch would be unreachable.
  return detail.code === "internal" ? EXIT.internal : exitCodeFor(detail.code);
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
    case "internal":
      return "";
    default: {
      const exhaustive: never = detail;
      return exhaustive;
    }
  }
}
