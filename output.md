# math-dbr.2 — Translator core + RuleProvider + unit tests

Deliverables for SQZ milestone 2: model-independent TypeScript translation
library — compress/expand, provider interface, deterministic RuleProvider
fallback, schema validation, retry/fallback ladder, vitest suite.

## Files created

| file | purpose |
|---|---|
| `src/types.ts` | Shared types: `Mode`, `SQZPayload` (v1), `LexiconEntry`, `Lexicon`, `ChatMessage`, `Provider`, `CompressOptions`, `CompressResult`, `ExpandOptions`. |
| `src/validate.ts` | ajv (draft-07) validator compiled from `sqz-schema.json`; `validatePayload(value) → {valid, errors}`. |
| `src/providers.ts` | `Provider` contract impls: `RuleProvider` (deterministic dictionary compression, no model, never throws, honors lexicon injected via system message, `DEFAULT_LEXICON` mirror of lexicon.md) and `passthroughPayload()` (graceful degradation: prose verbatim, confidence 0). |
| `src/translator.ts` | `compress(prose, {domain?, lexicon, provider?, retries?}) → {sqz, verbatim, confidence, latencyMs}`; `expand(payload, lexicon, {audit?}) → prose`. Retry/error-injection loop, provider-down fallback, unknown-symbol literal render + audit flag. |
| `tests/translator.test.ts` | Roundtrip, retry w/ error injection, all-retries-fail passthrough, unparseable output passthrough, provider-down → RuleProvider, domain override, unknown-symbol audit. |
| `tests/providers.test.ts` | RuleProvider determinism, schema validity, system-message lexicon injection, file extraction, pipeline clause, never-throws. |
| `tests/validate.test.ts` | Schema: valid payload + all 8 modes accepted; v/2, bad mode, confidence out of range, empty files, missing field, extra property, non-string constraint rejected. |
| `tests/lexicon.test.ts` | lexicon.md < 1000 tokens; DEFAULT_LEXICON: 8 symbols, unique symbol+domain, non-empty meaning/example. |
| `package.json`, `tsconfig.json` | npm setup: typescript + vitest + ajv; scripts `test` (vitest run), `typecheck`, `build`. |

## Error ladder (epic design) — as implemented

- parse/schema fail → inject validation errors into message list → retry (max 2) → passthrough (prose in `verbatim[]`, confidence 0)
- provider down/timeout → RuleProvider fallback → passthrough
- unknown symbol in expand → render literally + `unknown-symbol:<glyph>` audit flag
- invariant: original prose always recoverable (verbatim[] passes through byte-for-byte in expand); never silently mutated

## Acceptance verification

- **vitest suite green (mock providers)** — 4 files, **31 tests pass**, `npm test` clean; `tsc --noEmit` clean.
- **roundtrip compress→expand lossless for hand cases** — refactor case (`≋`, `μ`, files), verbatim clause "Ship the new version" expands byte-for-byte, general-mode fallback, `Δ/∂/→/⏭` clause rendering, all-symbols expand.
- **all error paths verified by tests** — retry+error injection (3 attempts, feedback message asserted), retry exhaustion → passthrough, non-JSON output → passthrough, provider throws → RuleProvider, unknown symbol literal + audit, provider `never throws`.
- **token count for lexicon < 1000** — lexicon.md word+glyph count asserted < 1000 in `tests/lexicon.test.ts`.

## Interface contract (for downstream tasks)

- `SQZPayload` v1 + schema: see `sqz-schema.json` (math-dbr.1)
- `Provider { name: string; generate(messages: ChatMessage[], schema: object): Promise<unknown> }` — returns JSON string or parsed object; non-conformant → retry ladder
- `compress(prose, {domain?, lexicon, provider?, retries?}) → {sqz, verbatim, confidence, latencyMs}` (default provider = RuleProvider)
- `expand(payload, lexicon, {audit?}) → prose` (audit array collects `unknown-symbol:<glyph>`)
- Symbol set: `Δ ≋ ∂ μ ⌁ → ✓ ⏭` (lexicon.md)

## Notes

- Tests are permanent, co-located in `tests/`, native vitest (no scripted test languages, no temp files).
- No git commit made (main session handles commits).
