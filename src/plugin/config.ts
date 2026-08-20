/**
 * Squeeze plugin configuration (opencode squeeze plugin, math-dbr.4).
 *
 * Resolution order (first match wins):
 *   1. Plugin options (opencode `plugin` tuple form: ["squeeze", {...}])
 *   2. Environment variables (SQZ_ENABLED, SQZ_PROVIDER, SQZ_MODEL,
 *      SQZ_THRESHOLD, SQZ_AUDIT, SQZ_EXPAND, SQZ_RETRIES)
 *   3. `<cwd>/squeeze.config.json`
 *   4. Defaults (DEFAULT_SQUEEZE_CONFIG)
 *
 * Kill switch: `enabled: false` makes every hook a no-op — sessions are
 * byte-identical to running without the plugin.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Lexicon } from "../types.js";
import { DEFAULT_LEXICON } from "../providers.js";

export interface SqueezeConfig {
  /** Kill switch. false → all hooks no-op, session byte-identical to no-plugin. */
  enabled: boolean;
  /** Provider name: "rule" (deterministic, no model) | "ollama" | unknown → rule. */
  provider: string;
  /** Model tag for model-backed providers (e.g. "qwen3:1.7b"). */
  model?: string;
  /** Minimum estimated input tokens before compression kicks in. */
  threshold: number;
  /** Audit mode: include original prose in a fenced [SQZ original] block. */
  audit: boolean;
  /** Expand toggle for assistant output. false → SQZ passes through verbatim. */
  expand: boolean;
  /** Max retries after the first parse failure (translator ladder). */
  retries: number;
  /** Symbol dictionary injected once per session (first user message). */
  lexicon: Lexicon;
}

export const CONFIG_FILE = "squeeze.config.json";

export const DEFAULT_SQUEEZE_CONFIG: SqueezeConfig = {
  enabled: false,
  provider: "rule",
  model: undefined,
  threshold: 60,
  audit: false,
  expand: true,
  retries: 2,
  lexicon: DEFAULT_LEXICON,
};

export interface SqueezeConfigFile {
  enabled?: boolean;
  provider?: string;
  model?: string;
  threshold?: number;
  audit?: boolean;
  expand?: boolean;
  retries?: number;
  lexicon?: Lexicon;
}

/** Read `<cwd>/squeeze.config.json`. Corrupt/missing file → null (defaults). */
export function readConfigFile(cwd: string): Partial<SqueezeConfig> | null {
  const file = join(cwd, CONFIG_FILE);
  if (!existsSync(file)) return null;
  let parsed: SqueezeConfigFile;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as SqueezeConfigFile;
  } catch {
    return null;
  }
  const out: Partial<SqueezeConfig> = {};
  if (typeof parsed.enabled === "boolean") out.enabled = parsed.enabled;
  if (typeof parsed.provider === "string") out.provider = parsed.provider;
  if (typeof parsed.model === "string") out.model = parsed.model;
  if (typeof parsed.threshold === "number") out.threshold = parsed.threshold;
  if (typeof parsed.audit === "boolean") out.audit = parsed.audit;
  if (typeof parsed.expand === "boolean") out.expand = parsed.expand;
  if (typeof parsed.retries === "number") out.retries = parsed.retries;
  if (Array.isArray(parsed.lexicon)) out.lexicon = parsed.lexicon;
  return out;
}

function envBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return v === "1" || v === "true" || v === "yes";
}

function envInt(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function pick<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((v) => v !== undefined);
}

/** Merge plugin options + env + config file + defaults. Never throws. */
export function loadConfig(
  overrides: Record<string, unknown> = {},
  cwd?: string,
): SqueezeConfig {
  const file = cwd ? readConfigFile(cwd) : null;
  const o = overrides;

  const lexicon =
    pick(
      Array.isArray(o.lexicon) ? (o.lexicon as Lexicon) : undefined,
      file?.lexicon,
      DEFAULT_SQUEEZE_CONFIG.lexicon,
    ) ?? DEFAULT_SQUEEZE_CONFIG.lexicon;

  return {
    enabled:
      pick(
        typeof o.enabled === "boolean" ? o.enabled : undefined,
        envBool("SQZ_ENABLED"),
        file?.enabled,
        DEFAULT_SQUEEZE_CONFIG.enabled,
      ) ?? DEFAULT_SQUEEZE_CONFIG.enabled,
    provider:
      pick(
        typeof o.provider === "string" ? o.provider : undefined,
        process.env.SQZ_PROVIDER,
        file?.provider,
        DEFAULT_SQUEEZE_CONFIG.provider,
      ) ?? DEFAULT_SQUEEZE_CONFIG.provider,
    model: pick(
      typeof o.model === "string" ? o.model : undefined,
      process.env.SQZ_MODEL,
      file?.model,
      DEFAULT_SQUEEZE_CONFIG.model,
    ),
    threshold:
      pick(
        typeof o.threshold === "number" ? o.threshold : undefined,
        envInt("SQZ_THRESHOLD"),
        file?.threshold,
        DEFAULT_SQUEEZE_CONFIG.threshold,
      ) ?? DEFAULT_SQUEEZE_CONFIG.threshold,
    audit:
      pick(
        typeof o.audit === "boolean" ? o.audit : undefined,
        envBool("SQZ_AUDIT"),
        file?.audit,
        DEFAULT_SQUEEZE_CONFIG.audit,
      ) ?? DEFAULT_SQUEEZE_CONFIG.audit,
    expand:
      pick(
        typeof o.expand === "boolean" ? o.expand : undefined,
        envBool("SQZ_EXPAND"),
        file?.expand,
        DEFAULT_SQUEEZE_CONFIG.expand,
      ) ?? DEFAULT_SQUEEZE_CONFIG.expand,
    retries:
      pick(
        typeof o.retries === "number" ? o.retries : undefined,
        envInt("SQZ_RETRIES"),
        file?.retries,
        DEFAULT_SQUEEZE_CONFIG.retries,
      ) ?? DEFAULT_SQUEEZE_CONFIG.retries,
    lexicon,
  };
}