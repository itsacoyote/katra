# ADR-006: `katra next` exits 0 when nothing is ready

## Status

Accepted

## Date

2026-08-04

## Supersedes

Acceptance criterion 26 in the F1 spec (`bd show katra-9aw.31`), which required `next` to exit **non-zero** when no task is ready. Depends on [ADR-005](ADR-005-internal-fault-exit-code.md), which fixed the meaning of each exit code.

## Context

`next` answers "of everything planned, what can I start right now?". When nothing can be started, it returned exit **1** so a script could branch with `katra next && …`.

ADR-005 then pinned down what each code means, and in doing so made that a contradiction. Its own reasoning:

> **An agent cannot branch on the result.** Exit 1 is defined as "your request was refused". A refusal is final: retrying it verbatim produces the same answer, and the correct response is to change the request or give up.

"Everything planned is blocked" is the exact opposite of final. It is the textbook *retry later*: close a blocker and the identical command returns a task. `AGENTS.md` now states the rule flatly — **1 must never mean "retry later"** — and `next` was the one command breaking it.

Codes 2 and 3 are no escape. ADR-005 groups 1, 2 and 3 together as *do not retry*; 2 means the invocation was malformed, and 3 means the current state refuses a well-formed request, which is nearly right but still says "refused" about a read that succeeded.

The deeper point is that **nothing failed**. `next` was asked a question, it looked, and the answer was "nothing yet". That is a successful read returning an empty result, and katra does not treat an empty `list` as an error either.

## Decision

**`next` always exits 0.** The distinction moves entirely into the payload, where it already lived:

```console
$ katra next --json
{ "status": "none", "blocked": [ { "id": "kt-…", "title": "stuck", "blockers": [ … ] } ] }
```

`status` discriminates `found` from `none`, and `blocked` distinguishes *everything is stuck* from *the backlog is empty* — the whole reason `NextResult` is a union rather than `Task | null`. In text mode the two read as `no Planned task is ready — 1 blocked:` and `nothing is in the Planned lane`.

A script branches on the document, not the exit code:

```bash
katra next --json | jq -e '.status == "found"' >/dev/null && echo "work available"
```

That is more typing than `katra next &&`, and it is the correct trade. katra's stated posture is that **agents are the primary reader and `--json` is the contract**; making the shell idiom cheaper at the cost of lying about what an exit code means is backwards for this tool.

## Consequences

- Every non-zero exit from katra now means the same thing: something is wrong. 1, 2 and 3 are final refusals; 4 is a fault worth retrying or escalating (ADR-005). No code means "ask again later".
- A shell one-liner branching on `next` must read the payload. This is the only ergonomic cost, and it is confined to text-mode shell use — the agent path was already reading JSON.
- Acceptance criterion 26 is superseded. `docs/f1-traceability.md` records the change and the tests assert exit 0 with the blocked set populated.
- `CliContext.setExitCode` now has no caller. It is kept: F4's `claim` needs exactly this channel — a legitimate but negative answer that must not become an error envelope — and deleting it now only means writing it again.

## Alternatives considered

**Keep exit 1 and soften ADR-005.** Rejected. The value of the exit-code taxonomy is that it is exact; an exception for one command turns "1 means do not retry" into "1 usually means do not retry", which an agent cannot act on. One command's shell ergonomics do not justify weakening the contract every command shares.

**Give `next` its own code, say 5, meaning "nothing available".** Rejected as the wrong axis. Exit codes describe *how a command failed*; this one succeeded. A fifth code for a successful read would be the only such code, and the next command needing the same distinction (`claim`, `brief`) would want its own, which is how a small fixed set becomes an unreadable one.

**Exit 3 (conflict).** Rejected: 3 says the current state refuses a well-formed request. Nothing was refused — the answer is simply empty — and ADR-005 already groups 3 with "do not retry".
