/**
 * Every migration, in order.
 *
 * Later features append their own step here rather than issuing
 * `CREATE TABLE IF NOT EXISTS` at startup — the version is what makes a schema
 * change reviewable and a partially-applied one impossible.
 */

import type { Migration } from "../migrate.js";
import { migration0001 } from "./0001-init.js";
import { migration0002 } from "./0002-events-and-notes.js";
import { migration0003 } from "./0003-claims-and-presence.js";
import { migration0004 } from "./0004-search-index.js";
import { migration0005 } from "./0005-refs.js";

export const MIGRATIONS: readonly Migration[] = [
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
];

export { buildInitDdl, DEFAULT_SCHEMA_SETS, type SchemaSets } from "./0001-init.js";
export {
  buildEventsDdl,
  DEFAULT_EVENT_SETS,
  type EventSets,
} from "./0002-events-and-notes.js";
export {
  buildClaimsAndPresenceDdl,
  type ClaimsAndPresenceSets,
  DEFAULT_CLAIMS_AND_PRESENCE_SETS,
} from "./0003-claims-and-presence.js";
// buildSearchIndexDdl is deliberately not re-exported here: 0004 takes no
// Sets argument (see its own docstring), so unlike the other builders in this
// barrel it has no sentinel-injection test to import it. This comment used to
// guess that a barrel export with no consumer is exactly what 0005 would
// cargo-cult — it wasn't: buildRefsDdl below widens the events CHECK from an
// eventTypes Sets object exactly like 0002/0003, so it earns the same
// re-export they get. Import buildSearchIndexDdl directly from
// "./0004-search-index.js" if a real use ever needs it.
export {
  buildRefsDdl,
  DEFAULT_REFS_SETS,
  type RefsSets,
} from "./0005-refs.js";
