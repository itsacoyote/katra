/**
 * The agent instructions name only commands that exist.
 *
 * `docs/agents-snippet.md` is what a consumer repository pastes into its
 * `AGENTS.md`, so a command named there and not registered sends every agent
 * session into a command-not-found. The spec's Tier-0 text mentions `claim`
 * and `release` before F4 builds them — this is the guard that keeps the
 * snippet honest until then, and it is meant to fail when F4's documentation
 * pass adds those words before the commands land.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createProgram } from "../src/cli/program.js";

const SNIPPET = fileURLToPath(new URL("../docs/agents-snippet.md", import.meta.url));

describe("docs/agents-snippet.md", () => {
  it("names only registered commands", () => {
    const text = readFileSync(SNIPPET, "utf8");
    const mentioned = new Set(
      [...text.matchAll(/`katra ([a-z][a-z-]*)/g)].map((match) => match[1] as string),
    );

    // A regex that matches nothing verifies nothing — the guard must prove it
    // found the snippet's commands before vouching for them.
    expect(mentioned.size).toBeGreaterThanOrEqual(4);

    const registered = new Set(
      createProgram({ cwd: process.cwd() }).commands.map((command) => command.name()),
    );
    for (const name of mentioned) {
      expect(registered, `snippet names \`katra ${name}\`, which is not a command`).toContain(name);
    }
  });
});
