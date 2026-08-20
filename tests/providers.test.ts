/**
 * RuleProvider tests (v2): deterministic no-model compression → SQZ line.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_LEXICON, RuleProvider } from "../src/providers.js";
import { validateLine } from "../src/validate.js";
import type { ChatMessage, Lexicon } from "../src/types.js";

function messages(prose: string): ChatMessage[] {
  return [
    { role: "system", content: "compress-prose-to-sqz" },
    { role: "user", content: prose },
  ];
}

describe("RuleProvider", () => {
  it("produces grammar-valid lines deterministically", async () => {
    const provider = new RuleProvider();
    const prose =
      "Refactor the tokenizer in src/tokenizer.ts. Preserve runtime behavior. Minimal diff.";

    const first = await provider.generate(messages(prose));
    const second = await provider.generate(messages(prose));
    expect(first).toEqual(second);
    expect(typeof first).toBe("string");
    const { valid, errors } = validateLine(first as string, DEFAULT_LEXICON);
    expect(valid, errors.join("; ")).toBe(true);
  });

  it("honors the lexicon passed at construction", async () => {
    const minimalOnly: Lexicon = [DEFAULT_LEXICON[3]]; // μ only
    const provider = new RuleProvider(minimalOnly);
    const result = (await provider.generate(
      messages("Minimal diff. Preserve behavior."),
    )) as string;

    expect(result).toContain("μ");
    expect(result).not.toContain("≋");
  });

  it("extracts file paths into the Δ target", async () => {
    const provider = new RuleProvider();
    const result = (await provider.generate(
      messages("Debug src/main.ts and src/util.ts."),
    )) as string;

    expect(result).toContain('Δ["src/main.ts","src/util.ts"]');
  });

  it("emits pipeline clause when flow trigger matches", async () => {
    const provider = new RuleProvider();
    const result = (await provider.generate(
      messages("Run lint then build then test before shipping."),
    )) as string;
    expect(result).toContain("→[lint → build → test]");
  });

  it("never throws and always returns a valid line", async () => {
    const provider = new RuleProvider();
    const result = await provider.generate(messages(""));
    expect(validateLine(result as string, DEFAULT_LEXICON).valid).toBe(true);
  });

  it("keeps unencodable clauses as v\"...\" verbatim segments", async () => {
    const provider = new RuleProvider();
    const result = (await provider.generate(
      messages("Docs for README.md. Make the callout bright and cheerful."),
    )) as string;
    expect(result).toContain('v"');
    expect(result).toContain("Make the callout bright and cheerful");
  });
});
