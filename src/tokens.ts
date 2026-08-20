/**
 * Token estimation utilities for savings measurement.
 *
 * Rough approximation (word runs + punctuation/symbol runs, ~GPT-style
 * whitespace+symbol splitting). Good enough for relative compression
 * comparisons; exact counts come from the target model's tokenizer during
 * bake-off (math-dbr.5).
 */

/** Count word-like runs and punctuation/symbol runs. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  const symbolRuns = text.match(/[\p{P}\p{S}]+/gu) ?? [];
  return words.length + symbolRuns.length;
}

/** 1 - tokens(compressed)/tokens(prose). Negative when envelope overhead wins. */
export function tokenSavings(compressed: string, prose: string): number {
  const base = estimateTokens(prose);
  if (base === 0) return 0;
  return 1 - estimateTokens(compressed) / base;
}