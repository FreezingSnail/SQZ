/**
 * SQZ v2 wire format for the opencode squeeze plugin.
 *
 * The compressed user message is an envelope of fenced blocks the big model
 * reads natively:
 *
 *   [SQZ original]          (audit mode only — original prose, never mutated)
 *   <prose>
 *   [/SQZ original]
 *   [SQZ v2]
 *   refactor Δ["src/a.ts"] L:ts ≋ μ ∂ v"keep log messages identical"
 *   [/SQZ]
 *   [SQZ lexicon]           (first user message of a session only)
 *   [{"symbol":"Δ",...}]
 *   [/SQZ lexicon]
 *
 * The payload block is a plain SQZ line — NOT a JSON envelope (v1 JSON was
 * larger than typical prose and forced slow structured generation).
 *
 * Assistant-side detection accepts only the explicit [SQZ v2] marker block;
 * bare prose is never rewritten (lossless invariant).
 */

import type { Lexicon, SQZLine } from "../types.js";

export const SQZ_PAYLOAD_OPEN = "[SQZ v2]";
export const SQZ_PAYLOAD_CLOSE = "[/SQZ]";
export const SQZ_LEXICON_OPEN = "[SQZ lexicon]";
export const SQZ_LEXICON_CLOSE = "[/SQZ lexicon]";
export const SQZ_ORIGINAL_OPEN = "[SQZ original]";
export const SQZ_ORIGINAL_CLOSE = "[/SQZ original]";

export interface EnvelopeParts {
  line?: SQZLine;
  lexicon?: Lexicon;
  original?: string;
}

export interface BuildEnvelopeOptions {
  /** Symbol dictionary. Rendered only when includeLexicon is true. */
  lexicon?: Lexicon;
  /** First user message of a session: append the full lexicon once. */
  includeLexicon: boolean;
  /** Audit mode: prepend the original prose untouched. */
  original?: string;
}

/** Build the compressed message envelope. */
export function buildEnvelope(line: SQZLine, options: BuildEnvelopeOptions): string {
  const blocks: string[] = [];
  if (options.original !== undefined && options.original.length > 0) {
    blocks.push(`${SQZ_ORIGINAL_OPEN}\n${options.original}\n${SQZ_ORIGINAL_CLOSE}`);
  }
  blocks.push(`${SQZ_PAYLOAD_OPEN}\n${line}\n${SQZ_PAYLOAD_CLOSE}`);
  if (options.includeLexicon && options.lexicon && options.lexicon.length > 0) {
    blocks.push(`${SQZ_LEXICON_OPEN}\n${JSON.stringify(options.lexicon)}\n${SQZ_LEXICON_CLOSE}`);
  }
  return blocks.join("\n\n");
}

const BLOCK_RE = /\[SQZ (v2|lexicon|original)\]([\s\S]*?)\[\/SQZ(?:\s\1)?\]/g;

/** Parse all envelope blocks out of a message. Never throws. */
export function parseEnvelope(text: string): EnvelopeParts {
  const parts: EnvelopeParts = {};
  for (const match of text.matchAll(BLOCK_RE)) {
    const kind = match[1];
    const content = match[2].trim();
    if (kind === "v2" && !parts.line) {
      parts.line = content;
    } else if (kind === "lexicon" && !parts.lexicon) {
      try {
        const parsed = JSON.parse(content) as unknown;
        if (Array.isArray(parsed)) parts.lexicon = parsed as Lexicon;
      } catch {
        /* ignore malformed lexicon block */
      }
    } else if (kind === "original" && parts.original === undefined) {
      parts.original = content;
    }
  }
  return parts;
}

export interface LineCandidate {
  /** Start offset of the span to replace (inclusive). */
  start: number;
  /** End offset of the span to replace (exclusive). */
  end: number;
  line: SQZLine;
}

const MARKER_RE = /\[SQZ v2\]\s*([\s\S]*?)\s*\[\/SQZ\]/g;

/**
 * Find spans of assistant output that carry a SQZ v2 line: explicit marker
 * block only. Prose is never matched (marker is the gate, lossless invariant).
 * Spans are non-overlapping, sorted by start.
 */
export function findLineCandidates(text: string): LineCandidate[] {
  const found: LineCandidate[] = [];
  for (const match of text.matchAll(MARKER_RE)) {
    const line = match[1].trim();
    if (line.length === 0) continue;
    found.push({ start: match.index, end: match.index + match[0].length, line });
  }
  return found;
}
