/**
 * SQZPayload schema validator tests (ajv against sqz-schema.json).
 */

import { describe, expect, it } from "vitest";
import { validatePayload } from "../src/validate.js";
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
