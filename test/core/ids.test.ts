import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isKatraException } from "../../src/core/errors.js";
import { idPattern, NOTE_ID_PREFIX } from "../../src/core/id-format.js";
import {
  generateId,
  ID_PREFIX,
  ID_RETRY_ATTEMPTS,
  ID_SUFFIX_LENGTH,
  insertWithRetry,
  MAX_CANDIDATES,
  MIN_PREFIX_LENGTH,
  requireId,
  resolveId,
} from "../../src/core/tasks/ids.js";
import { seedTask } from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture } from "../helpers/store.js";

let fixture: StoreFixture;
beforeEach(() => {
  fixture = createStoreFixture();
});
afterEach(() => fixture.cleanup());

describe("generateId", () => {
  it("generates an id matching kt- followed by six base36 characters", () => {
    const id = generateId();

    expect(id).toMatch(/^kt-[0-9a-z]{6}$/);
    expect(id.startsWith(ID_PREFIX)).toBe(true);
    expect(id.length).toBe(ID_PREFIX.length + ID_SUFFIX_LENGTH);
  });

  it("produces two thousand distinct ids across sequential creations", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => generateId()));
    expect(ids.size).toBe(2000);
  });

  it("draws every alphabet character without obvious bias", () => {
    // Folding a random byte with % 36 rather than rejecting the tail would make
    // the first four characters measurably more likely than the rest.
    const counts = new Map<string, number>();
    for (let i = 0; i < 3000; i++) {
      for (const char of generateId().slice(ID_PREFIX.length)) {
        counts.set(char, (counts.get(char) ?? 0) + 1);
      }
    }

    expect(counts.size).toBe(36);
    const frequencies = [...counts.values()];
    const expected = (3000 * ID_SUFFIX_LENGTH) / 36;
    // Generous band: this catches a systematic skew, not sampling noise.
    expect(Math.min(...frequencies)).toBeGreaterThan(expected * 0.7);
    expect(Math.max(...frequencies)).toBeLessThan(expected * 1.3);
  });
});

describe("generateId across id spaces", () => {
  it("generates an id with the prefix it was given", () => {
    const note = generateId(NOTE_ID_PREFIX);

    expect(note).toMatch(/^nt-[0-9a-z]{6}$/);
    expect(note.startsWith(NOTE_ID_PREFIX)).toBe(true);
  });

  it("still mints a task id when no prefix is given", () => {
    // `generateId()` is published from src/index.ts and has always meant a task
    // id. Making the prefix required would have been a breaking change to the
    // package's only id function.
    expect(generateId()).toMatch(/^kt-[0-9a-z]{6}$/);
  });

  it("varies only the prefix, never the suffix format", () => {
    // The alphabet, the length and the byte-rejection loop are the id format
    // itself. A parameterisation that let them drift per entity would make
    // `kt-` and `nt-` two different id schemes wearing one function.
    for (const prefix of [ID_PREFIX, NOTE_ID_PREFIX, "zz-", ""]) {
      const id = generateId(prefix);
      expect(id.slice(prefix.length)).toMatch(/^[0-9a-z]{6}$/);
      expect(id).toHaveLength(prefix.length + ID_SUFFIX_LENGTH);
    }
  });

  it("does not collide across two thousand note ids", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => generateId(NOTE_ID_PREFIX)));
    expect(ids.size).toBe(2000);
  });
});

describe("idPattern", () => {
  it("builds the GLOB from the id format rather than a hardcoded string", () => {
    expect(idPattern(ID_PREFIX)).toBe("kt-[0-9a-z][0-9a-z][0-9a-z][0-9a-z][0-9a-z][0-9a-z]");
    expect(idPattern(NOTE_ID_PREFIX)).toBe("nt-[0-9a-z][0-9a-z][0-9a-z][0-9a-z][0-9a-z][0-9a-z]");
  });

  it("emits one character class per suffix character", () => {
    // Falsifiability: the two assertions above would also pass against a pair
    // of hardcoded strings. Counting against ID_SUFFIX_LENGTH cannot — it is
    // the constant the pattern is supposed to be derived from.
    const classes = idPattern("x-").match(/\[0-9a-z\]/g) ?? [];
    expect(classes).toHaveLength(ID_SUFFIX_LENGTH);
    expect(idPattern("x-").startsWith("x-")).toBe(true);
  });

  it("matches every id generated for its prefix and rejects the other space", () => {
    // Asserted against SQLite's own GLOB, not a hand-rolled equivalent: the
    // pattern's only job is to go into a CHECK constraint, and a
    // reimplementation here would be testing my regex rather than the
    // constraint. A mismatch means either every insert fails or the constraint
    // is decorative.
    const db = new Database(":memory:");
    try {
      const matches = db.prepare("SELECT ? GLOB ? AS hit");
      const glob = (value: string, pattern: string): boolean =>
        (matches.get(value, pattern) as { hit: number }).hit === 1;

      for (let i = 0; i < 50; i++) {
        expect(glob(generateId(ID_PREFIX), idPattern(ID_PREFIX))).toBe(true);
        expect(glob(generateId(NOTE_ID_PREFIX), idPattern(NOTE_ID_PREFIX))).toBe(true);
        expect(glob(generateId(ID_PREFIX), idPattern(NOTE_ID_PREFIX))).toBe(false);
      }

      // Length is load-bearing too: a suffix one character short or long must
      // fail, or the constraint would admit ids nothing generates.
      expect(glob("kt-abcde", idPattern(ID_PREFIX))).toBe(false);
      expect(glob("kt-abcdefg", idPattern(ID_PREFIX))).toBe(false);
      expect(glob("kt-ABCDEF", idPattern(ID_PREFIX))).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("insertWithRetry", () => {
  it("mints from the id space it was given", () => {
    const seen: string[] = [];
    const id = insertWithRetry((candidate) => {
      seen.push(candidate);
    }, NOTE_ID_PREFIX);

    expect(id).toMatch(/^nt-[0-9a-z]{6}$/);
    expect(seen).toEqual([id]);
  });

  it("retries within the note id space rather than falling back to tasks", () => {
    // The retry regenerates, and a regeneration that dropped the prefix would
    // put a kt- id into the notes table — where the CHECK constraint rejects
    // it, surfacing as an unexplained failure several attempts later.
    const attempts: string[] = [];
    insertWithRetry((candidate) => {
      attempts.push(candidate);
      if (attempts.length < 3) {
        throw Object.assign(new Error("UNIQUE constraint failed: notes.id"), {
          code: "SQLITE_CONSTRAINT_PRIMARYKEY",
        });
      }
    }, NOTE_ID_PREFIX);

    expect(attempts).toHaveLength(3);
    expect(attempts.every((id) => id.startsWith(NOTE_ID_PREFIX))).toBe(true);
  });

  it("returns the id the insert accepted", () => {
    const seen: string[] = [];
    const id = insertWithRetry((candidate) => {
      seen.push(candidate);
    });

    expect(seen).toEqual([id]);
  });

  it("retries and succeeds when the first generated id already exists", () => {
    const attempts: string[] = [];
    const id = insertWithRetry((candidate) => {
      attempts.push(candidate);
      if (attempts.length < 3) {
        throw Object.assign(new Error("UNIQUE constraint failed: tasks.id"), {
          code: "SQLITE_CONSTRAINT_PRIMARYKEY",
        });
      }
    });

    expect(attempts).toHaveLength(3);
    expect(attempts.at(-1)).toBe(id);
    expect(new Set(attempts).size).toBe(3);
  });

  it("does not retry when the failure is a check-constraint violation", () => {
    // Retrying on any constraint would turn an invalid lane into a phantom id
    // collision, then into a misleading out-of-attempts error.
    let calls = 0;
    expect(() =>
      insertWithRetry(() => {
        calls += 1;
        throw Object.assign(new Error("CHECK constraint failed: lane"), {
          code: "SQLITE_CONSTRAINT_CHECK",
        });
      }),
    ).toThrowError(/CHECK constraint failed/);

    expect(calls).toBe(1);
  });

  it("gives up after the retry cap rather than looping forever", () => {
    let calls = 0;
    expect(() =>
      insertWithRetry(() => {
        calls += 1;
        throw Object.assign(new Error("collision"), { code: "SQLITE_CONSTRAINT_PRIMARYKEY" });
      }),
    ).toThrowError(/collision/);

    expect(calls).toBe(ID_RETRY_ATTEMPTS + 1);
  });

  it("matches the error code a real duplicate id actually raises", () => {
    // The retry only fires on SQLITE_CONSTRAINT_PRIMARYKEY, and every other
    // test here feeds it a hand-built error object carrying that code. If
    // SQLite ever reported a duplicate primary key differently, the retry
    // would stop working and nothing else in the suite would notice.
    const insert = (id: string): void => {
      fixture.store.db
        .prepare(
          "INSERT INTO tasks (id,level,kind,title,created_at,updated_at) VALUES (?,?,?,?,?,?)",
        )
        .run(id, "task", "feat", "dup", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    };

    insert("kt-dup001");
    try {
      insert("kt-dup001");
      expect.unreachable("a duplicate primary key should have thrown");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
    }
  });

  it("works against the real table", () => {
    const id = insertWithRetry((candidate) => {
      fixture.store.db
        .prepare(
          "INSERT INTO tasks (id,level,kind,title,created_at,updated_at) VALUES (?,?,?,?,?,?)",
        )
        .run(
          candidate,
          "task",
          "feat",
          "real",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
        );
    });

    expect(fixture.store.db.prepare("SELECT id FROM tasks").get()).toEqual({ id });
  });
});

describe("resolveId", () => {
  it("resolves a unique prefix to exactly one task", () => {
    const id = seedTask(fixture.store, { id: "kt-9f3k2a" });
    seedTask(fixture.store, { id: "kt-b7d0zz" });

    expect(resolveId(fixture.store, "9f3")).toEqual({ kind: "found", id });
  });

  it("resolves a prefix given with the kt- prefix included", () => {
    const id = seedTask(fixture.store, { id: "kt-9f3k2a" });

    expect(resolveId(fixture.store, "kt-9f3")).toEqual({ kind: "found", id });
    expect(resolveId(fixture.store, "kt-9f3k2a")).toEqual({ kind: "found", id });
  });

  it("returns every candidate when a prefix matches more than one task", () => {
    seedTask(fixture.store, { id: "kt-5c4a1b" });
    seedTask(fixture.store, { id: "kt-5c4f09" });
    seedTask(fixture.store, { id: "kt-5c4zz2" });
    seedTask(fixture.store, { id: "kt-99zzzz" });

    const result = resolveId(fixture.store, "5c4");

    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") throw new Error("unreachable");
    expect(result.candidates).toEqual(["kt-5c4a1b", "kt-5c4f09", "kt-5c4zz2"]);
    expect(result.truncated).toBe(false);
  });

  it("says so when more candidates matched than it will list", () => {
    // The candidate list is capped. Reporting a capped list as though it were
    // the whole set tells the caller it has seen every match when it has not —
    // and an agent narrowing its search against that list will never find the
    // task it wants.
    for (let i = 0; i < MAX_CANDIDATES + 5; i++) {
      seedTask(fixture.store, { id: `kt-ab${String(i).padStart(4, "0")}` });
    }

    const result = resolveId(fixture.store, "ab");

    if (result.kind !== "ambiguous") throw new Error("unreachable");
    expect(result.candidates).toHaveLength(MAX_CANDIDATES);
    expect(result.truncated).toBe(true);

    // And the refusal must not state a count it cannot know.
    try {
      requireId(fixture.store, "ab");
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.message).not.toMatch(new RegExp(`matches ${MAX_CANDIDATES} tasks`));
      expect(error.message).toContain(`more than ${MAX_CANDIDATES}`);
    }
  });

  it("reports no match distinctly from an ambiguous match", () => {
    seedTask(fixture.store, { id: "kt-9f3k2a" });

    expect(resolveId(fixture.store, "zzz")).toEqual({ kind: "not_found", input: "zzz" });
  });

  it("rejects a prefix shorter than the minimum length", () => {
    // Every id starts with kt-, so a single character would match the entire
    // backlog and dump it as "candidates".
    seedTask(fixture.store, { id: "kt-9f3k2a" });

    expect(() => resolveId(fixture.store, "k")).toThrowError(/too short/);
    expect(() => resolveId(fixture.store, "kt-")).toThrowError(/too short/);
    expect(MIN_PREFIX_LENGTH).toBeGreaterThan(1);
  });

  it("treats pattern metacharacters as ordinary text", () => {
    // Range bounds rather than LIKE or GLOB, so a wildcard cannot be smuggled
    // in through the id.
    seedTask(fixture.store, { id: "kt-9f3k2a" });

    expect(resolveId(fixture.store, "%%").kind).toBe("not_found");
    expect(resolveId(fixture.store, "9f*").kind).toBe("not_found");
    expect(resolveId(fixture.store, "__").kind).toBe("not_found");
  });

  it("uses an index seek rather than a full scan", () => {
    // LIKE 'prefix%' forfeits the index range scan; at 5,000 rows that was a
    // 7.7x difference, and it widens with the backlog.
    const plan = fixture.store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM tasks WHERE id >= ? AND id < ? ORDER BY id LIMIT ?",
      )
      .all("kt-5c4", "kt-5c4￿", 21) as Array<{ detail: string }>;

    const detail = plan.map((row) => row.detail).join(" ");
    expect(detail).toMatch(/SEARCH/);
    expect(detail).not.toMatch(/SCAN tasks(?! USING)/);
  });
});

describe("requireId", () => {
  it("returns the id when the prefix is unique", () => {
    const id = seedTask(fixture.store, { id: "kt-9f3k2a" });
    expect(requireId(fixture.store, "9f3")).toBe(id);
  });

  it("throws an ambiguous error carrying every candidate", () => {
    seedTask(fixture.store, { id: "kt-5c4a1b" });
    seedTask(fixture.store, { id: "kt-5c4f09" });

    try {
      requireId(fixture.store, "5c4");
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("ambiguous_id");
      if (error.detail.code !== "ambiguous_id") throw new Error("unreachable");
      // The candidates travel on the error so the CLI can list them rather
      // than only saying "ambiguous".
      expect(error.detail.candidates).toEqual(["kt-5c4a1b", "kt-5c4f09"]);
    }
  });

  it("throws a not-found error when nothing matches", () => {
    try {
      requireId(fixture.store, "zzz");
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("not_found");
    }
  });
});
