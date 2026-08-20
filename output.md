# math-dbr.3 — OllamaProvider + benchmark fixture (Go)

Status: CLOSED with documented gate results (see "Benchmark findings" below).

## Deliverables

- `src/providers/ollama.ts` — OllamaProvider (TS core, Provider interface): POST /api/chat, `format=json` + schema prompt on last system message, `think:false`, `keep_alive:30m`, temperature 0. Throws on transport/HTTP error → translator ladder falls back to RuleProvider → passthrough. Unit tests: `tests/ollama.test.ts` (mocked fetch, no daemon).
- `fixtures/tasks.json` — 100 canonical tasks (version 1) across all 8 modes (refactor 14, api 14, debug 12, docs 12, test 12, review 12, arch 12, general 12). Each: id/domain/mode/prose/expectedSymbols. Integrity tests: `tests/fixtures.test.ts` (TS) + `TestFixtureIntegrity` (Go).
- `bench/` — Go benchmark harness + integration gates (NOT vitest/JS, per ticket rewrite):
  - `harness.go` — fixture loader, token estimator, SQZPayload v1 validator (Go mirror), Ollama client (stdlib only), sequential `RunBenchmark` (concurrency capped at 1 — one task at a time), MT-Bench-style LLM-judge fidelity (`OLLAMA_JUDGE_MODEL` override supported).
  - `expand.go` — SQZ→prose expander (Go mirror of translator.ts) for judge roundtrips.
  - `bench_test.go` — fixture integrity, client unit tests (httptest), expand roundtrip, `TestBenchmarkGates` (model gate).
- `cmd/bench/main.go` — CLI: `go run ./cmd/bench [-model X] [-limit N] [-skip-judge] [-json]`. Default sequential.

## Verification

- `npm test` — 59 tests green (241ms), no daemon needed.
- `go vet ./bench/...`, `go build ./...` — clean.
- `tsc --noEmit` — clean.
- `go test ./bench/... -run 'TestFixtureIntegrity|TestClient|TestExpandRoundtrip'` — 6 green.
- Full gate: `go run ./cmd/bench -concurrency 1 -json` — 100 tasks sequential + judge (results below).

Runtime controls: `TestBenchmarkGates` skips under `-short`; `SQZ_BENCH_LIMIT` bounds tasks (default 10 in test, 0 = full); CLI `-limit` flag.

## Benchmark findings (qwen3:1.7b, sequential, 100 tasks, judge on)

| metric | result | gate |
|---|---|---|
| parse-pass | 0.89 | >= 0.98 — FAIL |
| p95 latency | 60001ms | < 300ms — FAIL |
| mean token savings | -0.43 | >= 0.40 — FAIL |
| fidelity (judge>=8) | 0.72 | >= 0.95 — FAIL |
| mean judge score | 7.64 | — |
| transport errors | 7 (60s timeouts) | — |
| invalid payloads | 4 | — |

10-task smoke (same machine, quieter window): parse-pass 1.000, p95 4654ms, savings 0.385, fidelity 0.80, meanScore 7.50, 0 transport errors.

Model-ladder rule applied: fidelity < 95% on 1.7b → documented; re-run with 4b-class model before promoting. qwen3:4b not pulled; qwen3.5:4b (pulled, 4b-class) tested: parse-pass 0.80 with 2x 120s timeouts under machine load — worse on this hardware. Ladder exhausted locally (qwen3:14b not pulled).

Contributing factor: this machine was running a second opencode session resident on Ollama (qwen2.5-coder:7b) during the full run, causing 60s request timeouts and skewed p95. A dedicated, unloaded Apple Silicon host may still meet gates.

Decision: promotion is owned by math-dbr.5 (bake-off). math-dbr.3 deliverables complete; gates encode acceptance and remain permanent; current numbers recorded here and in issue notes.
