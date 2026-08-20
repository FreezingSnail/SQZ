/**
 * Squeeze plugin e2e session harness tests (v2) — full session transcript
 * without a live opencode process or model (RuleProvider + mocks only).
 * Wire format: plain SQZ line inside the [SQZ v2] block.
 *
 * Acceptance mapping:
 *   - user prose in → compressed line to model → expanded output to user
 *   - audit mode round-trips original text
 *   - kill-switch config leaves session byte-identical to no-plugin
 *   - all failure paths fall back to prose
 */

import { describe, expect, it, vi } from "vitest";
import { SqueezeHarness } from "../../src/plugin/harness.js";
import { loadConfig } from "../../src/plugin/config.js";
import { makeDeps } from "../../src/plugin/squeeze.js";
import { parseEnvelope } from "../../src/plugin/format.js";
import { DEFAULT_LEXICON } from "../../src/providers.js";
import type { SQZLine } from "../../src/types.js";

const PROSE = "Refactor the tokenizer in src/tokenizer.ts. Preserve runtime behavior. Minimal diff.";

const MODEL_SQZ_REPLY: SQZLine =
  'debug Δ["src/main.ts"] L:ts ∂[(empty input, null)] μ v"Keep the retry loop"';

function harnessFor(options: Record<string, unknown> = {}) {
  const config = loadConfig({ enabled: true, provider: "rule", threshold: 5, ...options });
  return new SqueezeHarness(makeDeps(config), {
    threshold: config.threshold,
    audit: config.audit,
    retries: config.retries,
    expand: config.expand,
  });
}

describe("e2e session — happy path", () => {
  it("user prose in → compressed line to model → expanded output to user", async () => {
    const h = harnessFor();
    const turn = await h.turn(PROSE, `[SQZ v2]\n${MODEL_SQZ_REPLY}\n[/SQZ]`);

    // 1. user prose in
    expect(turn.userProse).toBe(PROSE);

    // 2. compressed line to model (envelope, not prose; first message has lexicon)
    expect(turn.modelInput).toContain("[SQZ v2]");
    expect(turn.modelInput).toContain("[SQZ lexicon]");
    const parts = parseEnvelope(turn.modelInput);
    expect(parts.line).toMatch(/^refactor\b/);
    expect(parts.lexicon).toEqual(DEFAULT_LEXICON);

    // 3. expanded output to user
    expect(turn.userOutput).toContain("Debug src/main.ts in ts.");
    expect(turn.userOutput).toContain("Handle edge cases: (empty input, null).");
    expect(turn.userOutput).toContain("Minimal diff.");
    expect(turn.userOutput).toContain("Keep the retry loop");
    expect(turn.userOutput).not.toContain("[SQZ");
  });

  it("lexicon injected once: second turn has no lexicon block", async () => {
    const h = harnessFor();
    await h.turn(PROSE, "ok");
    const second = await h.turn(PROSE, "ok");
    expect(second.modelInput).not.toContain("[SQZ lexicon]");
    expect(h.transcript).toHaveLength(2);
  });
});

describe("e2e session — audit mode", () => {
  it("round-trips the original prose inside the fenced block", async () => {
    const h = harnessFor({ audit: true });
    const turn = await h.turn(PROSE, "plain reply");
    expect(turn.modelInput).toContain("[SQZ original]");
    expect(turn.modelInput).toContain(PROSE);
    const parts = parseEnvelope(turn.modelInput);
    expect(parts.original).toBe(PROSE);
    expect(parts.line).toBeDefined();
  });
});

describe("e2e session — kill switch", () => {
  it("disabled config leaves the transcript byte-identical to no-plugin", async () => {
    const config = loadConfig({ enabled: false });
    const deps = makeDeps(config);
    const h = new SqueezeHarness(deps, {
      threshold: config.threshold,
      audit: config.audit,
      retries: config.retries,
      expand: config.expand,
    });
    const turn = await h.turn(PROSE, "plain reply");
    expect(turn.modelInput).toBe(PROSE);
    expect(turn.userOutput).toBe("plain reply");
    expect(parseEnvelope(turn.modelInput)).toEqual({});
  });
});

describe("e2e session — failure paths fall back to prose", () => {
  it("provider down → user prose passes through unchanged", async () => {
    const config = loadConfig({ enabled: true, provider: "rule", threshold: 5 });
    const deps = makeDeps(config);
    deps.compress = async () => {
      throw new Error("provider down");
    };
    const h = new SqueezeHarness(deps, {
      threshold: config.threshold,
      audit: config.audit,
      retries: config.retries,
      expand: config.expand,
    });
    const turn = await h.turn(PROSE, "plain reply");
    expect(turn.modelInput).toBe(PROSE);
    expect(turn.userOutput).toBe("plain reply");
  });

  it("expand parse failure → assistant output unchanged", async () => {
    const config = loadConfig({ enabled: true, provider: "rule", threshold: 5 });
    const deps = makeDeps(config);
    const h = new SqueezeHarness(deps, {
      threshold: config.threshold,
      audit: config.audit,
      retries: config.retries,
      expand: config.expand,
    });
    const turn = await h.turn(PROSE, "the model forgot the format: {v: 1, mode:");
    expect(turn.userOutput).toBe("the model forgot the format: {v: 1, mode:");
  });

  it("empty/refusal assistant output passes through", async () => {
    const h = harnessFor();
    const turn = await h.turn(PROSE, "");
    expect(turn.userOutput).toBe("");
  });

  it("unknown symbol in expand → literal render + audit flag, session survives", async () => {
    const config = loadConfig({ enabled: true, provider: "rule", threshold: 5 });
    const deps = makeDeps(config);
    deps.lexicon = DEFAULT_LEXICON.filter((e) => e.symbol !== "∂");
    const h = new SqueezeHarness(deps, {
      threshold: config.threshold,
      audit: config.audit,
      retries: config.retries,
      expand: config.expand,
    });
    const turn = await h.turn(
      PROSE,
      `[SQZ v2]\ndebug Δ["src/main.ts"] L:ts ∂[(empty input)]\n[/SQZ]`,
    );
    expect(turn.userOutput).toContain("∂"); // rendered literally
  });
});

describe("e2e session — savings sanity", () => {
  it("compressed model input is smaller than raw prose for verbose input", async () => {
    const verbose =
      "Please refactor the tokenizer module which lives in src/tokenizer.ts. " +
      "It is very important that you preserve the runtime behavior exactly " +
      "and that you make the smallest possible change to the code.";
    const h = harnessFor();
    const turn = await h.turn(verbose, "ok");
    expect(turn.modelInput).toContain("[SQZ v2]");
    // Model input excludes the ~800-token lexicon after the first message.
    const second = await h.turn(verbose, "ok");
    expect(second.modelInput.length).toBeLessThan(verbose.length);
  });
});
