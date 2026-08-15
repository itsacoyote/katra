# ADR-014: Core parses well-known ref URLs without providers

## Status

Accepted

## Date

2026-08-15

## Context

F7 adds external references (spec §4, §7): a task links to a GitHub PR or a
Linear issue, stored provider-agnostically as `{provider, qualified id, url,
cached fields}`. Spec §7 assigns `parse(url) → ref` to *provider plugins* —
core, in that reading, only ever accepts fully qualified input
(`--provider github --id owner/repo#12`).

But the dominant interaction is an agent pasting a URL at the moment it opens
or merges a PR, and the provider cycles (.21/.22) that would make pasting work
are several features away. Requiring explicit flags for the two trackers we
have already decided to support first (GitHub and Linear — settling part of
katra-9aw.6) would make the common case the clumsy case for the entire gap
between F7 and the provider work.

Recognizing `github.com` and `linear.app` URLs is pure string work: no
network, no auth, no CLI dependency — none of the reasons `resolve()` must
live in a plugin apply to `parse()` for hosts whose URL shapes are stable and
public.

## Decision

Core ships built-in recognition for exactly two hosts:

- `github.com/{owner}/{repo}/pull/{n}` and `…/issues/{n}` → provider
  `github`, id `owner/repo#n`
- `linear.app/{workspace}/issue/{TEAM-123}[/…]` → provider `linear`, id
  `TEAM-123`

plus their bare-id forms (`owner/repo#n`, `TEAM-123`). Every other URL
refuses with the explicit escape hatch (`--provider --id [--url]`), which
stores any provider name verbatim — core stays provider-agnostic in what it
*stores*, opinionated only in what it *parses*.

Provider plugins keep `parse(url)` in their future interface; a provider may
extend recognition to new hosts, and core's table never blocks that.

## Consequences

- Pasting a GitHub or Linear URL works from F7 on, with zero plugins and zero
  network — the storage feature is immediately usable, not scaffolding.
- Core carries host-specific knowledge: a small, table-driven parser that
  must change in a core release if either host reshapes its URLs, and new
  major hosts (GitLab, Jira) wait for either a core addition or the provider
  interface. Accepted: two stable URL shapes are cheap; a plugin system is
  not.
- The refusal path is the contract's edge: unknown URLs never guess. A typo'd
  host cannot silently store a junk ref, at the cost of one re-run with
  flags.
- Spec §7's provider-owned `parse()` is narrowed, not contradicted — this ADR
  is the record of that divergence.
