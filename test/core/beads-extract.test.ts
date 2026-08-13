import { describe, expect, it } from "vitest";
import {
  extractBeadsExport,
  MAX_SKIPPED_TYPE_CHARS,
  MAX_SKIPPED_TYPES,
} from "../../src/core/beads/extract.js";
import { isKatraException } from "../../src/core/errors.js";

/**
 * The minimal bd export record: every field {@link BeadsIssue} requires,
 * nothing optional. A factory, not a shared constant — several tests spread
 * and override fields, and a shared object would let one test's mutation
 * leak into another's.
 */
function minimalIssue(id: string): Record<string, unknown> {
  return {
    _type: "issue",
    id,
    title: `Issue ${id}`,
    description: "",
    status: "open",
    priority: 2,
    issue_type: "task",
    owner: "",
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: "alice",
    updated_at: "2026-01-01T00:00:00.000Z",
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
  };
}

describe("extractBeadsExport", () => {
  it("parses issues and counts skipped non-issue record types", () => {
    const text = [
      JSON.stringify(minimalIssue("bd-1")),
      JSON.stringify({ _type: "wisp", id: "w-1" }),
      JSON.stringify({ _type: "gate", id: "g-1" }),
      JSON.stringify({ _type: "gate", id: "g-2" }),
      JSON.stringify(minimalIssue("bd-2")),
    ].join("\n");

    const result = extractBeadsExport(text);

    expect(result.issues.map((issue) => issue.id)).toEqual(["bd-1", "bd-2"]);
    expect(result.skippedRecords).toEqual({
      count: 3,
      byType: [
        { type: "wisp", count: 1 },
        { type: "gate", count: 2 },
      ],
      truncated: false,
    });
  });

  it("refuses a malformed line naming its 1-based line number", () => {
    // Case 1: invalid JSON syntax on line 3.
    const syntaxBroken = [
      JSON.stringify(minimalIssue("bd-1")),
      JSON.stringify(minimalIssue("bd-2")),
      "{not valid json",
    ].join("\n");

    let caught: unknown;
    try {
      extractBeadsExport(syntaxBroken);
    } catch (err) {
      caught = err;
    }

    expect(isKatraException(caught)).toBe(true);
    if (!isKatraException(caught)) throw new Error("unreachable");
    expect(caught.detail.code).toBe("validation");
    expect(caught.message).toContain("line 3");
    if (caught.detail.code !== "validation") throw new Error("unreachable");
    expect(caught.detail.value).toBe(3);

    // Case 2: valid JSON, but not a bd export record — no string `_type` to
    // classify it as an issue or a skippable non-issue type. Shape basics,
    // not a value judgment about any field's content.
    const shapeBroken = [
      JSON.stringify(minimalIssue("bd-1")),
      JSON.stringify({ no_type: true }),
    ].join("\n");

    let caughtShape: unknown;
    try {
      extractBeadsExport(shapeBroken);
    } catch (err) {
      caughtShape = err;
    }

    expect(isKatraException(caughtShape)).toBe(true);
    if (!isKatraException(caughtShape)) throw new Error("unreachable");
    expect(caughtShape.detail.code).toBe("validation");
    expect(caughtShape.message).toContain("line 2");

    // Case 3: `_type: "issue"` but no string `id`/`title` — the
    // belt-and-braces floor. A record this bare cannot back a
    // `MigrationItemRef` anywhere downstream, so it refuses here rather than
    // reaching transform.ts as an issue with `id: undefined`.
    const noIdTitle = JSON.stringify({ _type: "issue" });

    let caughtBare: unknown;
    try {
      extractBeadsExport(noIdTitle);
    } catch (err) {
      caughtBare = err;
    }

    expect(isKatraException(caughtBare)).toBe(true);
    if (!isKatraException(caughtBare)) throw new Error("unreachable");
    expect(caughtBare.detail.code).toBe("validation");
    expect(caughtBare.message).toContain("line 1");
  });

  it("tolerates blank lines and a trailing newline", () => {
    const text = `${JSON.stringify(minimalIssue("bd-1"))}\n\n   \n${JSON.stringify(
      minimalIssue("bd-2"),
    )}\n`;

    const result = extractBeadsExport(text);

    expect(result.issues.map((issue) => issue.id)).toEqual(["bd-1", "bd-2"]);
    expect(result.skippedRecords).toEqual({ count: 0, byType: [], truncated: false });
  });

  it("parses an issue with every optional field absent", () => {
    const minimal = minimalIssue("bd-1");

    const result = extractBeadsExport(JSON.stringify(minimal));

    expect(result.issues).toHaveLength(1);
    const [issue] = result.issues;
    // Exact equality — not just a subset match — proves no `_type` leaked
    // through and no optional field appeared as an explicit `undefined`.
    expect(issue).toEqual({
      id: "bd-1",
      title: "Issue bd-1",
      description: "",
      status: "open",
      priority: 2,
      issue_type: "task",
      owner: "",
      created_at: "2026-01-01T00:00:00.000Z",
      created_by: "alice",
      updated_at: "2026-01-01T00:00:00.000Z",
      dependency_count: 0,
      dependent_count: 0,
      comment_count: 0,
    });
  });

  it("parses comments, labels and dependencies into typed arrays", () => {
    const record = {
      ...minimalIssue("bd-1"),
      labels: ["backend", "urgent"],
      dependencies: [
        {
          issue_id: "bd-1",
          depends_on_id: "bd-2",
          type: "blocks",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      comments: [
        {
          id: "c-1",
          issue_id: "bd-1",
          author: "bob",
          text: "hello",
          created_at: "2026-01-02T00:00:00.000Z",
        },
        { id: "c-2", issue_id: "bd-1", text: "no author", created_at: "2026-01-03T00:00:00.000Z" },
      ],
    };

    const result = extractBeadsExport(JSON.stringify(record));

    const [issue] = result.issues;
    expect(issue?.labels).toEqual(["backend", "urgent"]);
    expect(issue?.dependencies).toEqual([
      {
        issue_id: "bd-1",
        depends_on_id: "bd-2",
        type: "blocks",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(issue?.comments).toEqual([
      {
        id: "c-1",
        issue_id: "bd-1",
        author: "bob",
        text: "hello",
        created_at: "2026-01-02T00:00:00.000Z",
      },
      { id: "c-2", issue_id: "bd-1", text: "no author", created_at: "2026-01-03T00:00:00.000Z" },
    ]);
  });

  it("does not carry a hostile __proto__/constructor/hasOwnProperty key through to the returned issue", () => {
    const hostile: Record<string, unknown> = minimalIssue("bd-1");
    // Defined via `Object.defineProperty`, not `{ __proto__: ... }` object
    // literal syntax — the literal form sets the object's real prototype in
    // source code, which is not what a hostile export line does. This
    // creates a literal *own property* named "__proto__", the same shape
    // `JSON.parse` produces for `{"__proto__":...}` in untrusted JSON.
    Object.defineProperty(hostile, "__proto__", { value: { polluted: true }, enumerable: true });
    Object.defineProperty(hostile, "constructor", { value: { evil: true }, enumerable: true });
    Object.defineProperty(hostile, "hasOwnProperty", { value: "not a function", enumerable: true });

    const text = JSON.stringify(hostile);
    // Confirms the fixture really carries the hostile keys as JSON — a
    // broken fixture would prove nothing below.
    expect(text).toContain('"__proto__"');

    const result = extractBeadsExport(text);
    const [issue] = result.issues;

    expect(Object.hasOwn(issue as object, "__proto__")).toBe(false);
    expect(Object.hasOwn(issue as object, "constructor")).toBe(false);
    expect(Object.hasOwn(issue as object, "hasOwnProperty")).toBe(false);
    // The real, inherited `hasOwnProperty` is still reachable and callable —
    // a copied-through `"not a function"` value would make this a TypeError
    // instead. `Object.hasOwn` above cannot catch that: it checks ownership
    // directly without going through the object's own method, so calling the
    // method itself is the only way to prove it was not shadowed.
    // biome-ignore lint/suspicious/noPrototypeBuiltins: deliberately calling the instance method to prove it is not shadowed
    expect(issue?.hasOwnProperty("id")).toBe(true);
  });

  it("caps skippedRecords.byType at MAX_SKIPPED_TYPES distinct types, folding the rest into an exact count", () => {
    const distinctTypeCount = MAX_SKIPPED_TYPES + 1;
    const text = Array.from({ length: distinctTypeCount }, (_, i) =>
      JSON.stringify({ _type: `type-${i}`, id: `r-${i}` }),
    ).join("\n");

    const result = extractBeadsExport(text);

    expect(result.skippedRecords.byType).toHaveLength(MAX_SKIPPED_TYPES);
    expect(result.skippedRecords.truncated).toBe(true);
    // Exact, not capped: every one of the 21 skipped records is counted even
    // though only 20 get their own byType row.
    expect(result.skippedRecords.count).toBe(distinctTypeCount);
  });

  it("caps a hostile _type string before it enters the report", () => {
    const giantType = "x".repeat(MAX_SKIPPED_TYPE_CHARS * 5);
    const text = JSON.stringify({ _type: giantType, id: "r-1" });

    const result = extractBeadsExport(text);

    expect(result.skippedRecords.byType).toHaveLength(1);
    expect(result.skippedRecords.byType[0]?.type).toHaveLength(MAX_SKIPPED_TYPE_CHARS);
    expect(result.skippedRecords.count).toBe(1);
  });
});
