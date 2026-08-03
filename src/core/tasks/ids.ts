/**
 * Minting katra ids, and resolving the partial ones people actually type.
 *
 * Both halves live together because they share the alphabet and the prefix:
 * change one and the other must follow.
 *
 * See ADR-001 for why ids are short, random and flat rather than sequential,
 * hierarchical, or a ULID.
 */

import { randomBytes } from "node:crypto";
import { KatraException } from "../errors.js";
import type { OpenStore } from "../store.js";

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

/** How many times a colliding insert is retried before giving up. */
export const ID_RETRY_ATTEMPTS = 10;

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

function isPrimaryKeyCollision(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

/**
 * Runs `insert` with freshly generated ids until one is not already taken, and
 * returns the id that stuck.
 *
 * The retry matches **only** on a primary-key collision. Retrying on any
 * `SQLITE_CONSTRAINT_*` would silently turn a real bug — an invalid lane, a
 * bad priority — into a phantom id collision, and then into a confusing
 * "ran out of attempts" error several tries later.
 *
 * Safe to call inside a transaction: SQLite aborts the offending *statement*
 * on a constraint violation, not the surrounding transaction.
 */
export function insertWithRetry(insert: (id: string) => void): string {
  for (let attempt = 0; ; attempt++) {
    const id = generateId();
    try {
      insert(id);
      return id;
    } catch (error) {
      if (attempt >= ID_RETRY_ATTEMPTS || !isPrimaryKeyCollision(error)) throw error;
    }
  }
}

/** What looking up a partial id produced. */
export type IdResolution =
  | { readonly kind: "found"; readonly id: string }
  | { readonly kind: "ambiguous"; readonly input: string; readonly candidates: readonly string[] }
  | { readonly kind: "not_found"; readonly input: string };

/** How many candidates an ambiguous result lists before truncating. */
export const MAX_CANDIDATES = 20;

/**
 * Resolves a full or partial id to exactly one task.
 *
 * Accepts the id with or without its `kt-` prefix, so both `kt-9f3k2a` and
 * `9f3k2a` work, as does any unique leading portion of either.
 *
 * Lookup uses explicit range bounds rather than `LIKE`. `LIKE 'prefix%'`
 * forfeits SQLite's index range scan and degenerates into a full index walk —
 * measured at 5,000 rows, 2,000 `LIKE` lookups took 1.17s against 151ms for a
 * seek. Range bounds also sidestep pattern metacharacters entirely, so a
 * caller cannot smuggle a wildcard in through the id.
 */
export function resolveId(store: OpenStore, input: string): IdResolution {
  const trimmed = input.trim();
  const bare = trimmed.startsWith(ID_PREFIX) ? trimmed.slice(ID_PREFIX.length) : trimmed;

  // Without a floor, a single character matches most of the backlog: every id
  // starts with the same prefix, so `k` alone would list everything.
  if (bare.length < MIN_PREFIX_LENGTH) {
    throw new KatraException({
      code: "validation",
      message:
        `"${trimmed}" is too short to identify a task — ` +
        `give at least ${MIN_PREFIX_LENGTH} characters after "${ID_PREFIX}".`,
      field: "id",
      value: trimmed,
    });
  }

  const lower = `${ID_PREFIX}${bare}`;
  // U+FFFF encodes above every character the alphabet can produce, so this is
  // the exclusive upper bound of the prefix range.
  const upper = `${lower}￿`;

  const rows = store.db
    .prepare("SELECT id FROM tasks WHERE id >= ? AND id < ? ORDER BY id LIMIT ?")
    .all(lower, upper, MAX_CANDIDATES + 1) as Array<{ id: string }>;

  if (rows.length === 0) return { kind: "not_found", input: trimmed };
  if (rows.length === 1 && rows[0] !== undefined) return { kind: "found", id: rows[0].id };
  return {
    kind: "ambiguous",
    input: trimmed,
    candidates: rows.slice(0, MAX_CANDIDATES).map((row) => row.id),
  };
}

/**
 * Resolves a partial id or throws.
 *
 * The thrown error carries every candidate, so the caller can list them rather
 * than telling the user only that they were ambiguous.
 */
export function requireId(store: OpenStore, input: string): string {
  const resolution = resolveId(store, input);
  switch (resolution.kind) {
    case "found":
      return resolution.id;
    case "ambiguous":
      throw new KatraException({
        code: "ambiguous_id",
        message: `"${resolution.input}" matches ${resolution.candidates.length} tasks`,
        input: resolution.input,
        candidates: resolution.candidates,
      });
    case "not_found":
      throw new KatraException({
        code: "not_found",
        message: `no task matches "${resolution.input}"`,
        id: resolution.input,
      });
    default: {
      const exhaustive: never = resolution;
      return exhaustive;
    }
  }
}
