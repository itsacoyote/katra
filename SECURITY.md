# Security Policy

## Supported versions

katra is pre-alpha. Only the latest published version receives fixes.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report it privately through GitHub's [private vulnerability reporting](https://github.com/itsacoyote/katra/security/advisories/new) on this repository. Include:

- what the issue is and how it can be triggered
- the katra version, OS, and Node version
- a proof of concept if you have one

You can expect an initial response within a week.

## Scope notes

katra is a local, daemon-free CLI with no network listener. The areas most worth scrutiny are:

- **Provider plugins**, which execute external commands (e.g. the `gh` CLI) and handle tokens.
- **The SQLite store** under the repo's git dir, and anything that could let untrusted input reach it as SQL.
- **Agent hook adapters**, which run automatically at session lifecycle points.

Note that katra **never writes to external trackers** by design, so write-back is not an attack surface — if you find a path that does write outward, that is itself the bug.
