/**
 * Token estimator sanity tests.
 */

import { describe, expect, it } from "vitest";
import { estimateTokens, tokenSavings } from "../src/tokens.js";

describe("estimateTokens", () => {
  it("counts words and symbol runs", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello world")).toBe(2);
    expect(estimateTokens("src/tokenizer.ts")).toBe(5); // words: src, tokenizer, ts + symbols: '/', '.'
    expect(estimateTokens("Δ [\"src/a.ts\"]")).toBeGreaterThan(1);
  });
});

describe("tokenSavings", () => {
  it("reports 40%+ savings for a compact encoding of long prose", () => {
    const prose =
      "Please refactor the tokenizer module in src/tokenizer.ts and make sure the behavior stays identical for every input and keep the diff minimal. " +
      "Move the classification logic out of the large switch statement into a dedicated table-driven classifyToken function and preserve the exact order in which token kinds are emitted. " +
      "Handle edge cases such as empty input, unterminated strings, and lone surrogate pairs before the classification step. " +
      "Do not touch the test files and verify the full suite still passes after the refactor.";
    const sqz =
      '{"v":1,"mode":"refactor","target":{"files":["src/tokenizer.ts"],"lang":"ts"},"constraints":["≋ behavior(new) = behavior(old)","μ","∂ (empty, malformed)","⏭ tests/"],"verbatim":[],"confidence":0.95}';
    expect(tokenSavings(sqz, prose)).toBeGreaterThan(0.4);
  });

  it("returns 0 for empty prose", () => {
    expect(tokenSavings("x", "")).toBe(0);
  });
});