import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  EVENT_TYPES,
  type EventType,
  isEventType,
  isKind,
  isLane,
  isLevel,
  isNoteKind,
  isPriority,
  isTerminal,
  KINDS,
  type Kind,
  LANES,
  type Lane,
  LEVELS,
  type Level,
  NOTE_KIND_DEFAULT,
  NOTE_KINDS,
  type NoteKind,
  PRIORITIES,
  PRIORITY_DEFAULT,
  PRIORITY_MAX,
  PRIORITY_MIN,
  sqlEnum,
  TERMINAL_LANES,
} from "../../src/core/enums.js";
import {
  MAX_COUNT,
  narrowCount,
  narrowEventType,
  narrowKind,
  narrowNoteKind,
} from "../../src/core/narrow.js";

describe("fixed value sets", () => {
  it("derives Lane from the LANES array so the two cannot diverge", () => {
    // The compile-time half: an exhaustive switch over the Lane union. Adding a
    // value to LANES without handling it here is a type error, which is what
    // proves Lane is derived from the array rather than maintained beside it.
    const describeLane = (lane: Lane): string => {
      switch (lane) {
        case "Defined":
        case "Researching":
        case "Planned":
        case "In Progress":
        case "In Review":
          return "active";
        case "Done":
        case "Cancelled":
          return "terminal";
        default: {
          const exhaustive: never = lane;
          return exhaustive;
        }
      }
    };

    // The runtime half: every array member is a valid Lane and is handled.
    expect(LANES.map(describeLane)).toEqual([
      "active",
      "active",
      "active",
      "active",
      "active",
      "terminal",
      "terminal",
    ]);
  });

  it("orders the lanes to match the workflow stages", () => {
    expect(LANES).toEqual([
      "Defined",
      "Researching",
      "Planned",
      "In Progress",
      "In Review",
      "Done",
      "Cancelled",
    ]);
  });

  it("includes exactly Done and Cancelled in TERMINAL_LANES", () => {
    expect([...TERMINAL_LANES].sort()).toEqual(["Cancelled", "Done"]);
    // Every terminal lane must also be a lane; a typo would otherwise create a
    // terminal value no task could ever hold.
    for (const lane of TERMINAL_LANES) {
      expect(LANES).toContain(lane);
    }
  });

  it("returns true from isLane for every value in LANES", () => {
    for (const lane of LANES) {
      expect(isLane(lane)).toBe(true);
    }
  });

  it("returns false from isLane for a value outside LANES", () => {
    for (const bogus of ["Ready", "done", "DONE", "Todo", "", " Defined", "Defined "]) {
      expect(isLane(bogus)).toBe(false);
    }
  });

  it("identifies terminal lanes and rejects active ones", () => {
    expect(isTerminal("Done")).toBe(true);
    expect(isTerminal("Cancelled")).toBe(true);
    expect(isTerminal("Planned")).toBe(false);
    expect(isTerminal("In Review")).toBe(false);
  });

  it("narrows levels and kinds at a runtime boundary", () => {
    const levels: Level[] = LEVELS.filter(isLevel);
    const kinds: Kind[] = KINDS.filter(isKind);

    expect(levels).toEqual(["epic", "task"]);
    expect(kinds).toEqual(["feat", "fix", "refactor", "perf", "docs", "test", "chore"]);
    expect(isLevel("story")).toBe(false);
    expect(isKind("style")).toBe(false);
    expect(isKind("build")).toBe(false);
  });

  it("mirrors the conventional-commit types in KINDS", () => {
    // A task's kind is meant to match the prefix of the commits it produces.
    expect(KINDS).toEqual(["feat", "fix", "refactor", "perf", "docs", "test", "chore"]);
  });
});

describe("event types", () => {
  it("derives the event type union from the array", () => {
    // Same compile-time/runtime pairing as Lane: the exhaustive switch fails to
    // compile if EVENT_TYPES gains a member the union does not, which is what
    // proves the type is derived rather than hand-maintained beside it.
    const category = (type: EventType): string => {
      switch (type) {
        case "created":
        case "note-added":
          return "additive";
        case "status-changed":
        case "closed":
        case "cancelled":
        case "reopened":
          return "lifecycle";
        case "claimed":
        case "released":
          return "custody";
        case "deleted":
          return "removal";
        case "ref-linked":
        case "ref-unlinked":
          return "reference";
        default: {
          const exhaustive: never = type;
          return exhaustive;
        }
      }
    };

    expect(EVENT_TYPES.map(category)).toEqual([
      "additive",
      "custody",
      "custody",
      "lifecycle",
      "additive",
      "lifecycle",
      "lifecycle",
      "lifecycle",
      "removal",
      "reference",
      "reference",
    ]);
  });

  it("declares the eleven types the schema currently accepts, and no more", () => {
    // The spec's own list is nine, but not the same nine: `ref-status-changed`
    // still waits on the provider cycles — declaring a value nothing can
    // write would put it in a CHECK constraint under forward-only
    // migrations, expensive to take back. `deleted` (ADR-008), `cancelled`
    // (ADR-003) and `ref-unlinked` (F7 requirement 5) are additions the
    // spec's own list does not carry.
    expect(EVENT_TYPES).toEqual([
      "created",
      "claimed",
      "released",
      "status-changed",
      "note-added",
      "closed",
      "cancelled",
      "reopened",
      "deleted",
      "ref-linked",
      "ref-unlinked",
    ]);
    expect(EVENT_TYPES).toContain("ref-linked");
    expect(EVENT_TYPES).not.toContain("ref-status-changed");
  });

  it("returns true from isEventType for every declared type and false otherwise", () => {
    for (const type of EVENT_TYPES) expect(isEventType(type)).toBe(true);
    for (const bogus of ["Created", "note_added", "updated", "", "closed "]) {
      expect(isEventType(bogus)).toBe(false);
    }
  });

  it("rejects an event type outside the fixed set, naming all eleven", () => {
    try {
      narrowEventType("updated");
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // Naming the allowed values is the difference between an error an agent
      // can recover from and one it can only report.
      for (const type of EVENT_TYPES) expect(error.message).toContain(type);
      expect(error.message).toContain("updated");
    }
  });
});

describe("note kinds", () => {
  it("declares the four kinds with general as the default", () => {
    expect(NOTE_KINDS).toEqual(["general", "handoff", "decision", "acceptance"]);
    expect(NOTE_KINDS).toContain(NOTE_KIND_DEFAULT);
    expect(NOTE_KIND_DEFAULT).toBe("general");
  });

  it("derives the note kind union from the array", () => {
    const category = (kind: NoteKind): string => {
      switch (kind) {
        case "general":
          return "free";
        case "handoff":
        case "decision":
        case "acceptance":
          return "typed";
        default: {
          const exhaustive: never = kind;
          return exhaustive;
        }
      }
    };

    expect(NOTE_KINDS.map(category)).toEqual(["free", "typed", "typed", "typed"]);
  });

  it("rejects a note kind outside the fixed set, naming all four", () => {
    try {
      narrowNoteKind("summary");
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      for (const kind of NOTE_KINDS) expect(error.message).toContain(kind);
      expect(error.message).toContain("summary");
    }
  });

  it("keeps note kinds and task kinds separate", () => {
    // Two things called "kind" one import apart. Wiring either narrower to the
    // other's set would let `--kind feat` through on a note and `--kind
    // handoff` through on a task, and both would look like they worked.
    expect(NOTE_KINDS.some((kind) => (KINDS as readonly string[]).includes(kind))).toBe(false);

    expect(isNoteKind("handoff")).toBe(true);
    expect(isKind("handoff")).toBe(false);
    expect(isNoteKind("feat")).toBe(false);
    expect(isKind("feat")).toBe(true);

    expect(() => narrowNoteKind("feat")).toThrowError(/note kind/);
    expect(() => narrowKind("handoff")).toThrowError(/kind/);
    expect(narrowNoteKind("handoff")).toBe("handoff");
    expect(narrowKind("feat")).toBe("feat");
  });
});

describe("priority", () => {
  it("keeps the bounds and default inside the declared set", () => {
    expect(PRIORITIES).toEqual([0, 1, 2, 3, 4]);
    expect(PRIORITY_MIN).toBe(Math.min(...PRIORITIES));
    expect(PRIORITY_MAX).toBe(Math.max(...PRIORITIES));
    expect(PRIORITIES).toContain(PRIORITY_DEFAULT);
  });

  it("accepts every declared priority and rejects everything else", () => {
    for (const p of PRIORITIES) expect(isPriority(p)).toBe(true);
    for (const bad of [-1, 5, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isPriority(bad)).toBe(false);
    }
  });
});

describe("sqlEnum", () => {
  it("renders a quoted comma-separated IN-list from sqlEnum", () => {
    expect(sqlEnum(LEVELS)).toBe("'epic','task'");
    expect(sqlEnum(["a"])).toBe("'a'");
  });

  it("escapes an embedded quote so the fragment cannot break out of its literal", () => {
    expect(sqlEnum(["it's"])).toBe("'it''s'");
  });

  it("produces a sqlEnum fragment that SQLite accepts inside a CHECK constraint", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`CREATE TABLE probe (lane TEXT NOT NULL CHECK (lane IN (${sqlEnum(LANES)})))`);
      const insert = db.prepare("INSERT INTO probe (lane) VALUES (?)");

      for (const lane of LANES) {
        expect(() => insert.run(lane)).not.toThrow();
      }
      // The constraint must reject a value the array does not contain — this is
      // what makes the generated CHECK load-bearing rather than decorative.
      expect(() => insert.run("Ready")).toThrowError(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it("builds a constraint containing a value injected at build time", () => {
    // Falsifiability: asserting the DDL merely contains sqlEnum(LANES) would
    // also pass against a hardcoded list, since the two render identically.
    // Injecting a value no hardcoded list could know about cannot.
    const fragment = sqlEnum([...LANES, "Sentinel"]);
    expect(fragment).toContain("'Sentinel'");

    const db = new Database(":memory:");
    try {
      db.exec(`CREATE TABLE probe (lane TEXT NOT NULL CHECK (lane IN (${fragment})))`);
      expect(() => db.prepare("INSERT INTO probe (lane) VALUES (?)").run("Sentinel")).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe("narrowCount", () => {
  it("accepts zero and ordinary counts", () => {
    expect(narrowCount("0", "limit")).toBe(0);
    expect(narrowCount("25", "limit")).toBe(25);
    expect(narrowCount(7, "limit")).toBe(7);
  });

  it("refuses a count too large to bind, rather than failing as internal", () => {
    // `1e21` satisfies Number.isInteger, and better-sqlite3 then refuses to
    // bind it — surfacing as `internal` and exit 4, which tells an agent to
    // escalate a broken machine over a typo (ADR-005).
    for (const huge of ["1e21", String(Number.MAX_SAFE_INTEGER + 2), String(MAX_COUNT + 1)]) {
      expect(() => narrowCount(huge, "limit"), huge).toThrowError(/whole number of items between/);
    }
  });

  it("refuses a blank or nonsense value rather than reading it as zero", () => {
    // Number("") and Number(" ") are both 0, so these would silently mean
    // "return nothing" — and zero is a legitimate request, so it cannot double
    // as the rejection.
    for (const bad of ["", "   ", "lots", "-1", "2.5"]) {
      expect(() => narrowCount(bad, "limit"), bad).toThrowError(/whole number of items/);
    }
  });
});
