/**
 * SQZ translator core — model-independent compress/expand with
 * retry → fallback → passthrough ladder.
 *
 * Error ladder (epic design):
 *   parse/schema fail → inject error, retry (max `retries`) → passthrough
 *   provider down     → RuleProvider fallback → passthrough
 *   unknown symbol    → render literally + audit flag (expand)
 *
 * Invariant: original prose always recoverable; never silently mutated.
 */

import type {
  ChatMessage,
  CompressOptions,
  CompressResult,
  ExpandOptions,
  Lexicon,
  Mode,
  Provider,
  SQZPayload,
} from "./types.js";
import { isMode } from "./types.js";
import { validatePayload, schema } from "./validate.js";
import { RuleProvider, passthroughPayload } from "./providers.js";

const MODE_TEMPLATES: Record<Mode, string> = {
  refactor: "Refactor {files} in {lang}.",
  api: "Implement API for {files} in {lang}.",
  debug: "Debug {files} in {lang}.",
  docs: "Write docs for {files} in {lang}.",
  test: "Write tests for {files} in {lang}.",
  review: "Review {files} in {lang}.",
  arch: "Architect {files} in {lang}.",
  general: "Task on {files} in {lang}.",
};

const CLAUSE_TEMPLATES: Record<string, (operand: string) => string> = {
  "≋": (operand) => `Preserve behavior: ${operand.trim()}.`,
  "Δ": (operand) => `Change files: ${operand.trim()}.`,
  "∂": (operand) => `Handle edge cases: ${operand.trim()}.`,
  "μ": () => "Minimal diff.",
  "⌁": (operand) => `Coverage: ${operand.trim()}.`,
  "→": (operand) => `Pipeline: ${operand.trim()}.`,
  "✓": (operand) => `Verified: ${operand.trim()}.`,
  "⏭": (operand) => `Skip: ${operand.trim()}.`,
};

const SYMBOL_GLYPHS = new Set(["Δ", "≋", "∂", "μ", "⌁", "→", "✓", "⏭"]);

function normalize(raw: unknown): unknown {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

/**
 * Attempt provider generation up to `retries + 1` times. On schema failure,
 * inject the validation errors back into the message list (error injection).
 * Returns null when all attempts failed (caller falls back / passes through).
 */
async function generateValidPayload(
  provider: Provider,
  messages: ChatMessage[],
  schema: object,
  retries: number,
): Promise<SQZPayload | null> {
  let current = [...messages];
  for (let attempt = 0; attempt <= retries; attempt++) {
    const raw = await provider.generate(current, schema);
    const obj = normalize(raw);
    const { valid, errors } = validatePayload(obj);
    if (valid) return obj as SQZPayload;
    current = [
      ...current,
      { role: "assistant", content: JSON.stringify(obj) },
      {
        role: "system",
        content: `Schema validation failed: ${errors.join("; ")}. Respond again with a valid SQZ payload JSON object only.`,
      },
    ];
  }
  return null;
}

export async function compress(
  prose: string,
  options: CompressOptions,
): Promise<CompressResult> {
  const { domain, lexicon, retries = 2 } = options;
  const provider = options.provider ?? new RuleProvider();

  const started = performance.now();
  const messages: ChatMessage[] = [
    { role: "system", content: JSON.stringify({ task: "compress-prose-to-sqz", lexicon }) },
    { role: "user", content: prose },
  ];

  let payload: SQZPayload | null = null;
  try {
    payload = await generateValidPayload(provider, messages, schema, retries);
  } catch {
    // Provider down/timeout → deterministic fallback, no model.
    payload = await generateValidPayload(new RuleProvider(), messages, schema, 0);
  }
  const latencyMs = performance.now() - started;

  if (payload === null) {
    payload = passthroughPayload(prose, domain);
  }

  const sqz: SQZPayload = {
    ...payload,
    mode: isMode(domain) && domain !== undefined ? domain : payload.mode,
  };

  return {
    sqz,
    verbatim: sqz.verbatim,
    confidence: sqz.confidence,
    latencyMs,
  };
}

/** Render a constraint clause to prose. Unknown symbols render literally + audit flag. */
function renderClause(clause: string, lexicon: Lexicon, audit?: string[]): string {
  const trimmed = clause.trim();
  const knownSymbols = new Set(lexicon.map((e) => e.symbol));

  // Any glyph not in leading position → unparseable: render literally + flag.
  for (const glyph of SYMBOL_GLYPHS) {
    if (trimmed.includes(glyph) && !trimmed.startsWith(glyph)) {
      audit?.push(`unknown-symbol:${glyph}`);
      return trimmed;
    }
  }
  for (const glyph of SYMBOL_GLYPHS) {
    if (trimmed.startsWith(glyph)) {
      if (!knownSymbols.has(glyph)) {
        audit?.push(`unknown-symbol:${glyph}`);
        return trimmed;
      }
      const operand = trimmed.slice(glyph.length).trim();
      return CLAUSE_TEMPLATES[glyph]?.(operand) ?? trimmed;
    }
  }
  return trimmed;
}

export function expand(
  payload: SQZPayload,
  lexicon: Lexicon,
  options?: ExpandOptions,
): string {
  const audit = options?.audit;
  const files = payload.target.files.join(", ");
  const parts: string[] = [
    MODE_TEMPLATES[payload.mode]
      .replace("{files}", files)
      .replace("{lang}", payload.target.lang),
  ];
  for (const constraint of payload.constraints) {
    parts.push(renderClause(constraint, lexicon, audit));
  }
  // Verbatim clauses pass through byte-for-byte: lossless guarantee.
  for (const v of payload.verbatim) {
    parts.push(v);
  }
  return parts.join("\n");
}
