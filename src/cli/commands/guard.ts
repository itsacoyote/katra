/**
 * `katra guard` — the before-edit takeover check (F11 T2, ADR-019).
 *
 * The CLI wrapper around {@link guardCheck}'s pure verdict. Its whole job is
 * translating that verdict into a process outcome a hook can act on, and
 * doing so **fail-open**: only a successfully-read live takeover may ever
 * deny. Everything else — no store, a locked or corrupt database, an
 * in-handler usage refusal (a malformed `--liveness`), any exception raised
 * anywhere in this handler, rendering the verdict included — is caught and
 * reported as allow, never propagated to the CLI's ordinary `emitError` path
 * (which would map most of those to a nonzero exit a foreign agent might
 * treat as a block). The whole action body runs inside one `try`, not just
 * the store read, so a throw while rendering an already-decided deny cannot
 * leave the process exiting nonzero with no verdict actually reported.
 *
 * **Deny exits 2** — a deliberate, documented divergence from ADR-006 (`next`
 * answers a legitimate negative with exit 0, payload-only). Claude Code's
 * PreToolUse hook actually has **two** signals that block a tool call
 * unconditionally, in every permission mode including `bypassPermissions`:
 * exit 2 with a stderr reason, or exit 0 with a JSON
 * `permissionDecision: "deny"` on stdout. katra picks exit 2 anyway, on
 * agent-agnostic grounds, not because the JSON channel is somehow weaker or
 * overridable — it needs no per-agent stdout schema and takes no dependency
 * on the agent parsing katra's own output, where a JSON decision would. See
 * ADR-019's amendment for the full reasoning and its one known limit:
 * commander's own usage-error path also exits 2, for a genuinely malformed
 * invocation that never reaches this handler at all to be caught.
 */

import type { Command } from "commander";
import type { GuardOptions } from "../../core/claims/guard.js";
import { guardCheck } from "../../core/claims/guard.js";
import { describeLiveness } from "../../core/claims/repo.js";
import { nowIso } from "../../core/clock.js";
import type { ClaimInfo, GuardResult, StoreWarning } from "../../core/contract.js";
import { narrowWhen } from "../../core/narrow.js";
import { clamp, oneLine, SNIPPET_WIDTH } from "../format.js";
import { EXIT, emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStore } from "../with-store.js";

export type { GuardResult };

/**
 * Deny's exit code. Shares commander's own usage code by protocol necessity,
 * not by accident: of Claude Code's two unconditional block signals (exit 2
 * with stderr, or exit 0 with a JSON `permissionDecision: "deny"`), exit 2
 * is the one katra uses — chosen for agent-agnosticism, not because the
 * alternative is weaker — so it is the only value that could ever carry a
 * deny. See this module's own docs and ADR-019's amendment for the full
 * reasoning and the known limit the sharing creates.
 */
const GUARD_DENY_EXIT = EXIT.usage;

type DenyResult = Extract<GuardResult, { verdict: "deny" }>;

/**
 * Reshapes a deny verdict's own fields into the {@link ClaimInfo} shape
 * {@link describeLiveness} reads — `GuardResult`'s deny arm carries every
 * field that function touches (`claimedAt`, `lastSeen`) except `branch`,
 * which it never reads, so a literal `null` here costs nothing and avoids
 * widening the published `GuardResult` contract for a fact only this one
 * render needs.
 */
function denyClaim(result: DenyResult): ClaimInfo {
  return {
    holder: result.holder,
    actor: result.actor,
    claimedAt: result.claimedAt,
    lastSeen: result.lastSeen,
    branch: null,
  };
}

/**
 * The deny reason: who took the task, how long ago, and the unblock — the
 * same "refusal carries its unblock" house convention `claimTask`'s own
 * conflict message follows (`claims/repo.ts`). Every interpolated field goes
 * through {@link oneLine}, and the stored, attacker-reachable one (`actor`)
 * additionally through {@link clamp}: this reason is fed straight into agent
 * context on stderr, and nothing constrains what a stored actor string
 * contains or how long it is (the hostile-stored-actor regression shape this
 * mirrors is `test/cli/claim.test.ts`'s).
 */
function denyReason(result: DenyResult, now: string): string {
  return (
    `${oneLine(result.taskId)} is held by ${clamp(oneLine(result.actor), SNIPPET_WIDTH)}, ` +
    `${describeLiveness(denyClaim(result), now)} — claim other work (katra next) or take it back: ` +
    `katra release --force ${oneLine(result.taskId)}`
  );
}

/** Text and `--json` mirror each other exactly (spec criterion 1): this is the text half. */
function formatGuard(result: GuardResult, now: string): string {
  return result.verdict === "allow" ? "allow" : `deny — ${denyReason(result, now)}`;
}

/**
 * Built once, for both the two failure paths that need it: the store/parse
 * catch below, and any throw while rendering an already-decided verdict.
 * `clamp`+`oneLine` bound it the same way {@link denyReason} bounds a stored
 * actor — an error's own message can echo back arbitrary input (`narrowWhen`
 * quotes the raw flag value it refused), and this warning rides into agent
 * context exactly like a deny reason does.
 */
function failedOpenWarning(error: unknown): StoreWarning {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "guard-failed-open",
    message: `guard: ${clamp(oneLine(message), SNIPPET_WIDTH)} — allowing`,
  };
}

export function registerGuard(program: Command, context: CliContext): void {
  program
    .command("guard")
    .description(
      "deny (exit 2) an edit iff a different, live worktree took over this worktree's task; fails open on any error",
    )
    .option(
      "--liveness <when>",
      "how far back a rival still counts as live; 2w, 3d, 12h, 30m or ISO (default: 60m)",
    )
    .option("--json", "emit structured output")
    .action((options: { liveness?: string; json?: boolean }) => {
      const json = options.json === true;
      const now = nowIso();
      // Tracked so the catch below can tell whether it is undoing a deny
      // this same invocation already committed to signalling — see the
      // catch's own comment for why that matters.
      let deniedExitSet = false;

      try {
        const guardOptions: GuardOptions =
          options.liveness === undefined
            ? {}
            : { livenessFloor: narrowWhen(options.liveness, "--liveness", now) };

        const { result, warnings } = withStore(context, (store) => guardCheck(store, guardOptions));

        if (result.verdict === "deny") {
          context.streams.err(`katra: ${denyReason(result, now)}\n`);
          context.setExitCode(GUARD_DENY_EXIT);
          deniedExitSet = true;
        }

        emit(result, { json, warnings, streams: context.streams }, (value) =>
          formatGuard(value, now),
        );
      } catch (error) {
        // Fail-open by construction, across the *entire* handler: no store
        // (init never ran), a locked or corrupt database, this handler's own
        // usage refusal (a malformed --liveness), or a throw while rendering
        // a verdict already decided as deny — every one of these reads the
        // same way to a blocking hook — allow, never deny. The exit code is
        // rolled back explicitly rather than merely never having been set a
        // second time: `setExitCode` above may already have run before the
        // throw (rendering the stderr line itself is what can throw), and a
        // half-signalled deny — exit 2 with no verdict actually reported —
        // is worse than the collision this command exists to catch.
        if (deniedExitSet) context.setExitCode(EXIT.ok);

        // Reported through the same warnings channel every other non-fatal
        // finding uses (`--json` merges it into the document; text mode
        // writes a `warning:` line) rather than a bare stderr write with
        // nothing on stdout — an empty stdout under `--json` is itself a
        // contract break (`feature.test.ts`'s whole-command JSON sweep).
        // Deliberately not silenced (ADR-019): the warning still reaches the
        // caller, one line, sanitized — an unattended `|| true` wrapper is
        // exactly what this exists without, so a real failure stays visible
        // even though it never blocks.
        const allow: GuardResult = { verdict: "allow" };
        emit(
          allow,
          { json, warnings: [failedOpenWarning(error)], streams: context.streams },
          (value) => formatGuard(value, now),
        );
      }
    });
}
