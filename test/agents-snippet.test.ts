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
  it("names only registered commands, subcommands included", () => {
    const text = readFileSync(SNIPPET, "utf8");
    // The optional second word catches `note add` — the snippet's most
    // fragile instruction — not just its parent. `<id>` and `--flag` tokens
    // cannot match `[a-z]`, so they never read as a false subcommand.
    const mentioned = [...text.matchAll(/`katra ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g)].map(
      (match) => [match[1] as string, match[2]] as const,
    );

    // A regex that matches nothing verifies nothing — the guard must prove it
    // found the snippet's commands before vouching for them.
    expect(mentioned.length).toBeGreaterThanOrEqual(4);

    const program = createProgram({ cwd: process.cwd() });
    for (const [name, sub] of mentioned) {
      const command = program.commands.find((candidate) => candidate.name() === name);
      expect(command, `snippet names \`katra ${name}\`, which is not a command`).toBeDefined();
      if (command !== undefined && sub !== undefined && command.commands.length > 0) {
        expect(
          command.commands.map((candidate) => candidate.name()),
          `snippet names \`katra ${name} ${sub}\`, which is not a subcommand`,
        ).toContain(sub);
      }
    }
  });
});
