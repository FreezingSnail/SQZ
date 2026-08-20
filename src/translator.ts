/**
 * SQZ translator core — model-independent compress/expand with
 * retry → fallback → passthrough ladder.
 *
 * v2 wire format: compress() returns a plain SQZ line (no JSON envelope).
 * The line is the compact form — the JSON AST was bigger than typical prose
 * (measured savings -0.43) and forced slow structured generation.
 *
 * Error ladder (epic design):
 *   grammar fail    → inject error, retry (max `retries`) → passthrough
 *   provider down   → RuleProvider fallback → passthrough
 *   unknown symbol  → render literally + audit flag (expand)
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
  SQZLine,
} from "./types.js";
import { isMode } from "./types.js";
import { validateLine } from "./validate.js";
import { parseLine, lexiconEntry, type LineAST } from "./line.js";
import { RuleProvider, passthroughLine } from "./providers.js";

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
  "≋": (operand) => `Preserve behavior: ${operand.trim() || "same as before"}.`,
  "Δ": (operand) => `Change files: ${operand.trim()}.`,
  "∂": (operand) => `Handle edge cases: ${operand.trim() || "edge cases"}.`,
  "μ": () => "Minimal diff.",
  "⌁": (operand) => `Coverage: ${operand.trim() || "complete"}.`,
  "→": (operand) => `Pipeline: ${operand.trim()}.`,
  "✓": (operand) => `Verified: ${operand.trim() || "acceptance criteria"}.`,
  "⏭": (operand) => `Skip: ${operand.trim() || "leave untouched"}.`,
};

/** System prompt for the small model: lexicon table + grammar + one example. No JSON schema. */
export function compressPrompt(lexicon: Lexicon): string {
  const table = lexicon
    .map((e) => `${e.symbol} = ${e.meaning} (domain: ${e.domain})`)
    .join("\n");
  return (
    "You are the SQZ compressor. Encode the user's request into ONE SQZ line using this grammar:\n" +
    '<mode> Δ["file1","file2"] [L:<lang>] <symbol>[operand]... v"verbatim clause"\n' +
    "Modes: refactor api debug docs test review arch general.\n" +
    "Lexicon:\n" +
    table +
    "\nSymbols may carry a [...] or (...) operand; a bare symbol is a flag. " +
    'Anything you cannot encode confidently goes into v"..." segments verbatim.\n' +
    'Example: refactor Δ["src/a.ts"] L:ts ≋ μ ∂ v"keep log messages identical"\n' +
    "Emit ONLY the line, no commentary."
  );
}

/** Render a symbol clause to prose. Unknown symbols render literally + audit flag. */
function renderClause(clause: { symbol: string; operand: string }, lexicon: Lexicon, audit?: string[]): string {
  if (!lexiconEntry(lexicon, clause.symbol)) {
    audit?.push(`unknown-symbol:${clause.symbol}`);
    return clause.operand ? `${clause.symbol} ${clause.operand}` : clause.symbol;
  }
  const template = CLAUSE_TEMPLATES[clause.symbol];
  if (!template) {
    // Known to the lexicon but no built-in template: render literally.
    return clause.operand ? `${clause.symbol} ${clause.operand}` : clause.symbol;
  }
  return template(clause.operand);
}

/**
 * Attempt provider generation up to `retries + 1` times. On grammar failure,
 * inject the validation errors back into the message list (error injection).
 * Returns null when all attempts failed (caller falls back / passes through).
 */
async function generateValidLine(
  provider: Provider,
  messages: ChatMessage[],
  lexicon: Lexicon,
  retries: number,
): Promise<SQZLine | null> {
  let current = [...messages];
  for (let attempt = 0; attempt <= retries; attempt++) {
    const raw = await provider.generate(current);
    const line = typeof raw === "string" ? raw.trim() : "";
    const { valid, errors } = validateLine(line, lexicon);
    if (valid) return line;
    current = [
      ...current,
      { role: "assistant", content: line },
      {
        role: "system",
        content: `Grammar validation failed: ${errors.join("; ")}. Respond again with a single valid SQZ line only.`,
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
    { role: "system", content: compressPrompt(lexicon) },
    { role: "user", content: prose },
  ];

  let line: SQZLine | null = null;
  try {
    line = await generateValidLine(provider, messages, lexicon, retries);
  } catch {
    // Provider down/timeout → deterministic fallback, no model.
    line = await generateValidLine(new RuleProvider(), messages, lexicon, 0);
  }
  const latencyMs = performance.now() - started;

  let confidence = 0.9;
  if (line === null) {
    line = passthroughLine(prose, domain);
    confidence = 0;
  }

  // Domain hint: rewrite the leading mode token when the caller specified one.
  if (isMode(domain) && line !== null) {
    const ast = parseLine(line, lexicon);
    if (ast.mode && ast.mode !== domain) {
      line = line.replace(/^\S+/, domain);
    }
  }

  const ast = parseLine(line, lexicon);
  return {
    sqz: line,
    verbatim: ast.verbatim,
    confidence,
    latencyMs,
  };
}

/** Expand a v2 SQZ line back to prose. Unknown symbols render literally + audit flags. */
export function expand(
  line: SQZLine,
  lexicon: Lexicon,
  options?: ExpandOptions,
): string {
  const audit = options?.audit;
  const ast: LineAST = parseLine(line, lexicon);
  if (!ast.mode && ast.errors.length > 0 && ast.files.length === 0 && ast.verbatim.length === 0) {
    // Not parseable as SQZ at all: return it untouched (lossless invariant).
    audit?.push(`unparseable-line:${line}`);
    return line;
  }

  const files = ast.files.length > 0 ? ast.files.join(", ") : "-";
  const lang = ast.lang || "text";
  const template = (ast.mode && (MODE_TEMPLATES as Record<string, string>)[ast.mode])
    ?? MODE_TEMPLATES.general;

  const parts: string[] = [
    template.replace("{files}", files).replace("{lang}", lang),
  ];
  for (const clause of ast.clauses) {
    parts.push(renderClause(clause, lexicon, audit));
  }
  // Verbatim segments pass through byte-for-byte: lossless guarantee.
  for (const v of ast.verbatim) {
    parts.push(v);
  }
  return parts.join("\n");
}
