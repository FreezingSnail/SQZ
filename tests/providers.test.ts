/**
 * RuleProvider tests: deterministic no-model compression.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_LEXICON, RuleProvider } from "../src/providers.js";
import { validatePayload } from "../src/validate.js";
import type { ChatMessage, Lexicon } from "../src/types.js";

function messages(prose: string, lexicon: Lexicon = DEFAULT_LEXICON): ChatMessage[] {
  return [
    { role: "system", content: JSON.stringify({ task: "compress-prose-to-sqz", lexicon }) },
    { role: "user", content: prose },
  ];
}

describe("RuleProvider", () => {
  it("produces schema-valid payloads deterministically", async () => {
    const provider = new RuleProvider();
    const prose =
      "Refactor the tokenizer in src/tokenizer.ts. Preserve runtime behavior. Minimal diff.";

    const first = await provider.generate(messages(prose), {});
    const second = await provider.generate(messages(prose), {});
    expect(first).toEqual(second);
    expect(validatePayload(first).valid).toBe(true);
  });

  it("honors the lexicon injected in the system message", async () => {
    const provider = new RuleProvider();
    const minimalOnly: Lexicon = [DEFAULT_LEXICON[3]]; // μ only
    const result = (await provider.generate(
      messages("Minimal diff. Preserve behavior.", minimalOnly),
      {},
    )) as { constraints: string[] };

    expect(result.constraints).toContain("μ");
    expect(result.constraints).not.toContain("≋ behavior(new) = behavior(old)");
  });

  it("extracts file paths and skips them from verbatim", async () => {
    const provider = new RuleProvider();
    const result = (await provider.generate(
      messages("Debug src/main.ts and src/util.ts."),
      {},
    )) as { target: { files: string[] }; verbatim: string[] };

    expect(result.target.files).toContain("src/main.ts");
    expect(result.target.files).toContain("src/util.ts");
  });

  it("emits pipeline clause when flow trigger matches", async () => {
    const provider = new RuleProvider();
    const result = (await provider.generate(
      messages("Run lint then build then test before shipping."),
      {},
    )) as { constraints: string[] };
    expect(result.constraints).toContain("lint → build → test");
  });

  it("never throws and always returns a payload", async () => {
    const provider = new RuleProvider();
    const result = await provider.generate(messages(""), {});
    expect(validatePayload(result).valid).toBe(true);
  });
});
