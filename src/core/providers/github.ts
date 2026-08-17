/**
 * The GitHub provider (spec §7, ADR-015) — resolves a `github` ref's live
 * status with one `gh api` call through {@link runGh} (`core/git.ts`, T2),
 * the sole process-spawning boundary; this module never spawns anything
 * itself.
 *
 * **One call resolves both issues and PRs** (epic risk note 2, probed
 * against the real API): `gh api repos/{owner}/{repo}/issues/{n}` — GitHub's
 * issues endpoint also serves PR-backed issues, distinguished by a
 * `pull_request` key that is present iff the entity is a PR, with
 * `merged_at` nested inside it. No separate "is this a PR" lookup is ever
 * needed, so an escape-hatch ref with a `null` url still resolves fine.
 *
 * **Status derivation precedence** (epic risk note 2, probed real):
 * `pull_request.merged_at` present and non-empty → `merged`; else top-level
 * `draft === true` → `draft`; else the raw `state` field (`open`/`closed`)
 * passed through. A merged PR is reported `merged` regardless of what
 * `draft` or `state` also say — see {@link deriveStatus}.
 */

import { runGh } from "../git.js";
import { MAX_EXTERNAL_ID_LENGTH } from "../refs/parse.js";
import type { Ref } from "../refs/types.js";
import { parseJsonObject, sanitizeProviderTitle } from "./shared.js";
import type { Provider, ProviderResult } from "./types.js";

/**
 * `owner/repo#n`, re-derived from `ref.externalId` with this provider's own
 * strict pattern — never trusted from `ref.provider === "github"` alone
 * (epic risk note 3). `validateExplicitRef`'s `--provider/--id/--url` escape
 * hatch stores any id string under any provider name, so a hostile id must
 * be refused before its pieces are spliced into an argv element passed to
 * {@link runGh}.
 *
 * **What actually prevents flag injection is the constant `repos/` prefix**
 * on the argv element {@link resolve} builds
 * (`` repos/${owner}/${repo}/issues/${n} ``), not this pattern's charset:
 * `owner` never becomes the *first* character of the string handed to
 * `execFileSync` — that position is permanently `r` — so even a value
 * starting with `-` cannot make `gh` read the argument as a flag. This
 * pattern's job is narrower and separate: refuse a shape that is not a
 * plausible `owner/repo#n` at all (a space, a stray `#`, an embedded
 * `$()`/`;` — see the hostile-shape tests) and match GitHub's own naming
 * rules closely enough that a legitimate owner/repo round-trips.
 *
 * Each segment requires a non-`-` first character
 * (`[A-Za-z0-9._][A-Za-z0-9._-]*`) — GitHub itself does not allow a
 * repository or owner name to start with a hyphen either, so this also
 * happens to reject `-foo/bar#1`, but that is a shape correction, not the
 * safety mechanism described above. `n` is digits only.
 *
 * A segment that is exactly `.` or `..` passes this charset (neither
 * character is forbidden on its own) but is refused separately by
 * {@link isDotSegment} — the identical special case `refs/parse.ts`'s own
 * `isCleanSegment` carves out, for the same reason cited there: ordinary
 * path handling treats `.`/`..` specially, so a segment meant to name a
 * GitHub owner or repo should never silently be one of those two reserved
 * tokens instead.
 */
const GITHUB_EXTERNAL_ID_PATTERN =
  /^([A-Za-z0-9._][A-Za-z0-9._-]*)\/([A-Za-z0-9._][A-Za-z0-9._-]*)#([0-9]+)$/;

/** True for exactly `.` or `..` — see {@link GITHUB_EXTERNAL_ID_PATTERN}'s docs. */
function isDotSegment(segment: string): boolean {
  return segment === "." || segment === "..";
}

/**
 * The katra-side statuses a GitHub ref can resolve to (epic risk note 10) —
 * derived, never a raw GitHub field read verbatim. Order matches
 * {@link deriveStatus}'s precedence, not alphabetical. Kept only as the
 * source `GithubStatus` derives from (typescript-tips: derive types from
 * values) — {@link deriveStatus}'s own return type already closes off
 * anything outside this set at compile time, so nothing downstream
 * re-validates membership at runtime.
 */
const GITHUB_STATUSES = ["merged", "draft", "open", "closed"] as const;
type GithubStatus = (typeof GITHUB_STATUSES)[number];

/**
 * The `gh api repos/{owner}/{repo}/issues/{n}` response fields this
 * provider reads. Every field stays `unknown` until narrowed below — the
 * body is untrusted external data, read from a real HTTP response, not a
 * value katra produced.
 */
interface GithubIssueBody {
  readonly state: unknown;
  readonly title: unknown;
  readonly draft: unknown;
  readonly pull_request: unknown;
}

/**
 * Applies the precedence documented in this module's header, reading
 * `merged_at` from inside `pull_request` (never a top-level field) and
 * validating `state` against exactly `"open"`/`"closed"` rather than
 * trusting it — this is an HTTP response body, not a value katra produced.
 * `merged_at` must be a **non-empty** string: an empty string is not a
 * timestamp, and a response shaped that way should fall through to the
 * `draft`/`state` checks rather than being read as "merged". Returns
 * `undefined` when none of the three branches produces a known status, so
 * the caller can degrade to `malformed-response` instead of guessing.
 */
function deriveStatus(body: GithubIssueBody): GithubStatus | undefined {
  const pullRequest = body.pull_request;
  const mergedAt =
    pullRequest !== null && typeof pullRequest === "object"
      ? (pullRequest as { readonly merged_at?: unknown }).merged_at
      : undefined;
  if (typeof mergedAt === "string" && mergedAt.trim().length > 0) return "merged";
  if (body.draft === true) return "draft";
  if (body.state === "open" || body.state === "closed") return body.state;
  return undefined;
}

async function resolve(ref: Ref, env: NodeJS.ProcessEnv): Promise<ProviderResult> {
  if (ref.externalId.length > MAX_EXTERNAL_ID_LENGTH) {
    return { resolved: false, reason: "bad-shape" };
  }

  const shape = GITHUB_EXTERNAL_ID_PATTERN.exec(ref.externalId);
  if (shape === null) {
    return { resolved: false, reason: "bad-shape" };
  }
  const [, owner, repo, n] = shape;
  if (owner === undefined || repo === undefined || n === undefined) {
    return { resolved: false, reason: "bad-shape" };
  }
  if (isDotSegment(owner) || isDotSegment(repo)) {
    return { resolved: false, reason: "bad-shape" };
  }

  const result = runGh(env, ["api", `repos/${owner}/${repo}/issues/${n}`]);
  if (!result.ok) {
    return { resolved: false, reason: result.reason };
  }

  const raw = parseJsonObject(result.stdout);
  if (raw === undefined) {
    return { resolved: false, reason: "malformed-response" };
  }
  const body = raw as GithubIssueBody;

  const status = deriveStatus(body);
  if (status === undefined) {
    return { resolved: false, reason: "malformed-response" };
  }

  return {
    resolved: true,
    status,
    title: sanitizeProviderTitle(body.title),
  };
}

/** The GitHub provider — one of the two entries `registry.ts` (ADR-015) enumerates. */
export const githubProvider: Provider = {
  name: "github",
  match(ref: Ref): boolean {
    return ref.provider === "github";
  },
  resolve,
};
