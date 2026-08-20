# SQZ

Clean-room prompt-compression grammar + translation library.

SQZ encodes a prose instruction into **one line of symbols** — a compact wire format the target model executes natively. A small, per-session lexicon (~800 tokens) maps each glyph to one meaning; the per-message payload is just the line.

**Design invariants**

- **Lossless**: anything the compressor cannot encode confidently stays in `v"..."` verbatim segments and round-trips byte-for-byte. Original prose is always recoverable — never silently mutated.
- **Model-independent**: providers are pluggable (Ollama, AFM, or the deterministic `RuleProvider` that needs no model).
- **Robust**: retry with grammar-error injection → `RuleProvider` fallback → passthrough. Unknown symbols render literally and flag an audit entry.

## Wire format

```
<mode> Δ["f1","f2"] [L:<lang>] <symbol>[operand]... v"verbatim clause"
```

Example:

```
refactor Δ["src/tokenizer.ts"] L:ts ≋[behavior(new) = behavior(old)] μ v"Ship the new version"
```

- Modes: `refactor api debug docs test review arch general`
- Symbols: `Δ` change, `≋` behavior, `∂` edge, `μ` minimal, `⌁` coverage, `→` pipeline, `✓` verification, `⏭` omission
- Grammar: `sqz.ebnf` (EBNF), schema: `sqz-schema.json`, symbol dictionary: `lexicon.md`

## Example 1 — deterministic roundtrip (no model)

`RuleProvider` is a dictionary-based compressor — zero external dependencies, never throws.

```ts
import { compress, expand } from "./src/translator.js";
import { DEFAULT_LEXICON, RuleProvider } from "./src/providers.js";

const prose =
  "Refactor the tokenizer in src/tokenizer.ts. Preserve runtime behavior. Minimal diff.";

const result = await compress(prose, {
  lexicon: DEFAULT_LEXICON,
  provider: new RuleProvider(),
});

console.log(result.sqz); // refactor Δ["src/tokenizer.ts"] L:ts ≋ μ
console.log(result.confidence); // 0.9

// Expand back to prose — original meaning fully recoverable.
console.log(expand(result.sqz, DEFAULT_LEXICON));
// Refactor src/tokenizer.ts in ts.
// Preserve behavior: same as before.
// Minimal diff.
```

## Example 2 — local model provider + audit

Plug in Ollama for smarter compression. Unknown glyphs render literally and are flagged — nothing throws.

```ts
import { compress, expand } from "./src/translator.js";
import { DEFAULT_LEXICON } from "./src/providers.js";
import { OllamaProvider } from "./src/providers/ollama.js";

const provider = new OllamaProvider({ model: "qwen3:4b", timeoutMs: 2000 });

const result = await compress(
  "Write tests for src/line.ts. Complete coverage. Handle edge cases like null input.",
  { lexicon: DEFAULT_LEXICON, provider },
);

console.log(result.sqz); // test Δ["src/line.ts"] L:ts ⌁ ∂(null input)

const audit: string[] = [];
const prose = expand(result.sqz, DEFAULT_LEXICON, { audit });
console.log(prose);
console.log(audit); // [] — every symbol resolved
```

## Failure ladder

| Failure | Behavior |
|---|---|
| Grammar-invalid output | Inject validation errors, retry (default `retries: 2`) |
| Provider down / timeout | Deterministic `RuleProvider` fallback |
| All retries fail | Passthrough original prose, `confidence: 0` |
| Unknown symbol on expand | Render literally, push `unknown-symbol:<glyph>` to audit |

## Layout

- `src/` — TS library (translator, line parser, validation, providers)
- `src/plugin/` — opencode plugin integration
- `src/providers/` — Ollama / AFM providers
- `cmd/bench` — Go bench harness
- `tests/` — vitest suites

## License

MIT
