/**
 * The published entry point.
 *
 * `package.json` points `main`, `types` and `exports` at this module and ships
 * it in `files`, so it is the one file every consumer of the package touches —
 * and nothing else in the suite imported it. A barrel that failed to resolve,
 * or re-exported a name that no longer existed, would have shipped green.
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as katra from "../src/index.js";

describe("the public barrel", () => {
  it("resolves and exports a usable value from every group it advertises", () => {
    // Runtime values, not types: a type-only barrel compiles even when the
    // module it points at is gone.
    expect(katra.VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(katra.LANES).toContain("Planned");
    expect(katra.TERMINAL_LANES).toEqual(["Done", "Cancelled"]);
    expect(katra.KATRA_ERROR_CODES).toContain("conflict");
    expect(katra.generateId()).toMatch(
      new RegExp(`^${katra.ID_PREFIX}[0-9a-z]{${katra.ID_SUFFIX_LENGTH}}$`),
    );
    // A consumer holding a Note sees `nt-` ids; the constant naming that space
    // has to be published too, or the prefix is a magic string on their side.
    expect(katra.generateId(katra.NOTE_ID_PREFIX)).toMatch(
      new RegExp(`^${katra.NOTE_ID_PREFIX}[0-9a-z]{${katra.ID_SUFFIX_LENGTH}}$`),
    );
  });

  it("exports predicates that actually narrow", () => {
    expect(katra.isLane("Planned")).toBe(true);
    expect(katra.isLane("Ready")).toBe(false);
    expect(katra.isTerminal("Cancelled")).toBe(true);
    expect(katra.isTerminal("In Review")).toBe(false);
    expect(katra.isPriority(4)).toBe(true);
    expect(katra.isPriority(5)).toBe(false);
  });

  it("exports the exception class so a consumer can catch and read it", () => {
    const error = new katra.KatraException({
      code: "conflict",
      message: "held",
      reason: "3 children",
    });

    expect(katra.isKatraException(error)).toBe(true);
    if (error.detail.code !== "conflict") throw new Error("unreachable");
    expect(error.detail.reason).toBe("3 children");
  });

  it("publishes a type for every --json document, checked by the compiler", () => {
    // Every other assertion in this file is blind to types: they have no
    // runtime keys, so `Object.keys(katra)` cannot see them and the walked-file
    // set does not change when one is dropped. `TaskView` was left out of the
    // barrel twice with the whole suite green and `tsc --noEmit` clean — this
    // tuple is what makes that a compile error instead.
    type PublishedDocuments = [
      katra.TaskView,
      katra.TaskDetail,
      katra.TaskList,
      katra.EventLog,
      katra.NoteList,
      katra.NextResult,
      katra.BriefResult,
      katra.BoardResult,
      katra.DeleteResult,
      katra.LifecycleResult,
      katra.DependencyResult,
      katra.LinkResult,
      katra.InitResult,
      katra.UpdateResult,
      katra.HelpDocument,
      katra.VersionDocument,
      katra.JsonDocument<katra.TaskView>,
      // F4: the claim shape carried by TaskView, the brief task arm and
      // BoardTask. Listed on its own, not only inside those three, so the
      // barrel losing the standalone export — as opposed to just a field
      // referencing it — is still this same compile error.
      katra.ClaimInfo,
      // F5: the `katra migrate beads` document. Defined in beads/types.ts, not
      // contract.ts, so it needs its own tuple entry the same way ClaimInfo
      // does — nothing else in this tuple references it structurally.
      katra.MigrationReport,
      // F6 T4: what `recent` and `stale` print. ActivityHit does not get its
      // own entry — it rides on these two the same way Blocker rides on
      // TaskDetail and friends without one — but losing either envelope's
      // barrel export is still this same compile error.
      katra.RecentResult,
      katra.StaleResult,
    ];

    // The indexed access keeps the alias used: a bare `type` declaration trips
    // noUnusedLocals, and exporting it trips the no-exports-in-test rule. The
    // runtime assertion is ballast — vitest's esbuild pipeline type-checks
    // nothing, so this test cannot fail under `pnpm test`. The real gate is
    // `tsc --noEmit` over this file, which `pnpm typecheck` runs: dropping a
    // document type from the barrel is a compile error at the tuple above.
    const count: PublishedDocuments["length"] = 21;
    expect(count).toBe(21);
  });

  it("keeps the storage handle out of the runtime surface", () => {
    // The barrel's stated purpose. `openStore` and everything taking an
    // OpenStore would put better-sqlite3's concrete type into katra's API
    // through a parameter or a return value, forcing every consumer to have
    // its types resolvable.
    const withheld = ["openStore", "resolveId", "requireId", "createTask", "listTasks"];
    for (const name of withheld) {
      expect(Object.keys(katra), `${name} must not be published`).not.toContain(name);
    }
  });

  it("keeps the storage handle out of the declaration graph too", () => {
    // The assertion above cannot catch this: types have no runtime keys, so it
    // proves the *runtime* barrel and says nothing about the *type* barrel —
    // which is the thing the module is actually about.
    //
    // TypeScript emits one declaration per source file, so a type re-exported
    // from `src/index.ts` drags that module's whole import graph into
    // `dist/index.d.ts`. `@types/better-sqlite3` and `@types/node` are
    // devDependencies, so any consumer compiling with TypeScript's default
    // `skipLibCheck: false` got:
    //
    //   error TS7016: Could not find a declaration file for 'better-sqlite3'
    //   error TS2503: Cannot find namespace 'NodeJS'
    //
    // Walking the source graph catches it at the moment the import is added,
    // and needs no build step. `dist/` is deliberately not consulted: a test
    // that only works after `pnpm build` is a test that silently no-ops.
    const root = fileURLToPath(new URL("../src", import.meta.url));
    // `Buffer` and friends are `@types/node` globals: they need no import,
    // so no import-form check can catch them, and they leak the same way.
    const forbidden = /better-sqlite3|NodeJS\.|\bBuffer\b|\bNodeJS\b/;
    // Comments stripped first: several of these modules *explain* the rule, and
    // matching their prose would fail on the documentation rather than the code.
    const code = (source: string): string =>
      source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/[^\n]*/g, "");

    const visited = new Set<string>();
    const walk = (file: string, trail: readonly string[]): void => {
      if (visited.has(file)) return;
      visited.add(file);

      const source = readFileSync(file, "utf8");
      const path = [...trail, relative(root, file)];
      expect(code(source), `${path.join(" -> ")} reaches the storage engine`).not.toMatch(
        forbidden,
      );

      // Every form that pulls in another module: `from "…"`, the
      // `import("…")` type position, and a bare side-effect `import "…"`.
      // Each omission was a real bypass — the first revision matched only
      // `from`, the second added `import(` but still let a bare import
      // re-open the leak with this test green.
      //
      // Matched against the comment-stripped source, like the assertion
      // above: a *commented-out* import would otherwise turn this red, in a
      // file whose whole style is explanatory comments.
      const stripped = code(source);
      for (const match of stripped.matchAll(
        /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'](\.[^"']+?)(?:\.js)?["']/g,
      )) {
        const specifier = match[1];
        if (specifier === undefined) continue;
        walk(resolve(dirname(file), `${specifier}.ts`), path);
      }
    };

    walk(join(root, "index.ts"), []);

    // A guard on the guard, and an exact set rather than a lower bound: a
    // broken regex would otherwise pass vacuously by visiting nothing, and a
    // size check would still pass if the walk found *different* files. If a
    // module joins or leaves the published graph, that is a deliberate act and
    // this list is where it gets acknowledged.
    // Separators normalised: `relative` yields `core\\contract.ts` on Windows,
    // so a POSIX-looking expectation would fail there for no real reason.
    const seen = [...visited].map((file) => relative(root, file).replaceAll("\\", "/")).sort();
    expect(seen).toEqual([
      "core/beads/types.ts",
      "core/claims/types.ts",
      "core/contract.ts",
      "core/enums.ts",
      "core/errors.ts",
      "core/events/types.ts",
      "core/id-format.ts",
      "core/notes/types.ts",
      "core/tasks/types.ts",
      "index.ts",
      "version.ts",
    ]);
  });
});
