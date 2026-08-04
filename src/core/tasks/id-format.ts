/**
 * What a katra id *is*: the prefix, the length, the alphabet, and how a fresh
 * one is minted.
 *
 * Split from the lookup half in `ids.ts` for the same reason as
 * `core/contract.ts`: **nothing here may touch the storage engine.** Resolving
 * a partial id needs an `OpenStore`, which carries the better-sqlite3 handle,
 * and declarations are emitted per file — so re-exporting `generateId` from a
 * module that also declares `resolveId(store: OpenStore, …)` puts
 * `import Database from "better-sqlite3"` into the published `dist/index.d.ts`.
 *
 * The two halves still share this file's constants, so changing the alphabet or
 * the length changes both at once, which was the reason they lived together.
 *
 * See ADR-001 for why ids are short, random and flat rather than sequential,
 * hierarchical, or a ULID.
 */

import { randomBytes } from "node:crypto";

/** Distinguishes a katra id from a git SHA or an external issue number in prose. */
export const ID_PREFIX = "kt-";

/**
 * Six base36 characters.
 *
 * Measured collision probability across 2,000 creations: 69.6% at four
 * characters, 0.09% at six. Retry makes any length *correct*, so this is about
 * how often the retry path fires — at four it is routine, at six it is genuinely
 * exceptional, and the id is still short enough to type.
 */
export const ID_SUFFIX_LENGTH = 6;

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * Largest multiple of 36 that fits in a byte.
 *
 * Bytes at or above this are discarded rather than folded with `%`, which
 * would make the first four characters of the alphabet slightly more likely
 * than the rest.
 */
const UNBIASED_CEILING = 252;

/** Shortest prefix accepted for lookup, counted after any `kt-` is stripped. */
export const MIN_PREFIX_LENGTH = 2;

/** Generates a fresh id. Cryptographically random, not `Math.random`. */
export function generateId(): string {
  let suffix = "";
  while (suffix.length < ID_SUFFIX_LENGTH) {
    for (const byte of randomBytes(ID_SUFFIX_LENGTH * 2)) {
      if (byte >= UNBIASED_CEILING) continue;
      suffix += ALPHABET[byte % ALPHABET.length];
      if (suffix.length === ID_SUFFIX_LENGTH) break;
    }
  }
  return `${ID_PREFIX}${suffix}`;
}
