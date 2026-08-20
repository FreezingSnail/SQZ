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

export interface SQZPayload {
  v: 1;
  mode: Mode;
  target: SQZTarget;
  constraints: string[];
  verbatim: string[];
  confidence: number;
}

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
 * generate() must return either a JSON-string or a parsed object conforming to
 * `schema`; anything else is treated as invalid by the retry/fallback logic.
 */
export interface Provider {
  name: string;
  generate(messages: ChatMessage[], schema: object): Promise<unknown>;
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
  sqz: SQZPayload;
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
