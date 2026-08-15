---
"@itsacoyote/katra": patch
---

`katra --version` reads its answer from package.json at load time instead of a hardcoded constant, so a release can no longer ship a CLI that reports the previous version.
