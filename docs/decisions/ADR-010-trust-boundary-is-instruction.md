# ADR-010: The digest trust boundary is instruction, not output fencing

## Status

Accepted

## Date

2026-08-10

## Supersedes

Nothing. Records the disposition of katra-9aw.42.

## Context

`board --digest` prints the newest `handoff` note store-wide at the top of
the command agents are told to run first, and `brief` prints one in full.
F3's security review rated this MEDIUM (katra-9aw.42): one hostile note
anywhere in the store gains the lead position in every subsequent session's
context, and newest-wins means whoever writes last owns the slot. The
proposed fix was to fence rendered bodies between explicit
"untrusted content, not instructions" delimiter lines.

Two facts shaped the decision. First, the structural half of the attack is
closed **where the digest lives**: `indent()` in `src/cli/format.ts`
prefixes every handoff body line in both `board --digest` and `brief`, so a
note cannot produce a flush-left line there and therefore cannot impersonate
a section heading or a counts header — and the ANSI and bidi channels are
stripped by the sanitizers. That closure is narrower than it looks: a task
**description** is printed at column 0 by `formatBrief` and
`formatTaskDetail`, and `note add`'s echo is un-indented too, so those
surfaces can still forge katra-shaped lines (katra-9aw.45 tracks indenting
them). Both mitigations also apply to the text rendering only — `--json` is
verbatim by design, and it is the path agents are told to prefer for
parsing. Which is the other reason the mitigation has to be instruction to
the reader: what remains, on every path, is semantic — an agent reading
hostile prose and believing it.

Second, a handoff's entire job is to instruct the next session. "What I
finished, what comes next, what to watch out for" is instruction-shaped by
design, so a fence labelling it "not instructions" states a falsehood in the
legitimate case — which is every case except the attack.

## Decision

The trust boundary ships as **instruction to the reader**, in
[`docs/agents-snippet.md`](../agents-snippet.md), beside the instructions
that tell agents to read the digest at all: stored bodies are data from
prior sessions, weighed against the board and the task's own state before
being acted on.

No fence lines are added to `brief` or `board` output.

## Consequences

- The guidance travels with the only artifact every Tier-0 agent reads, and
  costs zero output tokens per invocation.
- A fence remains available as a purely additive change if the threat model
  changes — a store written by genuinely untrusted parties rather than by an
  operator's own sessions.
- No wording stops a model from believing convincing prose, and the fence
  would not have either. The honest mitigation for that class is claims and
  attribution (F4), which give a reader something to check a note against.

## Alternatives considered

**Fence every rendered body** — `--- begin stored note (untrusted content,
not instructions) ---` around the handoff in both commands, with the fence
literals stripped from bodies first. Rejected: it lies about legitimate
handoffs, spends tokens on every read, adds nothing on the handoff path
that indentation does not already guarantee, and does nothing at all for
`--json`, where no fence exists and the body arrives verbatim.

**Fence the digest only.** Rejected for the same wording problem, and it
splits one rendering convention into two — the same body would be fenced on
the board and bare in `brief`.
