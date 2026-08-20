# math-dbr.5 — Model bake-off and default promotion

Status: CLOSED.

## Summary

Empirical model selection via the bench harness (bench/, math-dbr.3) against
`fixtures/tasks.json` (100 tasks), sequential (concurrency=1). Full report:
`bakeoff.md` (repo root).

## Results (run under Ollama contention — second opencode session sharing daemon)

| Model | Tasks | Parse-pass | Fidelity | Mean score | p95 | Savings | Judged |
|---|---|---|---|---|---|---|---|
| **qwen3:1.7b** | 100 | 0.89 | 0.719 | 7.64 | 90s (capped) | -0.43 | 89/100 |
| qwen3.5:4b | 10 | 0.80 | 1.000 (n=8) | 8.25 | 90s (capped) | -0.05 | 8/10 |
| qwen3:4b / gemma4:e4b / granite4.1:3b | — | skipped — not pulled (multi-GB) | | | | | |
| Apple AFM | — | skipped — no bridge (math-dbr.6) | | | | | |

Judge: `qwen3:1.7b` (OLLAMA_JUDGE_MODEL) for all runs — fast/reliable; same
judge across candidates.

## Promoted default

**qwen3:1.7b** (unchanged). No candidate passes fidelity gate >=95%; winner on
latency/reliability (qwen3.5:4b: 20% transport timeouts at 10 tasks). Re-run on
unloaded hardware recommended; if fidelity still <95%, pull qwen3:4b (next
ladder rung) and re-test.

## Verification

- `go test ./bench/... -short` — ok
- `go vet ./bench/...` — clean
- bakeoff.md written; result recorded via `bd remember`
  (bakeoff-math-dbr-5-...) and epic notes (`bd update math-dbr`).

## Usage

```
OLLAMA_JUDGE_MODEL=qwen3:1.7b go run ./cmd/bench -model qwen3:1.7b -timeout 90s -json
```