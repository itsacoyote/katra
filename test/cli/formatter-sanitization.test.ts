/**
 * Recurrence guard for katra-9aw.47: the title / close-reason sanitization
 * class (an ANSI escape, an embedded newline, a bidi override, or a
 * zero-width char surviving unsanitized into terminal output) must not be
 * able to silently come back in any command-local formatter — existing or
 * future.
 *
 * This scans every `src/cli/commands/*.ts` file and fails, naming the file
 * and the offending interpolation, if any `${…}` interpolation referencing
 * `.title` or `.closeReason` lacks a `oneLine(` / `sanitizeBody(` wrap.
 *
 * SCOPE: this guard covers `src/cli/commands/*.ts` ONLY. `src/cli/format.ts`
 * (formatBoard/formatBrief/formatTaskList/…) is the sanitized *reference* and
 * is deliberately out of this guard's reach — it routes titles through a
 * local `text` alias (see format.ts:41), and this literal-`oneLine(` check
 * cannot fold an alias in (see the residual-limits note below). Req 6's
 * "cannot recur" is scoped to command-local formatters, not format.ts.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// --- comment stripping -------------------------------------------------

/**
 * Strips block comments entirely, and strips a `//` line comment only when
 * `//` is the first non-whitespace content on its line — never a `//`
 * appearing later in the line.
 *
 * Mirrors `test/core/providers.test.ts`'s `stripComments()`, not
 * `test/index.test.ts`'s `code()` (which strips every `//` to line-end and
 * would corrupt a `https://` string literal a command file may carry).
 * reconcile.ts:26,32,110, migrate.ts, and refresh.ts all mention `.title` /
 * `oneLine(` in doc prose that must neither satisfy nor trip this check —
 * comments have to go before matching. The scanner below only ever inspects
 * text found *inside* a `${…}` interpolation, so guarding against a
 * commented-out interpolation is the only thing comment-stripping needs to
 * do here; the URL-safe, full-line-only stripper is sufficient and doesn't
 * need `code()`'s more aggressive (and here, unnecessary) line truncation.
 */
function stripComments(source: string): string {
  const withoutBlockComments = source.replaceAll(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlockComments
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");
}

// --- interpolation extraction -------------------------------------------

/**
 * Extracts the text of every `${…}` interpolation in `source`, using a
 * brace-depth counter rather than a regex.
 *
 * `/\$\{[^}]*\}/` is wrong here: `[^}]` stops at the first inner `}`, so a
 * *nested* template literal or object/block literal inside an interpolation
 * truncates the match before the real content is seen — a silent false
 * negative. This codebase already writes nested interpolations (e.g.
 * `src/cli/format.ts:971`:
 * `` `  blocked by ${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""}` ``),
 * so the class is live and a naive regex would miss an unwrapped `.title`
 * sitting after the first inner `}`.
 *
 * From each `${`, depth starts at 1; every `{` increments it, every `}`
 * decrements it; the interpolation is the text spanning depth 1 -> 0.
 */
function extractInterpolations(source: string): string[] {
  const interpolations: string[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "$" || source[i + 1] !== "{") continue;

    let depth = 1;
    let j = i + 2;
    const start = j;
    while (j < source.length && depth > 0) {
      if (source[j] === "{") depth++;
      else if (source[j] === "}") depth--;
      if (depth > 0) j++;
    }
    interpolations.push(source.slice(start, j));
    i = j; // resume scanning right after this interpolation's true closing brace
  }
  return interpolations;
}

/**
 * `clamp(` alone does not satisfy this check: `clamp` bounds width, it does
 * not sanitize. The sanitized sites in this codebase read
 * `clamp(oneLine(x.title), W)` — `oneLine(` (or `sanitizeBody(` for the
 * rare multi-line field) has to appear literally inside the interpolation.
 */
const SENSITIVE_FIELD = /\.title\b|\.closeReason\b/;
const SANITIZER_CALL = /\boneLine\(|\bsanitizeBody\(/;

/**
 * Runs the guard's core check against one file's (already comment-stripped)
 * source and returns one formatted violation string per offending
 * interpolation. Factored out so the real command-file scan and the
 * nesting-blind self-proof fixture below exercise the exact same logic —
 * not a parallel copy that could drift from what actually runs.
 *
 * Documented residual limits (not closed by this guard, and not present
 * anywhere in the current tree):
 * - A `const { title } = task; … ${title}` destructuring, or a literal `}`
 *   inside a string argument, defeats a substring-keyed check like this one.
 *   Closing either would need a full AST parser — out of scope for a P2
 *   recurrence guard.
 * - This guard keys on the LITERAL `oneLine(` / `sanitizeBody(` call text.
 *   A sanitizer *alias* (e.g. `const id = (v) => oneLine(v)` at
 *   migrate.ts:130, or the `text` alias at format.ts:41) would trip this
 *   guard by design if a title were ever routed through it instead of
 *   `oneLine` directly — a loud false positive, not a silent miss. No
 *   command formatter currently wraps a title through an alias.
 */
function findUnwrappedSensitiveInterpolations(strippedSource: string, label: string): string[] {
  const violations: string[] = [];
  for (const interpolation of extractInterpolations(strippedSource)) {
    if (SENSITIVE_FIELD.test(interpolation) && !SANITIZER_CALL.test(interpolation)) {
      violations.push(`${label}: ${interpolation}`);
    }
  }
  return violations;
}

// --- command file enumeration -------------------------------------------

function commandSourceFiles(): { readonly root: string; readonly files: readonly string[] } {
  const root = fileURLToPath(new URL("../../src/cli/commands", import.meta.url));
  const files = readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"),
    )
    .map((entry) => entry.name);
  return { root, files };
}

// --- nesting-blind self-proof fixture ------------------------------------

/**
 * A known-bad inline fixture mirroring the shape of `format.ts:971`: an
 * outer interpolation whose *nested* template literal contains an inner
 * interpolation (`${task.id}`) followed, after that inner interpolation's
 * own closing brace, by an unwrapped `.title` reference.
 *
 * `/\$\{[^}]*\}/` starting at the outer `${` would consume up to (but not
 * past) the first raw `}` it meets — the inner interpolation's closing
 * brace right after `task.id` — and would never see the `.title` that comes
 * after it in the same outer interpolation. A brace-depth counter correctly
 * walks past that inner `}` (depth drops from 2 back to 1, not to 0) and
 * keeps reading until the outer interpolation's true closing brace, seeing
 * the unwrapped `.title` in between.
 */
const NESTED_UNWRAPPED_TITLE_FIXTURE = [
  "function formatFixture(task: { id: string; title: string }, flag: boolean): string {",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture text representing source, not a template literal to evaluate
  "  return `line ${flag ? `nested ${task.id}` : task.title}`;",
  "}",
].join("\n");

// --- tests ----------------------------------------------------------------

describe("command-local formatter title/close-reason sanitization", () => {
  it("no command-local formatter interpolates a stored .title/.closeReason without oneLine", () => {
    const { root, files } = commandSourceFiles();

    const violations = files.flatMap((file) => {
      const stripped = stripComments(readFileSync(join(root, file), "utf8"));
      return findUnwrappedSensitiveInterpolations(stripped, file);
    });

    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("the scanner is not nesting-blind — it flags an unwrapped .title inside a nested interpolation", () => {
    // No comment-stripping needed: the fixture carries no comments, and this
    // proves the extraction + wrap-check logic itself, not the stripper.
    const violations = findUnwrappedSensitiveInterpolations(
      NESTED_UNWRAPPED_TITLE_FIXTURE,
      "fixture",
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(".title");

    // Demonstrates the exact regression this guards against: the naive
    // `/\$\{[^}]*\}/` pattern truncates at the nested interpolation's own
    // closing brace (right after `task.id`) and never reaches the `.title`
    // that follows it in the same outer interpolation — a silent false
    // negative. The brace-depth scanner above does not have this blind spot.
    const naiveMatch = /\$\{([^}]*)\}/.exec(NESTED_UNWRAPPED_TITLE_FIXTURE);
    expect(naiveMatch?.[1]).not.toContain(".title");
  });

  it("the scanner sees every command file — guards against a vacuous pass", () => {
    const { files } = commandSourceFiles();
    // 26 command files exist today; 15 is a safe floor so a broken or
    // over-narrow directory/extension filter cannot pass this suite by
    // silently scanning zero (or too few) files.
    expect(files.length).toBeGreaterThanOrEqual(15);
  });
});
