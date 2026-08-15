import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, writeTx } from "../../src/core/db/connection.js";
import {
  appendEvent,
  DEFAULT_EVENT_LIMIT,
  epicIdFor,
  listEvents,
  rowToEvent,
} from "../../src/core/events/repo.js";
import { runConcurrent } from "../helpers/concurrent.js";
import { seedEpic, seedTask } from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture } from "../helpers/store.js";

let fixture: StoreFixture;
beforeEach(() => {
  fixture = createStoreFixture();
});
afterEach(() => fixture.cleanup());

const ACTOR = "feature/probe @ /repo/wt";

const countEvents = (): number =>
  (fixture.store.db.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }).c;

const readEvent = (id: number): Record<string, unknown> =>
  fixture.store.db.prepare("SELECT * FROM events WHERE id = ?").get(id) as Record<string, unknown>;

describe("appendEvent", () => {
  it("appends one event inside the caller's transaction", () => {
    const task = seedTask(fixture.store, { title: "a task" });

    const { id, now } = writeTx(fixture.store.db, (stamp) => ({
      id: appendEvent(
        fixture.store,
        { type: "created", entityId: task, actor: ACTOR, title: "a task" },
        stamp,
      ),
      now: stamp,
    }));

    expect(countEvents()).toBe(1);
    expect(readEvent(id)).toMatchObject({
      type: "created",
      entity_id: task,
      actor: ACTOR,
      title: "a task",
      created_at: now,
    });
  });

  it("shares the transaction's timestamp rather than reading its own clock", () => {
    // One `now` per transaction is what keeps a task and the event describing
    // it from disagreeing about when they happened by a millisecond.
    const task = seedTask(fixture.store);

    const now = writeTx(fixture.store.db, (stamp) => {
      appendEvent(fixture.store, { type: "created", entityId: task, actor: ACTOR }, stamp);
      appendEvent(fixture.store, { type: "closed", entityId: task, actor: ACTOR }, stamp);
      return stamp;
    });

    const stamps = fixture.store.db
      .prepare("SELECT DISTINCT created_at FROM events")
      .all() as Array<{ created_at: string }>;
    expect(stamps).toEqual([{ created_at: now }]);
  });

  it("leaves no event when the surrounding transaction rolls back", () => {
    // The spec requires the entity change and its event to be atomic. Opening
    // a transaction inside appendEvent would commit the event independently,
    // leaving history describing something that never happened.
    const task = seedTask(fixture.store);

    expect(() =>
      writeTx(fixture.store.db, (stamp) => {
        appendEvent(fixture.store, { type: "created", entityId: task, actor: ACTOR }, stamp);
        throw new Error("abort");
      }),
    ).toThrowError("abort");

    expect(countEvents()).toBe(0);
  });

  it("refuses to append outside a transaction at all", () => {
    // The contract made enforceable. Wrapping the append in its own
    // transaction would NOT be caught by the rollback test above —
    // better-sqlite3 turns a nested transaction into a SAVEPOINT, which rolls
    // back with the outer one and leaves the suite green. This catches the
    // failure that actually matters: an append with nothing around it, which
    // autocommits and can outlive the change it describes.
    const task = seedTask(fixture.store);

    expect(() =>
      appendEvent(fixture.store, { type: "created", entityId: task, actor: ACTOR }, "2026-01-01"),
    ).toThrowError(/must be called inside an open transaction/);
    expect(countEvents()).toBe(0);
  });

  it("returns strictly increasing ids within a transaction", () => {
    const task = seedTask(fixture.store);

    const ids = writeTx(fixture.store.db, (stamp) => [
      appendEvent(fixture.store, { type: "created", entityId: task, actor: ACTOR }, stamp),
      appendEvent(fixture.store, { type: "status-changed", entityId: task, actor: ACTOR }, stamp),
      appendEvent(fixture.store, { type: "closed", entityId: task, actor: ACTOR }, stamp),
    ]);

    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(3);
  });

  it("writes null into every column the event type does not use", () => {
    // A `created` event has no lanes, no ref and no reason. Writing empty
    // strings instead would make "unset" and "set to nothing" the same value.
    const task = seedTask(fixture.store);

    const id = writeTx(fixture.store.db, (stamp) =>
      appendEvent(fixture.store, { type: "created", entityId: task, actor: ACTOR }, stamp),
    );

    expect(readEvent(id)).toMatchObject({
      epic_id: null,
      from_lane: null,
      to_lane: null,
      ref: null,
      reason: null,
      title: null,
    });
  });

  it("records a lane transition with both ends", () => {
    const task = seedTask(fixture.store);

    const id = writeTx(fixture.store.db, (stamp) =>
      appendEvent(
        fixture.store,
        {
          type: "status-changed",
          entityId: task,
          actor: ACTOR,
          fromLane: "Defined",
          toLane: "In Progress",
        },
        stamp,
      ),
    );

    expect(readEvent(id)).toMatchObject({ from_lane: "Defined", to_lane: "In Progress" });
  });

  it("records the prior actor a forced release displaces", () => {
    // Nothing calls appendEvent with a non-null priorActor yet — release
    // --force lands in T4 — so the `?? null` default at the tail of the bind
    // list could silently swallow a real value with nothing to catch it.
    // Round-tripping through listEvents covers the bind position and the
    // read path in one assertion, not just the write.
    const task = seedTask(fixture.store);

    writeTx(fixture.store.db, (stamp) =>
      appendEvent(
        fixture.store,
        {
          type: "released",
          entityId: task,
          actor: ACTOR,
          priorActor: "feature/x @ /repo/wt-x",
        },
        stamp,
      ),
    );

    expect(listEvents(fixture.store, { entityId: task }).events[0]?.priorActor).toBe(
      "feature/x @ /repo/wt-x",
    );
  });

  it("records an event for an entity that no longer exists", () => {
    // ADR-008: `delete` appends its event as its last act, after the row is
    // gone. A foreign key — or a lookup inside appendEvent — would make the
    // final event of every deleted task impossible to write.
    const task = seedTask(fixture.store, { title: "a typo" });
    fixture.store.db.prepare("DELETE FROM tasks WHERE id = ?").run(task);

    const id = writeTx(fixture.store.db, (stamp) =>
      appendEvent(
        fixture.store,
        { type: "deleted", entityId: task, actor: ACTOR, title: "a typo" },
        stamp,
      ),
    );

    expect(readEvent(id)).toMatchObject({ entity_id: task, title: "a typo" });
  });
});

describe("event ids as a total order", () => {
  it("assigns strictly increasing ids across concurrent writers", { timeout: 60_000 }, async () => {
    // Requirement 7's claim, exercised where it can actually fail: six real
    // processes, six connections, one file. The id must order every event in
    // the store — and with T3's fix, created_at must agree with it, so a
    // reader comparing the two never sees an inversion.
    const dbPath = fixture.store.dbPath;
    const task = seedTask(fixture.store, { title: "contended" });
    fixture.store.close();

    const outcomes = await runConcurrent<{ ok: number }>({
      count: 6,
      source: `
        const { openStore } = await import(${JSON.stringify(
          new URL("../../src/core/store.ts", import.meta.url).href,
        )});
        const { writeTx } = await import(${JSON.stringify(
          new URL("../../src/core/db/connection.ts", import.meta.url).href,
        )});
        const { appendEvent } = await import(${JSON.stringify(
          new URL("../../src/core/events/repo.ts", import.meta.url).href,
        )});
        barrier();
        const { store } = openStore(${JSON.stringify(fixture.repo.dir)});
        let ok = 0;
        for (let i = 0; i < 20; i++) {
          writeTx(store.db, (now) => {
            appendEvent(store, {
              type: "note-added",
              entityId: ${JSON.stringify(task)},
              actor: "p" + INDEX + " @ /repo",
            }, now);
            const until = Date.now() + 2;
            while (Date.now() < until) {}
          });
          ok++;
        }
        store.close();
        report({ ok });
      `,
    });

    // Every process opens the same worktree, so presence's own heartbeat
    // (F4 T3, ADR-011) races on that one row alongside the appendEvent
    // contention this test is deliberately manufacturing. Its own short busy
    // budget can lose that race and warn once — expected, and distinct from
    // an actual failure in the write path this test exists to pin.
    const unexpectedStderr = outcomes
      .map((o) => o.stderr)
      .join("")
      .split("\n")
      .filter((line) => line !== "" && !/KatraPresenceWarning|--trace-warnings/.test(line))
      .join("\n");
    expect(unexpectedStderr).toBe("");
    expect(outcomes.map((o) => o.value?.ok)).toEqual([20, 20, 20, 20, 20, 20]);

    const verify = openDatabase(dbPath);
    const rows = verify.prepare("SELECT id, created_at FROM events ORDER BY id").all() as Array<{
      id: number;
      created_at: string;
    }>;
    verify.close();

    expect(rows).toHaveLength(120);
    expect(rows.map((r) => r.id)).toEqual([...rows.map((r) => r.id)].sort((a, b) => a - b));
    expect(new Set(rows.map((r) => r.id)).size).toBe(120);

    // Id order and time order agree. This is T3's fix observed through the
    // event stream: without it, a writer that queued for the lock commits with
    // a higher id and an earlier stamp.
    const inversions = rows.filter(
      (row, index) => index > 0 && row.created_at < (rows[index - 1]?.created_at ?? ""),
    );
    expect(inversions).toEqual([]);
  });
});

describe("epicIdFor", () => {
  it("stamps a task's parent epic", () => {
    const epic = seedEpic(fixture.store, { title: "an epic" });
    const task = seedTask(fixture.store, { parentId: epic });

    expect(epicIdFor({ id: task, level: "task", parentId: epic })).toBe(epic);
  });

  it("stamps null for a task with no parent", () => {
    // A top-level task genuinely has no epic. This is why the column is
    // nullable — NOT NULL would reject every event for a task created without
    // --parent.
    const task = seedTask(fixture.store);

    expect(epicIdFor({ id: task, level: "task", parentId: null })).toBeNull();
  });

  it("stamps an epic's own id for the epic's own events", () => {
    // The case that looks wrong until you check the schema. An epic's
    // parent_id is always NULL by CHECK, so `epicId = task.parentId` leaves
    // every epic's own events unstamped — and an epic-scoped read written as
    // `WHERE epic_id = ?` then silently excludes the epic's own activity.
    const epic = seedEpic(fixture.store, { title: "an epic" });

    expect(epicIdFor({ id: epic, level: "epic", parentId: null })).toBe(epic);
  });

  it("puts an epic and its children under one epic id", () => {
    // The property the three cases exist to produce, asserted end to end.
    const epic = seedEpic(fixture.store, { title: "an epic" });
    const child = seedTask(fixture.store, { parentId: epic });

    writeTx(fixture.store.db, (stamp) => {
      appendEvent(
        fixture.store,
        {
          type: "created",
          entityId: epic,
          epicId: epicIdFor({ id: epic, level: "epic", parentId: null }),
          actor: ACTOR,
        },
        stamp,
      );
      appendEvent(
        fixture.store,
        {
          type: "created",
          entityId: child,
          epicId: epicIdFor({ id: child, level: "task", parentId: epic }),
          actor: ACTOR,
        },
        stamp,
      );
    });

    const scoped = fixture.store.db
      .prepare("SELECT entity_id FROM events WHERE epic_id = ? ORDER BY id")
      .all(epic) as Array<{ entity_id: string }>;
    expect(scoped.map((row) => row.entity_id)).toEqual([epic, child]);
  });
});

describe("rowToEvent", () => {
  it("narrows every column rather than casting the row", () => {
    const task = seedTask(fixture.store);
    const id = writeTx(fixture.store.db, (stamp) =>
      appendEvent(
        fixture.store,
        {
          type: "status-changed",
          entityId: task,
          epicId: null,
          actor: ACTOR,
          fromLane: "Defined",
          toLane: "Planned",
          reason: "why",
        },
        stamp,
      ),
    );

    const event = rowToEvent(readEvent(id) as never);

    expect(event).toMatchObject({
      id,
      type: "status-changed",
      entityId: task,
      epicId: null,
      actor: ACTOR,
      fromLane: "Defined",
      toLane: "Planned",
      reason: "why",
      title: null,
    });
  });

  it("refuses a row whose actor column holds a BLOB", () => {
    // SQLite's flexible typing puts a BLOB in a TEXT column and better-sqlite3
    // returns a Buffer. Cast rather than narrowed, it reaches a formatter and
    // throws a TypeError surfacing as `internal`/exit 4 — telling an agent to
    // escalate a broken machine when the truth is one malformed row.
    const task = seedTask(fixture.store);
    fixture.store.db
      .prepare(
        "INSERT INTO events (type, entity_id, actor, created_at) VALUES (?,?,CAST(? AS BLOB),?)",
      )
      .run("created", task, Buffer.from("who"), "2026-01-01T00:00:00.000Z");

    const row = fixture.store.db.prepare("SELECT * FROM events").get() as Record<string, unknown>;
    expect(Buffer.isBuffer(row.actor)).toBe(true);
    expect(() => rowToEvent(row as never)).toThrowError(/actor must be text/);
  });

  it("refuses a row whose reason column holds a BLOB", () => {
    const task = seedTask(fixture.store);
    fixture.store.db
      .prepare(
        "INSERT INTO events (type, entity_id, actor, reason, created_at) VALUES (?,?,?,CAST(? AS BLOB),?)",
      )
      .run("closed", task, ACTOR, Buffer.from("why"), "2026-01-01T00:00:00.000Z");

    const row = fixture.store.db.prepare("SELECT * FROM events").get() as Record<string, unknown>;
    expect(() => rowToEvent(row as never)).toThrowError(/reason must be text/);
  });

  it("refuses a row whose type is outside the declared set", () => {
    // The CHECK constraint blocks this on write, so the row can only arrive
    // from a future build that added a type. Narrowing is what stops it
    // reaching a renderer that has no case for it.
    const row = {
      id: 1,
      type: "ref-status-changed",
      entity_id: "kt-aaaaaa",
      epic_id: null,
      actor: ACTOR,
      from_lane: null,
      to_lane: null,
      ref: null,
      reason: null,
      title: null,
      created_at: "2026-01-01T00:00:00.000Z",
    };

    expect(() => rowToEvent(row as never)).toThrowError(/event type must be one of/);
  });
});

describe("listEvents", () => {
  it("returns an entity's events newest first", () => {
    const task = seedTask(fixture.store);
    writeTx(fixture.store.db, (stamp) => {
      appendEvent(fixture.store, { type: "created", entityId: task, actor: ACTOR }, stamp);
      appendEvent(fixture.store, { type: "status-changed", entityId: task, actor: ACTOR }, stamp);
      appendEvent(fixture.store, { type: "closed", entityId: task, actor: ACTOR }, stamp);
    });

    expect(listEvents(fixture.store, { entityId: task }).events.map((e) => e.type)).toEqual([
      "closed",
      "status-changed",
      "created",
    ]);
  });

  it("returns only the entity asked for", () => {
    const one = seedTask(fixture.store);
    const two = seedTask(fixture.store);
    writeTx(fixture.store.db, (stamp) => {
      appendEvent(fixture.store, { type: "created", entityId: one, actor: ACTOR }, stamp);
      appendEvent(fixture.store, { type: "created", entityId: two, actor: ACTOR }, stamp);
    });

    expect(listEvents(fixture.store, { entityId: one }).events.map((e) => e.entityId)).toEqual([
      one,
    ]);
  });

  it("returns an epic's own events and its children's", () => {
    const epic = seedEpic(fixture.store, { title: "an epic" });
    const child = seedTask(fixture.store, { parentId: epic });
    const unrelated = seedTask(fixture.store);

    writeTx(fixture.store.db, (stamp) => {
      appendEvent(
        fixture.store,
        { type: "created", entityId: epic, epicId: epic, actor: ACTOR },
        stamp,
      );
      appendEvent(
        fixture.store,
        { type: "created", entityId: child, epicId: epic, actor: ACTOR },
        stamp,
      );
      appendEvent(fixture.store, { type: "created", entityId: unrelated, actor: ACTOR }, stamp);
    });

    const scoped = listEvents(fixture.store, { entityId: epic }).events;
    expect(scoped.map((e) => e.entityId).sort()).toEqual([child, epic].sort());
  });

  it("returns a plain task's own events only, not other tasks stamped nearby", () => {
    // The same query serves entity and epic scope. It is safe only because no
    // task's id appears in another task's epic_id unless that task is the
    // epic — asserted rather than assumed.
    const epic = seedEpic(fixture.store, { title: "an epic" });
    const child = seedTask(fixture.store, { parentId: epic });

    writeTx(fixture.store.db, (stamp) => {
      appendEvent(
        fixture.store,
        { type: "created", entityId: child, epicId: epic, actor: ACTOR },
        stamp,
      );
    });

    expect(listEvents(fixture.store, { entityId: child }).events).toHaveLength(1);
  });

  it("still returns a deleted task's history", () => {
    // Acceptance criterion 6, and the reason epic scoping reads the stamped
    // column. Built as a join to `tasks`, this returns nothing: the row is
    // gone.
    const task = seedTask(fixture.store, { title: "a typo" });
    writeTx(fixture.store.db, (stamp) => {
      appendEvent(
        fixture.store,
        { type: "created", entityId: task, actor: ACTOR, title: "a typo" },
        stamp,
      );
      appendEvent(
        fixture.store,
        { type: "deleted", entityId: task, actor: ACTOR, title: "a typo" },
        stamp,
      );
    });
    fixture.store.db.prepare("DELETE FROM tasks WHERE id = ?").run(task);

    const history = listEvents(fixture.store, { entityId: task }).events;
    expect(history.map((e) => e.type)).toEqual(["deleted", "created"]);
    expect(history[0]?.title).toBe("a typo");
  });

  it("keeps a deleted child's history under its epic", () => {
    // The sharper half of the same finding: scoping by `tasks.parent_id` would
    // lose this, because the child no longer exists to be joined to.
    const epic = seedEpic(fixture.store, { title: "an epic" });
    const child = seedTask(fixture.store, { parentId: epic, title: "gone" });
    writeTx(fixture.store.db, (stamp) => {
      appendEvent(
        fixture.store,
        { type: "created", entityId: child, epicId: epic, actor: ACTOR, title: "gone" },
        stamp,
      );
      appendEvent(
        fixture.store,
        { type: "deleted", entityId: child, epicId: epic, actor: ACTOR, title: "gone" },
        stamp,
      );
    });
    fixture.store.db.prepare("DELETE FROM tasks WHERE id = ?").run(child);

    expect(listEvents(fixture.store, { entityId: epic }).events.map((e) => e.type)).toEqual([
      "deleted",
      "created",
    ]);
  });

  it("still includes a deleted task's events in the whole-store read", () => {
    const task = seedTask(fixture.store);
    writeTx(fixture.store.db, (stamp) => {
      appendEvent(fixture.store, { type: "created", entityId: task, actor: ACTOR }, stamp);
    });
    fixture.store.db.prepare("DELETE FROM tasks WHERE id = ?").run(task);

    expect(listEvents(fixture.store).events).toHaveLength(1);
  });

  it("reads the whole store when no entity is given", () => {
    const one = seedTask(fixture.store);
    const two = seedTask(fixture.store);
    writeTx(fixture.store.db, (stamp) => {
      appendEvent(fixture.store, { type: "created", entityId: one, actor: ACTOR }, stamp);
      appendEvent(fixture.store, { type: "created", entityId: two, actor: ACTOR }, stamp);
    });

    expect(listEvents(fixture.store).events).toHaveLength(2);
  });

  it("says nothing happened rather than erroring on an empty store", () => {
    expect(listEvents(fixture.store).events).toEqual([]);
    expect(listEvents(fixture.store, { entityId: "kt-zzzzzz" }).events).toEqual([]);
  });

  it("orders by id so identical timestamps stay deterministic", () => {
    // Every event in one transaction shares a timestamp by design, so ordering
    // by created_at alone leaves them in whatever order the query plan
    // produced. The id is assigned inside the write lock and is total.
    const task = seedTask(fixture.store);
    const ids = writeTx(fixture.store.db, (stamp) => [
      appendEvent(fixture.store, { type: "created", entityId: task, actor: ACTOR }, stamp),
      appendEvent(fixture.store, { type: "status-changed", entityId: task, actor: ACTOR }, stamp),
      appendEvent(fixture.store, { type: "closed", entityId: task, actor: ACTOR }, stamp),
    ]);

    const stamps = new Set(listEvents(fixture.store).events.map((e) => e.createdAt));
    expect(stamps.size).toBe(1);

    for (let run = 0; run < 5; run++) {
      expect(listEvents(fixture.store).events.map((e) => e.id)).toEqual([...ids].reverse());
    }
  });

  it("bounds the result with limit, keeping the newest", () => {
    const task = seedTask(fixture.store);
    const ids = writeTx(fixture.store.db, (stamp) =>
      Array.from({ length: 10 }, () =>
        appendEvent(fixture.store, { type: "note-added", entityId: task, actor: ACTOR }, stamp),
      ),
    );

    const limited = listEvents(fixture.store, { limit: 3 }).events;
    expect(limited.map((e) => e.id)).toEqual([...ids].reverse().slice(0, 3));
  });

  it("applies a default bound rather than returning an unbounded history", () => {
    // Nothing prunes this table (ADR-008), so an unbounded default read grows
    // without limit for the life of the repository.
    const task = seedTask(fixture.store);
    writeTx(fixture.store.db, (stamp) => {
      for (let i = 0; i < DEFAULT_EVENT_LIMIT + 10; i++) {
        appendEvent(fixture.store, { type: "note-added", entityId: task, actor: ACTOR }, stamp);
      }
    });

    expect(listEvents(fixture.store).events).toHaveLength(DEFAULT_EVENT_LIMIT);
  });
});
