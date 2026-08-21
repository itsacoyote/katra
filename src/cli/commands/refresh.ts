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
 * 2. **Resolve, then write — per ref, never batched.** For each `OpenRef` in
 *    turn: `resolve` first (network — `providerFor`, T3's registry, picks
 *    the provider by the ref's own `provider` field; no match resolves to
 *    `unresolved "no-provider"` without ever calling anything
 *    network-shaped, the escape-hatch ref case, `--provider jira ...`,
 *    ADR-014 — `context.env` is threaded into every `resolve` call, since
 *    providers never read `process.env` themselves, T3's own structural
 *    pin, which is what makes an isolated test/sweep environment (no `gh`,
 *    no `LINEAR_API_KEY`) actually bite regardless of what the real process
 *    environment holds), then, once that `await` has settled, `applyRefresh`
 *    (T4's public, per-ref `writeTx` wrapper — itself fully synchronous)
 *    writes it before the loop moves to the next ref. **Never** a
 *    resolve-everything-then-write-everything pass over two arrays: epic
 *    risk note 5's "no transaction across an `await`" still holds exactly
 *    — `writeTx` is synchronous and never itself spans an `await` — but
 *    going ref-by-ref, rather than batching every resolve before any write,
 *    is what lets an interrupted run (a crash, a `SIGKILL` partway through)
 *    keep whatever it already wrote instead of losing a whole batch of
 *    already-resolved outcomes to the one ref that never got the chance to
 *    write. `applyRefresh`'s own `"gone"` result (the ref vanished between
 *    being gathered and this write) folds into the `unresolved` category
 *    here as reason `"gone"`, exactly like any other degraded outcome —
 *    never a thrown error that would abort every ref still queued behind
 *    it.
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
 * **`refresh <a closed/cancelled task's id>` reads as zero refs, not a
 * refusal.** `listOpenTaskRefsFor` (T4) is still lane-filtered even when a
 * task is named explicitly — a deliberate choice on T4's part, not an
 * oversight here: a task in a terminal lane contributes no rows, exactly as
 * if it held no refs at all, so that run reports `0 ref(s) checked` and
 * exits 0 rather than refusing or silently refreshing something the
 * "refresh only open work" invariant was never meant to cover.
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
 * The acceptance covers the whole consequence, not just the probe: a
 * resolved answer's status and title are PERSISTED to the store's cache
 * columns, rendered by `show`/`brief`/`--json`, and recorded in the event
 * log's transition text — an attacker-chosen private entity's title becomes
 * durable, replicated data, not a transient read (validate round-2 scan).
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
import { clamp, oneLine, SNIPPET_WIDTH } from "../format.js";
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
 *
 * **Also `reconcile`'s own bound (F9 T4), deliberately.** `reconcile.ts`
 * imports this constant directly rather than declaring its own — the same
 * "a bound reports itself" shape, the same order of magnitude of rows, and
 * no reason for the two commands' report caps to be able to drift apart
 * independently. Cross-command reuse, not a coincidence of both needing
 * *some* number: if the two ever need different bounds, that is the moment
 * to split them, not before.
 */
export const MAX_REFRESH_SECTION_ITEMS = 50;

/**
 * Bounds `items` to {@link MAX_REFRESH_SECTION_ITEMS}, reporting whether the
 * cap cut anything — pure, and exported so its boundary (a limit of 0
 * emptying a category) is unit-testable without a store.
 *
 * **Shared with `reconcile.ts` (F9 T4), deliberately** — see
 * {@link MAX_REFRESH_SECTION_ITEMS}'s own docs for why the two commands'
 * report-bounding stays one function rather than two. The generic `<T>`
 * already made this safe to reuse for a differently-shaped item before a
 * second caller existed to prove it.
 */
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
 * unrendered token. Exported (like buildRefreshSection) so the WORDING of
 * every sentence is pinnable — the satisfies clause guarantees presence,
 * not spelling (QA round-1 gap).
 */
export const REASON_SENTENCES = {
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

/**
 * Resolves one ref's provider outcome — never throws; the registry-miss and
 * the provider's own failure both become the ordinary `resolved: false` arm.
 *
 * The `try`/`catch` is defense-in-depth, not a path this suite can pin
 * through the CLI: `Provider.resolve`'s own contract is never-throw, and
 * both `github.ts`/`linear.ts` prove it in their own suite
 * (`test/core/providers.test.ts`) — the same asymmetry `output.ts` accepts
 * for its own structurally-unreachable `internal` branch (that module's
 * `exitCodeFor` docs). A provider that broke the contract anyway would
 * otherwise abort every ref still queued behind it with an unhandled
 * rejection instead of degrading just the one ref that misbehaved — `"gone"`
 * and `"no-provider"` fold a real ref-side vanish and a missing registry
 * entry into `unresolved` the identical way, and this is that same fold for
 * a provider bug. `"malformed-response"` (a fixed token, never
 * `String(error)`) is the honest bucket: this really is "a response came
 * back and this could not read it as one of the known shapes," the same
 * reasoning `classifyGhFailure`'s own catch-all in `core/git.ts` uses.
 */
async function resolveOne(ref: OpenRef, env: NodeJS.ProcessEnv): Promise<ProviderResult> {
  const provider = providerFor(ref.ref);
  if (provider === undefined) return { resolved: false, reason: "no-provider" };
  try {
    // `return await`, not `return`: without the await the promise escapes
    // this try and the catch below never fires — the await IS the defense,
    // not noise a cleanup may remove (senior round-2 INFO, proven live).
    return await provider.resolve(ref.ref, env);
  } catch {
    return { resolved: false, reason: "malformed-response" };
  }
}

/**
 * The whole orchestration: for each gathered ref, resolve (network, no
 * transaction open) then immediately write (one `applyRefresh` transaction
 * per ref) before moving to the next one. See this module's docs for the
 * full per-ref, never-batched account.
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

  const updated: RefreshUpdatedRef[] = [];
  const unchanged: RefreshUnchangedRef[] = [];
  const unresolved: RefreshUnresolvedRef[] = [];

  for (const ref of refs) {
    const outcome = await resolveOne(ref, env);

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
  // Every oneLine below is defense-in-depth too, and just as unpinnable in
  // this suite's own tests: provider/externalId ride in through F7's
  // --provider/--id escape hatch with no character-class restriction, so a
  // hostile value is a real, if untested-here, input this render must survive.
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
        `  ${oneLine(item.provider)}: ${clamp(oneLine(item.externalId), SNIPPET_WIDTH)}  ` +
        `${oneLine(item.from ?? "none")} -> ${oneLine(item.to)}`,
    ),
  );
  push(
    "unchanged",
    result.unchanged,
    result.unchanged.items.map(
      (item) => `  ${oneLine(item.provider)}: ${clamp(oneLine(item.externalId), SNIPPET_WIDTH)}`,
    ),
  );
  push(
    "unresolved",
    result.unresolved,
    result.unresolved.items.map(
      (item) =>
        `  ${oneLine(item.provider)}: ${clamp(oneLine(item.externalId), SNIPPET_WIDTH)}  ${REASON_SENTENCES[item.reason]}`,
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
