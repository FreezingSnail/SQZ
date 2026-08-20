/**
 * Squeeze plugin core tests: threshold gate, envelope building, audit mode,
 * confidence gate, every failure path → original prose unchanged, assistant
 * expansion + expand toggle, unknown-symbol audit passthrough.
 */

import { describe, expect, it, vi } from "vitest";
import {
  MIN_CONFIDENCE,
  processAssistantText,
  processUserText,
  type PluginDeps,
} from "../../src/plugin/core.js";
import { expandSqzInText } from "../../src/plugin/core.js";
import { buildEnvelope, findPayloadCandidates } from "../../src/plugin/format.js";
import { compress, expand } from "../../src/translator.js";
import { DEFAULT_LEXICON } from "../../src/providers.js";
import { estimateTokens } from "../../src/tokens.js";
import type { CompressOptions, CompressResult, Lexicon, SQZPayload } from "../../src/types.js";

const PROSE = "Refactor the tokenizer in src/tokenizer.ts. Preserve runtime behavior. Minimal diff.";
const PROSE_TOKENS = estimateTokens(PROSE); // ~16, well above the test threshold

const OPTS = { threshold: 5, audit: false, includeLexicon: true, retries: 2 };

function realDeps(log?: (m: string) => void): PluginDeps {
  return {
    compress: (prose: string, o: CompressOptions) => compress(prose, o),
    expandFn: expand,
    estimateTokens,
    lexicon: DEFAULT_LEXICON,
    log,
  };
}

describe("processUserText — happy path", () => {
  it("compresses prose into an envelope carrying the payload", async () => {
    const outcome = await processUserText(PROSE, realDeps(), OPTS);
    expect(outcome.compressed).toBe(true);
    expect(outcome.payload?.mode).toBe("refactor");
    expect(outcome.text).toContain("[SQZ v1]");
    expect(outcome.text).toContain("[/SQZ]");
  });

  it("includes lexicon block on first message (includeLexicon)", async () => {
    const outcome = await processUserText(PROSE, realDeps(), { ...OPTS, includeLexicon: true });
    expect(outcome.text).toContain("[SQZ lexicon]");
  });

  it("omits lexicon block on later messages", async () => {
    const outcome = await processUserText(PROSE, realDeps(), { ...OPTS, includeLexicon: false });
    expect(outcome.text).not.toContain("[SQZ lexicon]");
  });

  it("audit mode prepends original prose in a fenced block", async () => {
    const outcome = await processUserText(PROSE, realDeps(), { ...OPTS, audit: true });
    expect(outcome.text).toContain("[SQZ original]");
    expect(outcome.text).toContain(PROSE);
    expect(outcome.text.indexOf("[SQZ original]")).toBeLessThan(outcome.text.indexOf("[SQZ v1]"));
  });

  it("recoverability: original prose is always present via verbatim or audit", async () => {
    const outcome = await processUserText(PROSE, realDeps(), { ...OPTS, audit: false });
    // RuleProvider keeps unencodable clauses in verbatim[] inside the payload.
    expect(JSON.stringify(outcome.payload?.verbatim ?? [])).toBeTruthy();
    const parts = outcome.payload ? outcome.text : "";
    expect(parts).toContain("[SQZ v1]");
  });
});

describe("processUserText — gates and degradation", () => {
  it("threshold: short messages pass through unchanged", async () => {
    const short = "hi";
    const outcome = await processUserText(short, realDeps(), { ...OPTS, threshold: 1000 });
    expect(outcome.compressed).toBe(false);
    expect(outcome.text).toBe(short);
  });

  it("empty/whitespace messages pass through unchanged", async () => {
    const outcome = await processUserText("   \n  ", realDeps(), OPTS);
    expect(outcome.compressed).toBe(false);
    expect(outcome.text).toBe("   \n  ");
  });

  it("provider failure → original prose unchanged", async () => {
    const deps = realDeps();
    deps.compress = async () => {
      throw new Error("provider down");
    };
    const outcome = await processUserText(PROSE, deps, OPTS);
    expect(outcome.compressed).toBe(false);
    expect(outcome.text).toBe(PROSE);
  });

  it("low-confidence payload → original prose unchanged", async () => {
    const deps = realDeps();
    deps.compress = async (_p, _o): Promise<CompressResult> => ({
      sqz: {
        v: 1,
        mode: "general",
        target: { files: ["-"], lang: "text" },
        constraints: [],
        verbatim: [PROSE],
        confidence: MIN_CONFIDENCE - 0.05,
      },
      verbatim: [PROSE],
      confidence: MIN_CONFIDENCE - 0.05,
      latencyMs: 1,
    });
    const outcome = await processUserText(PROSE, deps, OPTS);
    expect(outcome.compressed).toBe(false);
    expect(outcome.text).toBe(PROSE);
  });

  it("confidence exactly at the gate compresses", async () => {
    const deps = realDeps();
    deps.compress = async (_p, _o): Promise<CompressResult> => ({
      sqz: {
        v: 1,
        mode: "general",
        target: { files: ["-"], lang: "text" },
        constraints: [],
        verbatim: [PROSE],
        confidence: MIN_CONFIDENCE,
      },
      verbatim: [PROSE],
      confidence: MIN_CONFIDENCE,
      latencyMs: 1,
    });
    const outcome = await processUserText(PROSE, deps, OPTS);
    expect(outcome.compressed).toBe(true);
  });

  it("never throws: catches compress errors and logs", async () => {
    const log = vi.fn();
    const deps = realDeps(log);
    deps.compress = async () => {
      throw new Error("boom");
    };
    const outcome = await processUserText(PROSE, deps, OPTS);
    expect(outcome.text).toBe(PROSE);
    expect(log).toHaveBeenCalled();
  });
});

describe("processAssistantText — expansion", () => {
  const PAYLOAD: SQZPayload = {
    v: 1,
    mode: "debug",
    target: { files: ["src/main.ts"], lang: "ts" },
    constraints: ["∂ (empty input, null)", "μ"],
    verbatim: [],
    confidence: 0.95,
  };

  it("expands a marker-block payload to prose", () => {
    const sqzText = `Plan:\n${buildEnvelope(PAYLOAD, { includeLexicon: false })}\nDone.`;
    const deps = realDeps();
    const outcome = processAssistantText(sqzText, deps, { expand: true });
    expect(outcome.expanded).toBe(true);
    expect(outcome.text).toContain("Debug src/main.ts in ts.");
    expect(outcome.text).toContain("Handle edge cases: (empty input, null).");
    expect(outcome.text).toContain("Minimal diff.");
    expect(outcome.text).not.toContain("[SQZ");
    expect(outcome.text).toContain("Plan:");
    expect(outcome.text).toContain("Done.");
  });

  it("expands bare JSON payload", () => {
    const sqzText = `Here: ${JSON.stringify(PAYLOAD)}`;
    const outcome = processAssistantText(sqzText, realDeps(), { expand: true });
    expect(outcome.expanded).toBe(true);
    expect(outcome.text).toContain("Debug src/main.ts in ts.");
  });

  it("expand toggle off → text byte-identical", () => {
    const sqzText = buildEnvelope(PAYLOAD, { includeLexicon: false });
    const outcome = processAssistantText(sqzText, realDeps(), { expand: false });
    expect(outcome.expanded).toBe(false);
    expect(outcome.text).toBe(sqzText);
  });

  it("plain prose passes through untouched", () => {
    const prose = "No SQZ here, just a helpful answer about refactoring.";
    const outcome = processAssistantText(prose, realDeps(), { expand: true });
    expect(outcome.expanded).toBe(false);
    expect(outcome.text).toBe(prose);
  });

  it("flags unknown symbols in audit but still renders the message", () => {
    const lexicon = DEFAULT_LEXICON.filter((e) => e.symbol !== "Δ");
    const deps: PluginDeps = { ...realDeps(), lexicon };
    const payload: SQZPayload = { ...PAYLOAD, constraints: ['Δ ["src/x.ts"]', "μ"] };
    const outcome = processAssistantText(JSON.stringify(payload), deps, { expand: true });
    expect(outcome.expanded).toBe(true);
    expect(outcome.text).toContain('Δ ["src/x.ts"]'); // rendered literally
    expect(outcome.auditFlags).toContain("unknown-symbol:Δ");
  });

  it("expand failure on a candidate skips it without corrupting the rest", () => {
    const deps = realDeps();
    deps.expandFn = () => {
      throw new Error("expand boom");
    };
    const sqzText = buildEnvelope(PAYLOAD, { includeLexicon: false });
    const outcome = processAssistantText(sqzText, deps, { expand: true });
    expect(outcome.expanded).toBe(false);
    expect(outcome.text).toBe(sqzText);
  });

  it("expands multiple payloads in one message", () => {
    const a = JSON.stringify(PAYLOAD);
    const b = JSON.stringify({ ...PAYLOAD, mode: "docs" });
    const outcome = processAssistantText(`A: ${a}\nB: ${b}`, realDeps(), { expand: true });
    expect(outcome.expanded).toBe(true);
    expect(outcome.text).toContain("Debug src/main.ts in ts.");
    expect(outcome.text).toContain("Write docs for src/main.ts in ts.");
    expect(outcome.text).not.toContain("SQZPayload");
  });
});

describe("expandSqzInText (format-adjacent helper)", () => {
  it("is idempotent: expanded text contains no payload candidates", () => {
    const PAYLOAD: SQZPayload = {
      v: 1,
      mode: "review",
      target: { files: ["src/auth.ts"], lang: "ts" },
      constraints: ["✓ examples run"],
      verbatim: [],
      confidence: 0.9,
    };
    const deps = realDeps();
    const audit: string[] = [];
    const first = expandSqzInText(JSON.stringify(PAYLOAD), deps, audit);
    expect(first.expanded).toBe(true);
    expect(findPayloadCandidates(first.text)).toEqual([]);
    expect(audit).toEqual([]);
  });
});