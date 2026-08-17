/**
 * `katra refresh` — resolves every linked ref's current status against its
 * provider (GitHub, Linear) and writes what changed.
 *
 * The only command whose own body needs to `await` — a provider's `resolve`
 * is a real network call — so it is the first to use `withStoreAsync`
 * (`with-store.ts`) rather than `withStore`, and Commander's own
 * `parseAsync` (already how `program.ts`'s `run` drives every invocation)
 * carries that async action handler through with no other command needing to
 * change. Every other command in this file tree stays synchronous.
 *
 * **Orchestration, in order:**
 *
 * 1. **Gather.** No explicit ids: `listOpenTaskRefs` (T4) — every ref linked
 *    to at least one open task. Explicit ids: each is resolved with
 *    `requireId` first — the ordinary house `not_found` refusal for one that
 *    does not exist, the same as every other command taking task ids — then
 *    `listOpenTaskRefsFor` (T4) scopes to just those tasks' refs. Both
 *    already dedupe to one entry per unique `refs.id` (`OpenRef`'s own
 *    docs); this function does no deduplication of its own.
 * 2. **Resolve.** Once per `OpenRef`, sequentially (epic risk note 12: no
 *    total budget, accepted for v1 — dedup by ref already halves the real
 *    cost), entirely **outside any transaction**: `writeTx` is synchronous
 *    and a provider's `resolve` is not, so the two must never overlap (epic
 *    risk note 5). `providerFor` (T3's registry) picks the provider by the
 *    ref's own `provider` field; no match resolves to `unresolved
 *    "no-provider"` without ever calling anything network-shaped — the
 *    escape-hatch ref case (`--provider jira ...`, ADR-014). `context.env`
 *    is threaded into every `resolve` call — providers never read
 *    `process.env` themselves (T3's own structural pin) — which is what
 *    makes an isolated test/sweep environment (no `gh`, no
 *    `LINEAR_API_KEY`) actually bite regardless of what the real process
 *    environment happens to hold.
 * 3. **Write.** Once resolution is done and no more network calls remain,
 *    each resolved outcome goes through `applyRefresh` (T4's public,
 *    per-ref `writeTx` wrapper) — one transaction per ref, never per holder.
 *    `applyRefresh`'s own `"gone"` result (the ref vanished between being
 *    gathered and this write) folds into the `unresolved` category here as
 *    reason `"gone"`, exactly like any other degraded outcome — never a
 *    thrown error that would abort every ref still queued behind it.
 *
 * **Exactly three outcomes per ref** (spec req 5): `updated` (the cache
 * changed — `applyRefresh` reports `"changed"`), `unchanged` (the cache
 * already matched), `unresolved <reason>` (a provider degraded, none is
 * registered, or the ref vanished). `refresh` exits 0 whenever every ref
 * resolved or degraded cleanly (ADR-006) — an all-`unresolved` run is not a
 * failure, the same reasoning `next` finding nothing ready is not one. Only
 * a genuinely malformed invocation — a nonexistent explicit id, today — is
 * a usage-shaped refusal with a non-zero exit.
 *
 * **Confused deputy, named and accepted (epic risk note 4).** `refresh` is,
 * by construction, an oracle for whatever GitHub/Linear credentials this
 * process's environment holds, against repos/issues an attacker chooses
 * simply by getting a ref stored under `provider: "github"`/`"linear"` with
 * an arbitrary `externalId` (F7's `ref add --provider/--id` escape hatch
 * places no restriction linking a ref's id to any real ownership check).
 * This is a known, deliberate consequence of F7 decoupling a ref's
 * `provider`/`externalId` from any binding to the repo katra itself runs
 * in — recorded here rather than worked around, because the fix (verifying
 * a ref's repo against the current repo's own remotes, say) is out of this
 * feature's scope and was never part of the spec's requirements for F8.
 *
 * **The token -> sentence render mapping is owned here** ({@link
 * REASON_SENTENCES}), not in `core/enums.ts` alongside `RefreshReason`
 * itself: the token vocabulary is a graph-root concern (T1's docs on that
 * module), but the *prose* is purely this command's own text rendering, and
 * nothing else in katra reads it. `--json` always carries the raw kebab
 * token; only text output goes through this map.
 */

import type { Command } from "commander";
import type {
  RefreshResult,
  RefreshSection,
  RefreshTotals,
  RefreshUnchangedRef,
  RefreshUnresolvedRef,
  RefreshUpdatedRef,
} from "../../core/contract.js";
import type { RefreshReason } from "../../core/enums.js";
import { providerFor } from "../../core/providers/registry.js";
import type { ProviderResult } from "../../core/providers/types.js";
import type { OpenRef } from "../../core/refs/repo.js";
import { applyRefresh, listOpenTaskRefs, listOpenTaskRefsFor } from "../../core/refs/repo.js";
import type { OpenStore } from "../../core/store.js";
import { requireId } from "../../core/tasks/ids.js";
import { oneLine } from "../format.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStoreAsync } from "../with-store.js";

/**
 * How many rows each of {@link RefreshResult}'s three categories renders at
 * most — the same "a bound reports itself" discipline every other bounded
 * read in katra follows (`DEFAULT_EVENT_LIMIT`, `MAX_CANDIDATES`, ...).
 * `refresh` has no `--limit` of its own (spec req 5 names no such flag): this
 * is a fixed ceiling on the *report*, not on how many refs actually get
 * resolved and written — every ref gathered in step 1 is still resolved and
 * written in full, whatever this bounds.
 */
export const MAX_REFRESH_SECTION_ITEMS = 50;

/** Bounds `items` to {@link MAX_REFRESH_SECTION_ITEMS}, reporting whether the cap cut anything — pure, and exported so its boundary (a limit of 0 emptying a category) is unit-testable without a store. */
export function buildRefreshSection<T>(
  items: readonly T[],
  limit: number = MAX_REFRESH_SECTION_ITEMS,
): RefreshSection<T> {
  const capped = items.slice(0, limit);
  return { count: items.length, items: capped, truncated: capped.length < items.length };
}

/**
 * Every `RefreshReason` (T1, `core/enums.ts`) rendered as a sentence, for
 * text output only — `--json` always carries the raw token. `satisfies
 * Record<RefreshReason, string>` is what makes T1 adding a thirteenth reason
 * without updating this map a compile error here, rather than a silently
 * unrendered token.
 */
const REASON_SENTENCES = {
  "gh-not-available": "gh not available",
  "gh-unauthenticated": "gh not authenticated",
  "not-found": "not found",
  "bad-credentials": "bad credentials",
  network: "network error",
  timeout: "timed out",
  "no-key": "LINEAR_API_KEY not set",
  "bad-key": "bad LINEAR_API_KEY",
  "malformed-response": "malformed response",
  "bad-shape": "not a valid reference for its provider",
  "no-provider": "no provider",
  gone: "ref no longer exists",
} satisfies Record<RefreshReason, string>;

/** Resolves one ref's provider outcome — never throws; the registry-miss and the provider's own failure both become the ordinary `resolved: false` arm. */
async function resolveOne(ref: OpenRef, env: NodeJS.ProcessEnv): Promise<ProviderResult> {
  const provider = providerFor(ref.ref);
  if (provider === undefined) return { resolved: false, reason: "no-provider" };
  return provider.resolve(ref.ref, env);
}

/**
 * The whole orchestration: gather, resolve (network, no transaction open),
 * then write (one `applyRefresh` transaction per ref). See this module's
 * docs for the full three-step account.
 */
async function runRefresh(
  store: OpenStore,
  env: NodeJS.ProcessEnv,
  ids: readonly string[],
): Promise<RefreshResult> {
  const refs =
    ids.length === 0
      ? listOpenTaskRefs(store)
      : listOpenTaskRefsFor(
          store,
          ids.map((id) => requireId(store, id)),
        );

  // Resolution happens for every gathered ref before any of them are
  // written — sequential, outside any transaction (this module's docs,
  // step 2).
  const resolutions: Array<{ readonly ref: OpenRef; readonly outcome: ProviderResult }> = [];
  for (const ref of refs) {
    resolutions.push({ ref, outcome: await resolveOne(ref, env) });
  }

  const updated: RefreshUpdatedRef[] = [];
  const unchanged: RefreshUnchangedRef[] = [];
  const unresolved: RefreshUnresolvedRef[] = [];

  for (const { ref, outcome } of resolutions) {
    if (!outcome.resolved) {
      unresolved.push({
        provider: ref.ref.provider,
        externalId: ref.ref.externalId,
        reason: outcome.reason,
      });
      continue;
    }

    const applied = applyRefresh(store, ref.refId, {
      status: outcome.status,
      title: outcome.title,
    });

    if (applied.kind === "gone") {
      unresolved.push({
        provider: ref.ref.provider,
        externalId: ref.ref.externalId,
        reason: "gone",
      });
    } else if (applied.kind === "unchanged") {
      unchanged.push({ provider: ref.ref.provider, externalId: ref.ref.externalId });
    } else {
      updated.push({
        provider: ref.ref.provider,
        externalId: ref.ref.externalId,
        from: applied.from,
        to: applied.to,
      });
    }
  }

  const totals: RefreshTotals = {
    refs: updated.length + unchanged.length + unresolved.length,
    updated: updated.length,
    unchanged: unchanged.length,
    unresolved: unresolved.length,
  };

  return {
    totals,
    updated: buildRefreshSection(updated),
    unchanged: buildRefreshSection(unchanged),
    unresolved: buildRefreshSection(unresolved),
  };
}

// ---------------------------------------------------------------------------
// Human rendering — one block per non-empty category, migrate.ts's own
// sections-accumulator style (module docs there).
// ---------------------------------------------------------------------------

function formatRefreshResult(result: RefreshResult): string {
  const blocks: string[] = [];
  const { totals } = result;

  blocks.push(
    `${String(totals.refs)} ref(s) checked — ${String(totals.updated)} updated, ` +
      `${String(totals.unchanged)} unchanged, ${String(totals.unresolved)} unresolved`,
  );

  const push = (
    label: string,
    section: RefreshSection<unknown>,
    lines: readonly string[],
  ): void => {
    if (section.count === 0) return;
    const rows = [`${label} (${String(section.count)})`, ...lines];
    if (section.truncated) rows.push("  … truncated");
    blocks.push(rows.join("\n"));
  };

  push(
    "updated",
    result.updated,
    result.updated.items.map(
      (item) =>
        `  ${oneLine(item.provider)}: ${oneLine(item.externalId)}  ` +
        `${oneLine(item.from ?? "none")} -> ${oneLine(item.to)}`,
    ),
  );
  push(
    "unchanged",
    result.unchanged,
    result.unchanged.items.map(
      (item) => `  ${oneLine(item.provider)}: ${oneLine(item.externalId)}`,
    ),
  );
  push(
    "unresolved",
    result.unresolved,
    result.unresolved.items.map(
      (item) =>
        `  ${oneLine(item.provider)}: ${oneLine(item.externalId)}  ${REASON_SENTENCES[item.reason]}`,
    ),
  );

  return blocks.join("\n\n");
}

export function registerRefresh(program: Command, context: CliContext): void {
  program
    .command("refresh")
    .argument(
      "[ids...]",
      "task ids whose linked refs to refresh, full or partial; omit to refresh every open task's refs",
    )
    .description("resolve every linked ref's current status against its provider (GitHub, Linear)")
    .option("--json", "emit structured output")
    .action(async (ids: string[], options: { json?: boolean }) => {
      const { result, warnings } = await withStoreAsync(context, (store) =>
        runRefresh(store, context.env, ids),
      );

      emit(
        result,
        { json: options.json === true, warnings, streams: context.streams },
        formatRefreshResult,
      );
    });
}
