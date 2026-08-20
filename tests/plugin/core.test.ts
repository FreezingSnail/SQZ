/**
 * Squeeze plugin core tests (v2): threshold gate, envelope building, audit
 * mode, confidence gate, every failure path → original prose unchanged,
 * assistant expansion + expand toggle, unknown-symbol audit passthrough.
 * Wire format: plain SQZ line inside the [SQZ v2] block.
 */

import { describe, expect, it, vi } from "vitest";
import {
  MIN_CONFIDENCE,
  processAssistantText,
  processUserText,
  expandSqzInText,
  type PluginDeps,
} from "../../src/plugin/core.js";
import { buildEnvelope, findLineCandidates } from "../../src/plugin/format.js";
import { compress, expand } from "../../src/translator.js";
import { DEFAULT_LEXICON } from "../../src/providers.js";
import { estimateTokens } from "../../src/tokens.js";
import type { CompressOptions, CompressResult, Lexicon, SQZLine } from "../../src/types.js";

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
  it("compresses prose into an envelope carrying the SQZ line", async () => {
    const outcome = await processUserText(PROSE, realDeps(), OPTS);
    expect(outcome.compressed).toBe(true);
    expect(outcome.line).toMatch(/^refactor\b/);
    expect(outcome.text).toContain("[SQZ v2]");
    expect(outcome.text).toContain("[/SQZ]");
    expect(outcome.text).not.toContain('"mode"'); // no JSON envelope
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
    expect(outcome.text.indexOf("[SQZ original]")).toBeLessThan(outcome.text.indexOf("[SQZ v2]"));
  });

  it("recoverability: line carries v\"...\" verbatim segments", async () => {
    const outcome = await processUserText(PROSE, realDeps(), { ...OPTS, audit: false });
    expect(outcome.line).toBeTruthy();
    expect(outcome.text).toContain("[SQZ v2]");
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

  it("low-confidence result → original prose unchanged", async () => {
    const deps = realDeps();
    deps.compress = async (_p, _o): Promise<CompressResult> => ({
      sqz: `general Δ["-"] L:text v"${PROSE}"`,
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
      sqz: `general Δ["-"] L:text v"${PROSE}"`,
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
  const LINE: SQZLine = 'debug Δ["src/main.ts"] L:ts ∂[(empty input, null)] μ';

  it("expands a marker-block line to prose", () => {
    const sqzText = `Plan:\n${buildEnvelope(LINE, { includeLexicon: false })}\nDone.`;
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

  it("expand toggle off → text byte-identical", () => {
    const sqzText = buildEnvelope(LINE, { includeLexicon: false });
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
    const line: SQZLine = 'debug Δ["src/x.ts"] L:ts Δ["src/x.ts"] μ';
    const outcome = processAssistantText(
      buildEnvelope(line, { includeLexicon: false }),
      deps,
      { expand: true },
    );
    expect(outcome.expanded).toBe(true);
    expect(outcome.text).toContain("Δ"); // rendered literally
    expect(outcome.auditFlags).toContain("unknown-symbol:Δ");
  });

  it("expand failure on a candidate skips it without corrupting the rest", () => {
    const deps = realDeps();
    deps.expandFn = () => {
      throw new Error("expand boom");
    };
    const sqzText = buildEnvelope(LINE, { includeLexicon: false });
    const outcome = processAssistantText(sqzText, deps, { expand: true });
    expect(outcome.expanded).toBe(false);
    expect(outcome.text).toBe(sqzText);
  });

  it("expands multiple lines in one message", () => {
    const a = buildEnvelope(LINE, { includeLexicon: false });
    const b = buildEnvelope('docs Δ["README.md"] L:md ⌁', { includeLexicon: false });
    const outcome = processAssistantText(`A: ${a}\nB: ${b}`, realDeps(), { expand: true });
    expect(outcome.expanded).toBe(true);
    expect(outcome.text).toContain("Debug src/main.ts in ts.");
    expect(outcome.text).toContain("Write docs for README.md in md.");
  });
});

describe("expandSqzInText (format-adjacent helper)", () => {
  it("is idempotent: expanded text contains no line candidates", () => {
    const LINE: SQZLine = 'review Δ["src/auth.ts"] L:ts ✓[examples run]';
    const deps = realDeps();
    const audit: string[] = [];
    const first = expandSqzInText(buildEnvelope(LINE, { includeLexicon: false }), deps, audit);
    expect(first.expanded).toBe(true);
    expect(findLineCandidates(first.text)).toEqual([]);
    expect(audit).toEqual([]);
  });
});
