/**
 * Translator core tests: compress/expand roundtrip, retry/error-injection,
 * provider-down fallback, passthrough, domain override, unknown-symbol audit.
 */

import { describe, expect, it } from "vitest";
import { compress, expand } from "../src/translator.js";
import { DEFAULT_LEXICON } from "../src/providers.js";
import { validatePayload } from "../src/validate.js";
import type { ChatMessage, Provider, SQZPayload } from "../src/types.js";

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

const VALID_PAYLOAD: SQZPayload = {
  v: 1,
  mode: "refactor",
  target: { files: ["src/tokenizer.ts"], lang: "ts" },
  constraints: ["≋ behavior(new) = behavior(old)", "μ"],
  verbatim: ["Ship the new version"],
  confidence: 0.94,
};

describe("compress — RuleProvider (deterministic default)", () => {
  it("encodes refactor prose into schema-valid SQZ payload", async () => {
    const prose =
      "Refactor the tokenizer in src/tokenizer.ts. Preserve runtime behavior. Minimal diff.";
    const result = await compress(prose, { lexicon: DEFAULT_LEXICON });

    expect(result.sqz.mode).toBe("refactor");
    expect(result.sqz.target.files).toContain("src/tokenizer.ts");
    expect(result.sqz.constraints).toContain("≋ behavior(new) = behavior(old)");
    expect(result.sqz.constraints).toContain("μ");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.verbatim).toEqual(result.sqz.verbatim);

    const { valid } = validatePayload(result.sqz);
    expect(valid).toBe(true);
  });

  it("leaves unencodable clauses verbatim and expands them byte-for-byte", async () => {
    const prose =
      "Refactor the tokenizer in src/tokenizer.ts. Ship the new version. Preserve runtime behavior.";
    const result = await compress(prose, { lexicon: DEFAULT_LEXICON });

    expect(result.verbatim).toContain("Ship the new version");

    const expanded = expand(result.sqz, DEFAULT_LEXICON);
    expect(expanded).toContain("Ship the new version");
    expect(expanded).toContain("Preserve behavior: behavior(new) = behavior(old).");
    expect(expanded).not.toContain("\nts\n");
  });

  it("mode defaults to general when nothing matches", async () => {
    const result = await compress("Weird clause that means nothing.", {
      lexicon: DEFAULT_LEXICON,
    });
    expect(result.sqz.mode).toBe("general");
    expect(result.verbatim).toContain("Weird clause that means nothing");
    const expanded = expand(result.sqz, DEFAULT_LEXICON);
    expect(expanded).toContain("Weird clause that means nothing");
  });

  it("domain hint overrides detected mode", async () => {
    const result = await compress("Refactor the tokenizer in src/tokenizer.ts.", {
      domain: "test",
      lexicon: DEFAULT_LEXICON,
    });
    expect(result.sqz.mode).toBe("test");
  });
});

describe("compress — retry with error injection", () => {
  it("injects schema errors and retries up to max before succeeding", async () => {
    const provider = mockProvider(async (_m, callIndex) => {
      if (callIndex === 0) return { v: 2, mode: "bogus" };
      if (callIndex === 1) return { v: 1, mode: "refactor" }; // missing target/verbatim/...
      return VALID_PAYLOAD;
    });

    const result = await compress("Refactor src/a.ts.", {
      lexicon: DEFAULT_LEXICON,
      provider,
      retries: 2,
    });

    expect(provider.calls.length).toBe(3);
    expect(validatePayload(result.sqz).valid).toBe(true);
    expect(provider.calls[1].some((m) => m.content.includes("Schema validation failed"))).toBe(true);
  });

  it("passes original prose through verbatim when all retries fail", async () => {
    const prose = "Refactor src/a.ts.";
    const provider = mockProvider(async () => ({ v: 99, mode: "nope" }));

    const result = await compress(prose, {
      lexicon: DEFAULT_LEXICON,
      provider,
      retries: 2,
    });

    expect(result.confidence).toBe(0);
    expect(result.sqz.verbatim).toEqual([prose]);
    expect(result.sqz.constraints).toEqual([]);
    // Original prose fully recoverable from expand.
    expect(expand(result.sqz, DEFAULT_LEXICON)).toContain(prose);
  });

  it("passes through on unparseable (non-JSON) provider output", async () => {
    const prose = "Debug src/main.ts.";
    const provider = mockProvider(async () => "this is not json");

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

    expect(validatePayload(result.sqz).valid).toBe(true);
    expect(result.sqz.mode).toBe("review");
    expect(result.sqz.target.files).toContain("src/auth.ts");
    expect(result.sqz.constraints.some((c) => c.startsWith("✓"))).toBe(true);
  });
});

describe("expand — unknown symbols", () => {
  it("renders a grammar glyph missing from the lexicon literally and flags audit", () => {
    const lexicon = DEFAULT_LEXICON.filter((e) => e.symbol !== "Δ");
    const audit: string[] = [];
    const payload: SQZPayload = {
      ...VALID_PAYLOAD,
      constraints: ['Δ ["src/x.ts"]'],
      verbatim: [],
    };

    const prose = expand(payload, lexicon, { audit });
    expect(prose).toContain('Δ ["src/x.ts"]');
    expect(audit).toContain("unknown-symbol:Δ");
  });

  it("flags a glyph rendered out of position and renders literally", () => {
    const audit: string[] = [];
    const payload: SQZPayload = {
      ...VALID_PAYLOAD,
      constraints: ["⌁ all ⏭ vendor/"],
      verbatim: [],
    };

    const prose = expand(payload, DEFAULT_LEXICON, { audit });
    expect(prose).toContain("⌁ all ⏭ vendor/");
    expect(audit).toContain("unknown-symbol:⏭");
  });

  it("renders plain prose clauses without audit", () => {
    const audit: string[] = [];
    const payload: SQZPayload = {
      ...VALID_PAYLOAD,
      constraints: ["just some prose", "μ"],
      verbatim: [],
    };
    const prose = expand(payload, DEFAULT_LEXICON, { audit });
    expect(prose).toContain("just some prose");
    expect(prose).toContain("Minimal diff.");
    expect(audit).toEqual([]);
  });

  it("renders known symbols into lexicon-driven prose", () => {
    const payload: SQZPayload = {
      ...VALID_PAYLOAD,
      constraints: ["∂ (empty input, null)", "→ lint → build → test", "⏭ vendor/"],
      verbatim: [],
    };
    const prose = expand(payload, DEFAULT_LEXICON);
    expect(prose).toContain("Handle edge cases: (empty input, null).");
    expect(prose).toContain("Pipeline: lint → build → test.");
    expect(prose).toContain("Skip: vendor/.");
  });
});
