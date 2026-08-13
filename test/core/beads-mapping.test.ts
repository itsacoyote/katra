import { describe, expect, it } from "vitest";
import {
  assembleNotes,
  buildTags,
  clampPriority,
  mapLevelAndKind,
  mapStatus,
  normalizeTimestamp,
  parseTitleKindPrefix,
  STATUS_MAP,
  TYPE_MAP,
} from "../../src/core/beads/mapping.js";
import type { MigrationItemRef } from "../../src/core/beads/types.js";
import { PRIORITY_DEFAULT } from "../../src/core/enums.js";

const ref = (oldId: string, title = "t"): MigrationItemRef => ({ oldId, title });

describe("STATUS_MAP", () => {
  it("declares exactly the seven documented beads statuses", () => {
    expect(Object.keys(STATUS_MAP).sort()).toEqual(
      ["blocked", "closed", "deferred", "hooked", "in_progress", "open", "pinned"].sort(),
    );
  });

  it("maps every beads status to its lane and tags per the doc table", () => {
    // Literal expectations from docs/migrating-from-beads.md's "Status
    // mapping" table — an independent source of truth, not a re-read of
    // STATUS_MAP itself, so this can actually disagree with the code.
    const r = ref("bd-1");
    expect(mapStatus(r, "open")).toEqual({ value: { lane: "Defined" }, degradations: [] });
    expect(mapStatus(r, "in_progress")).toEqual({
      value: { lane: "In Progress" },
      degradations: [],
    });
    expect(mapStatus(r, "blocked")).toEqual({ value: { lane: "Defined" }, degradations: [] });
    expect(mapStatus(r, "deferred")).toEqual({
      value: { lane: "Defined", tag: "deferred" },
      degradations: [],
    });
    expect(mapStatus(r, "pinned")).toEqual({
      value: { lane: "Defined", tag: "pinned" },
      degradations: [],
    });
    expect(mapStatus(r, "hooked")).toEqual({ value: { lane: "In Progress" }, degradations: [] });
    expect(mapStatus(r, "closed")).toEqual({ value: { lane: "Done" }, degradations: [] });
  });

  it("reports and defaults an unknown status instead of throwing", () => {
    const r = ref("bd-2", "weird one");
    expect(() => mapStatus(r, "quantum")).not.toThrow();

    const result = mapStatus(r, "quantum");
    expect(result.value).toEqual({ lane: "Defined" });
    expect(result.degradations).toEqual([{ oldId: "bd-2", title: "weird one", raw: "quantum" }]);
  });

  it("treats a prototype-property status as unmapped rather than resolving Object.prototype", () => {
    // A plain-object index with an attacker-controlled key ("constructor",
    // "toString", "__proto__", ...) resolves through Object.prototype
    // instead of returning undefined. Without an own-property guard this
    // would silently take the recognised-status branch with a non-
    // StatusMapping value — lane undefined, zero degradations reported.
    const r = ref("bd-15", "hostile export");
    const result = mapStatus(r, "constructor");

    expect(result.value).toEqual({ lane: "Defined" });
    expect(result.degradations).toEqual([
      { oldId: "bd-15", title: "hostile export", raw: "constructor" },
    ]);
  });
});

describe("TYPE_MAP and title kind-prefix parsing", () => {
  it("declares exactly the nine documented beads issue types", () => {
    expect(Object.keys(TYPE_MAP).sort()).toEqual(
      ["bug", "chore", "decision", "epic", "feature", "milestone", "spike", "story", "task"].sort(),
    );
  });

  it("parses feat:, fix(scope): prefixes and rejects gap:, finding:, decision:, sweep:", () => {
    expect(parseTitleKindPrefix("feat: katra brief")).toBe("feat");
    expect(parseTitleKindPrefix("fix(scope): repair the thing")).toBe("fix");

    // decision is a NOTE_KIND, not a KIND — it must never match the title
    // parser, or an issue_type "decision" row would double up with a title
    // prefix that means something else entirely.
    expect(parseTitleKindPrefix("decision: use postgres")).toBeUndefined();
    expect(parseTitleKindPrefix("gap: undocumented behavior")).toBeUndefined();
    expect(parseTitleKindPrefix("finding: something odd")).toBeUndefined();
    expect(parseTitleKindPrefix("sweep: cleanup pass")).toBeUndefined();

    // Not anchored / not a real prefix match.
    expect(parseTitleKindPrefix("feature: bigger word, not a kind")).toBeUndefined();
    expect(parseTitleKindPrefix("a feat: not at the start")).toBeUndefined();
  });

  it("prefers a valid title prefix over the issue_type map", () => {
    // issue_type "bug" IS in TYPE_MAP (-> kind "fix"), yet the title prefix
    // must still win per req 4's resolution order.
    const r = ref("bd-4", "feat: new exporter");
    const result = mapLevelAndKind(r, "bug");

    expect(result.value).toEqual({ level: "task", kind: "feat" });
    // bug is a recognised issue_type, so nothing is unmapped here.
    expect(result.degradations).toEqual([]);
  });

  it("falls back to the issue_type map when the title has no kind prefix", () => {
    const r = ref("bd-4b", "fix a bug that has no prefix");
    const result = mapLevelAndKind(r, "bug");

    expect(result.value).toEqual({ level: "task", kind: "fix" });
    expect(result.degradations).toEqual([]);
  });

  it("reports and defaults an unknown issue_type to task/chore", () => {
    const r = ref("bd-9", "no prefix here");
    const result = mapLevelAndKind(r, "gremlin");

    expect(result.value).toEqual({ level: "task", kind: "chore" });
    expect(result.degradations).toEqual([
      { oldId: "bd-9", title: "no prefix here", raw: "gremlin" },
    ]);
  });

  it("still recovers kind from a valid title prefix even when issue_type is unmapped", () => {
    const r = ref("bd-9b", "perf: speed it up");
    const result = mapLevelAndKind(r, "gremlin");

    expect(result.value).toEqual({ level: "task", kind: "perf" });
    // The issue_type is still unmapped and still reported, even though the
    // title prefix supplied a usable kind.
    expect(result.degradations).toEqual([
      { oldId: "bd-9b", title: "perf: speed it up", raw: "gremlin" },
    ]);
  });

  it("treats a prototype-property issue_type as unmapped rather than resolving Object.prototype", () => {
    const r = ref("bd-16", "hostile export");
    const result = mapLevelAndKind(r, "toString");

    expect(result.value).toEqual({ level: "task", kind: "chore" });
    expect(result.degradations).toEqual([
      { oldId: "bd-16", title: "hostile export", raw: "toString" },
    ]);
  });
});

describe("normalizeTimestamp", () => {
  const fallback = "1970-01-01T00:00:00.000Z";

  it("pads second-precision beads timestamps to katra's 24-char format", () => {
    const r = ref("bd-5");
    const result = normalizeTimestamp(r, "created_at", "2026-08-03T09:05:00Z", fallback);

    expect(result.value).toHaveLength(24);
    expect(result.value).toBe("2026-08-03T09:05:00.000Z");
    expect(result.degradations).toEqual([]);
  });

  it("keeps chronological order lexicographic after normalization", () => {
    const r = ref("bd-6");
    const raw = [
      "2026-08-03T09:05:00Z",
      "2026-08-03T09:05:01Z",
      "2026-08-03T10:00:00Z",
      "2026-08-04T00:00:00Z",
    ];

    const normalized = raw.map(
      (value) => normalizeTimestamp(r, "created_at", value, fallback).value,
    );
    for (const value of normalized) expect(value).toHaveLength(24);

    const lexicographic = [...normalized].sort();
    expect(lexicographic).toEqual(normalized);
  });

  it("substitutes the given fallback for an unparseable timestamp and reports it", () => {
    const r = ref("bd-13");
    const result = normalizeTimestamp(r, "created_at", "not-a-date", fallback);

    expect(result.value).toBe(fallback);
    expect(result.degradations).toEqual([
      { oldId: "bd-13", title: "t", field: "created_at", raw: "not-a-date", fallback },
    ]);
  });
});

describe("clampPriority", () => {
  it("passes an in-range priority straight through", () => {
    expect(clampPriority(ref("bd-10a"), 3)).toEqual({ value: 3, degradations: [] });
  });

  it("clamps an out-of-range priority to the nearest bound and reports it", () => {
    const r = ref("bd-10", "t");
    const high = clampPriority(r, 99);
    expect(high.value).toBe(4);
    expect(high.degradations).toEqual([
      { oldId: "bd-10", title: "t", field: "priority", raw: 99, clamped: 4 },
    ]);

    const low = clampPriority(r, -5);
    expect(low.value).toBe(0);
  });

  it("falls back to the default priority for a non-finite raw value", () => {
    const result = clampPriority(ref("bd-10c"), Number.NaN);
    expect(result.value).toBe(PRIORITY_DEFAULT);
  });
});

describe("buildTags", () => {
  it("builds tags from labels plus beads:<id> plus status tags", () => {
    const r = ref("bd-8", "t");
    const result = buildTags(r, ["urgent", "  ", "frontend"], "deferred");

    expect(result.value).toEqual(["urgent", "frontend", "beads:bd-8", "deferred"]);
    expect(result.degradations).toEqual([{ oldId: "bd-8", title: "t" }]);
  });

  it("omits the status tag entirely when there isn't one", () => {
    const result = buildTags(ref("bd-8b"), ["solo"], undefined);
    expect(result.value).toEqual(["solo", "beads:bd-8b"]);
  });

  it("deduplicates a label that collides with the beads: or status tag", () => {
    const result = buildTags(ref("bd-8c"), ["deferred"], "deferred");
    expect(result.value).toEqual(["deferred", "beads:bd-8c"]);
  });
});

describe("assembleNotes", () => {
  const fallback = "1970-01-01T00:00:00.000Z";

  it("assembles design/acceptance_criteria/notes/comments into typed notes preserving author and time", () => {
    const r = ref("bd-7", "t");
    // issueCreatedAt is already normalized by the caller (mapIssue,
    // transform.ts) — assembleNotes uses it as-is rather than re-normalizing,
    // so this is the 24-char canonical width, not a raw beads timestamp.
    const result = assembleNotes(
      r,
      "2026-08-03T09:05:00.000Z",
      {
        design: "  Use postgres  ",
        acceptanceCriteria: "Must pass CI",
        notes: "General remark",
        comments: [
          {
            id: "c-1",
            issue_id: "bd-7",
            author: "alice",
            text: "first comment",
            created_at: "2026-08-03T09:06:00Z",
          },
        ],
      },
      "migrator@katra",
      fallback,
    );

    expect(result.value).toEqual([
      {
        kind: "decision",
        body: "Use postgres",
        actor: "migrator@katra",
        createdAt: "2026-08-03T09:05:00.000Z",
      },
      {
        kind: "acceptance",
        body: "Must pass CI",
        actor: "migrator@katra",
        createdAt: "2026-08-03T09:05:00.000Z",
      },
      {
        kind: "general",
        body: "General remark",
        actor: "migrator@katra",
        createdAt: "2026-08-03T09:05:00.000Z",
      },
      {
        kind: "general",
        body: "first comment",
        actor: "alice",
        createdAt: "2026-08-03T09:06:00.000Z",
      },
    ]);
    expect(result.blankNotes).toEqual([]);
    expect(result.commentAuthorFallbacks).toEqual([]);
    expect(result.invalidTimestamps).toEqual([]);
  });

  it("skips a blank-after-trim note body and reports it", () => {
    const r = ref("bd-11", "t");
    const result = assembleNotes(
      r,
      "2026-08-03T09:05:00.000Z",
      { notes: "   " },
      "migrator@katra",
      fallback,
    );

    expect(result.value).toEqual([]);
    expect(result.blankNotes).toEqual([{ oldId: "bd-11", title: "t", noteKind: "general" }]);
  });

  it("falls back to migratingIdentity when a comment's author is missing or blank, and reports it", () => {
    const r = ref("bd-12", "t");
    const result = assembleNotes(
      r,
      "2026-08-03T09:05:00.000Z",
      {
        comments: [
          {
            id: "c-2",
            issue_id: "bd-12",
            text: "no author field",
            created_at: "2026-08-03T09:06:00Z",
          },
          {
            id: "c-3",
            issue_id: "bd-12",
            author: "   ",
            text: "blank author",
            created_at: "2026-08-03T09:07:00Z",
          },
        ],
      },
      "migrator@katra",
      fallback,
    );

    expect(result.value.map((note) => note.actor)).toEqual(["migrator@katra", "migrator@katra"]);
    expect(result.commentAuthorFallbacks).toEqual([
      { oldId: "bd-12", title: "t", commentId: "c-2" },
      { oldId: "bd-12", title: "t", commentId: "c-3" },
    ]);
  });

  it("reports an unparseable comment timestamp and substitutes the fallback", () => {
    const r = ref("bd-14", "t");
    const result = assembleNotes(
      r,
      "2026-08-03T09:05:00.000Z",
      {
        comments: [
          {
            id: "c-4",
            issue_id: "bd-14",
            author: "bob",
            text: "bad date",
            created_at: "not-a-date",
          },
        ],
      },
      "migrator@katra",
      fallback,
    );

    expect(result.value[0]?.createdAt).toBe(fallback);
    expect(result.invalidTimestamps).toEqual([
      {
        oldId: "bd-14",
        title: "t",
        field: "comment:c-4.created_at",
        raw: "not-a-date",
        fallback,
      },
    ]);
  });
});
