/**
 * SQZ v2 line grammar — tokenizer + AST.
 *
 * Wire format is ONE plain line (no JSON envelope):
 *
 *   <mode> Δ["f1","f2"] [L:<lang>] <symbol>[op]... v"verbatim clause"...
 *
 *   mode    := refactor | api | debug | docs | test | review | arch | general
 *   target  := Δ["file"(,"file")*]          (required, first Δ = target)
 *   lang    := L:<token>                    (optional)
 *   clause  := symbol [operand]             operand = [..] or (..) group
 *   verbatim:= v"raw prose"                 (lossless fallback, never dropped)
 *
 * The tokenizer never throws: parse problems are surfaced as `errors` so the
 * translator ladder can retry or pass the original prose through untouched.
 */

import type { Lexicon, Mode } from "./types.js";
import { MODES } from "./types.js";

export interface LineClause {
  symbol: string;
  operand: string;
}

export interface LineAST {
  mode: string;
  files: string[];
  lang: string;
  clauses: LineClause[];
  verbatim: string[];
  errors: string[];
}

/** Symbols with built-in expansion templates (mirror of translator CLAUSE_TEMPLATES). */
export const LINE_GLYPHS = ["Δ", "≋", "∂", "μ", "⌁", "→", "✓", "⏭"] as const;

function isGlyph(ch: string): boolean {
  return (LINE_GLYPHS as readonly string[]).includes(ch);
}

/** Read a "..." quoted string starting at s[i]. Returns [value, nextIndex]. */
function readQuoted(s: string, i: number, errors: string[]): [string, number] {
  // i is at the opening quote
  let out = "";
  let j = i + 1;
  while (j < s.length) {
    const ch = s[j];
    if (ch === "\\" && j + 1 < s.length) {
      out += s[j + 1];
      j += 2;
      continue;
    }
    if (ch === '"') return [out, j + 1];
    out += ch;
    j++;
  }
  errors.push("unterminated quote");
  return [out, s.length];
}

/** Read a [..] or (..) balanced group starting at s[i]. Returns [inner, nextIndex]. */
function readGroup(s: string, i: number, errors: string[]): [string, number] {
  const open = s[i];
  const close = open === "[" ? "]" : ")";
  let depth = 0;
  let inner = "";
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (ch === '"') {
      const [q, next] = readQuoted(s, j, errors);
      inner += '"' + q + '"';
      j = next - 1;
      continue;
    }
    if (ch === open) {
      depth++;
      if (depth > 1) inner += ch; // nested group: keep it
      continue;
    }
    if (ch === close) {
      depth--;
      if (depth === 0) return [inner, j + 1];
      inner += ch; // nested close: keep it
      continue;
    }
    inner += ch;
  }
  errors.push(`unbalanced ${open}`);
  return [inner, s.length];
}

/** Split a Δ[...] group inner into file strings. Handles quoted + bare entries. */
export function splitFiles(inner: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === '"') {
      const errors: string[] = [];
      const [q, next] = readQuoted(inner, i, errors);
      parts.push(q);
      i = next;
      continue;
    }
    if (ch === ",") {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter((p) => p.length > 0);
}

/** Tokenize a v2 SQZ line into an AST. Never throws. */
export function parseLine(line: string, lexicon: Lexicon): LineAST {
  const ast: LineAST = {
    mode: "",
    files: [],
    lang: "",
    clauses: [],
    verbatim: [],
    errors: [],
  };
  const knownSymbols = new Set(lexicon.map((e) => e.symbol));

  const s = line.trim();
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Verbatim segment: v"raw prose"
    if (ch === "v" && s[i + 1] === '"') {
      const [q, next] = readQuoted(s, i + 1, ast.errors);
      ast.verbatim.push(q);
      i = next;
      continue;
    }

    // Quoted string without symbol (stray) — keep literal, flag.
    if (ch === '"') {
      const [q, next] = readQuoted(s, i, ast.errors);
      ast.errors.push(`stray quoted token "${q}"`);
      i = next;
      continue;
    }

    // Δ[...] target (first Δ) or clause with bracket/paren operand.
    if (isGlyph(ch)) {
      let j = i + 1;
      while (j < s.length && !/\s|["[\]()]/.test(s[j])) j++;
      const symbol = s.slice(i, j);
      if (s[j] === "[" || s[j] === "(") {
        const [inner, next] = readGroup(s, j, ast.errors);
        if (symbol === "Δ" && ast.files.length === 0) {
          ast.files = splitFiles(inner);
          if (ast.files.length === 0) ast.errors.push("Δ target has no files");
        } else {
          ast.clauses.push({ symbol, operand: inner.trim() });
        }
        i = next;
        continue;
      }
      if (!knownSymbols.has(symbol)) {
        ast.errors.push(`unknown symbol ${symbol}`);
        ast.clauses.push({ symbol, operand: "" });
      } else {
        ast.clauses.push({ symbol, operand: "" });
      }
      i = j;
      continue;
    }

    // Lang token: L:<token>
    if (ch === "L" && s[i + 1] === ":") {
      let j = i + 2;
      while (j < s.length && !/\s/.test(s[j])) j++;
      const lang = s.slice(i + 2, j);
      if (lang) ast.lang = lang;
      else ast.errors.push("L: has no lang token");
      i = j;
      continue;
    }

    // Mode word (bare) — first bare word must be a valid mode.
    let j = i;
    while (j < s.length && !/\s|["[\]()]/.test(s[j])) j++;
    if (j === i) {
      // Stray structural char ([ ] ( )): skip it, flag it — never loop.
      ast.errors.push(`unexpected token "${s[i]}"`);
      i++;
      continue;
    }
    const word = s.slice(i, j);
    if (!ast.mode && (MODES as readonly string[]).includes(word)) {
      ast.mode = word as Mode;
      i = j;
      continue;
    }
    ast.errors.push(`unexpected token "${word}"`);
    i = j;
  }

  if (!ast.mode) ast.errors.push("missing mode");
  if (ast.files.length === 0) ast.errors.push("missing Δ target");
  return ast;
}

/** Lexicon lookup by symbol (undefined when the symbol is unknown). */
export function lexiconEntry(lexicon: Lexicon, symbol: string) {
  return lexicon.find((e) => e.symbol === symbol);
}
