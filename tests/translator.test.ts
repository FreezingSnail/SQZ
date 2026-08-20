/**
 * Translator core tests (v2): compress/expand roundtrip, retry/error-injection,
 * provider-down fallback, passthrough, domain override, unknown-symbol audit.
 * Wire format: plain SQZ line — no JSON envelope.
 */

import { describe, expect, it } from "vitest";
import { compress, expand } from "../src/translator.js";
import { DEFAULT_LEXICON, RuleProvider, passthroughLine } from "../src/providers.js";
import { validateLine } from "../src/validate.js";
import { parseLine } from "../src/line.js";
import type { ChatMessage, Provider, SQZLine } from "../src/types.js";

interface MockProvider extends Provider {
  calls: ChatMessage[][];
}

function mockProvider(
  handler: (messages: ChatMessage[], callIndex: number) => Promise<unknown>,
): MockProvider {
  const calls: ChatMessage[][] = [];
  const provider: MockProvider = {
    name: "mock",
    calls,
    async generate(messages: ChatMessage[]): Promise<unknown> {
      calls.push([...messages]);
      return handler(messages, calls.length - 1);
    },
  };
  return provider;
}

const VALID_LINE: SQZLine =
  'refactor Δ["src/tokenizer.ts"] L:ts ≋[behavior(new) = behavior(old)] μ v"Ship the new version"';

describe("compress — RuleProvider (deterministic default)", () => {
  it("encodes refactor prose into a grammar-valid SQZ line", async () => {
    const prose =
      "Refactor the tokenizer in src/tokenizer.ts. Preserve runtime behavior. Minimal diff.";
    const result = await compress(prose, { lexicon: DEFAULT_LEXICON });

    expect(result.sqz).toMatch(/^refactor\b/);
    expect(result.sqz).toContain('Δ["src/tokenizer.ts"]');
    expect(result.sqz).toContain("≋");
    expect(result.sqz).toContain("μ");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const { valid, errors } = validateLine(result.sqz, DEFAULT_LEXICON);
    expect(valid, errors.join("; ")).toBe(true);
    expect(result.sqz).not.toContain("{");
  });

  it("leaves unencodable clauses verbatim and expands them byte-for-byte", async () => {
    const prose =
      "Refactor the tokenizer in src/tokenizer.ts. Ship the new version. Preserve runtime behavior.";
    const result = await compress(prose, { lexicon: DEFAULT_LEXICON });

    expect(result.verbatim).toContain("Ship the new version");

    const expanded = expand(result.sqz, DEFAULT_LEXICON);
    expect(expanded).toContain("Ship the new version");
    expect(expanded).toContain("Preserve behavior: behavior(new) = behavior(old).");
  });

  it("mode defaults to general when nothing matches", async () => {
    const result = await compress("Weird clause that means nothing.", {
      lexicon: DEFAULT_LEXICON,
    });
    expect(result.sqz).toMatch(/^general\b/);
    expect(result.verbatim).toContain("Weird clause that means nothing");
    const expanded = expand(result.sqz, DEFAULT_LEXICON);
    expect(expanded).toContain("Weird clause that means nothing");
  });

  it("domain hint overrides detected mode", async () => {
    const result = await compress("Refactor the tokenizer in src/tokenizer.ts.", {
      domain: "test",
      lexicon: DEFAULT_LEXICON,
    });
    expect(result.sqz).toMatch(/^test\b/);
  });
});

describe("compress — retry with error injection", () => {
  it("injects grammar errors and retries up to max before succeeding", async () => {
    const provider = mockProvider(async (_m, callIndex) => {
      if (callIndex === 0) return "bogus garbage no mode";
      if (callIndex === 1) return 'refactor Δ["src/a.ts"]'; // no L:, fine — still valid
      return VALID_LINE;
    });

    const result = await compress("Refactor src/a.ts.", {
      lexicon: DEFAULT_LEXICON,
      provider,
      retries: 2,
    });

    expect(provider.calls.length).toBe(2);
    expect(validateLine(result.sqz, DEFAULT_LEXICON).valid).toBe(true);
    expect(provider.calls[1].some((m) => m.content.includes("Grammar validation failed"))).toBe(true);
  });

  it("passes original prose through verbatim when all retries fail", async () => {
    const prose = "Refactor src/a.ts.";
    const provider = mockProvider(async () => "not a sqz line");

    const result = await compress(prose, {
      lexicon: DEFAULT_LEXICON,
      provider,
      retries: 2,
    });

    expect(result.confidence).toBe(0);
    expect(result.sqz).toBe(passthroughLine(prose));
    // Original prose fully recoverable from expand.
    expect(expand(result.sqz, DEFAULT_LEXICON)).toContain(prose);
  });

  it("passes through on garbage provider output", async () => {
    const prose = "Debug src/main.ts.";
    const provider = mockProvider(async () => "this is not a line at all");

    const result = await compress(prose, { lexicon: DEFAULT_LEXICON, provider });
    expect(result.confidence).toBe(0);
    expect(expand(result.sqz, DEFAULT_LEXICON)).toContain(prose);
  });
});

describe("compress — provider down → RuleProvider fallback", () => {
  it("falls back to deterministic RuleProvider when provider throws", async () => {
    const provider = mockProvider(async () => {
      throw new Error("provider unavailable");
    });

    const result = await compress(
      "Review the auth handler in src/auth.ts. Verified against acceptance criteria.",
      { lexicon: DEFAULT_LEXICON, provider },
    );

    expect(validateLine(result.sqz, DEFAULT_LEXICON).valid).toBe(true);
    expect(result.sqz).toMatch(/^review\b/);
    expect(result.sqz).toContain('Δ["src/auth.ts"]');
    expect(result.sqz).toContain("✓");
  });
});

describe("expand — unknown symbols and rendering", () => {
  it("renders a glyph missing from the lexicon literally and flags audit", () => {
    const lexicon = DEFAULT_LEXICON.filter((e) => e.symbol !== "Δ");
    const audit: string[] = [];
    const line: SQZLine = 'refactor Δ["src/x.ts"] L:ts Δ["src/x.ts"]';

    const prose = expand(line, lexicon, { audit });
    expect(prose).toContain("Δ");
    expect(audit).toContain("unknown-symbol:Δ");
  });

  it("renders known symbols into lexicon-driven prose", () => {
    const line: SQZLine =
      'refactor Δ["src/a.ts"] L:ts ∂[(empty input, null)] →[lint → build → test] ⏭[vendor/] μ';
    const prose = expand(line, DEFAULT_LEXICON);
    expect(prose).toContain("Handle edge cases: (empty input, null).");
    expect(prose).toContain("Pipeline: lint → build → test.");
    expect(prose).toContain("Skip: vendor/.");
    expect(prose).toContain("Minimal diff.");
    expect(prose).toContain("Refactor src/a.ts in ts.");
  });

  it("returns unparseable non-SQZ text untouched (lossless invariant)", () => {
    const audit: string[] = [];
    const prose = expand("random prose with no structure", DEFAULT_LEXICON, { audit });
    expect(prose).toBe("random prose with no structure");
    expect(audit).toContain("unparseable-line:random prose with no structure");
  });

  it("verbatim segments round-trip byte-for-byte", () => {
    const line: SQZLine = 'docs Δ["README.md"] L:md v"Ship it \\"soon\\""';
    const prose = expand(line, DEFAULT_LEXICON);
    expect(prose).toContain('Ship it "soon"');
  });

  it("parseLine extracts the v2 AST", () => {
    const ast = parseLine(VALID_LINE, DEFAULT_LEXICON);
    expect(ast.mode).toBe("refactor");
    expect(ast.files).toEqual(["src/tokenizer.ts"]);
    expect(ast.lang).toBe("ts");
    expect(ast.clauses.map((c) => c.symbol)).toEqual(["≋", "μ"]);
    expect(ast.verbatim).toEqual(["Ship the new version"]);
    expect(ast.errors).toEqual([]);
  });
});
