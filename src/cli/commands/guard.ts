/**
 * `katra guard` — the before-edit takeover check (F11 T2, ADR-019).
 *
 * The CLI wrapper around {@link guardCheck}'s pure verdict. Its whole job is
 * translating that verdict into a process outcome a hook can act on, and
 * doing so **fail-open**: only a successfully-read live takeover may ever
 * deny. Everything else — no store, a locked or corrupt database, an
 * in-handler usage refusal (a malformed `--liveness`), any other exception —
 * is caught right here and reported as allow, never propagated to the CLI's
 * ordinary `emitError` path (which would map most of those to a nonzero exit
 * a foreign agent might treat as a block).
 *
 * **Deny exits 2** — a deliberate, documented divergence from ADR-006 (`next`
 * answers a legitimate negative with exit 0, payload-only). Claude Code's
 * PreToolUse hook has exactly one signal that blocks a tool call
 * unconditionally, in every permission mode: exit 2, with stderr fed back to
 * the agent as the blocking reason. That is the whole justification — one
 * agent-agnostic signal needing no per-agent stdout shaping and no dependency
 * on the agent parsing katra's own output — not that the alternative (a JSON
 * `permissionDecision` on stdout) is somehow weaker or overridable. See
 * ADR-019's amendment for the full reasoning and its one known limit:
 * commander's own usage-error path also exits 2, for a genuinely malformed
 * invocation that never reaches this handler at all to be caught.
 */

import type { Command } from "commander";
import type { GuardOptions } from "../../core/claims/guard.js";
import { guardCheck } from "../../core/claims/guard.js";
import { describeLiveness } from "../../core/claims/repo.js";
import { nowIso } from "../../core/clock.js";
import type { ClaimInfo, GuardResult } from "../../core/contract.js";
import { narrowWhen } from "../../core/narrow.js";
import { oneLine } from "../format.js";
import { EXIT, emit } from "../output.js";
import type { CliContext } from "../program.js";
import type { StoreOutcome } from "../with-store.js";
import { withStore } from "../with-store.js";

export type { GuardResult };

/**
 * Deny's exit code. Shares commander's own usage code by protocol necessity,
 * not by accident: exit 2 is the only signal Claude Code's PreToolUse hook
 * treats as an unconditional block, so it is the only value that could ever
 * carry a deny — see this module's own docs and ADR-019's amendment for the
 * full reasoning and the known limit the sharing creates.
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
 * conflict message follows (`claims/repo.ts`). Every stored field this
 * interpolates (`actor`) goes through {@link oneLine}: it is fed straight
 * into agent context, on stderr, and nothing constrains what a stored actor
 * string contains (the hostile-stored-actor regression shape this mirrors is
 * `test/cli/claim.test.ts`'s).
 */
function denyReason(result: DenyResult, now: string): string {
  return (
    `${result.taskId} is held by ${oneLine(result.actor)}, ${describeLiveness(denyClaim(result), now)} — ` +
    `claim other work (katra next) or take it back: katra release --force ${result.taskId}`
  );
}

/** Text and `--json` mirror each other exactly (spec criterion 1): this is the text half. */
function formatGuard(result: GuardResult, now: string): string {
  return result.verdict === "allow" ? "allow" : `deny — ${denyReason(result, now)}`;
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

      let outcome: StoreOutcome<GuardResult>;
      try {
        const guardOptions: GuardOptions =
          options.liveness === undefined
            ? {}
            : { livenessFloor: narrowWhen(options.liveness, "--liveness", now) };

        outcome = withStore(context, (store) => guardCheck(store, guardOptions));
      } catch (error) {
        // Fail-open by construction: no store (init never ran), a locked or
        // corrupt database, this handler's own usage refusal (a malformed
        // --liveness), or any other exception all read the same way to a
        // blocking hook — allow, never deny. Deliberately not silenced
        // (ADR-019): the warning still reaches stderr, one line, sanitized —
        // an unattended `|| true` wrapper is exactly what this exists
        // without, so a real failure stays visible even though it never
        // blocks.
        const message = error instanceof Error ? error.message : String(error);
        context.streams.err(`katra: guard: ${oneLine(message)} — allowing\n`);
        return;
      }

      const { result, warnings } = outcome;

      if (result.verdict === "deny") {
        context.streams.err(`katra: ${denyReason(result, now)}\n`);
        context.setExitCode(GUARD_DENY_EXIT);
      }

      emit(result, { json, warnings, streams: context.streams }, (value) =>
        formatGuard(value, now),
      );
    });
}
