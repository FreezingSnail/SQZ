/**
 * Squeeze plugin core — pure, role-agnostic message processing.
 *
 * Every function is dependency-injected (compress/expand/lexicon/estimator)
 * so unit tests never need a live model. Invariant: the user's original
 * prose is always recoverable; a failure at any point leaves the text
 * byte-identical to what arrived.
 */

import type { CompressOptions, CompressResult, ExpandOptions, Lexicon, SQZPayload } from "../types.js";
import { SQZ_PAYLOAD_OPEN, buildEnvelope, findPayloadCandidates } from "./format.js";

/** Lexicon.md usage note: confidence below 0.9 → keep prose fallback. */
export const MIN_CONFIDENCE = 0.9;

export interface PluginDeps {
  /** Compress via the translator ladder (provider + retry + passthrough). */
  compress: (prose: string, opts: CompressOptions) => Promise<CompressResult>;
  /** Expand SQZ → prose (renders unknown symbols literally + audit flags). */
  expandFn: (payload: SQZPayload, lexicon: Lexicon, opts?: ExpandOptions) => string;
  /** Token estimator used for the threshold gate. */
  estimateTokens: (text: string) => number;
  /** Symbol dictionary. */
  lexicon: Lexicon;
  /** Optional logger (plugin startup context). */
  log?: (message: string) => void;
}

export interface ProcessUserOptions {
  /** Min estimated input tokens before compression runs. */
  threshold: number;
  /** Audit mode: original prose included in a fenced block. */
  audit: boolean;
  /** First message of a session: append the full lexicon. */
  includeLexicon: boolean;
  /** Max retries after first parse failure (translator ladder). */
  retries: number;
  /** Optional mode/domain hint. */
  domain?: string;
}

export interface UserMessageOutcome {
  compressed: boolean;
  text: string;
  payload?: SQZPayload;
}

/**
 * Pre hook: compress a user message into the SQZ envelope.
 * Every failure path returns the original text unchanged.
 */
export async function processUserText(
  text: string,
  deps: PluginDeps,
  opts: ProcessUserOptions,
): Promise<UserMessageOutcome> {
  const trimmed = text.trim();
  if (!trimmed) return { compressed: false, text };
  // Already an envelope (or user literally sent the marker): never double-compress.
  if (trimmed.includes(SQZ_PAYLOAD_OPEN)) return { compressed: false, text };
  if (deps.estimateTokens(trimmed) < opts.threshold) {
    return { compressed: false, text };
  }

  let result: CompressResult;
  try {
    result = await deps.compress(trimmed, {
      lexicon: deps.lexicon,
      retries: opts.retries,
      domain: opts.domain,
    });
  } catch (err) {
    deps.log?.(`compress degraded: ${err instanceof Error ? err.message : String(err)}`);
    return { compressed: false, text };
  }

  if (!result?.sqz || result.confidence < MIN_CONFIDENCE) {
    return { compressed: false, text };
  }

  const envelope = buildEnvelope(result.sqz, {
    lexicon: deps.lexicon,
    includeLexicon: opts.includeLexicon,
    original: opts.audit ? text : undefined,
  });

  return { compressed: true, text: envelope, payload: result.sqz };
}

export interface AssistantOutcome {
  expanded: boolean;
  text: string;
  auditFlags: string[];
}

/** Replace every SQZ payload candidate with expanded prose. Never throws. */
export function expandSqzInText(
  text: string,
  deps: PluginDeps,
  auditFlags: string[],
): AssistantOutcome {
  const candidates = findPayloadCandidates(text);
  if (candidates.length === 0) return { expanded: false, text, auditFlags: [] };

  let out = text;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i];
    let prose: string;
    try {
      prose = deps.expandFn(c.payload, deps.lexicon, { audit: auditFlags });
    } catch (err) {
      deps.log?.(`expand degraded: ${err instanceof Error ? err.message : String(err)}`);
      continue; // never corrupt: skip this candidate
    }
    if (!prose) continue;
    out = out.slice(0, c.start) + prose + out.slice(c.end);
  }
  return { expanded: out !== text, text: out, auditFlags };
}

/**
 * Post hook: expand SQZ payloads in assistant output back to prose.
 * `expand` toggle off → text passes through byte-identical.
 */
export function processAssistantText(
  text: string,
  deps: PluginDeps,
  opts: { expand: boolean },
): AssistantOutcome {
  if (!opts.expand) return { expanded: false, text, auditFlags: [] };
  return expandSqzInText(text, deps, []);
}