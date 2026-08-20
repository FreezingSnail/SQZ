/**
 * OllamaProvider — real local-model compressor via Ollama's chat API.
 *
 * Implements the `Provider` contract from types.ts. Calls POST /api/chat with
 * `format: "json"` plus the target JSON Schema embedded in the system prompt,
 * so the model emits a schema-valid SQZ payload directly.
 *
 * Rejection loop integration: the retry/error-injection loop lives in
 * translator.ts (`generateValidPayload`). This provider stays stateless across
 * attempts and accepts the appended assistant-error + system-feedback messages
 * as ordinary history — the schema instruction rides on the last system
 * message, so each retry re-sees the schema.
 *
 * Failure contract: throws on transport error / timeout / HTTP error, so the
 * translator ladder falls back to RuleProvider → passthrough. Unparseable
 * content is NOT resolved as an object: the raw string is returned and
 * translator.normalize() lets the retry ladder decide.
 */

import type { ChatMessage, Provider } from "../types.js";

export interface OllamaOptions {
  /** Model tag, e.g. "qwen3:1.7b". Env OLLAMA_MODEL overrides. */
  model?: string;
  /** Ollama base URL. Default http://127.0.0.1:11434. Env OLLAMA_BASE_URL overrides. */
  baseUrl?: string;
  /** Per-request timeout ms. Default 500 (epic design: provider budget). */
  timeoutMs?: number;
  /** Sampling temperature. Default 0 (deterministic). */
  temperature?: number;
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export const DEFAULT_OLLAMA_MODEL = "qwen3:1.7b";
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const OLLAMA_CHAT_PATH = "/api/chat";

/** Instruction appended to the last system message before every request. */
export function schemaPrompt(schema: object): string {
  return (
    "Respond with a single JSON object conforming to this JSON Schema:\n" +
    `${JSON.stringify(schema)}\n` +
    "Output only the JSON object — no commentary, no markdown fences."
  );
}

/** Attach the schema instruction to the last system message (prepend one if absent). */
export function withSchemaPrompt(messages: ChatMessage[], schema: object): ChatMessage[] {
  const out = messages.map((m) => ({ ...m }));
  const idx = out.map((m) => m.role).lastIndexOf("system");
  if (idx === -1) {
    out.unshift({ role: "system", content: schemaPrompt(schema) });
  } else {
    out[idx] = { ...out[idx], content: `${out[idx].content}\n\n${schemaPrompt(schema)}` };
  }
  return out;
}

/** Parse chat content: strip fences, JSON.parse, else return raw string. */
export function parseContent(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = (fenced ? fenced[1].trim() : trimmed).replace(/^```(?:json)?/, "").replace(/```$/, "");
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return candidate;
  }
}

export class OllamaProvider implements Provider {
  readonly name = "ollama";
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly temperature: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaOptions = {}) {
    this.model = options.model ?? process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL;
    this.baseUrl = (options.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 500;
    this.temperature = options.temperature ?? 0;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  getModel(): string {
    return this.model;
  }

  /** True when the Ollama daemon answers on the configured base URL. */
  async ping(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
        method: "GET",
        signal: AbortSignal.timeout(1000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** True when the daemon is up AND `model` (default: this.model) is pulled. */
  async hasModel(model?: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return false;
      const tags = (await res.json()) as { models?: Array<{ name: string }> };
      const want = model ?? this.model;
      return (tags.models ?? []).some((m) => m.name === want);
    } catch {
      return false;
    }
  }

  /**
   * POST /api/chat.
   *
   * v2 compress path (schema omitted): plain text, no format:json, no schema
   * prompt — the small model emits one raw SQZ line (fast, few tokens).
   *
   * Legacy JSON path (schema given, judge-style calls): format=json + schema
   * prompt appended to the system message.
   *
   * Resolves to the parsed JSON object, or the raw content string when
   * unparseable (translator.normalize() decides). Throws on transport error,
   * timeout, or non-OK HTTP status → translator falls back to RuleProvider.
   */
  async generate(messages: ChatMessage[], schema?: object): Promise<unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: schema ? withSchemaPrompt(messages, schema) : messages,
      stream: false,
      // Reasoning models (qwen3.5+) emit chain-of-thought by default; disable
      // it for low-latency structured output. Ignored by non-thinking models.
      think: false,
      // Hold the model in memory across benchmark runs (avoids reload stalls).
      keep_alive: "30m",
      options: { temperature: this.temperature },
    };
    if (schema) {
      body.format = "json";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${OLLAMA_CHAT_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(`ollama request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`ollama HTTP ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { message?: { content?: string }; error?: string };
    if (data.error) throw new Error(`ollama error: ${data.error}`);
    return parseContent(data.message?.content ?? "");
  }
}