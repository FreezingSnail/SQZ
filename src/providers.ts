/**
 * RuleProvider — deterministic dictionary-based fallback. No model.
 *
 * Encodes prose to SQZ by matching lexicon symbol triggers (from lexicon.md)
 * and extracting file paths. Never throws. Anything it cannot encode stays in
 * `verbatim[]` unchanged (lossless policy).
 */

import type {
  ChatMessage,
  Lexicon,
  LexiconEntry,
  Mode,
  Provider,
  SQZPayload,
} from "./types.js";
import { isMode } from "./types.js";

/** Mirror of lexicon.md (symbol table) — used when no system-message lexicon is injected. */
export const DEFAULT_LEXICON: Lexicon = [
  { symbol: "Δ", domain: "change", meaning: "the set of files/diffs this payload may modify", example: 'Δ ["src/a.ts","src/b.ts"]' },
  { symbol: "≋", domain: "behavior", meaning: "behavior(new) = behavior(old); preserve runtime behavior", example: "≋ fn normalize = fn old" },
  { symbol: "∂", domain: "edge", meaning: "edge cases that must be handled", example: "∂ (empty input, null, overflow)" },
  { symbol: "μ", domain: "minimal", meaning: "minimal diff; smallest change satisfying intent", example: 'constraints: ["μ"]' },
  { symbol: "⌁", domain: "coverage", meaning: "complete coverage; all paths/branches/cases", example: "⌁ all" },
  { symbol: "→", domain: "flow", meaning: "pipeline: sequence of stages or transitions", example: "lint → build → test" },
  { symbol: "✓", domain: "verification", meaning: "checked/verified against stated acceptance criteria", example: "✓ examples run" },
  { symbol: "⏭", domain: "omission", meaning: "deliberately skipped; leave untouched", example: "⏭ vendor/" },
];

const SYMBOL_TRIGGERS: Record<string, readonly string[]> = {
  "Δ": ["may modify", "modify file", "change file", "touch", "edit file"],
  "≋": ["preserve", "same behavior", "behavior(new)", "behavior(old)", "equivalent", "behavior"],
  "∂": ["edge case", "edge-case"],
  "μ": ["minimal diff", "smallest change", "minimal change", "minimal"],
  "⌁": ["complete coverage", "all paths", "all branches", "all cases", "coverage"],
  "→": ["pipeline", "stages", "stage", "sequence", "then"],
  "✓": ["verified", "verify", "checked", "acceptance criteria"],
  "⏭": ["skip", "leave untouched", "ignore", "omit", "do not touch"],
};

const MODE_KEYWORDS: readonly [Mode, readonly string[]][] = [
  ["refactor", ["refactor", "rewrite"]],
  ["api", ["api", "endpoint"]],
  ["debug", ["debug", "bug"]],
  ["docs", ["documentation", "docs"]],
  ["test", ["test", "tests", "testing"]],
  ["review", ["review"]],
  ["arch", ["architecture", "architect"]],
];

const FILE_RE = /[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|rb|java|swift|c|h|cpp|hpp|sh|yml|yaml|toml|css|html)/g;

const EDGE_WORDS = ["empty", "null", "overflow", "boundary", "invalid", "error", "missing"];
const PIPELINE_WORDS = ["lint", "build", "test", "typecheck", "deploy", "publish"];

function extractLexicon(messages: ChatMessage[]): Lexicon {
  const system = messages.find((m) => m.role === "system");
  if (system) {
    try {
      const parsed = JSON.parse(system.content) as { lexicon?: Lexicon };
      if (Array.isArray(parsed.lexicon) && parsed.lexicon.length > 0) return parsed.lexicon;
    } catch {
      /* fall through to default */
    }
  }
  return DEFAULT_LEXICON;
}

function lastUserContent(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}

function detectMode(prose: string): Mode {
  const lower = prose.toLowerCase();
  for (const [mode, keywords] of MODE_KEYWORDS) {
    if (keywords.some((k) => lower.includes(k))) return mode;
  }
  return "general";
}

function detectFiles(prose: string): string[] {
  const files = [...new Set(prose.match(FILE_RE) ?? [])];
  return files;
}

function clauseForSymbol(
  entry: LexiconEntry,
  prose: string,
  files: string[],
): string | null {
  const lower = prose.toLowerCase();
  const triggers = SYMBOL_TRIGGERS[entry.symbol];
  if (!triggers || !triggers.some((t) => lower.includes(t))) return null;

  switch (entry.symbol) {
    case "Δ":
      return files.length > 0
        ? `Δ [${files.map((f) => JSON.stringify(f)).join(", ")}]`
        : 'Δ ["-"]';
    case "≋":
      return "≋ behavior(new) = behavior(old)";
    case "∂": {
      const found = EDGE_WORDS.filter((w) => lower.includes(w));
      return found.length > 0 ? `∂ (${found.join(", ")})` : "∂ (edge cases)";
    }
    case "μ":
      return "μ";
    case "⌁":
      return "⌁ all";
    case "→": {
      const steps = PIPELINE_WORDS.filter((w) => lower.includes(w));
      return steps.length > 0 ? steps.join(" → ") : "lint → build → test";
    }
    case "✓":
      return "✓ examples run";
    case "⏭": {
      const skipMatch = lower.match(/(?:skip|ignore|leave untouched|omit|do not touch)\s+([\w./-]+)/);
      return skipMatch ? `⏭ ${skipMatch[1]}` : "⏭ vendor/";
    }
    default:
      return null;
  }
}

function detectVerbatim(prose: string, mode: Mode, files: string[], usedMeanings: Set<string>): string[] {
  const lower = prose.toLowerCase();
  const chunks = prose
    .split(/[.;\n]+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  const modeKeywords = MODE_KEYWORDS.find(([m]) => m === mode)?.[1] ?? [];
  const verbatim: string[] = [];
  for (const chunk of chunks) {
    const chunkLower = chunk.toLowerCase();
    // File-path fragments (e.g. "ts" split off "src/tokenizer.ts.") are not prose.
    const isFileFragment = files.some(
      (f) => chunkLower.includes(f.toLowerCase()) || f.toLowerCase().includes(chunkLower.trim()),
    );
    const matched =
      [...usedMeanings].some((m) => chunkLower.includes(m)) ||
      FILE_RE.test(chunk) ||
      isFileFragment ||
      modeKeywords.some((k) => chunkLower.includes(k));
    if (!matched) verbatim.push(chunk);
  }
  return verbatim;
}

/** Deterministic, no-model compression. Guaranteed schema-valid output. */
export class RuleProvider implements Provider {
  readonly name = "rule";

  async generate(messages: ChatMessage[], _schema: object): Promise<unknown> {
    const lexicon = extractLexicon(messages);
    const prose = lastUserContent(messages);
    if (!prose) {
      // Never throws; empty input yields a valid, content-free payload.
      return {
        v: 1,
        mode: "general",
        target: { files: ["-"], lang: "text" },
        constraints: [],
        verbatim: [],
        confidence: 0,
      };
    }

    const mode = detectMode(prose);
    const files = detectFiles(prose);
    const usedMeanings = new Set<string>();
    const constraints: string[] = [];

    for (const entry of lexicon) {
      const clause = clauseForSymbol(entry, prose, files);
      if (clause !== null) {
        constraints.push(clause);
        const t = SYMBOL_TRIGGERS[entry.symbol];
        if (t) {
          const matched = t.find((trigger) => prose.toLowerCase().includes(trigger));
          if (matched) usedMeanings.add(matched);
        }
      }
    }

    const verbatim = detectVerbatim(prose, mode, files, usedMeanings);

    const payload: SQZPayload = {
      v: 1,
      mode,
      target: {
        files: files.length > 0 ? files : ["-"],
        lang: "ts",
      },
      constraints,
      verbatim,
      confidence: 0.9,
    };
    return payload;
  }
}

/** Graceful-degradation payload: original prose preserved verbatim, nothing invented. */
export function passthroughPayload(prose: string, domain?: string): SQZPayload {
  return {
    v: 1,
    mode: isMode(domain) ? domain : "general",
    target: { files: ["-"], lang: "text" },
    constraints: [],
    verbatim: [prose],
    confidence: 0,
  };
}
