/**
 * The shapes `parseRefInput` and `validateExplicitRef` (`parse.ts`) produce,
 * plus `Ref`, the published view of a stored reference.
 *
 * Pure — no store or `better-sqlite3` import, deliberately, for the same
 * reason `search-query.ts` stays free of them (see that file's module docs):
 * `Ref` is re-exported from `contract.ts` (T5), and a store-touching import
 * here would drag `better-sqlite3`'s types into that published surface.
 * `id-format.ts` / `tasks/ids.ts` is the precedent this split follows.
 */

/**
 * A reference `parseRefInput` recognized, before it is stored.
 *
 * `provider` is narrowed to the two hosts core parses without a plugin
 * (ADR-014) — `github.com` and `linear.app` — never a free-form string, so a
 * caller pattern-matching on it gets a compile error the day a third host is
 * added rather than a silent fallthrough. {@link ExplicitRef} is the
 * general-provider counterpart for the `--provider/--id/--url` escape hatch.
 *
 * `externalId` and `url` are always the **canonical** form: derived from
 * matched path segments only, never the input re-serialized. Every URL
 * variant of the same underlying thing — a trailing `/files`, a `?query`, a
 * `#fragment`, a `www.` host, an uppercase host, `http` instead of `https` —
 * collapses to byte-identical `externalId` and `url` here, which is what lets
 * `refs`' `UNIQUE(provider, external_id)` (T1) dedupe them into one row
 * instead of one per variant a user happened to paste.
 */
export interface ParsedRef {
  readonly provider: "github" | "linear";
  readonly externalId: string;
  readonly url: string | null;
}

/**
 * Why `parseRefInput` would not turn `text` into a {@link ParsedRef}.
 *
 * One shape for every refusal reason — unrecognized host, malformed URL,
 * or a canonical value that would breach `refs`' own `CHECK` bounds (T1) —
 * because every one of them resolves the same way: `message` always names
 * the `--provider/--id/--url` escape hatch (ADR-014), so a caller never has
 * to branch on *why* before telling the user what to do about it.
 */
export interface RefInputRefusal {
  readonly recognized: false;
  readonly message: string;
}

/**
 * What `parseRefInput` hands back: a recognized reference, or why not.
 *
 * Discriminated on `recognized`, mirroring `contract.ts`'s `NextResult` /
 * `BriefResult` — a caller narrows without a cast, and cannot read `ref` on
 * the refusal arm by mistake.
 */
export type ParseRefResult =
  | { readonly recognized: true; readonly ref: ParsedRef }
  | RefInputRefusal;

/**
 * What `validateExplicitRef` accepts — the `--provider/--id/--url` escape
 * hatch's raw input, before trimming or bound-checking.
 *
 * `url` is optional and separately nullable: omitting the property and
 * passing `null` both mean "no URL supplied" (the CLI, T6, need not choose),
 * distinct from passing an empty string, which is a validation failure.
 */
export interface ExplicitRefInput {
  readonly provider: string;
  readonly id: string;
  readonly url?: string | null;
}

/**
 * A reference stored through the explicit escape hatch, validated but not
 * otherwise transformed.
 *
 * Unlike {@link ParsedRef}, `provider` is a free string — ADR-014's whole
 * point is that core stays provider-agnostic in what it *stores*, opinionated
 * only in what it *parses* — so this is the general-provider counterpart, not
 * a duplicate. `url`, when supplied, is kept exactly as given (trimmed only):
 * unlike {@link ParsedRef}'s reconstructed-from-segments url, there are no
 * segments to reconstruct from for an arbitrary provider, and rewriting a
 * value the caller explicitly typed would be a surprise, not a courtesy.
 */
export interface ExplicitRef {
  readonly provider: string;
  readonly externalId: string;
  readonly url: string | null;
}

/** Why `validateExplicitRef` would not accept an {@link ExplicitRefInput}. */
export interface ExplicitRefRefusal {
  readonly valid: false;
  readonly message: string;
}

/**
 * What `validateExplicitRef` hands back: a validated reference, or why not.
 *
 * Discriminated on `valid`, for the same reason {@link ParseRefResult} is
 * discriminated on `recognized`.
 */
export type ValidateExplicitRefResult =
  | { readonly valid: true; readonly ref: ExplicitRef }
  | ExplicitRefRefusal;

/**
 * A stored reference, as published — `contract.ts` (T5) re-exports this onto
 * `TaskView` and `BriefResult` the same way it re-exports `Blocker` and
 * `ClaimInfo` (see that file's module docs for why the split exists).
 *
 * No `id` field: `refs.id` (T1) is an internal, reusable rowid — never
 * published and never a CLI input (spec amendment, epic comment 2). `ref
 * remove`'s two stable forms are the url and the qualified id, both already
 * present here.
 *
 * `cachedStatus` / `cachedTitle` / `syncedAt` exist on the schema from T1 but
 * stay `null` until a later provider cycle (.21+) resolves them — this cycle
 * stores and displays refs with no network, so every reference published by
 * F7 carries these as `null`, not merely typed to allow it.
 */
export interface Ref {
  readonly provider: string;
  readonly externalId: string;
  readonly url: string | null;
  readonly cachedStatus: string | null;
  readonly cachedTitle: string | null;
  readonly syncedAt: string | null;
}
