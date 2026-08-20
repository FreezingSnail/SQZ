/**
 * Fixture integrity tests — fixtures/tasks.json (math-dbr.3).
 * 100 canonical tasks, all 8 modes, unique ids, valid shapes.
 */

import { describe, expect, it } from "vitest";
import fixture from "../fixtures/tasks.json" with { type: "json" };
import { MODES, isMode } from "../src/types.js";
import { DEFAULT_LEXICON } from "../src/providers.js";

const KNOWN_SYMBOLS = new Set(DEFAULT_LEXICON.map((e) => e.symbol));

interface Task {
  id: string;
  domain: string;
  mode: string;
  prose: string;
  expectedSymbols: string[];
}

const tasks = fixture.tasks as Task[];

describe("fixtures/tasks.json", () => {
  it("contains exactly 100 canonical tasks", () => {
    expect(fixture.version).toBe(1);
    expect(fixture.count).toBe(100);
    expect(tasks.length).toBe(100);
  });

  it("has unique ids in sqz-NNN form", () => {
    const ids = tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^sqz-\d{3}$/);
  });

  it("covers all 8 modes with a sane distribution (>=10 each)", () => {
    const counts = new Map<string, number>();
    for (const t of tasks) counts.set(t.mode, (counts.get(t.mode) ?? 0) + 1);
    for (const mode of MODES) {
      expect(counts.get(mode) ?? 0).toBeGreaterThanOrEqual(10);
    }
    expect(counts.size).toBe(8);
  });

  it("domain equals mode and every mode is valid", () => {
    for (const t of tasks) {
      expect(t.domain).toBe(t.mode);
      expect(isMode(t.mode)).toBe(true);
    }
  });

  it("every task has non-trivial prose with a file path or code reference", () => {
    for (const t of tasks) {
      expect(t.prose.length).toBeGreaterThan(40);
      expect(t.prose).toMatch(/\.(ts|js|md|sh|json)\b|[A-Za-z/_-]+\/\S+/);
    }
  });

  it("expectedSymbols are non-empty and drawn from the lexicon symbol set", () => {
    for (const t of tasks) {
      expect(t.expectedSymbols.length).toBeGreaterThanOrEqual(1);
      for (const sym of t.expectedSymbols) expect(KNOWN_SYMBOLS.has(sym)).toBe(true);
    }
  });

  it("each expectedSymbol trigger phrase appears in the prose (fixture quality gate)", () => {
    const triggers: Record<string, readonly string[]> = {
      "Δ": ["/", ".ts", ".js", ".md"],
      "≋": ["preserve", "same behavior", "identical", "unchanged", "equivalent", "behavior"],
      "∂": ["edge case", "edge-case", "boundary", "malformed", "empty", "missing"],
      "μ": ["minimal diff", "minimal change", "minimal fix"],
      "⌁": ["coverage", "complete coverage"],
      "→": ["stages", "pipeline", "streaming pipeline"],
      "✓": ["verify", "verified", "acceptance criteria"],
      "⏭": ["do not touch", "skip", "leave", "untouched", "do not change"],
    };
    for (const t of tasks) {
      const lower = t.prose.toLowerCase();
      for (const sym of t.expectedSymbols) {
        const any = (triggers[sym] ?? []).some((tr) => lower.includes(tr));
        expect(any, `task ${t.id} expects ${sym} but prose has no trigger`).toBe(true);
      }
    }
  });
});