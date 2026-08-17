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
 * `pull_request.merged_at` present → `merged`; else top-level `draft ===
 * true` → `draft`; else the raw `state` field (`open`/`closed`) passed
 * through. A merged PR is reported `merged` regardless of what `draft` or
 * `state` also say — see {@link deriveStatus}.
 */

import { runGh } from "../git.js";
import { MAX_CACHED_TITLE_LENGTH } from "../refs/parse.js";
import type { Ref } from "../refs/types.js";
import { CONTROL_CHARS_PATTERN, capText } from "../text.js";
import type { Provider, ProviderResult } from "./types.js";

/**
 * `owner/repo#n`, re-derived from `ref.externalId` with this provider's own
 * strict pattern — never trusted from `ref.provider === "github"` alone
 * (epic risk note 3). `validateExplicitRef`'s `--provider/--id/--url` escape
 * hatch stores any id string under any provider name, so a hostile id
 * shaped like a `gh` flag (`-R evil/repo`, `--jq .token`) must refuse before
 * it ever becomes an argv element passed to {@link runGh} — matching the
 * shape is not the same question as "is this safe to spawn with", and this
 * pattern answers both at once by being anchored end to end: an input the
 * character classes allow piece-by-piece but that carries one extra
 * character anywhere (a space, a second `#`, a trailing letter on the issue
 * number) still refuses whole, never partially matches and falls through.
 *
 * Owner/repo characters are `[A-Za-z0-9._-]` only — GitHub's own charset,
 * permissive but closed, the same one `refs/parse.ts`'s bare-form pattern
 * documents as "a lossless round trip through GitHub's own naming"; `n` is
 * digits only.
 */
const GITHUB_EXTERNAL_ID_PATTERN = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#([0-9]+)$/;

/**
 * The four katra-side statuses a GitHub ref can resolve to (epic risk note
 * 10) — derived, never a raw GitHub field read verbatim. Order matches
 * {@link deriveStatus}'s precedence, not alphabetical.
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

/** Parses `stdout` as a GitHub issue/PR body, or `undefined` for anything that is not a JSON object — never throws. */
function parseIssueBody(stdout: string): GithubIssueBody | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  return parsed as GithubIssueBody;
}

/**
 * Applies the precedence documented in this module's header, reading
 * `merged_at` from inside `pull_request` (never a top-level field) and
 * validating `state` against exactly `"open"`/`"closed"` rather than
 * trusting it — this is an HTTP response body, not a value katra produced.
 * Returns `undefined` when none of the three branches produces a known
 * status, so the caller can degrade to `malformed-response` instead of
 * guessing.
 */
function deriveStatus(body: GithubIssueBody): GithubStatus | undefined {
  const pullRequest = body.pull_request;
  const mergedAt =
    pullRequest !== null && typeof pullRequest === "object"
      ? (pullRequest as { readonly merged_at?: unknown }).merged_at
      : undefined;
  if (typeof mergedAt === "string") return "merged";
  if (body.draft === true) return "draft";
  if (body.state === "open" || body.state === "closed") return body.state;
  return undefined;
}

/**
 * Bounds a provider-supplied title the same way the write seam
 * (`refs/repo.ts`'s `applyRefreshWithin`) backstops it one layer down:
 * screened of every control character via the imported
 * {@link CONTROL_CHARS_PATTERN} (never a second copy of the character
 * class), then capped to {@link MAX_CACHED_TITLE_LENGTH} code points with
 * {@link capText} (epic risk note 7). Never refuses: a control character or
 * an oversized title is not a reason to fail the whole resolve, only to
 * bound what comes out of it. A non-string `title` (missing from the
 * response) becomes `null` — "no title" is an ordinary outcome, not a
 * parse failure.
 */
function sanitizeTitle(title: unknown): string | null {
  if (typeof title !== "string") return null;
  const screened = title.replaceAll(new RegExp(CONTROL_CHARS_PATTERN.source, "g"), "");
  return capText(screened, MAX_CACHED_TITLE_LENGTH).text;
}

async function resolve(ref: Ref, env: NodeJS.ProcessEnv): Promise<ProviderResult> {
  const shape = GITHUB_EXTERNAL_ID_PATTERN.exec(ref.externalId);
  if (shape === null) {
    return { resolved: false, reason: "bad-shape" };
  }
  const [, owner, repo, n] = shape;

  const result = runGh(env, ["api", `repos/${owner}/${repo}/issues/${n}`]);
  if (!result.ok) {
    return { resolved: false, reason: result.reason };
  }

  const body = parseIssueBody(result.stdout);
  if (body === undefined) {
    return { resolved: false, reason: "malformed-response" };
  }

  const status = deriveStatus(body);
  if (status === undefined || !GITHUB_STATUSES.includes(status)) {
    return { resolved: false, reason: "malformed-response" };
  }

  return {
    resolved: true,
    // No capText here, unlike title: status has already passed the
    // vocabulary check above, a strictly stronger guarantee than a length
    // bound for a fixed set of short literals — capping past it would cap
    // nothing real.
    status,
    title: sanitizeTitle(body.title),
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
