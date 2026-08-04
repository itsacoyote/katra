import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  isKind,
  isLane,
  isLevel,
  isPriority,
  isTerminal,
  KINDS,
  type Kind,
  LANES,
  type Lane,
  LEVELS,
  type Level,
  PRIORITIES,
  PRIORITY_DEFAULT,
  PRIORITY_MAX,
  PRIORITY_MIN,
  sqlEnum,
  TERMINAL_LANES,
} from "../../src/core/enums.js";

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
