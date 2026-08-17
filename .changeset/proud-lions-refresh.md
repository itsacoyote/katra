---
"@itsacoyote/katra": minor
---

Add `katra refresh` and built-in GitHub/Linear providers — external refs get live status. `refresh` resolves every ref linked to open work (or just the tasks you name) through the spec's provider seam: GitHub via your already-authenticated `gh`, Linear via its API with `LINEAR_API_KEY` in the environment. Real changes fill the cached status/title `show` and `brief` now render and land in task history as `ref-status-changed` events; unchanged refs just bump their sync time; offline, unauthenticated, or unknown-provider refs degrade to a named reason and the command still exits 0 — resolution failing is a state, not an error. Nothing here ever moves a task: acting on refreshed status is reconcile's job, a later, explicit command. Providers are compiled in rather than discovered (ADR-015), the interface has no write method by construction, and migration 0006 widens the event vocabulary; existing stores upgrade in place on open.
