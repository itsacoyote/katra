/**
 * beads → katra: load — the one-transaction historical write (F5, T6,
 * `katra-9aw.49.6`).
 *
 * `loadMigration` is the third and final pipeline stage: `extract.ts` (T3)
 * and `transform.ts` (T5) have already turned untrusted JSONL into a fully
 * classified {@link MigrationPlan} — every item, note, edge and event this
 * function writes is a decision `transform.ts` already made. This module's
 * only remaining jobs are (1) refuse a non-empty store and (2) drive T1's
 * `*Within` seams, in the right order, with the plan's historical times,
 * inside one transaction.
 *
 * **The non-empty-store refusal is the only refusal this function performs.**
 * Epic requirement 9 (as amended): transform pre-classifies everything else a
 * write path could reject — cycles, empty titles, blank note bodies,
 * out-of-range values — so a plan `transform.ts` produced is guaranteed
 * write-clean. Anything else this function throws (see the internal-only
 * guards below) signals a plan that is *not* what `transform.ts` promises —
 * a transform bug, not a load-time report item — which is exactly why those
 * guards use `internal`, the same code {@link applyMoveWithin} uses for an
 * incoherent `Move` from a direct caller.
 *
 * **Row order:** epics before tasks — `tasks_parent_must_be_epic_insert`
 * requires a parent to already exist, and `plan.items` is not itself sorted
 * that way (`transform.ts` emits it in accepted-issue/input order). **Closed
 * items are created into `Defined`, then moved to their terminal lane through
 * {@link applyMoveWithin}** — never straight into a terminal lane, which
 * `createTaskWithin`'s own guard refuses, and never a post-hoc raw `UPDATE`.
 * **Events are appended last, in one pass, in exactly `plan.events`' order**
 * — deliberately not row-insertion order, so `events.id` (katra's real total
 * order) reads as true chronological history once every row already exists.
 *
 * The old-id → new-id map (and the parallel plan-local-note-id → new-id map)
 * are both `Map`s, never plain objects, for the same reason `transform.ts`
 * keeps every old-id-keyed structure a `Map`: beads ids are attacker content
 * (`--from` accepts an arbitrary export), and a plain object keyed by
 * untrusted input resolves `"__proto__"` through `Object.prototype` instead
 * of storing it.
 */

import type { Identity } from "../actor.js";
import { actorFromIdentity } from "../actor.js";
import { writeTx } from "../db/connection.js";
import type { Level } from "../enums.js";
import { isTerminal, KINDS, LANES, LEVELS } from "../enums.js";
import { KatraException } from "../errors.js";
import { appendEvent, epicIdFor } from "../events/repo.js";
import { addDependencyWithin } from "../graph/deps.js";
import { addLinkWithin } from "../graph/links.js";
import { createNoteWithin } from "../notes/repo.js";
import type { OpenStore } from "../store.js";
import type { Move } from "../tasks/lifecycle.js";
import { applyMoveWithin } from "../tasks/lifecycle.js";
import { createTaskWithin } from "../tasks/repo.js";
import type { ImportedCounts, MigrationIdMapEntry, MigrationPlan, PlannedItem } from "./types.js";

/** What `loadMigration` hands back once its transaction commits. */
export interface LoadResult {
  /** Rows actually written, grouped the same three ways {@link MigrationReport.imported} is. */
  readonly counts: ImportedCounts;
  /**
   * Every planned item, in `plan.items`' own order, each now carrying the
   * minted id it was written under — the same shape a preview's `idMap`
   * uses with every `newId: null`, so a caller can build the post-apply
   * {@link MigrationReport} by filling in this one field.
   */
  readonly idMap: readonly MigrationIdMapEntry[];
}

/**
 * Looks up a value a plan referenced by an old-id-shaped key, or throws.
 *
 * Every call site here is a guard against a plan `transform.ts` did not
 * actually produce — every real key `transform.ts` writes into a
 * `PlannedEdge`/`PlannedNote`/`PlannedEvent` is one its own accompanying
 * `PlannedItem`/`PlannedNote` supplied, so a miss here means the plan handed
 * to `loadMigration` is internally inconsistent. That is a transform bug, not
 * one of the write-path conditions transform pre-classifies, so it is
 * reported the same way `applyMoveWithin` reports an incoherent `Move`:
 * `internal`, not a refusal.
 */
function requireMapped<V>(map: ReadonlyMap<string, V>, key: string, what: string): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new KatraException({
      code: "internal",
      message:
        `beads migration: no migrated ${what} for beads id "${key}" — the plan referenced ` +
        "something that was never created. This is a transform bug, not a load-time refusal.",
    });
  }
  return value;
}

/** A fully-keyed, zero-initialized `Record` — mirrors `transform.ts`'s own `zeroCounts`. */
function zeroCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  const result = {} as Record<K, number>;
  for (const key of keys) result[key] = 0;
  return result;
}

/**
 * Counts what was actually written, grouped by level/kind/lane.
 *
 * Computed from `plan.items` after every row has committed, not carried over
 * from `transform.ts`'s own report — the two are numerically identical today
 * because a committed load writes every planned item or none, but they answer
 * different questions ("what would be written" vs "what was written"), and
 * only this function's answer is honest to call the load's.
 */
function computeImportedCounts(items: readonly PlannedItem[]): ImportedCounts {
  const byLevel = zeroCounts(LEVELS);
  const byKind = zeroCounts(KINDS);
  const byLane = zeroCounts(LANES);

  for (const item of items) {
    byLevel[item.level] += 1;
    byKind[item.kind] += 1;
    byLane[item.lane] += 1;
  }

  return { byLevel, byKind, byLane };
}

/** Just enough about an already-created item to compute its `created`/`closed`/`note-added` events' `epicId`. */
interface ItemMeta {
  readonly level: Level;
  readonly parentId: string | null;
}

/**
 * Writes a planned migration into `store` — the whole of `katra migrate
 * beads --apply`'s effect on the database, in one `BEGIN IMMEDIATE`
 * transaction.
 *
 * `identity` is the migrating identity, per epic requirement 8's actor
 * policy: `created`/`closed` events stamp *who ran the migration* — the
 * honest answer, since nobody in this repository witnessed the original
 * beads history — while a migrated note's actor is the note's own beads
 * author (or the migrating identity, when `transform.ts` already fell back),
 * carried on {@link PlannedNote.actor} and passed straight through. Resolved
 * to an actor string once, before the transaction opens, matching every
 * other write path in this codebase (`createTask`, `transition`): resolving
 * a git subprocess inside `BEGIN IMMEDIATE` would hold the exclusive write
 * lock across the spawn.
 *
 * A thrown error anywhere — the refusal, an internal-consistency guard, or a
 * `*Within` seam's own validation — rolls back everything `writeTx` has
 * written so far in this call, `writeTx`'s existing all-or-nothing contract.
 * Nothing here opens a second transaction or commits early.
 */
export function loadMigration(
  store: OpenStore,
  plan: MigrationPlan,
  identity: Identity,
): LoadResult {
  const actor = actorFromIdentity(identity);

  return writeTx(store.db, () => {
    // ---------------------------------------------------------------------
    // (1) Refusal, first, before any write. Scoped to `tasks` alone — never
    // a broader "is this store empty" definition. `openStore` bumps presence
    // on every open, so a check that looked at any other table would refuse
    // its own preview run.
    // ---------------------------------------------------------------------
    const hasExistingTask = store.db.prepare("SELECT 1 FROM tasks LIMIT 1").get() !== undefined;
    if (hasExistingTask) {
      throw new KatraException({
        code: "conflict",
        message:
          "this store already has tasks — `katra migrate beads --apply` only loads into an " +
          "empty store, to keep the migration one-shot and avoid a duplicated backlog. Run it " +
          "against a fresh `katra init`, or migrate into a disposable store.",
        reason: "store already contains tasks",
      });
    }

    // ---------------------------------------------------------------------
    // (2) Rows: epics before tasks, so every parent pre-exists by the time a
    // child references it. `plan.items` is otherwise left in its own order —
    // stable partitioning keeps that order within each group.
    // ---------------------------------------------------------------------
    const idMap = new Map<string, string>();
    const itemMeta = new Map<string, ItemMeta>();

    const epics = plan.items.filter((item) => item.level === "epic");
    const nonEpics = plan.items.filter((item) => item.level !== "epic");

    for (const item of [...epics, ...nonEpics]) {
      const parentId =
        item.parentOldId === null ? null : requireMapped(idMap, item.parentOldId, "parent item");
      const closed = isTerminal(item.lane);

      // Closed items are created into `Defined` and reach their real lane
      // only through `applyMoveWithin`, below — `createTaskWithin`'s own
      // terminal-lane guard (repo.ts:181-190) refuses a direct creation into
      // `Done`/`Cancelled`, and that guard staying intact is the point: a
      // migrated task's honest history is "created, then closed", never
      // "always was".
      const newId = createTaskWithin(
        store,
        {
          title: item.title,
          level: item.level,
          kind: item.kind,
          description: item.description,
          lane: closed ? "Defined" : item.lane,
          priority: item.priority,
          assignee: item.assignee,
          parentId,
          tags: item.tags,
        },
        // An open item's own, possibly-later-than-created `updated_at`
        // travels straight through here. A closed item's pre-move
        // `updated_at` is thrown away the moment `applyMoveWithin` runs
        // below, so there is nothing worth passing for it — leaving it
        // unset here just means it starts equal to `createdAt`, exactly
        // like every other seam's default.
        closed
          ? { createdAt: item.createdAt }
          : { createdAt: item.createdAt, updatedAt: item.updatedAt },
      );

      idMap.set(item.oldId, newId);
      itemMeta.set(item.oldId, { level: item.level, parentId });

      if (closed) {
        if (item.closedAt === null) {
          throw new KatraException({
            code: "internal",
            message:
              `beads migration: item "${item.oldId}" is in terminal lane "${item.lane}" but has ` +
              "no closedAt — the plan is internally inconsistent.",
          });
        }

        const move: Move = {
          lane: item.lane,
          markClosed: true,
          reason: item.closeReason,
          event: "closed",
        };
        applyMoveWithin(store, newId, move, { at: item.closedAt, updatedAt: item.updatedAt });
      }
    }

    // ---------------------------------------------------------------------
    // (3) Notes, deps, links — every row keeps its own historical time.
    // Links canonicalize their endpoints internally (`addLinkWithin` →
    // `resolvePair` → `canonical`, `graph/links.ts`), so the post-remap `a <
    // b` ordering the `links` table's `CHECK` requires needs no help here.
    // ---------------------------------------------------------------------
    const noteIdMap = new Map<string, string>();
    for (const note of plan.notes) {
      const taskId = requireMapped(idMap, note.itemOldId, "note target");
      const newNoteId = createNoteWithin(
        store,
        { taskId, body: note.body, kind: note.kind },
        { actor: note.actor, createdAt: note.createdAt },
      );
      noteIdMap.set(note.id, newNoteId);
    }

    for (const edge of plan.edges) {
      if (edge.kind === "dependency") {
        const taskId = requireMapped(idMap, edge.taskOldId, "dependency task");
        const dependsOnId = requireMapped(idMap, edge.dependsOnOldId, "dependency target");
        addDependencyWithin(store, taskId, dependsOnId, { createdAt: edge.createdAt });
      } else {
        const a = requireMapped(idMap, edge.aOldId, "link endpoint");
        const b = requireMapped(idMap, edge.bOldId, "link endpoint");
        addLinkWithin(store, a, b, { createdAt: edge.createdAt });
      }
    }

    // ---------------------------------------------------------------------
    // (4) Events, last, in one pass, in exactly `plan.events`'s own
    // chronological order — `transform.ts` already sorted it by `(at,
    // itemOldId, type)`. Row-insertion order above (epics-first) and this
    // order are deliberately different; `events.id` must reflect this one.
    // ---------------------------------------------------------------------
    for (const event of plan.events) {
      const entityId = requireMapped(idMap, event.itemOldId, "event entity");
      const meta = requireMapped(itemMeta, event.itemOldId, "event entity metadata");
      const epicId = epicIdFor({ id: entityId, level: meta.level, parentId: meta.parentId });

      switch (event.type) {
        case "created":
          appendEvent(
            store,
            { type: "created", entityId, epicId, actor, title: event.title },
            event.at,
          );
          break;
        case "closed":
          appendEvent(
            store,
            { type: "closed", entityId, epicId, actor, reason: event.reason },
            event.at,
          );
          break;
        case "note-added": {
          const ref = requireMapped(noteIdMap, event.noteRef, "note reference");
          appendEvent(
            store,
            { type: "note-added", entityId, epicId, actor: event.actor, ref },
            event.at,
          );
          break;
        }
      }
    }

    // ---------------------------------------------------------------------
    // (5) Counts + id map. Built from `plan.items`, in its own order, so a
    // preview's `idMap` (every `newId: null`) and this one differ in exactly
    // one field per row.
    // ---------------------------------------------------------------------
    const idMapEntries: MigrationIdMapEntry[] = plan.items.map((item) => ({
      oldId: item.oldId,
      newId: idMap.get(item.oldId) ?? null,
    }));

    return { counts: computeImportedCounts(plan.items), idMap: idMapEntries };
  });
}
