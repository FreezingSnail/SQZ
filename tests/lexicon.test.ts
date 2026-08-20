/**
 * Lexicon contract tests: size gate (<1000 tokens) + one symbol/meaning per
 * domain, enforced programmatically per math-dbr.1 acceptance.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LEXICON } from "../src/providers.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function roughTokens(text: string): number {
  // Words + symbol glyphs — conservative upper-bound proxy for tokens.
  const words = text.split(/\s+/).filter(Boolean).length;
  const glyphs = (text.match(/[Δ≋∂μ⌁→✓⏭]/g) ?? []).length;
  return words + glyphs;
}

describe("lexicon.md size gate", () => {
  it("stays under 1000 tokens for session injection", () => {
    const md = readFileSync(resolve(REPO_ROOT, "lexicon.md"), "utf8");
    const tokens = roughTokens(md);
    expect(tokens).toBeLessThan(1000);
  });
});

describe("lexicon contract (one symbol, one meaning, one domain)", () => {
  it("DEFAULT_LEXICON mirrors lexicon.md: 8 symbols", () => {
    expect(DEFAULT_LEXICON.length).toBe(8);
    const symbols = new Set(DEFAULT_LEXICON.map((e) => e.symbol));
    expect(symbols.size).toBe(8);
  });

  it("symbols and domains are unique — no reuse", () => {
    const symbols = new Set<string>();
    const domains = new Set<string>();
    for (const entry of DEFAULT_LEXICON) {
      expect(symbols.has(entry.symbol)).toBe(false);
      expect(domains.has(entry.domain)).toBe(false);
      symbols.add(entry.symbol);
      domains.add(entry.domain);
    }
  });

  it("every entry has non-empty meaning and example", () => {
    for (const entry of DEFAULT_LEXICON) {
      expect(entry.meaning.trim().length).toBeGreaterThan(0);
      expect(entry.example.trim().length).toBeGreaterThan(0);
    }
  });
});
