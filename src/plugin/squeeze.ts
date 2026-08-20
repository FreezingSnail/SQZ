/**
 * squeeze plugin — opencode hook wiring (math-dbr.4).
 *
 * Architecture (epic): human prose → hook.pre → [small model: compress] →
 * SQZ payload → big model; SQZ output → hook.post → [small model: expand] →
 * prose → human.
 *
 * Hook mapping on the opencode plugin surface:
 *   - `chat.message` (fires on user message receipt, before the LLM sees it):
 *     compress user prose into the SQZ envelope; append the session lexicon
 *     on the first user message; audit mode prepends the original prose in a
 *     fenced block. Mutates `output.parts[i].text` in place.
 *   - `experimental.chat.messages.transform` (fires when the next model
 *     request is assembled): detect SQZ payloads in assistant text parts and
 *     expand them to prose in place — the stored parts (what the user sees
 *     rendered) and the model's subsequent context both carry expanded prose.
 *
 * Graceful degradation: every failure path (provider down, parse fail, empty
 * output, unknown symbol, bad config) leaves messages byte-identical to the
 * no-plugin case. The plugin never blocks or corrupts a message.
 */

import type { Plugin, PluginOptions } from "@opencode-ai/plugin";
import { compress, expand } from "../translator.js";
import { estimateTokens } from "../tokens.js";
import { RuleProvider } from "../providers.js";
import { OllamaProvider } from "../providers/ollama.js";
import type { Provider, CompressOptions } from "../types.js";
import { loadConfig, type SqueezeConfig } from "./config.js";
import {
  processUserText,
  processAssistantText,
  type PluginDeps,
} from "./core.js";

/** Provider factory. Unknown provider names fall back to RuleProvider. */
export function providerForConfig(config: SqueezeConfig): Provider {
  switch (config.provider) {
    case "rule":
      return new RuleProvider();
    case "ollama":
      return new OllamaProvider({ model: config.model });
    default:
      return new RuleProvider();
  }
}

/** Build the dependency object used by the pure core functions. */
export function makeDeps(config: SqueezeConfig, log?: (message: string) => void): PluginDeps {
  const provider = providerForConfig(config);
  return {
    compress: (prose, opts: CompressOptions) =>
      compress(prose, {
        ...opts,
        provider,
        lexicon: config.lexicon,
        retries: config.retries,
      }),
    expandFn: expand,
    estimateTokens,
    lexicon: config.lexicon,
    log,
  };
}

interface SessionState {
  lexiconInjected: boolean;
}

/**
 * opencode plugin entry. Loaded automatically from `.opencode/plugins/`.
 * Config: plugin options tuple, env vars, or `squeeze.config.json` in the
 * project root (see config.ts).
 */
export const SqueezePlugin: Plugin = async (input, options: PluginOptions = {}) => {
  const cwd = input.worktree || input.directory;
  const config = loadConfig(options, cwd);

  const log = (message: string): void => {
    void input.client.app
      .log({ body: { service: "squeeze", level: "info", message, extra: { cwd } } })
      .catch(() => {
        /* logging must never break the plugin */
      });
  };

  const deps = makeDeps(config, log);
  const sessions = new Map<string, SessionState>();

  return {
    "chat.message": async (msg, output) => {
      if (!config.enabled) return;
      try {
        if (output.message.role !== "user") return;
        const sessionID = msg.sessionID;
        const state: SessionState = sessions.get(sessionID) ?? { lexiconInjected: false };

        for (const part of output.parts) {
          if (part.type !== "text") continue;
          // Synthetic parts carry file/tool context — never compress those.
          if (part.synthetic) continue;
          const outcome = await processUserText(part.text, deps, {
            threshold: config.threshold,
            audit: config.audit,
            includeLexicon: !state.lexiconInjected,
            retries: config.retries,
          });
          if (outcome.compressed) {
            part.text = outcome.text;
            deps.log?.(
              `compressed user message (mode=${outcome.payload?.mode ?? "?"}, ` +
                `tokens=${deps.estimateTokens(part.text)})`,
            );
          }
        }

        if (!state.lexiconInjected) {
          state.lexiconInjected = true;
          sessions.set(sessionID, state);
        }
      } catch (err) {
        deps.log?.(`chat.message degraded: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      if (!config.enabled || !config.expand) return;
      try {
        for (const entry of output.messages) {
          if (entry.info.role !== "assistant") continue;
          for (const part of entry.parts) {
            if (part.type !== "text") continue;
            const outcome = processAssistantText(part.text, deps, { expand: true });
            if (outcome.expanded) {
              part.text = outcome.text;
              if (outcome.auditFlags.length > 0) {
                deps.log?.(`expand audit: ${outcome.auditFlags.join(", ")}`);
              }
            }
          }
        }
      } catch (err) {
        deps.log?.(`messages.transform degraded: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
};

export default SqueezePlugin;