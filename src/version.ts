import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * The package version, read from package.json at load time.
 *
 * Read rather than hardcoded so a release cannot ship a CLI that reports the
 * wrong version: `changeset version` bumps only package.json, and a stale
 * constant here is exactly how 0.1.0 nearly shipped announcing itself as
 * 0.0.0. Kept in its own module so both the library entry and the CLI can
 * read it without either importing the other.
 *
 * The relative path holds in both worlds this module lives in: bundled under
 * `dist/` and as source under `src/`, package.json is one directory up.
 */
export const VERSION: string = require("../package.json").version;
