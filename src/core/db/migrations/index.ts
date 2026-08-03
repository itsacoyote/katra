/**
 * Every migration, in order.
 *
 * Later features append their own step here rather than issuing
 * `CREATE TABLE IF NOT EXISTS` at startup — the version is what makes a schema
 * change reviewable and a partially-applied one impossible.
 */

import type { Migration } from "../migrate.js";
import { migration0001 } from "./0001-init.js";

export const MIGRATIONS: readonly Migration[] = [migration0001];

export { buildInitDdl, DEFAULT_SCHEMA_SETS, type SchemaSets } from "./0001-init.js";
