# ADR-005: Separate a katra fault from a refused request, in the error union and in the exit code

## Status

Accepted

## Date

2026-08-03

## Supersedes

Extends the four exit codes fixed in `docs/katra-spec.md` §11 (requirement 49), and the `KatraErrorDetail` union it describes.

## Context

katra defined four exit codes:

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | user error — the request was understood and refused |
| 2 | usage — the invocation itself was malformed |
| 3 | conflict — legal request, but the current state refuses it |

Everything the core throws deliberately is a `KatraException` carrying a `KatraErrorDetail`, and `output.ts` maps its `code` to one of those four. Anything else caught at the CLI boundary — an unwritable database, a corrupt file, a genuine bug — was reported as `katra: internal error: …` and **also exited 1**.

Two problems follow, and both bite katra's primary reader hardest.

**An agent cannot branch on the result.** Exit 1 is defined as "your request was refused". A refusal is final: retrying it verbatim produces the same answer, and the correct response is to change the request or give up. A read-only store is the opposite — the request was fine, the machine is not, and the correct response is to retry or escalate to a human. Collapsing both into 1 leaves no way to tell them apart except by parsing the message, which is exactly what the structured contract exists to avoid.

**The published type lied.** The `--json` envelope emitted `{"error": {"code": "internal", …}}`, but `"internal"` was not a member of `KatraErrorDetail`. A consumer switching exhaustively over the union — which the `never` checks throughout the codebase actively encourage — hit a value the type said could not exist. The union claimed to be closed and was not.

Adding a fifth exit code is not free. Four codes are easy to hold in your head and the spec presents them as a fixed set, so a fifth is a real cost to weigh against a real defect.

## Decision

**Add `internal` as a fifth exit code (4), and as a member of `KatraErrorDetail`.**

```ts
export const EXIT = { ok: 0, user: 1, usage: 2, conflict: 3, internal: 4 } as const;
```

```ts
| { readonly code: "internal"; readonly message: string };
```

It is **not** a member of `KATRA_ERROR_CODES`, and nothing in `src/core/` throws it. That asymmetry is deliberate and is the whole shape of the decision:

- `KATRA_ERROR_CODES` is *"the failures katra raises on purpose"*. A fault is by definition not one of those, so putting it in the array would make `EXIT_FOR_ERROR`'s `satisfies Record<KatraErrorCode, number>` demand a mapping for something the core never produces.
- `KatraErrorDetail` is *"what the `--json` error envelope can contain"*. The envelope really can contain it, so the union has to admit it or it is describing a shape the CLI does not emit.

`internal` carries only a message. There is nothing structured to offer: unlike `ambiguous_id`'s candidates or `cycle`'s path, a fault has no "what would unblock this" — the answer is always "retry, or fix the machine".

## Consequences

- An agent can distinguish *do not retry* (1, 2, 3) from *retry or escalate* (4) without reading prose.
- `exitCodeFor` handles `internal` outside the `satisfies`-checked table, so adding a genuine `KatraErrorCode` without a mapping is still a compile error.
- The spec's "four exit codes" wording is superseded. `docs/f1-traceability.md` criterion 29 continues to exercise the original four on real paths, with two further tests covering the fifth.
- Every future surface — an MCP server, a library API — inherits the distinction, because it lives in the shared error union rather than in the CLI.

## Alternatives considered

**Leave both at 1.** Rejected: it is the status quo, and the failure it causes is silent. An agent that treats a read-only store as a refusal abandons work that would have succeeded a second later.

**Reuse 2 (usage) for faults.** Rejected: 2 means *you typed it wrong*, which is actively misleading for a disk error and would send an agent into rewriting a command that was already correct.

**Keep the union closed and emit a different envelope shape for faults** — say `{"fault": {…}}` rather than `{"error": {…}}`. Rejected: it forces every consumer to check two shapes on every call to learn whether anything went wrong, to save one union member. The single envelope with a discriminated `code` is the simpler contract.
