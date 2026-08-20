/**
 * Squeeze plugin hook-wiring tests — SDK-shaped objects, no live opencode.
 * Covers: user-message compression in `chat.message`, once-per-session
 * lexicon, kill switch (byte-identical), assistant expansion via
 * `experimental.chat.messages.transform`, synthetic-part skip, and full
 * degradation (never throws, never corrupts).
 */

import { describe, expect, it } from "vitest";
import { SqueezePlugin } from "../../src/plugin/squeeze.js";
import { DEFAULT_LEXICON } from "../../src/providers.js";
import { estimateTokens } from "../../src/tokens.js";

const PROSE = "Refactor the tokenizer in src/tokenizer.ts. Preserve runtime behavior. Minimal diff.";

function stubInput(): any {
  return {
    client: { app: { log: async () => ({}) } },
    directory: "/repo",
    worktree: "/repo",
  };
}

async function loadPlugin(options: Record<string, unknown> = {}): Promise<any> {
  return SqueezePlugin(stubInput(), options);
}

function textPart(text: string) {
  return { id: "p1", sessionID: "s1", messageID: "m1", type: "text", text };
}

function userOutput(text: string) {
  return {
    message: { id: "m1", sessionID: "s1", role: "user", time: { created: 0 }, agent: "build" },
    parts: [textPart(text)],
  };
}

describe("chat.message pre hook", () => {
  it("compresses user prose into a SQZ envelope before the model sees it", async () => {
    const hooks = await loadPlugin({ enabled: true, provider: "rule", threshold: 5 });
    const output = userOutput(PROSE);
    await hooks["chat.message"]!({ sessionID: "s1" }, output);

    expect(output.parts[0].type).toBe("text");
    expect(output.parts[0].text).toContain("[SQZ v1]");
    expect(output.parts[0].text).toContain("[/SQZ]");
  });

  it("injects the session lexicon on the first user message only", async () => {
    const hooks = await loadPlugin({ enabled: true, provider: "rule", threshold: 5 });
    const first = userOutput(PROSE);
    await hooks["chat.message"]!({ sessionID: "s1" }, first);
    expect(first.parts[0].text).toContain("[SQZ lexicon]");
    expect(first.parts[0].text).toContain(JSON.stringify(DEFAULT_LEXICON).slice(0, 40));

    const second = userOutput(PROSE);
    await hooks["chat.message"]!({ sessionID: "s1" }, second);
    expect(second.parts[0].text).not.toContain("[SQZ lexicon]");
  });

  it("tracks lexicon injection per session", async () => {
    const hooks = await loadPlugin({ enabled: true, provider: "rule", threshold: 5 });
    const a1 = userOutput(PROSE);
    const b1 = userOutput(PROSE);
    await hooks["chat.message"]!({ sessionID: "session-a" }, a1);
    await hooks["chat.message"]!({ sessionID: "session-b" }, b1);
    expect(a1.parts[0].text).toContain("[SQZ lexicon]");
    expect(b1.parts[0].text).toContain("[SQZ lexicon]");
  });

  it("kill switch: disabled config leaves parts byte-identical", async () => {
    const hooks = await loadPlugin({ enabled: false });
    const output = userOutput(PROSE);
    await hooks["chat.message"]!({ sessionID: "s1" }, output);
    expect(output.parts[0].text).toBe(PROSE);
  });

  it("skips synthetic parts (file/tool context never compressed)", async () => {
    const hooks = await loadPlugin({ enabled: true, provider: "rule", threshold: 5 });
    const output = {
      message: { id: "m1", sessionID: "s1", role: "user" },
      parts: [
        { ...textPart(""), synthetic: true, text: "```ts\nconst x = 1\n```" },
        textPart(PROSE),
      ],
    };
    await hooks["chat.message"]!({ sessionID: "s1" }, output);
    expect(output.parts[0].text).toBe("```ts\nconst x = 1\n```");
    expect(output.parts[1].text).toContain("[SQZ v1]");
  });

  it("assistant role in chat.message is ignored", async () => {
    const hooks = await loadPlugin({ enabled: true, provider: "rule", threshold: 5 });
    const output = {
      message: { id: "m1", sessionID: "s1", role: "assistant" },
      parts: [textPart("some reply")],
    };
    await hooks["chat.message"]!({ sessionID: "s1" }, output);
    expect(output.parts[0].text).toBe("some reply");
  });
});

describe("experimental.chat.messages.transform post hook", () => {
  const PAYLOAD = {
    v: 1,
    mode: "debug",
    target: { files: ["src/main.ts"], lang: "ts" },
    constraints: ["∂ (empty input, null)"],
    verbatim: [],
    confidence: 0.95,
  };

  function assistantHistory(sqzText: string) {
    return {
      messages: [
        {
          info: { role: "assistant" },
          parts: [textPart(sqzText)],
        },
      ],
    };
  }

  it("expands SQZ in assistant parts to prose in place", async () => {
    const hooks = await loadPlugin({ enabled: true, provider: "rule", threshold: 5 });
    const sqz = `Plan:\n[SQZ v1]\n${JSON.stringify(PAYLOAD)}\n[/SQZ]\nDone.`;
    const output = assistantHistory(sqz);
    await hooks["experimental.chat.messages.transform"]!({}, output);
    expect(output.messages[0].parts[0].text).toContain("Debug src/main.ts in ts.");
    expect(output.messages[0].parts[0].text).toContain("Handle edge cases: (empty input, null).");
    expect(output.messages[0].parts[0].text).not.toContain("[SQZ");
  });

  it("expand toggle off → assistant text byte-identical", async () => {
    const hooks = await loadPlugin({ enabled: true, provider: "rule", threshold: 5, expand: false });
    const sqz = `[SQZ v1]\n${JSON.stringify(PAYLOAD)}\n[/SQZ]`;
    const output = assistantHistory(sqz);
    await hooks["experimental.chat.messages.transform"]!({}, output);
    expect(output.messages[0].parts[0].text).toBe(sqz);
  });

  it("never touches user messages in history", async () => {
    const hooks = await loadPlugin({ enabled: true, provider: "rule", threshold: 5 });
    const output = {
      messages: [
        { info: { role: "user" }, parts: [textPart(PROSE)] },
        { info: { role: "assistant" }, parts: [textPart("plain reply")] },
      ],
    };
    await hooks["experimental.chat.messages.transform"]!({}, output);
    expect(output.messages[0].parts[0].text).toBe(PROSE);
    expect(output.messages[1].parts[0].text).toBe("plain reply");
  });
});

describe("degradation — plugin never blocks or corrupts", () => {
  it("non-text parts are ignored without error", async () => {
    const hooks = await loadPlugin({ enabled: true, provider: "rule", threshold: 5 });
    const output = {
      message: { id: "m1", sessionID: "s1", role: "user" },
      parts: [{ id: "t", sessionID: "s1", messageID: "m1", type: "tool", state: {} }],
    };
    await hooks["chat.message"]!({ sessionID: "s1" }, output as any);
    expect(output.parts[0].type).toBe("tool");
  });

  it("corrupt config file + unknown provider → graceful defaults, no throw", async () => {
    const hooks = await loadPlugin({ enabled: true, provider: "no-such-provider", threshold: 5 });
    const output = userOutput(PROSE);
    await hooks["chat.message"]!({ sessionID: "s1" }, output);
    expect(output.parts[0].text).toContain("[SQZ v1]"); // rule fallback still compressed
  });

  it("hook wiring never double-compresses an existing envelope", async () => {
    const hooks = await loadPlugin({ enabled: true, provider: "rule", threshold: 5 });
    const first = userOutput(PROSE);
    await hooks["chat.message"]!({ sessionID: "s1" }, first);
    const compressed = first.parts[0].text;

    // Feeding the already-compressed envelope through again must not change it.
    const second = userOutput(compressed);
    await hooks["chat.message"]!({ sessionID: "s1" }, second);
    expect(second.parts[0].text).toBe(compressed);
  });

  it("short messages below threshold stay byte-identical even when enabled", async () => {
    const hooks = await loadPlugin({ enabled: true, provider: "rule", threshold: 10_000 });
    const output = userOutput("hi");
    await hooks["chat.message"]!({ sessionID: "s1" }, output);
    expect(output.parts[0].text).toBe("hi");
  });

  it("token estimate utility is consistent", () => {
    expect(estimateTokens(PROSE)).toBeGreaterThan(5);
  });
});