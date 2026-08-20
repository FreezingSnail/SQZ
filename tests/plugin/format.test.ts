/**
 * Squeeze plugin wire-format tests: envelope build/parse roundtrip, payload
 * candidate detection (marker / fenced / bare JSON), no false positives on
 * prose, overlap dedupe.
 */

import { describe, expect, it } from "vitest";
import {
  SQZ_LEXICON_OPEN,
  SQZ_ORIGINAL_OPEN,
  SQZ_PAYLOAD_OPEN,
  buildEnvelope,
  findPayloadCandidates,
  parseEnvelope,
} from "../../src/plugin/format.js";
import { DEFAULT_LEXICON } from "../../src/providers.js";
import type { SQZPayload } from "../../src/types.js";

const PAYLOAD: SQZPayload = {
  v: 1,
  mode: "debug",
  target: { files: ["src/main.ts"], lang: "ts" },
  constraints: ["∂ (empty input, null)", "μ"],
  verbatim: ["Keep the retry loop"],
  confidence: 0.95,
};

describe("buildEnvelope", () => {
  it("builds payload-only envelope", () => {
    const env = buildEnvelope(PAYLOAD, { includeLexicon: false });
    expect(env).toContain(SQZ_PAYLOAD_OPEN);
    expect(env).toContain("[/SQZ]");
    expect(env).toContain(JSON.stringify(PAYLOAD));
    expect(env).not.toContain(SQZ_LEXICON_OPEN);
    expect(env).not.toContain(SQZ_ORIGINAL_OPEN);
  });

  it("appends lexicon block when includeLexicon and lexicon present", () => {
    const env = buildEnvelope(PAYLOAD, { includeLexicon: true, lexicon: DEFAULT_LEXICON });
    expect(env).toContain(SQZ_LEXICON_OPEN);
    expect(env).toContain("[/SQZ lexicon]");
    expect(env).toContain(JSON.stringify(DEFAULT_LEXICON));
  });

  it("skips lexicon when empty", () => {
    const env = buildEnvelope(PAYLOAD, { includeLexicon: true, lexicon: [] });
    expect(env).not.toContain(SQZ_LEXICON_OPEN);
  });

  it("prepends original prose block in audit mode", () => {
    const env = buildEnvelope(PAYLOAD, { includeLexicon: false, original: "Debug src/main.ts." });
    expect(env).toContain(SQZ_ORIGINAL_OPEN);
    expect(env).toContain("Debug src/main.ts.");
    expect(env.indexOf(SQZ_ORIGINAL_OPEN)).toBeLessThan(env.indexOf(SQZ_PAYLOAD_OPEN));
  });
});

describe("parseEnvelope", () => {
  it("round-trips payload + lexicon + original", () => {
    const original = "Debug src/main.ts, keep behavior.";
    const env = buildEnvelope(PAYLOAD, { includeLexicon: true, lexicon: DEFAULT_LEXICON, original });
    const parts = parseEnvelope(env);
    expect(parts.payload).toEqual(PAYLOAD);
    expect(parts.lexicon).toEqual(DEFAULT_LEXICON);
    expect(parts.original).toBe(original);
  });

  it("returns empty object for plain prose", () => {
    expect(parseEnvelope("just some prose")).toEqual({});
  });

  it("ignores malformed payload JSON", () => {
    const env = "[SQZ v1]\n{not json\n[/SQZ]";
    expect(parseEnvelope(env).payload).toBeUndefined();
  });
});

describe("findPayloadCandidates", () => {
  it("detects marker block", () => {
    const text = `Here is the plan:\n[SQZ v1]\n${JSON.stringify(PAYLOAD)}\n[/SQZ]\nDone.`;
    const cands = findPayloadCandidates(text);
    expect(cands).toHaveLength(1);
    expect(cands[0].payload).toEqual(PAYLOAD);
    expect(text.slice(cands[0].start, cands[0].end)).toContain("[/SQZ]");
  });

  it("detects fenced JSON", () => {
    const text = "```json\n" + JSON.stringify(PAYLOAD) + "\n```";
    const cands = findPayloadCandidates(text);
    expect(cands).toHaveLength(1);
    expect(cands[0].payload).toEqual(PAYLOAD);
  });

  it("detects bare JSON object", () => {
    const text = `Answer: ${JSON.stringify(PAYLOAD)}`;
    const cands = findPayloadCandidates(text);
    expect(cands).toHaveLength(1);
    expect(cands[0].payload).toEqual(PAYLOAD);
    expect(text.slice(cands[0].start, cands[0].end)).toBe(JSON.stringify(PAYLOAD));
  });

  it("rejects schema-invalid JSON (never rewrites prose)", () => {
    const text = `The config is {"v":1,"mode":"debug"}`;
    expect(findPayloadCandidates(text)).toEqual([]);
  });

  it("rejects plain prose entirely", () => {
    const prose = "Refactor the tokenizer in src/tokenizer.ts. Preserve runtime behavior.";
    expect(findPayloadCandidates(prose)).toEqual([]);
  });

  it("marker inside a fence still yields exactly one candidate (the marker)", () => {
    const inner = `[SQZ v1]\n${JSON.stringify(PAYLOAD)}\n[/SQZ]`;
    const text = "```json\n" + inner + "\n```";
    const cands = findPayloadCandidates(text);
    expect(cands).toHaveLength(1);
    expect(text.slice(cands[0].start, cands[0].end)).toContain("[SQZ v1]");
  });

  it("finds multiple independent payloads in one message", () => {
    const text = `${JSON.stringify(PAYLOAD)} and ${JSON.stringify({ ...PAYLOAD, mode: "docs" })}`;
    const cands = findPayloadCandidates(text);
    expect(cands).toHaveLength(2);
  });
});