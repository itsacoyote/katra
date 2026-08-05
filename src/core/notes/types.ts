/**
 * The shapes typed notes store and hand back.
 *
 * Like `tasks/types.ts`, these **are** the `--json` contract: output is
 * `JSON.stringify` of the value a command returns. Field names are camelCase
 * here and snake_case in SQL; `repo.ts` is the single place that boundary is
 * crossed.
 */

import type { NoteKind } from "../enums.js";

/** A note, as stored. */
export interface Note {
  /** An `nt-` id, from the same machinery task ids use. */
  readonly id: string;
  readonly taskId: string;
  readonly kind: NoteKind;
  /**
   * The note itself.
   *
   * Never empty: a note without a body is not a note. Unlike a task's
   * description, this is the content rather than an optional elaboration, so
   * the emptiness check is a refusal rather than a shrug — and the schema
   * enforces it too, since `NOT NULL` alone accepts the empty string.
   */
  readonly body: string;
  readonly actor: string;
  readonly createdAt: string;
}

/** What `note add` accepts. */
export interface NewNote {
  readonly taskId: string;
  readonly body: string;
  readonly kind?: NoteKind;
}

/** The filters `note list` accepts. */
export interface NoteFilters {
  /** Notes on one task. Omit for every note in the store. */
  readonly taskId?: string;
  readonly kind?: NoteKind;
  /** Most recent this many. */
  readonly limit?: number;
}
