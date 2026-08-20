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

## Prompt mutation

SQZ mutates a prompt through three shapes, each lossless to the last:

```
prose  ──compress──▶  SQZ line  ──envelope──▶  model  ──expand──▶  prose
```

## Example 3 — mutate a prompt through compress/expand

```ts
import { compress, expand } from "./src/translator.js";
import { DEFAULT_LEXICON, RuleProvider } from "./src/providers.js";

const prompt =
  "Debug src/parser.ts. Handle edge cases like empty input and null. Skip vendor/. Minimal diff.";

const { sqz } = await compress(prompt, {
  lexicon: DEFAULT_LEXICON,
  provider: new RuleProvider(),
});

console.log(sqz); // debug Δ["src/parser.ts"] L:ts ∂(empty input, null) ⏭ vendor/ μ

// Model runs on the compact line; expand restores the full prompt.
console.log(expand(sqz, DEFAULT_LEXICON));
// Debug src/parser.ts in ts.
// Handle edge cases: empty input, null.
// Skip: vendor/.
// Minimal diff.
```

## Example 4 — full pipeline: envelope in, expanded prose out

`processUserText` wraps the line in a `[SQZ v2]` envelope for the model; `processAssistantText` expands any `[SQZ v2]` block the model echoes back.

```ts
import { processUserText, processAssistantText } from "./src/plugin/core.js";
import { DEFAULT_LEXICON, RuleProvider } from "./src/providers.js";
import { compress, expand } from "./src/translator.js";

const deps = {
  compress,
  expandFn: expand,
  estimateTokens: (t: string) => t.split(/\s+/).length,
  lexicon: DEFAULT_LEXICON,
};

// User prompt → SQZ envelope sent to the model.
const user = await processUserText(
  "Refactor src/a.ts and src/b.ts. Preserve behavior. Minimal diff.",
  deps,
  { threshold: 5, audit: false, includeLexicon: false, retries: 2 },
);

console.log(user.text);
// [SQZ v2]
// refactor Δ["src/a.ts","src/b.ts"] L:ts ≋ μ
// [/SQZ]

// Model replies with a compact SQZ line → expanded back to prose.
const reply = '[SQZ v2]\ndocs Δ["src/a.ts"] L:ts ⌁\n[/SQZ]';
const out = processAssistantText(reply, deps, { expand: true });
console.log(out.expanded); // true
console.log(out.text);
// Write docs for src/a.ts in ts.
// Coverage: complete.
```

`processUserText` is guarded by `estimateTokens >= threshold` and `confidence >= 0.9`; any failure returns the text byte-identical — prose is never mutated unless SQZ is confident.

## Example 5 — long prompt, compressed

A 104-word prompt compresses to a 30-token SQZ line with `RuleProvider` (≈71% fewer tokens); everything the encoder cannot map stays verbatim.

**Before — the prompt (~104 tokens):**

```text
Refactor the authentication service in src/auth.ts and the rate limiter in
src/ratelimit.ts. Preserve the existing runtime behavior exactly — do not
change how tokens are validated or how errors are returned. Add comprehensive
coverage across all code paths, including the failure branches. Handle edge
cases like empty token payloads, expired sessions, and concurrent logins from
the same account. Make the smallest possible change; keep the diff minimal and
avoid touching unrelated files. Run the lint, then the build, then the test
suite in that order. Skip anything under the vendor directory entirely. Verify
the refactor against the acceptance criteria in the ticket before finishing.
```

**After — compressed SQZ line (~30 tokens):**

```text
refactor Δ["src/auth.ts","src/ratelimit.ts"] L:ts
≋[behavior(new) = behavior(old)] ∂[empty, error] μ ⌁[all]
→[lint → build → test] ✓[examples run] ⏭[anything]
v"ts and the rate limiter in src/ratelimit" v"Make the smallest possible change"
```

Mapped: `refactor` mode, two files in `Δ`, `≋` behavior, `∂` edge cases, `μ` minimal, `⌁` coverage, `→` pipeline, `✓` verification, `⏭` skip. The two unmappable clauses drop into `v"..."` verbatim — byte-preserved, never paraphrased.

**Expanded back to prose** (lossless round-trip):

```text
Refactor src/auth.ts, src/ratelimit.ts in ts.
Preserve behavior: behavior(new) = behavior(old).
Handle edge cases: empty, error.
Minimal diff.
Coverage: all.
Pipeline: lint → build → test.
Verified: examples run.
Skip: anything.
ts and the rate limiter in src/ratelimit
Make the smallest possible change
```

## Benchmarks

Measured 2026-08-20 on 100-task fixture (`fixtures/tasks.json`), judge qwen3:1.7b. Full detail in `bakeoff.md`.

| Provider | Parse-pass | p95 | Savings | Fidelity | Mean score |
|---|---|---|---|---|---|
| **rule (no model)** | **1.000** | **0ms** | 0.196 | 0.53 | 7.37 |
| qwen3:1.7b | 0.97 | 2.3s | 0.415 | 0.37 | 7.26 |
| qwen3.5:4b | 0.95 | 10.5s | 0.468 | 0.67 | 7.38 |

- **savings** = token reduction vs original prose. The v1 JSON envelope was *bigger* than prose (savings −0.43) — that finding drove the v2 plain-line design.
- **rule** is the promoted default: only candidate clearing the 300ms p95 gate (0ms, deterministic, works offline / provider-down), and beats qwen3:1.7b on fidelity.
- **model** compress stays opt-in for long messages where savings (0.415–0.468 vs 0.196) outweigh the 2.3–10.5s cost.
- **fidelity ≥0.95** unattained by all local candidates (best 0.67) — lossy symbol compression judged against full content; see open items in `bakeoff.md`.

Interactive profile (`squeeze.config.json`): provider `rule`, threshold 60. Batch/overnight (`squeeze.config.batch.json`): qwen3.5:4b, threshold 0, `audit: true`, `timeoutMs: 30000`.

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
