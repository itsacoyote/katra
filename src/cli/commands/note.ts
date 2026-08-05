/**
 * `katra note add` and `katra note list`.
 *
 * **Real Commander subcommands**, not two flat commands named with a space.
 * The plan proposed `program.command("note add")` and two research lenses
 * endorsed it; neither ran it. Against commander 15:
 *
 * ```
 * .command("note add")  ->  a command named "note" with a positional arg "add"
 * .command("note list") ->  throws: cannot add command 'note' as already have
 *                           command 'note'
 * ```
 *
 * `createProgram()` runs on every invocation, so that would not merely have
 * broken `note` — it would have made every katra command exit 4.
 *
 * The reason the flat form was proposed was real, though: `valueTakingFlags`
 * used to read options from one command level, and `--kind`/`--body-file` live
 * on the child. That is fixed at the source — it now descends the tree — so
 * subcommands cost nothing here.
 */

import type { Command } from "commander";
import type { NoteList } from "../../core/contract.js";
import { narrowCount, narrowNoteKind } from "../../core/narrow.js";
import { createNote, listNotes } from "../../core/notes/repo.js";
import { requireId } from "../../core/tasks/ids.js";
import { readBody } from "../body.js";
import { formatNote, formatNoteList } from "../format.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStore } from "../with-store.js";

interface AddOptions {
  readonly kind?: string;
  readonly bodyFile?: string;
  readonly json?: boolean;
}

interface ListOptions {
  readonly kind?: string;
  readonly limit?: string;
  readonly json?: boolean;
}

export function registerNote(program: Command, context: CliContext): void {
  const note = program.command("note").description("attach and read typed notes on a task");

  note
    .command("add")
    .argument("<id>", "the task to attach it to; accepts a partial id")
    .description("attach a note to a task")
    .option("--kind <kind>", "general, handoff, decision or acceptance (default: general)")
    // No inline body argument, deliberately. A note is prose: it holds quotes,
    // backticks, newlines and whatever a shell would otherwise mangle, which
    // is exactly what `readBody` exists for.
    .option("--body-file <path>", 'read the note from a file, or "-" for stdin')
    .option("--json", "emit structured output")
    .action((id: string, options: AddOptions) => {
      const body = readBody({
        bodyFile: options.bodyFile,
        cwd: context.cwd,
        readStdin: context.readStdin,
      });

      const { result, warnings } = withStore(context, (store) =>
        createNote(store, {
          taskId: id,
          // `readBody` returns undefined for a missing flag *and* for a blank
          // file. Both are the same mistake here — a note with no content —
          // and the core refuses them with one message naming why a note
          // differs from a task's optional description.
          body: body ?? "",
          ...(options.kind === undefined ? {} : { kind: narrowNoteKind(options.kind) }),
        }),
      );

      emit(result, { json: options.json === true, warnings, streams: context.streams }, formatNote);
    });

  note
    .command("list")
    // Optional, like `log`: with an id it is that task's notes, without one it
    // is every note in the store.
    .argument("[id]", "a task, or omit for every note; accepts a partial id")
    .description("read notes, newest first")
    .option("--kind <kind>", "only notes of this kind")
    .option("--limit <n>", "return at most this many")
    .option("--json", "emit structured output")
    .action((id: string | undefined, options: ListOptions) => {
      const kind = options.kind === undefined ? undefined : narrowNoteKind(options.kind);
      const limit = options.limit === undefined ? undefined : narrowCount(options.limit, "limit");

      const { result, warnings } = withStore(context, (store) =>
        listNotes(store, {
          // requireId, not the raw string: `note list 9f3` should work, and an
          // id matching nothing should say so rather than returning an empty
          // list that reads as "this task has no notes".
          ...(id === undefined ? {} : { taskId: requireId(store, id) }),
          ...(kind === undefined ? {} : { kind }),
          ...(limit === undefined ? {} : { limit }),
        }),
      );

      const document: NoteList = { notes: result };
      emit(document, { json: options.json === true, warnings, streams: context.streams }, (value) =>
        formatNoteList(value.notes),
      );
    });
}
