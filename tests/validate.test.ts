/**
 * Validation tests.
 * validatePayload — ajv against sqz-schema.json (v1, tooling-only).
 * validateLine — v2 plain-line grammar (the wire format).
 */

import { describe, expect, it } from "vitest";
import { validateLine, validatePayload } from "../src/validate.js";
import { DEFAULT_LEXICON } from "../src/providers.js";
import type { SQZPayload } from "../src/types.js";

const VALID: SQZPayload = {
  v: 1,
  mode: "refactor",
  target: { files: ["src/a.ts"], lang: "ts" },
  constraints: ["≋ behavior(new) = behavior(old)", "μ"],
  verbatim: ["raw prose clause"],
  confidence: 0.94,
};

describe("validatePayload", () => {
  it("accepts a valid v1 payload", () => {
    expect(validatePayload(VALID).valid).toBe(true);
  });

  it("accepts every mode enum value", () => {
    for (const mode of ["refactor", "api", "debug", "docs", "test", "review", "arch", "general"]) {
      expect(validatePayload({ ...VALID, mode }).valid).toBe(true);
    }
  });

  it("rejects wrong version", () => {
    expect(validatePayload({ ...VALID, v: 2 }).valid).toBe(false);
  });

  it("rejects unknown mode", () => {
    expect(validatePayload({ ...VALID, mode: "bogus" }).valid).toBe(false);
  });

  it("rejects confidence out of range", () => {
    expect(validatePayload({ ...VALID, confidence: 1.5 }).valid).toBe(false);
    expect(validatePayload({ ...VALID, confidence: -0.1 }).valid).toBe(false);
  });

  it("rejects empty files list", () => {
    expect(
      validatePayload({ ...VALID, target: { files: [], lang: "ts" } }).valid,
    ).toBe(false);
  });

  it("rejects missing required fields", () => {
    const { verbatim: _drop, ...noVerbatim } = VALID;
    expect(validatePayload(noVerbatim).valid).toBe(false);
  });

  it("rejects extra properties", () => {
    expect(validatePayload({ ...VALID, extra: 1 }).valid).toBe(false);
  });

  it("rejects non-string constraint", () => {
    expect(
      validatePayload({ ...VALID, constraints: ["μ", 42] as never[] }).valid,
    ).toBe(false);
  });

  it("reports structured error messages on failure", () => {
    const { valid, errors } = validatePayload({ ...VALID, v: 2 });
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toMatch(/v/);
  });
});

describe("validateLine (v2 wire format)", () => {
  const VALID_LINE = 'refactor Δ["src/a.ts"] L:ts ≋ μ ∂ v"raw prose"';

  it("accepts a valid line", () => {
    const { valid, errors } = validateLine(VALID_LINE, DEFAULT_LEXICON);
    expect(valid, errors.join("; ")).toBe(true);
  });

  it("accepts every mode as the leading token", () => {
    for (const mode of ["refactor", "api", "debug", "docs", "test", "review", "arch", "general"]) {
      const { valid, errors } = validateLine(`${mode} Δ["src/a.ts"]`, DEFAULT_LEXICON);
      expect(valid, errors.join("; ")).toBe(true);
    }
  });

  it("rejects empty lines", () => {
    expect(validateLine("", DEFAULT_LEXICON).valid).toBe(false);
  });

  it("rejects missing mode", () => {
    expect(validateLine('Δ["src/a.ts"] μ', DEFAULT_LEXICON).valid).toBe(false);
  });

  it("rejects unknown mode", () => {
    expect(validateLine('bogus Δ["src/a.ts"]', DEFAULT_LEXICON).valid).toBe(false);
  });

  it("rejects missing Δ target", () => {
    expect(validateLine("refactor μ", DEFAULT_LEXICON).valid).toBe(false);
  });

  it("rejects Δ target with no files", () => {
    expect(validateLine('refactor Δ[]', DEFAULT_LEXICON).valid).toBe(false);
  });

  it("rejects unknown symbols", () => {
    const { valid, errors } = validateLine('refactor Δ["src/a.ts"] λ', DEFAULT_LEXICON);
    expect(valid).toBe(false);
    expect(errors.join(" ")).toMatch(/unknown symbol|unexpected token/);
  });

  it("rejects unbalanced brackets", () => {
    expect(validateLine('refactor Δ["src/a.ts"] ∂[unclosed', DEFAULT_LEXICON).valid).toBe(false);
  });

  it("rejects unterminated quote", () => {
    expect(validateLine('refactor Δ["src/a.ts] v"oops', DEFAULT_LEXICON).valid).toBe(false);
  });

  it("rejects stray tokens", () => {
    expect(validateLine('refactor Δ["src/a.ts"] gazonk', DEFAULT_LEXICON).valid).toBe(false);
  });

  it("is microsecond-fast (no network, no model)", () => {
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      validateLine(VALID_LINE, DEFAULT_LEXICON);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000); // 10k validations well under 1s
  });
});
