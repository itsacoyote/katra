import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isKatraException } from "../../src/core/errors.js";
import { createNote, getNote, listNotes } from "../../src/core/notes/repo.js";
import { seedEpic, seedTask } from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture } from "../helpers/store.js";

const ACTOR = "feature/f2 @ /repo/wt-f2";

let fixture: StoreFixture;
beforeEach(() => {
  fixture = createStoreFixture({ actor: ACTOR });
});
afterEach(() => fixture.cleanup());

describe("createNote", () => {
  it("creates a note with an nt- prefixed id", () => {
    const task = seedTask(fixture.store);

    const note = createNote(fixture.store, { taskId: task, body: "a handoff" });

    expect(note.id).toMatch(/^nt-[0-9a-z]{6}$/);
    expect(note).toMatchObject({
      taskId: task,
      kind: "general",
      body: "a handoff",
      actor: ACTOR,
    });
  });

  it("records the kind it was given", () => {
    const task = seedTask(fixture.store);

    const note = createNote(fixture.store, { taskId: task, body: "b", kind: "handoff" });

    expect(note.kind).toBe("handoff");
  });

  it("rejects a kind from the task-kind set", () => {
    // Two things called "kind" one import apart. Accepting `feat` here would
    // look like it worked and produce a note nothing can filter for.
    const task = seedTask(fixture.store);

    expect(() =>
      createNote(fixture.store, { taskId: task, body: "b", kind: "feat" as never }),
    ).toThrowError(/note kind must be one of/);
  });

  it("refuses an empty body, naming that a note needs one", () => {
    const task = seedTask(fixture.store);

    try {
      createNote(fixture.store, { taskId: task, body: "" });
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("validation");
      // Not a constraint dump: the refusal has to say why a note is different
      // from a task description, which *is* optional.
      expect(error.message).toMatch(/a note needs a body/);
      expect(error.message).not.toMatch(/CHECK constraint/);
    }
  });

  it("refuses a whitespace-only body", () => {
    // `readBody` returns undefined for a blank file, and three spaces is the
    // same mistake as none — a row that says nothing.
    const task = seedTask(fixture.store);

    for (const blank of ["   ", "\n\n", "\t", " \r\n "]) {
      expect(() => createNote(fixture.store, { taskId: task, body: blank })).toThrowError(
        /a note needs a body/,
      );
    }
    expect(listNotes(fixture.store)).toEqual([]);
  });

  it("refuses a note on a task that does not exist", () => {
    try {
      createNote(fixture.store, { taskId: "kt-zzzzzz", body: "orphan" });
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("not_found");
      expect(error.message).toMatch(/katra add/);
    }
  });

  it("resolves a partial task id", () => {
    const task = seedTask(fixture.store, { id: "kt-9f3k2a" });

    expect(createNote(fixture.store, { taskId: "9f3", body: "b" }).taskId).toBe(task);
  });

  it("records a note-added event pointing at the note", () => {
    // The seventh event type, and the only one no task path produces.
    const epic = seedEpic(fixture.store, { title: "an epic" });
    const task = seedTask(fixture.store, { parentId: epic });

    const note = createNote(fixture.store, { taskId: task, body: "a handoff" });

    const event = fixture.store.db
      .prepare("SELECT * FROM events WHERE type = 'note-added'")
      .get() as Record<string, unknown>;
    expect(event).toMatchObject({
      entity_id: task,
      epic_id: epic,
      ref: note.id,
      actor: ACTOR,
    });
  });

  it("leaves neither note nor event when the body is refused", () => {
    const task = seedTask(fixture.store);

    expect(() => createNote(fixture.store, { taskId: task, body: "  " })).toThrowError();

    expect(listNotes(fixture.store)).toEqual([]);
    expect(fixture.store.db.prepare("SELECT COUNT(*) c FROM events").get()).toEqual({ c: 0 });
  });

  it("gives the note and its event the same timestamp", () => {
    const task = seedTask(fixture.store);

    const note = createNote(fixture.store, { taskId: task, body: "b" });

    const event = fixture.store.db
      .prepare("SELECT created_at FROM events WHERE type='note-added'")
      .get() as { created_at: string };
    expect(event.created_at).toBe(note.createdAt);
  });
});

describe("note bodies round-trip", () => {
  it("round-trips a body containing newlines, tabs and unicode", () => {
    // A note is where pasted output and model text land. Anything normalised
    // on the way in is lost for good — there is no undo until snapshots.
    const task = seedTask(fixture.store);
    const body = "line one\n\tindented\r\nquotes \"'` and $VARS\n— em dash, emoji 🜃, ligature ﬁ";

    const note = createNote(fixture.store, { taskId: task, body });

    expect(note.body).toBe(body);
    expect(getNote(fixture.store, note.id)?.body).toBe(body);
  });

  it("preserves leading and trailing whitespace inside a non-empty body", () => {
    // Trimming would be the obvious thing to do next to the emptiness check,
    // and it would silently eat the indentation of pasted code.
    const task = seedTask(fixture.store);
    const body = "    indented first line\nlast line    ";

    expect(createNote(fixture.store, { taskId: task, body }).body).toBe(body);
  });

  it("round-trips a body containing an embedded null byte", () => {
    // SQLite stores it; a C-string-minded layer would truncate at it.
    const task = seedTask(fixture.store);
    const body = "before\u0000after";

    const note = createNote(fixture.store, { taskId: task, body });

    expect(note.body).toBe(body);
    expect(getNote(fixture.store, note.id)?.body).toHaveLength(body.length);
  });

  it("refuses a row whose body column holds a BLOB", () => {
    // Flexible typing puts a Buffer in a TEXT column, and a formatter calling
    // .trim() on it throws a TypeError that surfaces as internal/exit 4 —
    // escalating a broken machine for what is one malformed row.
    const task = seedTask(fixture.store);
    fixture.store.db
      .prepare(
        "INSERT INTO notes (id,task_id,kind,body,actor,created_at) VALUES (?,?,?,CAST(? AS BLOB),?,?)",
      )
      .run("nt-blob01", task, "general", Buffer.from("bytes"), ACTOR, "2026-01-01T00:00:00.000Z");

    expect(() => getNote(fixture.store, "nt-blob01")).toThrowError(/body must be text/);
  });
});

describe("listNotes", () => {
  it("lists newest first and filters by kind", () => {
    const task = seedTask(fixture.store);
    const first = createNote(fixture.store, { taskId: task, body: "one", kind: "decision" });
    const second = createNote(fixture.store, { taskId: task, body: "two", kind: "handoff" });
    const third = createNote(fixture.store, { taskId: task, body: "three", kind: "handoff" });

    expect(listNotes(fixture.store).map((n) => n.id)).toEqual([third.id, second.id, first.id]);
    expect(listNotes(fixture.store, { kind: "handoff" }).map((n) => n.id)).toEqual([
      third.id,
      second.id,
    ]);
    expect(listNotes(fixture.store, { kind: "acceptance" })).toEqual([]);
  });

  it("returns only the notes of the task asked for", () => {
    const one = seedTask(fixture.store);
    const two = seedTask(fixture.store);
    createNote(fixture.store, { taskId: one, body: "mine" });
    createNote(fixture.store, { taskId: two, body: "theirs" });

    expect(listNotes(fixture.store, { taskId: one }).map((n) => n.body)).toEqual(["mine"]);
  });

  it("orders notes written in the same millisecond by insertion, not by id", () => {
    // Timestamps are millisecond-precision and notes added together routinely
    // share one — three separate createNote calls did, which is how this was
    // found. `nt-` ids are random (ADR-001), so breaking the tie with the id
    // returns them in an order unrelated to when they were written.
    //
    // The ids run *backwards* against insertion order here on purpose: with
    // ascending ids, "insertion order" and "id order" coincide and the
    // assertion holds either way.
    const task = seedTask(fixture.store);
    const stamp = "2026-01-01T00:00:00.000Z";
    const insert = fixture.store.db.prepare(
      "INSERT INTO notes (id,task_id,kind,body,actor,created_at) VALUES (?,?,?,?,?,?)",
    );
    for (const id of ["nt-aaaaaa", "nt-zzzzzz", "nt-mmmmmm"]) {
      insert.run(id, task, "general", `body ${id}`, ACTOR, stamp);
    }

    for (let run = 0; run < 5; run++) {
      // Newest first: the last one inserted leads, whatever its id sorts as.
      expect(listNotes(fixture.store).map((n) => n.id)).toEqual([
        "nt-mmmmmm",
        "nt-zzzzzz",
        "nt-aaaaaa",
      ]);
    }
  });

  it("returns notes created in sequence newest first even within one millisecond", () => {
    // The end-to-end version, and the case that actually failed: three
    // createNote calls fast enough to share a timestamp came back in id order.
    const task = seedTask(fixture.store);
    const first = createNote(fixture.store, { taskId: task, body: "one" });
    const second = createNote(fixture.store, { taskId: task, body: "two" });
    const third = createNote(fixture.store, { taskId: task, body: "three" });

    expect(listNotes(fixture.store).map((n) => n.body)).toEqual(["three", "two", "one"]);
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
  });

  it("bounds the result with limit", () => {
    const task = seedTask(fixture.store);
    for (let i = 0; i < 5; i++) createNote(fixture.store, { taskId: task, body: `note ${i}` });

    expect(listNotes(fixture.store, { limit: 2 })).toHaveLength(2);
    expect(listNotes(fixture.store, { limit: 0 })).toEqual([]);
  });

  it("says nothing rather than erroring on a store with no notes", () => {
    expect(listNotes(fixture.store)).toEqual([]);
    expect(listNotes(fixture.store, { taskId: "kt-zzzzzz" })).toEqual([]);
  });

  it("loses a task's notes when the task is deleted, but keeps the event", () => {
    // ADR-008's dividing line, from the notes side: history survives, content
    // does not.
    const task = seedTask(fixture.store);
    createNote(fixture.store, { taskId: task, body: "goes away" });

    fixture.store.db.prepare("DELETE FROM tasks WHERE id = ?").run(task);

    expect(listNotes(fixture.store)).toEqual([]);
    expect(
      fixture.store.db.prepare("SELECT COUNT(*) c FROM events WHERE type='note-added'").get(),
    ).toEqual({ c: 1 });
  });
});
