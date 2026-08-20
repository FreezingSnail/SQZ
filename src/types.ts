/**
 * SQZ translation library — shared types.
 * Shapes mirror sqz.ebnf (payload production) and sqz-schema.json (SQZPayload v1).
 */

export type Mode =
  | "refactor"
  | "api"
  | "debug"
  | "docs"
  | "test"
  | "review"
  | "arch"
  | "general";

export const MODES: readonly Mode[] = [
  "refactor",
  "api",
  "debug",
  "docs",
  "test",
  "review",
  "arch",
  "general",
];

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

export interface SQZTarget {
  files: string[];
  lang: string;
}

/**
 * SQZPayload (v1) — retained as tooling-only schema (sqz-schema.json). NOT
 * on the wire since v2: the compress path emits a plain SQZLine instead.
 */
export interface SQZPayload {
  v: 1;
  mode: Mode;
  target: SQZTarget;
  constraints: string[];
  verbatim: string[];
  confidence: number;
}

/**
 * SQZLine (v2 wire format) — one plain line of symbols, no JSON envelope.
 * Grammar (sqz.ebnf v2): <mode> Δ["f1","f2"] [L:<lang>] <symbol>[op]... v"..."
 * Example: refactor Δ["src/a.ts"] L:ts ≋ μ ∂ v"keep log messages identical"
 */
export type SQZLine = string;

/** Lexicon entry: one symbol, one meaning, one domain (see lexicon.md). */
export interface LexiconEntry {
  symbol: string;
  domain: string;
  meaning: string;
  example: string;
}

export type Lexicon = LexiconEntry[];

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Model-independent provider contract.
 * generate() returns either a parsed object (when `schema` is given — legacy
 * JSON path, still used for judge-style calls) or a raw SQZ line (when
 * `schema` is omitted — v2 plain-text compress path).
 */
export interface Provider {
  name: string;
  generate(messages: ChatMessage[], schema?: object): Promise<unknown>;
}

export interface CompressOptions {
  /** Optional mode hint ("refactor" | "api" | ... | "general"). */
  domain?: string;
  /** Lexicon used for symbol encoding. */
  lexicon: Lexicon;
  /** Provider to call first. Defaults to RuleProvider (deterministic, no model). */
  provider?: Provider;
  /** Max additional attempts after the first parse failure (default 2). */
  retries?: number;
}

export interface CompressResult {
  /** v2: plain SQZ line (no JSON envelope). */
  sqz: SQZLine;
  /** Raw prose clauses that could not be encoded — preserved unchanged. */
  verbatim: string[];
  /** Compressor self-reported intent-preservation probability (0..1). */
  confidence: number;
  /** Wall-clock time of compress (provider + validation), ms. */
  latencyMs: number;
}

export interface ExpandOptions {
  /** Collect audit flags, e.g. "unknown-symbol:λ". Never throws. */
  audit?: string[];
}
