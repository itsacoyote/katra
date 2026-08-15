/**
 * `katra ref add` and `katra ref remove` — attach or remove an external
 * reference (a GitHub PR/issue, a Linear issue, or any other provider through
 * the explicit escape hatch) on a task.
 *
 * **Real Commander subcommands**, not two flat commands named with a space —
 * `note.ts`'s module docs record why: against commander 15,
 * `program.command("ref add")` would register a command named `"ref"` with a
 * positional argument `"add"`, and a sibling `.command("ref remove")` beside
 * it throws `cannot add command 'ref' as already have command 'ref'`.
 * `createProgram()` runs on every invocation, so that would not merely break
 * `ref` — every katra command would exit 4.
 */

import type { Command } from "commander";
import type { RefResult } from "../../core/contract.js";
import { KatraException } from "../../core/errors.js";
import { parseRefInput, validateExplicitRef } from "../../core/refs/parse.js";
import type { RefInput } from "../../core/refs/repo.js";
import { linkRef, unlinkRef } from "../../core/refs/repo.js";
import { formatRefResult } from "../format.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStore } from "../with-store.js";

interface AddOptions {
  readonly provider?: string;
  readonly id?: string;
  readonly url?: string;
  readonly json?: boolean;
}

/**
 * What every `ref add` usage refusal below names — the identical flag shape
 * `parseRefInput`/`validateExplicitRef` themselves point to (ADR-014), so a
 * caller sees one spelling of the escape hatch no matter which refusal path
 * produced it.
 */
const EXPLICIT_FLAGS = "--provider <name> --id <id> [--url <url>]";

/**
 * Turns `ref add`'s arguments into the `{provider, externalId, url}` triple
 * `linkRef` stores.
 *
 * Two mutually exclusive forms (spec req 3): the positional `ref`, recognized
 * by `parseRefInput` (a GitHub/Linear URL or bare id), or the
 * `--provider/--id/--url` escape hatch, validated by `validateExplicitRef`.
 * Giving both is refused rather than silently preferring one — a caller who
 * pastes a recognized URL *and* passes `--provider` almost certainly meant one
 * or the other, and guessing which would be a worse failure than asking.
 * Giving neither is refused the same way, naming both forms.
 */
function resolveRefInput(ref: string | undefined, options: AddOptions): RefInput {
  const explicitGiven =
    options.provider !== undefined || options.id !== undefined || options.url !== undefined;

  if (ref !== undefined && explicitGiven) {
    throw new KatraException({
      code: "usage",
      message: `ref add takes a url/id or ${EXPLICIT_FLAGS}, not both`,
    });
  }

  if (ref === undefined && !explicitGiven) {
    throw new KatraException({
      code: "usage",
      message: `ref add needs a url or id, or ${EXPLICIT_FLAGS}`,
    });
  }

  if (ref !== undefined) {
    const parsed = parseRefInput(ref);
    if (!parsed.recognized) {
      throw new KatraException({
        code: "validation",
        message: parsed.message,
        field: "ref",
        value: ref,
      });
    }
    return parsed.ref;
  }

  // Missing flags read as empty strings here, not as a TypeScript-only gap:
  // `validateExplicitRef`'s own runtime guards refuse a missing `provider` or
  // `id` with a message naming which one, rather than this function
  // duplicating that check.
  const validated = validateExplicitRef({
    provider: options.provider ?? "",
    id: options.id ?? "",
    url: options.url ?? null,
  });
  if (!validated.valid) {
    throw new KatraException({
      code: "validation",
      message: validated.message,
      field: "ref",
      value: { provider: options.provider, id: options.id, url: options.url },
    });
  }
  return validated.ref;
}

export function registerRef(program: Command, context: CliContext): void {
  const ref = program
    .command("ref")
    .description("attach or remove an external reference (GitHub, Linear, ...) on a task");

  ref
    .command("add")
    .argument("<task-id>", "the task to attach it to; accepts a partial id")
    .argument(
      "[ref]",
      "a github.com/linear.app URL, owner/repo#n, or TEAM-123; omit with --provider",
    )
    .description("link a GitHub or Linear reference, or any provider via --provider/--id/--url")
    .option("--provider <name>", "store an arbitrary provider explicitly, bypassing recognition")
    .option("--id <id>", "the external id, with --provider")
    .option("--url <url>", "an absolute http(s) URL, with --provider")
    .option("--json", "emit structured output")
    .action((taskId: string, refArg: string | undefined, options: AddOptions) => {
      const input = resolveRefInput(refArg, options);

      const { result, warnings } = withStore(context, (store) => linkRef(store, taskId, input));

      // Annotated, so the shape the CLI prints and the type the package
      // publishes cannot drift apart without a compile error.
      const document: RefResult = result;
      emit(
        document,
        { json: options.json === true, warnings, streams: context.streams },
        formatRefResult,
      );
    });

  ref
    .command("remove")
    .argument("<task-id>", "the task to remove it from; accepts a partial id")
    .argument(
      "<ref>",
      "the url or the qualified id (owner/repo#12, ENG-451) of a ref linked to this task",
    )
    .description("remove an external reference from a task")
    .option("--json", "emit structured output")
    .action((taskId: string, refArg: string, options: { json?: boolean }) => {
      // `refArg` goes straight to `unlinkRef` — never through `resolveId`/
      // `requireId`. Those range-scan `tasks`, the wrong table entirely for a
      // ref's url-or-qualified-id (risk note 17); `unlinkRef` resolves it
      // task-scoped against this task's own linked refs instead.
      const { result, warnings } = withStore(context, (store) => unlinkRef(store, taskId, refArg));

      const document: RefResult = result;
      emit(
        document,
        { json: options.json === true, warnings, streams: context.streams },
        formatRefResult,
      );
    });
}
