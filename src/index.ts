/**
 * katra — library core.
 *
 * Everything katra can do lives here as plain TypeScript. The CLI in `cli.ts`
 * is a thin wrapper over this module, which keeps a future MCP surface a
 * wrapper rather than a rewrite (see docs/katra-spec.md §8).
 *
 * Nothing is implemented yet — the design session comes first.
 */

/** Package version, injected at build time from package.json. */
export const VERSION = "0.0.0";

/** Placeholder so the build, types, and tests have something real to bite on. */
export function describe(): string {
  return "katra — local, git-native, agent-first project manager";
}
