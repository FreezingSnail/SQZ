/**
 * SQZ wire format for the opencode squeeze plugin.
 *
 * The compressed user message is an envelope of fenced blocks the big model
 * reads natively:
 *
 *   [SQZ original]          (audit mode only — original prose, never mutated)
 *   <prose>
 *   [/SQZ original]
 *   [SQZ v1]
 *   {"v":1,"mode":...}      (SQZPayload — schema-validated)
 *   [/SQZ]
 *   [SQZ lexicon]           (first user message of a session only)
 *   [{"symbol":"Δ",...}]
 *   [/SQZ lexicon]
 *
 * Assistant-side detection accepts the explicit block, a ```json fence, or a
 * bare JSON object that validates against the SQZPayload schema — unknown
 * prose is never rewritten (lossless invariant).
 */

import type { Lexicon, SQZPayload } from "../types.js";
import { validatePayload } from "../validate.js";

export const SQZ_PAYLOAD_OPEN = "[SQZ v1]";
export const SQZ_PAYLOAD_CLOSE = "[/SQZ]";
export const SQZ_LEXICON_OPEN = "[SQZ lexicon]";
export const SQZ_LEXICON_CLOSE = "[/SQZ lexicon]";
export const SQZ_ORIGINAL_OPEN = "[SQZ original]";
export const SQZ_ORIGINAL_CLOSE = "[/SQZ original]";

export interface EnvelopeParts {
  payload?: SQZPayload;
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
export function buildEnvelope(payload: SQZPayload, options: BuildEnvelopeOptions): string {
  const blocks: string[] = [];
  if (options.original !== undefined && options.original.length > 0) {
    blocks.push(`${SQZ_ORIGINAL_OPEN}\n${options.original}\n${SQZ_ORIGINAL_CLOSE}`);
  }
  blocks.push(`${SQZ_PAYLOAD_OPEN}\n${JSON.stringify(payload)}\n${SQZ_PAYLOAD_CLOSE}`);
  if (options.includeLexicon && options.lexicon && options.lexicon.length > 0) {
    blocks.push(`${SQZ_LEXICON_OPEN}\n${JSON.stringify(options.lexicon)}\n${SQZ_LEXICON_CLOSE}`);
  }
  return blocks.join("\n\n");
}

function parsePayloadJson(json: string): SQZPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const { valid } = validatePayload(parsed);
  return valid ? (parsed as SQZPayload) : null;
}

const BLOCK_RE = /\[SQZ (v1|lexicon|original)\]([\s\S]*?)\[\/SQZ(?:\s\1)?\]/g;

/** Parse all envelope blocks out of a message. Never throws. */
export function parseEnvelope(text: string): EnvelopeParts {
  const parts: EnvelopeParts = {};
  for (const match of text.matchAll(BLOCK_RE)) {
    const kind = match[1];
    const content = match[2].trim();
    if (kind === "v1" && !parts.payload) {
      const payload = parsePayloadJson(content);
      if (payload) parts.payload = payload;
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

export interface PayloadCandidate {
  /** Start offset of the span to replace (inclusive). */
  start: number;
  /** End offset of the span to replace (exclusive). */
  end: number;
  payload: SQZPayload;
}

const MARKER_RE = /\[SQZ v1\]\s*([\s\S]*?)\s*\[\/SQZ\]/g;
const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/g;

/**
 * Find spans of assistant output that encode a SQZ payload: explicit marker
 * block, fenced JSON, or bare JSON object. Spans are non-overlapping, sorted
 * by start. Prose never matches (schema validation is the gate).
 */
export function findPayloadCandidates(text: string): PayloadCandidate[] {
  const found: PayloadCandidate[] = [];

  for (const match of text.matchAll(MARKER_RE)) {
    const payload = parsePayloadJson(match[1]);
    if (payload) {
      found.push({ start: match.index, end: match.index + match[0].length, payload });
    }
  }

  for (const match of text.matchAll(FENCE_RE)) {
    const payload = parsePayloadJson(match[1]);
    if (payload) {
      found.push({ start: match.index, end: match.index + match[0].length, payload });
    }
  }

  // Bare JSON objects: scan each '{' and walk brace depth to the matching '}'.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") {
        depth--;
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
    }
    if (end === -1) break;
    const payload = parsePayloadJson(text.slice(i, end));
    if (payload) {
      found.push({ start: i, end, payload });
    }
    i = end - 1;
  }

  // Dedupe overlapping spans (prefer the outer/earlier one), keep sorted.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: PayloadCandidate[] = [];
  let lastEnd = -1;
  for (const c of found) {
    if (c.start < lastEnd) continue;
    out.push(c);
    lastEnd = c.end;
  }
  return out;
}