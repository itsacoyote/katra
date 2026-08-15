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
 * Control and line-separator characters that must never survive into a
 * value this module hands back -- whether reconstructed (a decoded path
 * segment feeding {@link ParsedRef}) or stored verbatim (an explicit
 * `--url`, {@link validateExplicitRef}): the C0 controls (NUL through
 * Unit Separator -- covering NUL, tab, CR, LF, ESC), DEL, the C1
 * controls, and the two Unicode line separators LINE SEPARATOR /
 * PARAGRAPH SEPARATOR -- invisible to a terminal, line breaks to any
 * other renderer. The same set `cli/format.ts`'s `oneLine` strips at
 * render time (AGENTS.md); this module refuses them outright instead,
 * since it is the boundary where they would otherwise start looking
 * like ordinary, already-validated data. Every codepoint below is
 * written as an explicit unicode escape, never a raw byte in this file
 * (house rule).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CONTROL_CHARS_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * What a decoded GitHub/Linear path segment -- owner, repo, or Linear
 * workspace -- may never contain: `/` and `#`, which would let the
 * segment forge a boundary `externalId` doesn't otherwise have (the
 * security-scan finding this exists to close -- a percent-encoded
 * `%2F`/`%23` decoding into a literal separator mid-segment used to
 * splice extra, attacker-chosen path components into the stored id);
 * `?`, which the same decode can turn into a query-string delimiter
 * that was never in the raw path; and every character in
 * {@link CONTROL_CHARS_PATTERN}. Applied identically to a bare
 * `owner/repo#n` input's captured groups and to a URL's decoded path
 * segments -- the two are the same trust boundary and must refuse the
 * same shapes, or a URL built from one recognized bare ref could
 * recognize differently than the bare ref itself.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const FORBIDDEN_SEGMENT_PATTERN = /[/#?\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function isCleanSegment(segment: string): boolean {
  return !FORBIDDEN_SEGMENT_PATTERN.test(segment);
}

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
  // encodeURIComponent, not a raw splice: owner/repo already passed
  // isCleanSegment (no /, #, ?, or control character survives), but a
  // decoded segment can still legitimately contain a literal "%" — and
  // splicing that raw into a url template produces a string that reparses
  // to a DIFFERENT decoded value than the one just canonicalized (the
  // double-encoding finding: "%252F" decodes once here to a literal
  // "%2F", and an un-re-encoded url would reparse that "%2F" into "/" on
  // the next parse). Re-encoding here is what makes reparsing this exact
  // url reproduce the identical externalId (see the convergence tests).
  const url = `https://${GITHUB_HOST}/${encodeURIComponent(ownerLower)}/${encodeURIComponent(repoLower)}/${kind}/${n}`;
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
  // Same re-encoding reasoning as buildGithubRef: workspace already passed
  // isCleanSegment, but still needs encodeURIComponent so a literal "%"
  // (or any other character encodeURIComponent escapes) surviving into it
  // cannot make the reconstructed url reparse to a different value.
  const url =
    workspace === null
      ? null
      : `https://${LINEAR_HOST}/${encodeURIComponent(workspace)}/issue/${teamKeyUpper}`;
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
 * raw path. Every decoded segment is then checked with
 * {@link isCleanSegment}: a decode that produced a `/`, `#`, `?`, or a
 * control character refuses the whole path here, before
 * `matchGithubSegments`/`matchLinearSegments` ever see it — those two have
 * no character-class restriction of their own on owner/repo/workspace
 * (risk note 4's deliberate permissiveness), so without this check a
 * decoded `%2F`/`%23` would otherwise splice a forged extra path
 * component straight into the stored `externalId` (the security-scan
 * finding this closes).
 *
 * Returns `undefined` on malformed percent-encoding (`decodeURIComponent`
 * throwing `URIError`) or on a segment `isCleanSegment` rejects, rather
 * than letting either escape as an uncaught crash or a spliced id.
 */
function decodeSegments(pathname: string): string[] | undefined {
  const raw = pathname.split("/").filter((segment) => segment.length > 0);
  const decoded: string[] = [];
  for (const segment of raw) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (!isCleanSegment(value)) return undefined;
    decoded.push(value);
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
 * network and no plugin (ADR-014). Never throws: `text` is checked with
 * `typeof` before anything else touches it, every branch that can fail
 * (`new URL`, `decodeURIComponent`) is caught, and every regex is linear, so
 * even a 10,000-character hostile paste refuses in the time it takes to
 * compare a length.
 *
 * Recognition, in order:
 * 0. A non-`string` `text` refuses immediately (see the guard above).
 * 1. `text.length` over {@link MAX_INPUT_LENGTH} refuses immediately, before
 *    any regex or URL parse runs (risk note 9).
 * 2. If `text.trim()` parses as an absolute `http(s)` URL: the port must be
 *    empty (an explicit port refuses — risk note 6) — WHATWG normalizes
 *    away a *default* port (`:443` on `https`, `:80` on `http`) before this
 *    ever sees it, so those are accepted like any bare host, while an
 *    explicit non-default port (`:8443`, ...) is the one this refuses — and
 *    the hostname, with at most one leading `www.` stripped, must equal
 *    `github.com` or `linear.app` **exactly** — never `includes`/`endsWith`,
 *    which is what keeps `github.com.evil.com` and `evil-github.com`
 *    refusing, and an IDN homograph refusing too: `URL.hostname` is already
 *    in punycode form by the time this compares it, so a Cyrillic/Greek
 *    lookalike simply fails the exact match without this function ever
 *    needing to decode punycode itself (risk note 7). WHATWG also strips
 *    any ASCII tab/CR/LF found *anywhere* in `text` (not just the host) as
 *    part of ordinary URL parsing — the same thing a browser's address bar
 *    does — so `git`+TAB+`hub.com/...` parses to the clean hostname
 *    `github.com` and recognizes normally; this function never stores the
 *    raw input, only values it reconstructs itself, so there is nothing for
 *    a stripped character to have hidden inside (contrast
 *    {@link validateExplicitRef}, which stores its `url` verbatim and needs
 *    its own explicit check for exactly this reason). A URL that parses but
 *    is not one of the two hosts refuses here — it is never handed to the
 *    bare-form patterns below, which could not match a `scheme://` string
 *    anyway.
 * 3. Otherwise `text.trim()` is tried against the bare `owner/repo#n` and
 *    `TEAM-123` patterns. An SSH remote (`git@github.com:owner/repo.git`) is
 *    not a valid absolute URL (step 2 leaves it as "not a URL") and does not
 *    match either bare pattern either — it refuses cleanly, never throws
 *    (risk note 8).
 * 4. Anything matching neither refuses, naming the `--provider/--id/--url`
 *    escape hatch (ADR-014).
 *
 * The returned `ref.externalId`/`ref.url` are always reconstructed from the
 * matched, `isCleanSegment`-checked parts, never the input re-serialized —
 * so a credential-bearing URL (`https://user:pass@github.com/...`)
 * recognizes normally and the credentials are simply never read, let alone
 * stored (risk notes 1 and 25); a top-level `?query`/`#fragment` on the URL
 * is never even seen by the path matcher, since `URL` already splits those
 * into `search`/`hash`; and a query/fragment/separator character that only
 * appears *after* percent-decoding a path segment (`%3F`, `%23`, `%2F`) is
 * caught by `isCleanSegment` and refuses the whole input, rather than
 * splicing into `externalId` — so every cosmetic variant of the same PR or
 * issue (trailing `/files`, a `?query`, a `#fragment`, `www.`, an uppercase
 * host, `http` instead of `https`, a credentialed URL) converges on
 * byte-identical output, and re-parsing that output's own `url` reproduces
 * the identical `ParsedRef` again (the convergence tests) — `encodeURIComponent`
 * in `buildGithubRef`/`buildLinearRef` is what keeps a literal `%` inside an
 * already-clean segment from making that second parse disagree with the
 * first.
 */
export function parseRefInput(text: string): ParseRefResult {
  // Runtime guard, not just the TS signature: this is a boundary function —
  // reachable from parsed JSON (a library caller, a future MCP surface)
  // where nothing enforces the type at compile time — and `text.length` on
  // a non-string throws, which would contradict "never throws" below.
  if (typeof text !== "string") {
    return refuseInput("input must be a string");
  }
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
    // isCleanSegment here mirrors the check decodeSegments applies to a
    // URL's decoded path segments (risk note in FORBIDDEN_SEGMENT_PATTERN's
    // docs) — a bare bareGithub owner/repo and a URL-derived one are the
    // same trust boundary, so a `?` or control character must refuse the
    // same way through either path.
    if (
      owner !== undefined &&
      repo !== undefined &&
      n !== undefined &&
      isCleanSegment(owner) &&
      isCleanSegment(repo)
    ) {
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
 * credentials, no explicit port, and no control character or line
 * separator ({@link CONTROL_CHARS_PATTERN} — the WHATWG parser can
 * silently strip or re-encode those on the way to the shape check, so they
 * are checked directly against the string this function actually stores),
 * at most {@link MAX_URL_LENGTH} characters — kept exactly as given
 * (trimmed only) on success, since unlike a recognized ref there are no
 * matched segments to reconstruct a canonical form from, and rewriting what
 * the caller explicitly typed would be a surprise (risk note 24: "no
 * network" does not mean "store anything as a url" — the shape still has
 * to be a real absolute http(s) URL).
 *
 * `provider` and `url` are never cross-checked against each other —
 * `{provider: "github", url: "https://ghe.example.com/..."}` is accepted.
 * Deliberate (ADR-014's provider-agnosticism): a self-hosted GitHub
 * Enterprise or Linear-on-a-different-domain instance is a legitimate real
 * case with no other way to be stored under a recognizable provider name,
 * and this function has no way to know which hosts are "really" which
 * provider without becoming a second, competing host table alongside
 * {@link parseRefInput}'s. Pinned by a test — do not turn this into a
 * refusal without revisiting that decision first.
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
  // `parsed` reflects what WHATWG normalized `trimmedUrl` INTO — but the
  // value stored below is `trimmedUrl` itself, verbatim (this function's
  // whole point, unlike parseRefInput's reconstructed url). WHATWG can
  // silently strip or re-encode a control character on the way to `parsed`
  // (an embedded tab/CR/LF disappears from `parsed.hostname` entirely; a
  // NUL/ESC surviving elsewhere gets percent-encoded into `parsed.pathname`)
  // — so checking only `parsed` and then storing `trimmedUrl` verbatim would
  // let exactly those characters ride along into storage looking
  // pre-validated. Checked directly against `trimmedUrl`, not `parsed`.
  if (CONTROL_CHARS_PATTERN.test(trimmedUrl)) {
    return refuseExplicit("url must not contain control characters or line separators");
  }

  return { valid: true, ref: buildExplicitRef(provider, externalId, trimmedUrl) };
}

function buildExplicitRef(provider: string, externalId: string, url: string | null): ExplicitRef {
  return { provider, externalId, url };
}
