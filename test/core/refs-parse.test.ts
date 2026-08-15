import { describe, expect, it } from "vitest";
import {
  MAX_EXTERNAL_ID_LENGTH,
  MAX_INPUT_LENGTH,
  MAX_PROVIDER_LENGTH,
  MAX_URL_LENGTH,
  parseRefInput,
  validateExplicitRef,
} from "../../src/core/refs/parse.js";
import type { ParsedRef, ParseRefResult } from "../../src/core/refs/types.js";

/** Narrows a recognized result, failing loudly if the input refused instead. */
function unwrap(result: ParseRefResult): ParsedRef {
  if (!result.recognized) {
    throw new Error(`expected recognized, got refusal: ${result.message}`);
  }
  return result.ref;
}

/** Narrows a refusal, failing loudly if the input was recognized instead. */
function unwrapRefusal(result: ParseRefResult): string {
  if (result.recognized) {
    throw new Error(`expected refusal, got recognized: ${JSON.stringify(result.ref)}`);
  }
  return result.message;
}

/**
 * Hostile probe strings built from `String.fromCharCode` rather than escape
 * literals, per house rule: raw control bytes never appear as literals in a
 * committed file. Covers NUL, a C0 control, DEL, the RLO bidi override
 * (Trojan Source), and quote/backtick characters — both standalone and
 * embedded inside otherwise-plausible ref shapes.
 */
const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const ESC = String.fromCharCode(0x1b);
const DEL = String.fromCharCode(127);
const RLO = String.fromCharCode(0x202e);
const DQUOTE = String.fromCharCode(34);
const SQUOTE = String.fromCharCode(39);
const BACKTICK = String.fromCharCode(96);

const HOSTILE_CORPUS: readonly string[] = [
  NUL,
  BEL,
  DEL,
  RLO,
  DQUOTE,
  SQUOTE,
  BACKTICK,
  `owner/repo${NUL}#1`,
  `${RLO}owner/repo#1`,
  `TEAM${NUL}-123`,
  `${DQUOTE}owner/repo#1${DQUOTE}`,
  `${SQUOTE}; DROP TABLE refs; --`,
  `https://github.com/${NUL}/repo/pull/1`,
  `https://github.com/owner/repo/pull/1${RLO}`,
  `${BACKTICK}rm -rf /${BACKTICK}`,
  `owner${BEL}/repo#1`,
  // A homograph attempt built from a raw byte rather than a source literal,
  // combined with plain text around it.
  `https://${RLO}github.com/owner/repo/pull/1`,
];

describe("parseRefInput", () => {
  it("recognizes every GitHub PR URL variant identically (canonical table)", () => {
    const expected: ParsedRef = {
      provider: "github",
      externalId: "owner/repo#42",
      url: "https://github.com/owner/repo/pull/42",
    };

    const variants = [
      "https://github.com/Owner/Repo/pull/42",
      "https://github.com/Owner/Repo/pull/42/files",
      "https://github.com/Owner/Repo/pull/42?utm_source=share",
      "https://github.com/Owner/Repo/pull/42#discussion_r123",
      "https://www.github.com/Owner/Repo/pull/42",
      "https://GITHUB.COM/Owner/Repo/pull/42",
      "http://github.com/Owner/Repo/pull/42",
    ];

    for (const variant of variants) {
      expect(unwrap(parseRefInput(variant)), variant).toEqual(expected);
    }
  });

  it("round-trips bare github and linear ids, deriving /issues/ never /pull/", () => {
    const github = unwrap(parseRefInput("owner/repo#42"));
    expect(github).toEqual({
      provider: "github",
      externalId: "owner/repo#42",
      url: "https://github.com/owner/repo/issues/42",
    });

    const linear = unwrap(parseRefInput("ENG-451"));
    expect(linear).toEqual({ provider: "linear", externalId: "ENG-451", url: null });

    // Feeding the derived url straight back in must reproduce the same
    // externalId — a genuine round trip, not just a plausible-looking one.
    expect(github.url).not.toBeNull();
    const reparsed = unwrap(parseRefInput(github.url as string));
    expect(reparsed.externalId).toBe(github.externalId);
  });

  it("refuses a git@ SSH remote without throwing", () => {
    expect(() => parseRefInput("git@github.com:owner/repo.git")).not.toThrow();
    const message = unwrapRefusal(parseRefInput("git@github.com:owner/repo.git"));
    expect(message).toContain("--provider");
  });

  it("refuses lookalike hosts (github.com.evil.com, evil-github.com)", () => {
    expect(unwrapRefusal(parseRefInput("https://github.com.evil.com/owner/repo/pull/1"))).toContain(
      "--provider",
    );
    expect(unwrapRefusal(parseRefInput("https://evil-github.com/owner/repo/pull/1"))).toContain(
      "--provider",
    );
  });

  it("refuses a punycode/IDN homograph host", () => {
    // Latin small letter script g (U+0261) in place of ASCII "g" — the
    // WHATWG URL parser converts this to its punycode form before this
    // function ever sees `hostname`, so the exact-match against the literal
    // ASCII "github.com" refuses it without decoding punycode itself.
    const homograph = "https://ɡithub.com/owner/repo/pull/1";
    const url = new URL(homograph);
    expect(url.hostname).not.toBe("github.com");
    expect(url.hostname.startsWith("xn--")).toBe(true);

    expect(() => parseRefInput(homograph)).not.toThrow();
    expect(unwrapRefusal(parseRefInput(homograph))).toContain("--provider");
  });

  it("drops credentials from a credentialed URL and refuses an explicit port", () => {
    const withCredentials = unwrap(parseRefInput("https://user:pass@github.com/owner/repo/pull/1"));
    expect(withCredentials).toEqual({
      provider: "github",
      externalId: "owner/repo#1",
      url: "https://github.com/owner/repo/pull/1",
    });

    expect(
      unwrapRefusal(parseRefInput("https://user:pass@github.com:8080/owner/repo/pull/1")),
    ).toContain("port");
  });

  it("refuses a 10,000-character input fast", () => {
    const huge = "a".repeat(10_000);
    const start = performance.now();
    const result = parseRefInput(huge);
    const elapsed = performance.now() - start;

    expect(result.recognized).toBe(false);
    expect(elapsed).toBeLessThan(100);
  });

  it("never throws on a hostile byte corpus (control bytes, RLO, NUL, quotes)", () => {
    for (const input of HOSTILE_CORPUS) {
      expect(() => parseRefInput(input), `threw for ${JSON.stringify(input)}`).not.toThrow();
    }
  });

  it("parses a dotted owner segment (my.repo)", () => {
    expect(unwrap(parseRefInput("my.repo/other#5"))).toEqual({
      provider: "github",
      externalId: "my.repo/other#5",
      url: "https://github.com/my.repo/other/issues/5",
    });

    expect(unwrap(parseRefInput("https://github.com/my.repo/other2/pull/9"))).toEqual({
      provider: "github",
      externalId: "my.repo/other2#9",
      url: "https://github.com/my.repo/other2/pull/9",
    });
  });

  it("classifies KT-451 as linear, never task-id shaped", () => {
    expect(unwrap(parseRefInput("KT-451"))).toEqual({
      provider: "linear",
      externalId: "KT-451",
      url: null,
    });

    // A real katra task id has a base36 (letter-bearing) suffix, not an
    // all-digit one — this never matches the linear grammar, which requires
    // digits after the hyphen. Distinct shapes, no accidental collision.
    expect(parseRefInput("kt-9nfn9v").recognized).toBe(false);
  });

  it("discriminates the 2048 input-cap boundary", () => {
    const atCap = "a".repeat(MAX_INPUT_LENGTH);
    const overCap = "a".repeat(MAX_INPUT_LENGTH + 1);

    // At the cap: the input is short enough to reach grammar matching, and
    // a run of "a" matches no grammar, so it refuses for that reason.
    const atCapMessage = unwrapRefusal(parseRefInput(atCap));
    expect(atCapMessage).toContain("not a recognized");

    // One character past: refused by the length gate itself, before any
    // regex or URL parse — a distinguishable refusal reason.
    const overCapMessage = unwrapRefusal(parseRefInput(overCap));
    expect(overCapMessage).toContain(`exceeds ${MAX_INPUT_LENGTH} characters`);
  });

  it("accepts a derived external id at 256 chars, refuses at 257 (from a URL path)", () => {
    // externalId = `${owner}/${repo}#1` -> length = owner.length + repo.length + 3.
    const repoLength = 10;
    const githubUrlFor = (externalIdLength: number): string => {
      const ownerLength = externalIdLength - 3 - repoLength;
      const owner = "o".repeat(ownerLength);
      const repo = "r".repeat(repoLength);
      return `https://github.com/${owner}/${repo}/pull/1`;
    };

    const atBound = unwrap(parseRefInput(githubUrlFor(MAX_EXTERNAL_ID_LENGTH)));
    expect(atBound.externalId).toHaveLength(MAX_EXTERNAL_ID_LENGTH);

    const overBound = unwrapRefusal(parseRefInput(githubUrlFor(MAX_EXTERNAL_ID_LENGTH + 1)));
    expect(overBound).toContain(`exceeds ${MAX_EXTERNAL_ID_LENGTH} characters`);
  });

  it("refuses a bare owner/repo#n whose derived url exceeds 2048", () => {
    // owner/repo long enough that the raw bare input still clears the 2048
    // input cap, but the reconstructed /issues/ url does not.
    const owner = "o".repeat(1010);
    const repo = "r".repeat(1010);
    const bare = `${owner}/${repo}#1`;
    expect(bare.length).toBeLessThan(MAX_INPUT_LENGTH);

    const message = unwrapRefusal(parseRefInput(bare));
    expect(message).toContain(`exceeds ${MAX_URL_LENGTH} characters`);
  });

  it("refuses a percent-encoded path-segment splice attempt", () => {
    // A decoded "%2F"/"%23"/"%3F" inside a single path segment used to
    // splice extra components into the stored externalId — the segment
    // decodes to "victim/repo/settings/secrets?z", which isCleanSegment now
    // rejects outright rather than handing to the owner/repo grammar.
    const splice = "https://github.com/victim%2Frepo%2Fsettings%2Fsecrets%3Fz/x/pull/1";
    expect(parseRefInput(splice).recognized).toBe(false);

    // %23 decoding to a literal "#" mid-segment.
    expect(parseRefInput("https://github.com/owner/re%23po/pull/1").recognized).toBe(false);

    // %3F decoding to a literal "?" mid-segment.
    expect(parseRefInput("https://github.com/owner/re%3Fpo/pull/1").recognized).toBe(false);
  });

  it("refuses C0 controls that survive a single percent-decode (%1B, %0A)", () => {
    expect(parseRefInput("https://github.com/owner/re%1Bpo/pull/1").recognized).toBe(false);
    expect(parseRefInput("https://github.com/owner/re%0Apo/pull/1").recognized).toBe(false);
  });

  it("refuses a bare owner/repo#n whose owner/repo contains a query delimiter or control character", () => {
    // "?" is not excluded by BARE_GITHUB_PATTERN's character class on its
    // own — isCleanSegment is what refuses it, matching the URL-decoded
    // path's grammar so a bare ref and its derived url never disagree.
    expect(parseRefInput("owner?withquestion/repo#1").recognized).toBe(false);

    // A raw control byte (BEL) embedded directly in a bare owner segment.
    expect(parseRefInput(`owner${BEL}/repo#1`).recognized).toBe(false);
  });

  it("converges on a byte-identical ParsedRef when re-parsing its own canonical url", () => {
    const recognizedInputs = [
      "https://github.com/Owner/Repo/pull/42",
      "owner/repo#7",
      "https://linear.app/myworkspace/issue/eng-451/some-title",
      // The double-encoding case: a single decode of "%252F" yields the
      // literal "re%2fpo" (a "%" survives, not a "/"), which isCleanSegment
      // accepts — encodeURIComponent in buildGithubRef is what keeps the
      // *next* parse of the reconstructed url from decoding that "%2f" one
      // effective layer further into an actual "/", which would otherwise
      // split the id into a different externalId (dedupe split).
      "https://github.com/owner/re%252Fpo/pull/1",
    ];

    for (const input of recognizedInputs) {
      const first = unwrap(parseRefInput(input));
      if (first.url === null) continue; // linear bare form has no url to round-trip
      const second = unwrap(parseRefInput(first.url));
      expect(second, `round-trip diverged for ${JSON.stringify(input)}`).toEqual(first);
    }
  });

  it("refuses non-string input without throwing", () => {
    expect(() => parseRefInput(null as never)).not.toThrow();
    expect(parseRefInput(null as never).recognized).toBe(false);

    expect(() => parseRefInput(42 as never)).not.toThrow();
    expect(parseRefInput(42 as never).recognized).toBe(false);

    expect(() => parseRefInput(undefined as never)).not.toThrow();
    expect(parseRefInput(undefined as never).recognized).toBe(false);
  });

  it("accepts a derived external id at 256 code points using astral characters, refuses at 257", () => {
    // .length (UTF-16 units) and textWidth (code points) disagree exactly
    // here: an astral character is 2 units but 1 code point, so a check
    // that used .length instead of textWidth would refuse this at-bound
    // case as if it were already over the limit. Only a handful of astral
    // characters are used (mixed with plain ASCII padding) rather than
    // filling the whole owner with them -- each one costs 12 characters
    // once percent-encoded into the derived url, and filling the whole
    // owner would trip the url bound instead of the one this test targets.
    const astral = "\u{1F600}"; // an emoji, one code point, two UTF-16 units
    expect([...astral]).toHaveLength(1);
    const astralCount = 3;

    const repoLength = 10;
    const bareRefFor = (externalIdCodePoints: number): string => {
      const ownerCodePoints = externalIdCodePoints - 3 - repoLength;
      const owner = astral.repeat(astralCount) + "o".repeat(ownerCodePoints - astralCount);
      const repo = "r".repeat(repoLength);
      return `${owner}/${repo}#1`;
    };

    const atBound = unwrap(parseRefInput(bareRefFor(MAX_EXTERNAL_ID_LENGTH)));
    expect([...atBound.externalId]).toHaveLength(MAX_EXTERNAL_ID_LENGTH);

    const overBoundMessage = unwrapRefusal(parseRefInput(bareRefFor(MAX_EXTERNAL_ID_LENGTH + 1)));
    expect(overBoundMessage).toContain(`exceeds ${MAX_EXTERNAL_ID_LENGTH} characters`);
  });

  it("accepts a default port (443 https, 80 http), still refuses an explicit non-default port", () => {
    // WHATWG normalizes away a URL's own default port before this function
    // ever sees `url.port` — it reads as "", identical to no port at all.
    expect(unwrap(parseRefInput("https://github.com:443/owner/repo/pull/1"))).toEqual({
      provider: "github",
      externalId: "owner/repo#1",
      url: "https://github.com/owner/repo/pull/1",
    });
    expect(unwrap(parseRefInput("http://github.com:80/owner/repo/pull/1"))).toEqual({
      provider: "github",
      externalId: "owner/repo#1",
      url: "https://github.com/owner/repo/pull/1",
    });

    expect(parseRefInput("https://github.com:8443/owner/repo/pull/1").recognized).toBe(false);
  });

  it("recognizes a host with an embedded tab, same as a browser address bar", () => {
    // WHATWG strips ASCII tab/CR/LF found anywhere in the input as part of
    // ordinary URL parsing (not specific to this function) -- so this reads
    // as the clean host "github.com". Because parseRefInput reconstructs its
    // own output rather than ever echoing the raw input, there is nothing
    // for the stripped tab to have hidden inside the result.
    const withTab = `https://git${TAB}hub.com/owner/repo/pull/1`;
    expect(unwrap(parseRefInput(withTab))).toEqual({
      provider: "github",
      externalId: "owner/repo#1",
      url: "https://github.com/owner/repo/pull/1",
    });
  });

  it('refuses a bare owner or repo that is exactly "." or ".."', () => {
    // Neither "." nor ".." contains a forbidden character, so the regex
    // check alone would accept them -- but WHATWG's path normalization
    // collapses a "." or ".." path segment on the *next* parse, which would
    // otherwise let this recognize the first time and refuse on re-parse of
    // its own derived url (the convergence invariant every other test in
    // this file relies on).
    expect(parseRefInput("./repo#1").recognized).toBe(false);
    expect(parseRefInput("../repo#1").recognized).toBe(false);
    expect(parseRefInput("owner/.#1").recognized).toBe(false);
    expect(parseRefInput("owner/..#1").recognized).toBe(false);

    // The same shapes recognized (wrongly) before the fix would have built
    // a url that refuses on re-parse -- confirm that url-form input using
    // "." or ".." as the owner segment is refused too, not just the bare
    // form (the same trust boundary, per isCleanSegment's docs).
    expect(parseRefInput("https://github.com/./repo/pull/1").recognized).toBe(false);
    expect(parseRefInput("https://github.com/../repo/pull/1").recognized).toBe(false);
  });
});

describe("validateExplicitRef", () => {
  it("accepts provider/id at their max bounds, refuses one character past", () => {
    const atProviderBound = validateExplicitRef({
      provider: "p".repeat(MAX_PROVIDER_LENGTH),
      id: "x",
    });
    expect(atProviderBound.valid).toBe(true);

    const overProviderBound = validateExplicitRef({
      provider: "p".repeat(MAX_PROVIDER_LENGTH + 1),
      id: "x",
    });
    expect(overProviderBound.valid).toBe(false);

    const atIdBound = validateExplicitRef({
      provider: "p",
      id: "i".repeat(MAX_EXTERNAL_ID_LENGTH),
    });
    expect(atIdBound.valid).toBe(true);

    const overIdBound = validateExplicitRef({
      provider: "p",
      id: "i".repeat(MAX_EXTERNAL_ID_LENGTH + 1),
    });
    expect(overIdBound.valid).toBe(false);
  });

  it("accepts a url at 2048 characters, refuses at 2049", () => {
    const prefix = "https://example.com/";
    const urlOfLength = (length: number): string => prefix + "a".repeat(length - prefix.length);

    const atBound = urlOfLength(MAX_URL_LENGTH);
    expect(atBound).toHaveLength(MAX_URL_LENGTH);
    expect(validateExplicitRef({ provider: "gitlab", id: "PROJ-1", url: atBound }).valid).toBe(
      true,
    );

    const overBound = urlOfLength(MAX_URL_LENGTH + 1);
    expect(validateExplicitRef({ provider: "gitlab", id: "PROJ-1", url: overBound }).valid).toBe(
      false,
    );
  });

  it("refuses javascript: and file: urls", () => {
    const jsResult = validateExplicitRef({
      provider: "gitlab",
      id: "PROJ-1",
      url: "javascript:alert(1)",
    });
    expect(jsResult.valid).toBe(false);

    const fileResult = validateExplicitRef({
      provider: "gitlab",
      id: "PROJ-1",
      url: "file:///etc/passwd",
    });
    expect(fileResult.valid).toBe(false);
  });

  it("refuses urls carrying credentials or an explicit port", () => {
    const credentialed = validateExplicitRef({
      provider: "gitlab",
      id: "PROJ-1",
      url: "https://user:pass@gitlab.example.com/proj/1",
    });
    expect(credentialed.valid).toBe(false);

    const ported = validateExplicitRef({
      provider: "gitlab",
      id: "PROJ-1",
      url: "https://gitlab.example.com:8443/proj/1",
    });
    expect(ported.valid).toBe(false);
  });

  it("treats an absent or blank url as null, and accepts a plain absolute url", () => {
    const absent = validateExplicitRef({ provider: "gitlab", id: "PROJ-1" });
    expect(absent).toEqual({
      valid: true,
      ref: { provider: "gitlab", externalId: "PROJ-1", url: null },
    });

    const blank = validateExplicitRef({ provider: "gitlab", id: "PROJ-1", url: "   " });
    expect(blank).toEqual({
      valid: true,
      ref: { provider: "gitlab", externalId: "PROJ-1", url: null },
    });

    const withUrl = validateExplicitRef({
      provider: "gitlab",
      id: "PROJ-1",
      url: "https://gitlab.example.com/proj/-/merge_requests/1",
    });
    expect(withUrl).toEqual({
      valid: true,
      ref: {
        provider: "gitlab",
        externalId: "PROJ-1",
        url: "https://gitlab.example.com/proj/-/merge_requests/1",
      },
    });
  });

  it("stores a normal url byte-verbatim (trimmed only, not rewritten)", () => {
    const input = "https://gitlab.example.com/group/proj/-/issues/9?tab=notes";
    const result = validateExplicitRef({ provider: "gitlab", id: "PROJ-9", url: `  ${input}  ` });
    expect(result).toEqual({
      valid: true,
      ref: { provider: "gitlab", externalId: "PROJ-9", url: input },
    });
  });

  it("refuses control characters and line separators surviving into a stored url", () => {
    // WHATWG can silently strip or re-encode these on the way to the shape
    // check (`parseAbsoluteHttpUrl`'s return value) while the raw character
    // stays present in the string this function actually stores -- checked
    // directly against that stored string, not the normalized one.

    // A raw NUL in the path.
    const withNul = validateExplicitRef({
      provider: "gitlab",
      id: "PROJ-1",
      url: `https://gitlab.example.com/path${NUL}here`,
    });
    expect(withNul.valid).toBe(false);

    // An embedded CRLF -- WHATWG strips it from `parsed.pathname` entirely,
    // so the shape check alone would see nothing wrong.
    const withCrlf = validateExplicitRef({
      provider: "gitlab",
      id: "PROJ-1",
      url: `https://gitlab.example.com/path${CR}${LF}here`,
    });
    expect(withCrlf.valid).toBe(false);

    // An OSC8 terminal hyperlink escape sequence (ESC ] 8 ; ; url BEL) --
    // ESC alone is enough to refuse, well before any OSC8-specific parsing.
    const osc8 = `${ESC}]8;;https://evil.example${BEL}`;
    const withOsc8 = validateExplicitRef({
      provider: "gitlab",
      id: "PROJ-1",
      url: `https://gitlab.example.com/${osc8}link`,
    });
    expect(withOsc8.valid).toBe(false);

    // A newline embedded in the host -- WHATWG strips it and `parsed.hostname`
    // reads clean, so again the shape check alone would not catch this.
    const newlineHost = validateExplicitRef({
      provider: "gitlab",
      id: "PROJ-1",
      url: `https://git${LF}lab.example.com/proj/1`,
    });
    expect(newlineHost.valid).toBe(false);
  });

  it("accepts provider 'github' with an unrelated url (GitHub Enterprise, pinned)", () => {
    // Deliberate (ADR-014's provider-agnosticism): provider and url are
    // never cross-checked, so a self-hosted GitHub Enterprise instance (or
    // any other host) can be stored under provider "github". This is a
    // pinning test, not a gap report -- do not turn this into a refusal.
    const result = validateExplicitRef({
      provider: "github",
      id: "owner/repo#1",
      url: "https://ghe.example.com/owner/repo/pull/1",
    });
    expect(result).toEqual({
      valid: true,
      ref: {
        provider: "github",
        externalId: "owner/repo#1",
        url: "https://ghe.example.com/owner/repo/pull/1",
      },
    });
  });

  it("refuses malformed runtime input without throwing", () => {
    // A boundary function reachable from parsed JSON, where nothing enforces
    // ExplicitRefInput's shape at compile time -- each of these throws a
    // TypeError on .trim() without the runtime guards.
    expect(() => validateExplicitRef(null as never)).not.toThrow();
    expect(validateExplicitRef(null as never).valid).toBe(false);

    expect(() => validateExplicitRef({} as never)).not.toThrow();
    expect(validateExplicitRef({} as never).valid).toBe(false);

    expect(() => validateExplicitRef({ provider: 42, id: "i" } as never)).not.toThrow();
    expect(validateExplicitRef({ provider: 42, id: "i" } as never).valid).toBe(false);

    expect(() => validateExplicitRef({ url: 42 } as never)).not.toThrow();
    expect(validateExplicitRef({ url: 42 } as never).valid).toBe(false);

    // A structurally valid provider/id with a non-string, non-null url --
    // the case the url-specific guard exists for, distinct from the missing
    // provider/id case above.
    const badUrl = { provider: "gitlab", id: "PROJ-1", url: 42 } as never;
    expect(() => validateExplicitRef(badUrl)).not.toThrow();
    expect(validateExplicitRef(badUrl).valid).toBe(false);
  });
});
