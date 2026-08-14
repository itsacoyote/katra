/**
 * `katra search` — full-text over task titles, descriptions and note bodies,
 * plus structured filters, usable with or without query text (spec §6c).
 */

import type { Command } from "commander";
import { nowIso } from "../../core/clock.js";
import type { SearchResult } from "../../core/contract.js";
import { KatraException } from "../../core/errors.js";
import { narrowCount, narrowKind, narrowLane, narrowLevel, narrowWhen } from "../../core/narrow.js";
import type { SearchOptions } from "../../core/search.js";
import { readSearch } from "../../core/search.js";
import { formatSearch } from "../format.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStore } from "../with-store.js";

interface SearchCliOptions {
  readonly lane?: string;
  readonly kind?: string;
  readonly level?: string;
  readonly epic?: string;
  readonly tag?: string;
  readonly updatedBefore?: string;
  readonly updatedAfter?: string;
  readonly limit?: string;
  readonly json?: boolean;
}

export function registerSearch(program: Command, context: CliContext): void {
  program
    .command("search")
    .argument("[query]", "text to search for; omit to filter only")
    .description("full-text over titles, descriptions and notes, with structured filters")
    .option("--lane <lane>", "only tasks in this lane")
    .option("--kind <kind>", "only tasks of this kind")
    .option("--level <level>", "epic or task")
    .option("--epic <id>", "only children of this epic; accepts a partial id")
    .option("--tag <tag>", "only tasks carrying this tag")
    .option("--updated-before <when>", "only activity before this; 2w, 3d, 12h, 30m or ISO")
    .option("--updated-after <when>", "only activity after this; 2w, 3d, 12h, 30m or ISO")
    .option("--limit <n>", "return at most this many, best match first")
    .option("--json", "emit structured output")
    .action((query: string | undefined, options: SearchCliOptions) => {
      // One `now` for the whole invocation: both time flags resolve against
      // the same instant, so `--updated-before 1h --updated-after 2h` reads
      // as one coherent window rather than two clock reads a few
      // milliseconds apart.
      const now = nowIso();

      // The one usage refusal this command has: no query text and no filter
      // at all. A punctuation-only or emoji-only query still counts as query
      // text here — it is present, non-blank, and reaches readSearch, which
      // routes it through matchExpression and returns a legitimate (likely
      // empty) result rather than a refusal (spec AC 5). Blank is checked the
      // same way matchExpression itself decides "nothing to search on": no
      // token survives a whitespace split.
      const hasQuery = query !== undefined && query.trim() !== "";
      const hasFilters =
        options.lane !== undefined ||
        options.kind !== undefined ||
        options.level !== undefined ||
        options.epic !== undefined ||
        options.tag !== undefined ||
        options.updatedBefore !== undefined ||
        options.updatedAfter !== undefined;

      if (!hasQuery && !hasFilters) {
        throw new KatraException({
          code: "usage",
          message:
            "search needs query text or at least one filter — pass a query, or one of " +
            "--lane/--kind/--level/--epic/--tag/--updated-before/--updated-after",
        });
      }

      // Narrowed at the boundary, so a bad --lane names the lanes rather than
      // silently matching nothing (list.ts's precedent). `epic` is passed
      // through raw — readSearch resolves it via requireEpicId itself, since
      // it already holds the store the resolution needs.
      const base: SearchOptions = {
        ...(query === undefined ? {} : { query }),
        ...(options.lane === undefined ? {} : { lane: narrowLane(options.lane) }),
        ...(options.kind === undefined ? {} : { kind: narrowKind(options.kind) }),
        ...(options.level === undefined ? {} : { level: narrowLevel(options.level) }),
        ...(options.epic === undefined ? {} : { epic: options.epic }),
        ...(options.tag === undefined ? {} : { tag: options.tag }),
        ...(options.updatedBefore === undefined
          ? {}
          : { updatedBefore: narrowWhen(options.updatedBefore, "--updated-before", now) }),
        ...(options.updatedAfter === undefined
          ? {}
          : { updatedAfter: narrowWhen(options.updatedAfter, "--updated-after", now) }),
        ...(options.limit === undefined ? {} : { limit: narrowCount(options.limit, "limit") }),
      };

      const { result, warnings } = withStore(context, (store) => readSearch(store, base));

      // Annotated, so the shape the CLI prints and the type the package
      // publishes cannot drift apart without a compile error (board.ts's
      // precedent).
      const document: SearchResult = result;
      emit(
        document,
        { json: options.json === true, warnings, streams: context.streams },
        formatSearch,
      );
    });
}
