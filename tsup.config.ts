import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  // Declarations are emitted by `tsc -p tsconfig.build.json` instead of tsup's
  // dts step: tsup delegates to rollup-plugin-dts, which pins its own
  // TypeScript internally and breaks against TS 7.
  dts: false,
  sourcemap: true,
  clean: true,
  // better-sqlite3 is a native addon — never bundle it.
  external: ["better-sqlite3"],
});
