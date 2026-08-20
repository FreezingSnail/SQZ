# SQZ v2 — final state (math-dbr.7 + math-dbr.8)

## What v2 changed (math-dbr.7)

Dropped the JSON envelope from the compress path. Wire format = ONE plain SQZ
line: `refactor Δ["src/a.ts"] L:ts ≋ μ ∂ v"keep log messages identical"`.
Validation = local grammar check (µs, no model). Lossless policy: unencodable
clauses go into v"..." verbatim segments. Lexicon injected once per session.

## Re-bake-off results (math-dbr.8, 100 tasks, sequential, unloaded machine)

| Provider | Parse-pass | p95 | Savings | Fidelity | Full run |
|---|---|---|---|---|---|
| rule (no model) | 1.000 | 0ms | 0.196 | 0.53 | 2:01 |
| qwen3:1.7b | 0.97 | 2.3s | 0.415 | 0.37 | 4:45 |
| qwen3.5:4b | 0.95 | 10.5s | 0.468 | 0.67 | 19:17 |

Before/after (qwen3:1.7b, v1 → v2): savings -0.43 → +0.415; p95 60s → 2.3s;
transport errors 7 → 0. The v2 redesign fixed both failure modes.

## Promoted default

**RuleProvider** (deterministic) — the only candidate that meets the "fast"
requirement (p95 0ms). Model compress opt-in for long messages.

Gates unmet: fidelity >=0.95 by all local candidates (best 0.67, qwen3.5:4b);
documented in bakeoff.md. Open: stronger judge (gpt-oss:20b), qwen3:4b pull,
AFM re-test when Apple Intelligence enabled.

## Verification

- `npm test`: 148/148 green (1.5s)
- `npx tsc --noEmit`: clean
- `go test ./bench/... -short`: green (0.3s), `go vet ./...`: clean
- Full v2 runs: rule 2:01, qwen3:1.7b 4:45, qwen3.5:4b 19:17 (sequential + judge)
