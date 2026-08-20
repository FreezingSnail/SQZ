# SQZ v2 — plain-line payload (math-dbr.7)

## What changed

v1 compress emitted a JSON envelope (`{"v":1,"mode":...,"target":{...},"constraints":[...],"verbatim":[...],"confidence":...}`) validated by JSON Schema, with `format:json` structured generation. Measured on qwen3:1.7b: **token savings −0.43** (envelope larger than prose) and ~2-5s per compress (schema in prompt + long JSON decode + parse retries).

v2 drops the envelope entirely. The wire format is **one plain SQZ line**:

```
refactor Δ["src/a.ts"] L:ts ≋ μ ∂ v"keep log messages identical"
```

- No JSON, no schema prompt, no `format:json` — plain text generation
- Validation = local grammar check (microseconds, zero model roundtrips)
- Lossless policy intact: unencodable clauses go into `v"..."` verbatim segments
- Lexicon still injected once per session; per-message payload is just the line

## Files

- `src/line.ts` — v2 line tokenizer + AST (new)
- `src/translator.ts` — compress → SQZLine; expand(line); grammar retry ladder
- `src/validate.ts` — validateLine (local grammar) + validatePayload (v1, tooling-only)
- `src/providers.ts` — RuleProvider emits lines; passthroughLine
- `src/providers/ollama.ts` — generate(messages, schema?) — plain text when schema omitted
- `src/plugin/format.ts` / `core.ts` — `[SQZ v2]` block carries the line; marker-only detection (no bare-JSON scanning)
- `sqz.ebnf` — v2 line grammar; v1 payload grammar marked tooling-only
- Tests: translator/providers/validate/plugin suites updated to v2 + new grammar tests

## Verification

- `npm test`: 148/148 green (1.1s)
- `npx tsc --noEmit`: clean
- Roundtrip lossless via RuleProvider (hand cases)
- validateLine: 10k validations < 1s (measured in test)

## Next

math-dbr.8: bench v2 (Go harness → plain-line metrics) + re-bake-off on qwen3:1.7b.
Expect: positive savings (line < prose), sub-second compress latency, simpler grammar pass rate.
