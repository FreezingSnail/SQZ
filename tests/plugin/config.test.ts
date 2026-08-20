/**
 * Squeeze plugin config tests: resolution order (options > env > file >
 * defaults), kill switch, corrupt config file fallback.
 */

import { describe, expect, it, afterEach, vi } from "vitest";
import {
  CONFIG_FILE,
  DEFAULT_SQUEEZE_CONFIG,
  loadConfig,
  readConfigFile,
} from "../../src/plugin/config.js";
import { DEFAULT_LEXICON } from "../../src/providers.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const CWD_ENABLED = join(FIXTURES, "config-enabled");
const CWD_CORRUPT = join(FIXTURES, "config-corrupt");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadConfig — defaults", () => {
  it("returns defaults with no overrides, env, or file", () => {
    const cfg = loadConfig();
    expect(cfg.enabled).toBe(DEFAULT_SQUEEZE_CONFIG.enabled);
    expect(cfg.provider).toBe("rule");
    expect(cfg.threshold).toBe(60);
    expect(cfg.audit).toBe(false);
    expect(cfg.expand).toBe(true);
    expect(cfg.retries).toBe(2);
    expect(cfg.timeoutMs).toBe(500);
    expect(cfg.lexicon).toEqual(DEFAULT_LEXICON);
  });

  it("timeoutMs resolves: options > env > file > default", () => {
    vi.stubEnv("SQZ_TIMEOUT_MS", "15000");
    const fromEnv = loadConfig();
    expect(fromEnv.timeoutMs).toBe(15000);

    const withOption = loadConfig({ timeoutMs: 45000 });
    expect(withOption.timeoutMs).toBe(45000);
  });

  it("batch profile: ollama + long timeout + zero threshold + audit", () => {
    const cfg = loadConfig({
      provider: "ollama",
      model: "qwen3.5:4b",
      threshold: 0,
      audit: true,
      timeoutMs: 30000,
    });
    expect(cfg.provider).toBe("ollama");
    expect(cfg.model).toBe("qwen3.5:4b");
    expect(cfg.threshold).toBe(0);
    expect(cfg.audit).toBe(true);
    expect(cfg.timeoutMs).toBe(30000);
  });

  it("options tuple form wins over everything", () => {
    const cfg = loadConfig({ enabled: true, provider: "ollama", model: "qwen3:4b", threshold: 10 }, CWD_ENABLED);
    expect(cfg.enabled).toBe(true);
    expect(cfg.provider).toBe("ollama");
    expect(cfg.model).toBe("qwen3:4b");
    expect(cfg.threshold).toBe(10);
  });

  it("kill switch disabled makes hooks no-op surface (enabled=false)", () => {
    expect(DEFAULT_SQUEEZE_CONFIG.enabled).toBe(false);
  });
});

describe("readConfigFile / file merge", () => {
  it("reads a valid squeeze.config.json", () => {
    const file = readConfigFile(CWD_ENABLED);
    expect(file).not.toBeNull();
    expect(file?.enabled).toBe(true);
    expect(file?.provider).toBe("ollama");
    expect(file?.model).toBe("test-model:1b");
    expect(file?.threshold).toBe(20);
    expect(file?.audit).toBe(true);
    expect(file?.expand).toBe(false);
    expect(file?.retries).toBe(3);
  });

  it("missing file returns null", () => {
    expect(readConfigFile(HERE)).toBeNull();
  });

  it("corrupt file returns null (defaults win, graceful)", () => {
    expect(readConfigFile(CWD_CORRUPT)).toBeNull();
    const cfg = loadConfig({}, CWD_CORRUPT);
    expect(cfg.enabled).toBe(false);
    expect(cfg.provider).toBe("rule");
  });

  it("file values apply when no option/env overrides them", () => {
    const cfg = loadConfig({}, CWD_ENABLED);
    expect(cfg.enabled).toBe(true);
    expect(cfg.provider).toBe("ollama");
    expect(cfg.model).toBe("test-model:1b");
    expect(cfg.threshold).toBe(20);
    expect(cfg.audit).toBe(true);
    expect(cfg.expand).toBe(false);
    expect(cfg.retries).toBe(3);
  });

  it("CONFIG_FILE name is stable", () => {
    expect(CONFIG_FILE).toBe("squeeze.config.json");
  });
});

describe("loadConfig — environment overrides", () => {
  it("env beats file but loses to explicit options", () => {
    vi.stubEnv("SQZ_ENABLED", "true");
    vi.stubEnv("SQZ_THRESHOLD", "5");
    vi.stubEnv("SQZ_PROVIDER", "rule");

    const fromFile = loadConfig({}, CWD_ENABLED);
    expect(fromFile.enabled).toBe(true);
    expect(fromFile.threshold).toBe(5);
    expect(fromFile.provider).toBe("rule");

    const withOption = loadConfig({ threshold: 99 }, CWD_ENABLED);
    expect(withOption.threshold).toBe(99);
  });

  it("boolean env parsing accepts 1/true/yes", () => {
    vi.stubEnv("SQZ_AUDIT", "yes");
    vi.stubEnv("SQZ_EXPAND", "1");
    const cfg = loadConfig();
    expect(cfg.audit).toBe(true);
    expect(cfg.expand).toBe(true);
  });

  it("model env override", () => {
    vi.stubEnv("SQZ_MODEL", "gemma4:e4b");
    const cfg = loadConfig();
    expect(cfg.model).toBe("gemma4:e4b");
  });
});