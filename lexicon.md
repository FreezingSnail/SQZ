# SQZ Lexicon — symbol dictionary

One symbol, one meaning, one domain. Injected once per session (~800 tokens).
Unknown symbol in expand → render literally, flag in audit.

| symbol | domain | meaning | example |
|---|---|---|---|
| Δ | change | the set of files/diffs this payload may modify | Δ ["src/a.ts","src/b.ts"] |
| ≋ | behavior | behavior(new) = behavior(old); preserve runtime behavior | ≋ fn normalize = fn old |
| ∂ | edge | edge cases that must be handled | ∂ (empty input, null, overflow) |
| μ | minimal | minimal diff; smallest change satisfying intent | constraints: ["μ"] |
| ⌁ | coverage | complete coverage; all paths/branches/cases | ⌁ all |
| → | flow | pipeline: sequence of stages or transitions | lint → build → test |
| ✓ | verification | checked/verified against stated acceptance criteria | ✓ examples run |
| ⏭ | omission | deliberately skipped; leave untouched | ⏭ vendor/ |

## Usage notes

- **Domain discipline**: a symbol is never reused for a second meaning in a
  different domain. If a new domain needs a symbol, mint a new glyph.
- **Lossless policy**: any clause the compressor cannot encode confidently
  stays verbatim prose in `verbatim[]`. Symbols never paraphrase.
- **Confidence**: `confidence` is the compressor's self-reported probability
  the payload preserves intent (0–1). Below 0.9 → keep prose fallback.
- **Composition**: clauses combine inside `constraints[]`; each clause is
  independent. Order in the array is not significant.

## Grammar reference

Formal syntax: see `sqz.ebnf`. JSON shape: see `sqz-schema.json`.
