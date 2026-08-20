/**
 * Squeeze plugin wire-format tests (v2): envelope build/parse roundtrip, line
 * candidate detection (explicit marker only), no false positives on prose.
 */

import { describe, expect, it } from "vitest";
import {
  SQZ_LEXICON_OPEN,
  SQZ_ORIGINAL_OPEN,
  SQZ_PAYLOAD_OPEN,
  buildEnvelope,
  findLineCandidates,
  parseEnvelope,
} from "../../src/plugin/format.js";
import { DEFAULT_LEXICON } from "../../src/providers.js";
import type { SQZLine } from "../../src/types.js";

const LINE: SQZLine = 'debug Δ["src/main.ts"] L:ts ∂[(empty input, null)] μ v"Keep the retry loop"';

describe("buildEnvelope", () => {
  it("builds line-only envelope", () => {
    const env = buildEnvelope(LINE, { includeLexicon: false });
    expect(env).toContain(SQZ_PAYLOAD_OPEN);
    expect(env).toContain("[/SQZ]");
    expect(env).toContain(LINE);
    expect(env).not.toContain(SQZ_LEXICON_OPEN);
    expect(env).not.toContain(SQZ_ORIGINAL_OPEN);
  });

  it("appends lexicon block when includeLexicon and lexicon present", () => {
    const env = buildEnvelope(LINE, { includeLexicon: true, lexicon: DEFAULT_LEXICON });
    expect(env).toContain(SQZ_LEXICON_OPEN);
    expect(env).toContain("[/SQZ lexicon]");
    expect(env).toContain(JSON.stringify(DEFAULT_LEXICON));
  });

  it("skips lexicon when empty", () => {
    const env = buildEnvelope(LINE, { includeLexicon: true, lexicon: [] });
    expect(env).not.toContain(SQZ_LEXICON_OPEN);
  });

  it("prepends original prose block in audit mode", () => {
    const env = buildEnvelope(LINE, { includeLexicon: false, original: "Debug src/main.ts." });
    expect(env).toContain(SQZ_ORIGINAL_OPEN);
    expect(env).toContain("Debug src/main.ts.");
    expect(env.indexOf(SQZ_ORIGINAL_OPEN)).toBeLessThan(env.indexOf(SQZ_PAYLOAD_OPEN));
  });
});

describe("parseEnvelope", () => {
  it("round-trips line + lexicon + original", () => {
    const original = "Debug src/main.ts, keep behavior.";
    const env = buildEnvelope(LINE, { includeLexicon: true, lexicon: DEFAULT_LEXICON, original });
    const parts = parseEnvelope(env);
    expect(parts.line).toBe(LINE);
    expect(parts.lexicon).toEqual(DEFAULT_LEXICON);
    expect(parts.original).toBe(original);
  });

  it("returns empty object for plain prose", () => {
    expect(parseEnvelope("just some prose")).toEqual({});
  });

  it("captures any v2 block content as the line (grammar gates later)", () => {
    const env = "[SQZ v2]\nnot a valid line but still the block\n[/SQZ]";
    expect(parseEnvelope(env).line).toBe("not a valid line but still the block");
  });
});

describe("findLineCandidates", () => {
  it("detects marker block", () => {
    const text = `Here is the plan:\n[SQZ v2]\n${LINE}\n[/SQZ]\nDone.`;
    const cands = findLineCandidates(text);
    expect(cands).toHaveLength(1);
    expect(cands[0].line).toBe(LINE);
    expect(text.slice(cands[0].start, cands[0].end)).toContain("[/SQZ]");
  });

  it("rejects plain prose entirely (no bare detection in v2)", () => {
    const prose = "Refactor the tokenizer in src/tokenizer.ts. Preserve runtime behavior.";
    expect(findLineCandidates(prose)).toEqual([]);
  });

  it("rejects v1 JSON marker blocks (no longer on the wire)", () => {
    const text = '[SQZ v1]\n{"v":1}\n[/SQZ]';
    expect(findLineCandidates(text)).toEqual([]);
  });

  it("rejects bare JSON text", () => {
    const text = `The config is {"v":1,"mode":"debug"}`;
    expect(findLineCandidates(text)).toEqual([]);
  });

  it("finds multiple independent lines in one message", () => {
    const a = buildEnvelope(LINE, { includeLexicon: false });
    const b = buildEnvelope('docs Δ["README.md"] L:md ⌁', { includeLexicon: false });
    const cands = findLineCandidates(`${a}\n---\n${b}`);
    expect(cands).toHaveLength(2);
  });

  it("skips empty blocks", () => {
    expect(findLineCandidates("[SQZ v2]\n\n[/SQZ]")).toEqual([]);
  });
});
