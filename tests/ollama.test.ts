/**
 * OllamaProvider unit tests — mocked fetch, no daemon required.
 * Covers request building (format=json + schema prompt), content parsing,
 * transport errors, timeout, and availability detection.
 */

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_OLLAMA_MODEL,
  OllamaProvider,
  parseContent,
  schemaPrompt,
  withSchemaPrompt,
} from "../src/providers/ollama.js";
import type { ChatMessage } from "../src/types.js";

const SCHEMA = { type: "object", required: ["v"] };

function chatResponse(content: string): Response {
  return new Response(JSON.stringify({ message: { content } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mockFetch(responses: Array<Response | ((init?: RequestInit) => Promise<Response>)>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch call");
    calls.push({ url: String(url), init });
    return typeof next === "function" ? next(init) : next;
  }) as typeof fetch;
  return { fetchImpl: impl, calls };
}

const messages: ChatMessage[] = [
  { role: "system", content: JSON.stringify({ task: "compress-prose-to-sqz" }) },
  { role: "user", content: "Refactor src/a.ts, preserve behavior." },
];

describe("schemaPrompt / withSchemaPrompt", () => {
  it("appends schema instruction to the last system message", () => {
    const out = withSchemaPrompt(messages, SCHEMA);
    expect(out.length).toBe(2);
    expect(out[0].content).toContain(schemaPrompt(SCHEMA));
    expect(out[1]).toEqual(messages[1]);
  });

  it("prepends a system message when none exists", () => {
    const only: ChatMessage[] = [{ role: "user", content: "hi" }];
    const out = withSchemaPrompt(only, SCHEMA);
    expect(out[0].role).toBe("system");
    expect(out[0].content).toContain("JSON Schema");
    expect(out[1]).toEqual(only[0]);
  });

  it("schema prompt embeds the serialized schema and JSON-only instruction", () => {
    const prompt = schemaPrompt(SCHEMA);
    expect(prompt).toContain(JSON.stringify(SCHEMA));
    expect(prompt).toMatch(/JSON object only|no commentary/i);
  });
});

describe("parseContent", () => {
  it("parses plain JSON", () => {
    expect(parseContent('{"v":1}')).toEqual({ v: 1 });
  });

  it("strips markdown fences before parsing", () => {
    expect(parseContent('```json\n{"v":1}\n```')).toEqual({ v: 1 });
    expect(parseContent('```\n{"v":1}\n```')).toEqual({ v: 1 });
  });

  it("returns the raw string when unparseable (retry ladder decides)", () => {
    const raw = "sorry, here is my answer";
    expect(parseContent(raw)).toBe(raw);
  });
});

describe("OllamaProvider.generate", () => {
  it("POSTs /api/chat with model, format=json, stream=false, schema prompt", async () => {
    const { fetchImpl, calls } = mockFetch([chatResponse('{"v":1}')]);
    const provider = new OllamaProvider({ fetchImpl, timeoutMs: 5000 });
    await provider.generate(messages, SCHEMA);

    expect(calls.length).toBe(1);
    expect(calls[0].url).toMatch(/\/api\/chat$/);
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init?.body)) as {
      model: string;
      format: string;
      stream: boolean;
      messages: ChatMessage[];
    };
    expect(body.model).toBe(DEFAULT_OLLAMA_MODEL);
    expect(body.format).toBe("json");
    expect(body.stream).toBe(false);
    expect(body.messages[0].content).toContain("JSON Schema");
  });

  it("resolves the parsed JSON object from message.content", async () => {
    const { fetchImpl } = mockFetch([chatResponse('{"v":1,"mode":"refactor"}')]);
    const provider = new OllamaProvider({ fetchImpl });
    await expect(provider.generate(messages, SCHEMA)).resolves.toEqual({ v: 1, mode: "refactor" });
  });

  it("returns the raw content string when unparseable", async () => {
    const { fetchImpl } = mockFetch([chatResponse("no json here")]);
    const provider = new OllamaProvider({ fetchImpl });
    await expect(provider.generate(messages, SCHEMA)).resolves.toBe("no json here");
  });

  it("throws on non-OK HTTP status", async () => {
    const { fetchImpl } = mockFetch([new Response("bad", { status: 500 })]);
    const provider = new OllamaProvider({ fetchImpl });
    await expect(provider.generate(messages, SCHEMA)).rejects.toThrow(/500/);
  });

  it("throws on daemon error field", async () => {
    const { fetchImpl } = mockFetch([jsonResponse({ error: "model not found" })]);
    const provider = new OllamaProvider({ fetchImpl });
    await expect(provider.generate(messages, SCHEMA)).rejects.toThrow(/model not found/);
  });

  it("throws on transport failure (daemon down)", async () => {
    const fetchImpl = (async () => {
      throw new Error("fetch failed");
    }) as typeof fetch;
    const provider = new OllamaProvider({ fetchImpl });
    await expect(provider.generate(messages, SCHEMA)).rejects.toThrow(/ollama request failed/);
  });

  it("aborts and throws on timeout", async () => {
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;
    const provider = new OllamaProvider({ fetchImpl, timeoutMs: 10 });
    await expect(provider.generate(messages, SCHEMA)).rejects.toThrow(/ollama request failed/);
  });

  it("honors model option and baseUrl normalization", async () => {
    const { fetchImpl, calls } = mockFetch([chatResponse('{"v":1}')]);
    const provider = new OllamaProvider({ fetchImpl, model: "qwen3:4b", baseUrl: "http://127.0.0.1:11434/" });
    await provider.generate(messages, SCHEMA);
    const body = JSON.parse(String(calls[0].init?.body)) as { model: string };
    expect(body.model).toBe("qwen3:4b");
    expect(calls[0].url.startsWith("http://127.0.0.1:11434/api/chat")).toBe(true);
  });
});

describe("OllamaProvider availability detection", () => {
  it("ping() is true when /api/tags answers ok", async () => {
    const { fetchImpl } = mockFetch([jsonResponse({ models: [] })]);
    const provider = new OllamaProvider({ fetchImpl });
    await expect(provider.ping()).resolves.toBe(true);
  });

  it("ping() is false when daemon is down", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    const provider = new OllamaProvider({ fetchImpl });
    await expect(provider.ping()).resolves.toBe(false);
  });

  it("hasModel() is true when the model tag is pulled", async () => {
    const tags = () => jsonResponse({ models: [{ name: "qwen3:1.7b" }, { name: "qwen3:4b" }] });
    const { fetchImpl } = mockFetch([tags(), tags(), tags()]);
    const provider = new OllamaProvider({ fetchImpl, model: "qwen3:1.7b" });
    await expect(provider.hasModel()).resolves.toBe(true);
    await expect(provider.hasModel("qwen3:4b")).resolves.toBe(true);
    await expect(provider.hasModel("missing:1b")).resolves.toBe(false);
  });
});

describe("rejection loop integration with mocked provider", () => {
  it("passes appended retry feedback messages back to the provider", async () => {
    const seen: ChatMessage[][] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: ChatMessage[] };
      seen.push(body.messages);
      // First attempt: invalid payload. Second attempt: valid.
      const valid = seen.length > 1;
      return chatResponse(valid ? '{"v":1,"mode":"refactor","target":{"files":["src/a.ts"],"lang":"ts"},"constraints":[],"verbatim":[],"confidence":0.9}' : '"not an object"');
    }) as typeof fetch;

    const provider = new OllamaProvider({ fetchImpl, timeoutMs: 5000 });
    const first = await provider.generate(messages, SCHEMA);
    // parseContent JSON-parses the quoted string, so the value is the bare string.
    expect(first).toBe("not an object");

    // Simulate translator's error injection: append assistant error + system feedback.
    const retried = [
      ...messages,
      { role: "assistant" as const, content: '"not an object"' },
      { role: "system" as const, content: "Schema validation failed: / type must be object. Respond again." },
    ];
    const second = await provider.generate(retried, SCHEMA);
    expect(second).toMatchObject({ v: 1, mode: "refactor" });
    // Schema instruction still present on the last system message.
    expect(seen[1].filter((m) => m.role === "system").at(-1)?.content).toContain("JSON Schema");
  });
});