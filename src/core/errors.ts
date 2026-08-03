/**
 * katra's error taxonomy.
 *
 * The core throws; only the CLI decides what a failure means to a process.
 * Nothing here mentions exit codes — that mapping lives in one place in
 * `src/cli/`, which is what keeps a later MCP surface a wrapper rather than a
 * rewrite.
 *
 * Every failure carries a **structured** payload rather than a formatted
 * string, because katra's primary reader is an agent: a refusal has to say what
 * blocked it and what would unblock it in a form that survives `--json`.
 */

/** The fixed set of failure kinds. Adding one is a deliberate act. */
export const KATRA_ERROR_CODES = [
  "not_found",
  "ambiguous_id",
  "validation",
  "cycle",
  "conflict",
  "usage",
] as const;

export type KatraErrorCode = (typeof KATRA_ERROR_CODES)[number];

/**
 * Discriminated on `code`, so a consumer narrows to the payload it needs
 * without a cast. A `never` exhaustiveness check at each switch makes a new
 * code a compile error everywhere it must be handled.
 */
export type KatraErrorDetail =
  /** No entity matched the given id or prefix. */
  | { readonly code: "not_found"; readonly message: string; readonly id: string }
  /** A partial id matched more than one entity; every candidate is listed. */
  | {
      readonly code: "ambiguous_id";
      readonly message: string;
      readonly input: string;
      readonly candidates: readonly string[];
    }
  /** A value fell outside what the model allows. */
  | {
      readonly code: "validation";
      readonly message: string;
      readonly field: string;
      readonly value: unknown;
    }
  /** A dependency edge would close a cycle; `path` names the full loop. */
  | { readonly code: "cycle"; readonly message: string; readonly path: readonly string[] }
  /** The action is legal but the current state refuses it; `reason` says why. */
  | { readonly code: "conflict"; readonly message: string; readonly reason: string }
  /** The invocation itself was malformed. */
  | { readonly code: "usage"; readonly message: string };

/** Every failure katra raises on purpose. */
export class KatraException extends Error {
  readonly detail: KatraErrorDetail;

  constructor(detail: KatraErrorDetail) {
    super(detail.message);
    this.name = "KatraException";
    this.detail = detail;
    // Restores the prototype chain so `instanceof` holds regardless of how the
    // class is downlevelled or bundled.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Narrows an unknown caught value. The CLI's single catch site uses this to
 * separate katra's deliberate failures from genuine crashes — the two deserve
 * very different output.
 */
export function isKatraException(value: unknown): value is KatraException {
  return value instanceof KatraException;
}
