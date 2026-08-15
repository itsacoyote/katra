/**
 * The one place a pasted URL or bare id becomes a `{provider, externalId,
 * url}` reference: `parseRefInput` (ADR-014's built-in GitHub/Linear
 * recognition) and `validateExplicitRef` (the `--provider/--id/--url` escape
 * hatch every other provider goes through).
 *
 * Pure string logic — no store or `better-sqlite3` import, deliberately, for
 * the same reason `search-query.ts` stays free of them: this module's
 * declarations (`types.ts`) are safe to re-export from `contract.ts` (T5)
 * without dragging the database handle into that published surface.
 * `id-format.ts` / `tasks/ids.ts` is the precedent this split follows.
 *
 * The grammar and every bound below encode the epic's research risk notes
 * (katra-9aw.58, epic comment 1, items 1-10/18/24/25) — not derived from the
 * spec prose alone, so the numbered comments trace back to that record.
 */

import { textWidth } from "../text.js";
import type {
  ExplicitRef,
  ExplicitRefInput,
  ExplicitRefRefusal,
  ParsedRef,
  ParseRefResult,
  RefInputRefusal,
  ValidateExplicitRefResult,
} from "./types.js";

const GITHUB_HOST = "github.com";
const LINEAR_HOST = "linear.app";

/**
 * Hard cap on raw `parseRefInput` input, checked before any regex runs
 * (risk note 9).
 *
 * A DoS guard, not a stored-value bound — unlike {@link MAX_EXTERNAL_ID_LENGTH}
 * / {@link MAX_URL_LENGTH} it is measured in UTF-16 code units (`.length`),
 * not code points: the whole point is an O(1) check that rejects a hostile
 * multi-kilobyte paste before the function does any real work, and counting
 * code points would itself be an O(n) pass over exactly the string this cap
 * exists to avoid touching. Every regex below is also linear (no nested
 * quantifiers), so this is defense in depth, not the only thing standing
 * between a large paste and a hang.
 */
export const MAX_INPUT_LENGTH = 2048;

/**
 * `refs.external_id`'s bound (T1's migration: `CHECK (length(external_id)
 * BETWEEN 1 AND 256)`).
 *
 * A derived value must be checked against the same bound the DDL enforces,
 * or a hostile-but-otherwise-parseable input exits `parseRefInput` clean and
 * then fails as an internal SQLite constraint error three layers down
 * instead of a typed refusal here (iter-3 risk B1). Measured with
 * {@link textWidth} (code points), matching SQLite's own `length()` on TEXT —
 * `.length` counts UTF-16 units and would cap a string of astral characters
 * (rare in a repo/team slug, but not impossible) more tightly than the DDL
 * actually does.
 */
export const MAX_EXTERNAL_ID_LENGTH = 256;

/** `refs.url`'s bound (T1: `CHECK (url IS NULL OR length(url) <= 2048)`). Same reasoning as {@link MAX_EXTERNAL_ID_LENGTH}. */
export const MAX_URL_LENGTH = 2048;

/** `refs.provider`'s bound (T1: `CHECK (length(provider) BETWEEN 1 AND 64)`). */
export const MAX_PROVIDER_LENGTH = 64;

/**
 * What every `parseRefInput` refusal ends with (ADR-014's escape hatch) — one
 * literal string, so a caller can rely on the exact flag names never drifting
 * between one refusal reason and another.
 */
const ESCAPE_HATCH = "store it explicitly with --provider <name> --id <id> [--url <url>]";

function refuseInput(reason: string): RefInputRefusal {
  return { recognized: false, message: `${reason} — ${ESCAPE_HATCH}` };
}

function refuseExplicit(reason: string): ExplicitRefRefusal {
  return { valid: false, message: reason };
}

/**
 * Builds the canonical {@link ParsedRef} and applies the output bounds
 * (iter-3 risk B1) — the one path every recognized shape (URL or bare, GitHub
 * or Linear) funnels through, so the bound check cannot be forgotten on one
 * of the four call sites.
 */
function finalize(
  provider: "github" | "linear",
  externalId: string,
  url: string | null,
): ParseRefResult {
  // url checked first: for the bare `owner/repo#n` derivation (url =
  // externalId's overhead plus a fixed "https://github.com/.../issues/"
  // wrapper), a url over MAX_URL_LENGTH always implies an externalId over
  // MAX_EXTERNAL_ID_LENGTH too, but not the reverse — checking url first
  // surfaces that specific refusal reason instead of always reporting the
  // externalId one whenever both happen to be breached at once.
  if (url !== null && textWidth(url) > MAX_URL_LENGTH) {
    return refuseInput(`derived url exceeds ${MAX_URL_LENGTH} characters`);
  }
  if (textWidth(externalId) > MAX_EXTERNAL_ID_LENGTH) {
    return refuseInput(`derived external id exceeds ${MAX_EXTERNAL_ID_LENGTH} characters`);
  }
  return { recognized: true, ref: { provider, externalId, url } };
}

/**
 * Builds a GitHub `ParsedRef` from already-matched, already-decoded parts.
 *
 * `owner`/`repo` are lowercased here — the one place that happens — so the
 * URL-form and bare-form callers, and every case variant either can arrive
 * in, converge on the identical externalId/url pair (risk note 2). `kind` is
 * `"pull"` or `"issues"` for a URL match (never converted between the two);
 * the bare `owner/repo#n` form always passes `"issues"` — GitHub redirects
 * issues to pull requests, never the reverse, so guessing `/pull/` would be
 * wrong for an issue and right only by luck for a PR (risk note 3).
 */
function buildGithubRef(
  owner: string,
  repo: string,
  kind: "pull" | "issues",
  n: string,
): ParseRefResult {
  const ownerLower = owner.toLowerCase();
  const repoLower = repo.toLowerCase();
  const externalId = `${ownerLower}/${repoLower}#${n}`;
  const url = `https://${GITHUB_HOST}/${ownerLower}/${repoLower}/${kind}/${n}`;
  return finalize("github", externalId, url);
}

/**
 * Builds a Linear `ParsedRef`. `teamKey` is uppercased here, identically for
 * the URL and bare forms (risk note 2). `workspace` is `null` for a bare
 * `TEAM-123` input — there is no workspace slug to derive a URL from, so the
 * ref stores with `url: null` rather than guessing one (spec req 2).
 * `workspace` itself is never case-normalized: only the team key collides
 * across trackers, a workspace slug is just a label.
 */
function buildLinearRef(teamKey: string, workspace: string | null): ParseRefResult {
  const teamKeyUpper = teamKey.toUpperCase();
  const url =
    workspace === null ? null : `https://${LINEAR_HOST}/${workspace}/issue/${teamKeyUpper}`;
  return finalize("linear", teamKeyUpper, url);
}

/**
 * `owner/repo#n`, matched only against a **bare** (non-URL) input.
 *
 * `[^/#]+` for owner/repo is deliberately permissive — anything but the two
 * characters that would make the split ambiguous — because the goal is a
 * lossless round trip through GitHub's own naming, not re-implementing its
 * validation rules (risk note 4). One quantifier per group, none nested:
 * linear-time by construction (risk note 9).
 */
const BARE_GITHUB_PATTERN = /^([^/#]+)\/([^/#]+)#([0-9]+)$/;

/**
 * `TEAM-123`, matched against a bare input and, reused via `.test`, against a
 * single decoded Linear URL path segment. Case-insensitive by construction
 * (`[A-Za-z]+`) — {@link buildLinearRef} is what normalizes the case, not
 * this pattern — and requires an all-digit issue number, which is what keeps
 * a katra task id (base36, so usually letter-bearing) from ever incidentally
 * matching a *different* thing than what it is (risk note 18: this function
 * classifies input shape only, it is never the thing that decides whether
 * some other string is a task id — that stays entirely out of this module).
 */
const BARE_LINEAR_PATTERN = /^([A-Za-z]+)-([0-9]+)$/;

const DIGITS_PATTERN = /^[0-9]+$/;
const LEADING_WWW_PATTERN = /^www\./;

/**
 * Parses `text` as an absolute `http:`/`https:` URL, or returns `undefined`
 * for anything that is not one — including a genuine parse failure (a bare
 * id, an SSH-style `git@host:path` remote, which is not a valid absolute URL
 * at all — risk note 8) and a URL with a scheme this function does not
 * accept (`javascript:`, `file:`, ...). Never throws: `new URL` is the only
 * thing here that can, and it is always inside the `try`.
 */
function parseAbsoluteHttpUrl(text: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return url;
}

/**
 * Splits a URL pathname into non-empty segments and percent-decodes each one
 * **exactly once** (risk note 5) — decoding after the split, not before, so
 * a `%2F` inside a segment cannot introduce a boundary that was never in the
 * raw path; it just becomes a literal slash character living inside that one
 * segment's decoded value, which the grammar below will then simply fail to
 * match against (owner/repo/team-key patterns don't allow `/`).
 *
 * Returns `undefined` on malformed percent-encoding (`decodeURIComponent`
 * throwing `URIError`) rather than letting that escape as an uncaught crash.
 */
function decodeSegments(pathname: string): string[] | undefined {
  const raw = pathname.split("/").filter((segment) => segment.length > 0);
  const decoded: string[] = [];
  for (const segment of raw) {
    try {
      decoded.push(decodeURIComponent(segment));
    } catch {
      return undefined;
    }
  }
  return decoded;
}

interface GithubPathMatch {
  readonly owner: string;
  readonly repo: string;
  readonly kind: "pull" | "issues";
  readonly n: string;
}

/** `/{owner}/{repo}/pull/{n}` or `/{owner}/{repo}/issues/{n}`, with any further segments (`/files`, ...) silently discarded (risk note 1). */
function matchGithubSegments(segments: readonly string[]): GithubPathMatch | undefined {
  const owner = segments[0];
  const repo = segments[1];
  const kind = segments[2];
  const n = segments[3];
  if (owner === undefined || repo === undefined || kind === undefined || n === undefined)
    return undefined;
  if (kind !== "pull" && kind !== "issues") return undefined;
  if (!DIGITS_PATTERN.test(n)) return undefined;
  return { owner, repo, kind, n };
}

interface LinearPathMatch {
  readonly workspace: string;
  readonly teamKey: string;
}

/** `/{workspace}/issue/{TEAM-123}`, with any further segments (a title slug) silently discarded (risk note 1). */
function matchLinearSegments(segments: readonly string[]): LinearPathMatch | undefined {
  const workspace = segments[0];
  const literal = segments[1];
  const teamKey = segments[2];
  if (workspace === undefined || literal === undefined || teamKey === undefined) return undefined;
  if (literal !== "issue") return undefined;
  if (!BARE_LINEAR_PATTERN.test(teamKey)) return undefined;
  return { workspace, teamKey };
}

/**
 * Recognizes a pasted GitHub or Linear reference — URL or bare id — with no
 * network and no plugin (ADR-014). Never throws: every branch that can fail
 * (`new URL`, `decodeURIComponent`) is caught, and every regex is linear, so
 * even a 10,000-character hostile paste refuses in the time it takes to
 * compare a length.
 *
 * Recognition, in order:
 * 1. `text.length` over {@link MAX_INPUT_LENGTH} refuses immediately, before
 *    any regex or URL parse runs (risk note 9).
 * 2. If `text.trim()` parses as an absolute `http(s)` URL: the port must be
 *    empty (an explicit port refuses — risk note 6) and the hostname, with
 *    at most one leading `www.` stripped, must equal `github.com` or
 *    `linear.app` **exactly** — never `includes`/`endsWith`, which is what
 *    keeps `github.com.evil.com` and `evil-github.com` refusing, and an IDN
 *    homograph refusing too: `URL.hostname` is already in punycode form by
 *    the time this compares it, so a Cyrillic/Greek lookalike simply fails
 *    the exact match without this function ever needing to decode punycode
 *    itself (risk note 7). A URL that parses but is not one of the two hosts
 *    refuses here — it is never handed to the bare-form patterns below,
 *    which could not match a `scheme://` string anyway.
 * 3. Otherwise `text.trim()` is tried against the bare `owner/repo#n` and
 *    `TEAM-123` patterns. An SSH remote (`git@github.com:owner/repo.git`) is
 *    not a valid absolute URL (step 2 leaves it as "not a URL") and does not
 *    match either bare pattern either — it refuses cleanly, never throws
 *    (risk note 8).
 * 4. Anything matching neither refuses, naming the `--provider/--id/--url`
 *    escape hatch (ADR-014).
 *
 * The returned `ref.externalId`/`ref.url` are always reconstructed from the
 * matched parts, never the input re-serialized — so a credential-bearing URL
 * (`https://user:pass@github.com/...`) recognizes normally and the
 * credentials are simply never read, let alone stored (risk notes 1 and 25),
 * and every cosmetic variant of the same PR or issue (trailing `/files`, a
 * `?query`, a `#fragment`, `www.`, an uppercase host, `http` instead of
 * `https`) converges on byte-identical output.
 */
export function parseRefInput(text: string): ParseRefResult {
  if (text.length > MAX_INPUT_LENGTH) {
    return refuseInput(`input exceeds ${MAX_INPUT_LENGTH} characters`);
  }
  const trimmed = text.trim();

  const url = parseAbsoluteHttpUrl(trimmed);
  if (url !== undefined) {
    if (url.port !== "") return refuseInput("URL must not specify a port");
    const host = url.hostname.replace(LEADING_WWW_PATTERN, "");
    const segments = decodeSegments(url.pathname);
    if (segments === undefined) return refuseInput("URL path is not validly percent-encoded");

    if (host === GITHUB_HOST) {
      const match = matchGithubSegments(segments);
      if (match !== undefined) return buildGithubRef(match.owner, match.repo, match.kind, match.n);
    } else if (host === LINEAR_HOST) {
      const match = matchLinearSegments(segments);
      if (match !== undefined) return buildLinearRef(match.teamKey, match.workspace);
    }
    return refuseInput("not a recognized github.com or linear.app reference URL");
  }

  const bareGithub = BARE_GITHUB_PATTERN.exec(trimmed);
  if (bareGithub !== null) {
    const owner = bareGithub[1];
    const repo = bareGithub[2];
    const n = bareGithub[3];
    if (owner !== undefined && repo !== undefined && n !== undefined) {
      return buildGithubRef(owner, repo, "issues", n);
    }
  }

  const bareLinear = BARE_LINEAR_PATTERN.exec(trimmed);
  if (bareLinear !== null) {
    const letters = bareLinear[1];
    const digits = bareLinear[2];
    if (letters !== undefined && digits !== undefined) {
      return buildLinearRef(`${letters}-${digits}`, null);
    }
  }

  return refuseInput("not a recognized github or linear reference");
}

/**
 * Validates the `--provider/--id/--url` escape hatch's raw input (ADR-014) —
 * every provider `parseRefInput` does not recognize by built-in parsing goes
 * through this instead. Unlike {@link parseRefInput}, `provider` is trusted
 * verbatim (trimmed only): core stays provider-agnostic in what it stores.
 *
 * Rules: `provider` and `id` non-empty after trimming and within
 * {@link MAX_PROVIDER_LENGTH} / {@link MAX_EXTERNAL_ID_LENGTH}; `url`, when
 * given and non-blank, must parse as an absolute `http`/`https` URL with no
 * credentials and no explicit port, at most {@link MAX_URL_LENGTH}
 * characters — kept exactly as given (trimmed only) on success, since unlike
 * a recognized ref there are no matched segments to reconstruct a canonical
 * form from, and rewriting what the caller explicitly typed would be a
 * surprise (risk note 24: "no network" does not mean "store anything as a
 * url" — the shape still has to be a real absolute http(s) URL).
 */
export function validateExplicitRef(input: ExplicitRefInput): ValidateExplicitRefResult {
  const provider = input.provider.trim();
  const externalId = input.id.trim();

  if (provider.length === 0) return refuseExplicit("provider must not be empty");
  if (externalId.length === 0) return refuseExplicit("id must not be empty");
  if (textWidth(provider) > MAX_PROVIDER_LENGTH) {
    return refuseExplicit(`provider exceeds ${MAX_PROVIDER_LENGTH} characters`);
  }
  if (textWidth(externalId) > MAX_EXTERNAL_ID_LENGTH) {
    return refuseExplicit(`id exceeds ${MAX_EXTERNAL_ID_LENGTH} characters`);
  }

  const rawUrl = input.url;
  if (rawUrl === undefined || rawUrl === null) {
    return { valid: true, ref: buildExplicitRef(provider, externalId, null) };
  }

  const trimmedUrl = rawUrl.trim();
  if (trimmedUrl.length === 0) {
    return { valid: true, ref: buildExplicitRef(provider, externalId, null) };
  }
  if (textWidth(trimmedUrl) > MAX_URL_LENGTH) {
    return refuseExplicit(`url exceeds ${MAX_URL_LENGTH} characters`);
  }

  const parsed = parseAbsoluteHttpUrl(trimmedUrl);
  if (parsed === undefined) {
    return refuseExplicit("url must be an absolute http:// or https:// URL");
  }
  if (parsed.port !== "") {
    return refuseExplicit("url must not specify a port");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return refuseExplicit("url must not contain credentials");
  }

  return { valid: true, ref: buildExplicitRef(provider, externalId, trimmedUrl) };
}

function buildExplicitRef(provider: string, externalId: string, url: string | null): ExplicitRef {
  return { provider, externalId, url };
}
