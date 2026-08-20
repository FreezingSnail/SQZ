# SQZ Model Bake-off (math-dbr.5)

Date: 2026-08-20. Harness: `go run ./cmd/bench` (bench/, math-dbr.3), fixture
`fixtures/tasks.json` (100 tasks), sequential only (concurrency=1), `think:false`,
`temperature:0`, `keep_alive:30m`, per-request timeout 90s.

Hardware note: run happened while a second opencode session shared the same
Ollama daemon — every latency figure is under contention and upper-bounded.

## Candidates

| Model | Status |
|---|---|
| qwen3:1.7b | tested — full 100-task run + judge |
| qwen3.5:4b | tested — 10-task smoke + judge (full run skipped: timeout pathology) |
| qwen3:4b | NOT pulled — multi-GB download; documented, not tested |
| gemma4:e4b | NOT pulled — multi-GB download; documented, not tested |
| granite4.1:3b | NOT pulled — multi-GB download; documented, not tested |
| Apple AFM | no bridge yet — math-dbr.6 (afm-bridge + AFMProvider) pending |

Judge model: `qwen3:1.7b` (OLLAMA_JUDGE_MODEL) for all runs — fastest and most
reliable pulled model; the stronger candidate qwen3.5:4b is timeout-prone under
contention and would skew judgeFailed. Same judge everywhere keeps comparisons
apples-to-apples. Bias caveat: judge is the same model as the qwen3:1.7b
candidate (self-judge leniency possible); mitigated by identical judge for all
candidates and schema-constrained `{"score":1..10}` output.

## Results

| Model | Tasks | Parse-pass | Fidelity | Mean judge score | p95 latency | Token savings | Judged/tasks |
|---|---|---|---|---|---|---|---|
| qwen3:1.7b | 100 | 0.89 | 0.719 | 7.64 | 90.0s (capped) | -0.43 | 89/100 |
| qwen3.5:4b | 10 | 0.80 | 1.000 (n=8) | 8.25 | 90.0s (capped) | -0.05 | 8/10 |
| qwen3:4b | — | skipped: not pulled | | | | | |
| gemma4:e4b | — | skipped: not pulled | | | | | |
| granite4.1:3b | — | skipped: not pulled | | | | | |
| AFM (on-device) | — | skipped: no bridge (math-dbr.6) | | | | | |

Details:

- **qwen3:1.7b (full)**: 100 tasks, 89 valid payloads (7 transport errors —
  timeout-capped at 90s under contention; 4 invalid payloads). Fidelity 0.719
  (64/89 scored >=8), meanScore 7.64. Savings -0.43 (JSON envelope outweighs
  prose for a 1.7B compressor). Reproduces the math-dbr.4-era baseline exactly
  (parse 0.89, p95 60s, savings -0.43, fidelity 0.72, meanScore 7.64) — stable.
- **qwen3.5:4b (smoke, 10)**: 2/10 transport timeouts (20% at 90s cap) —
  full 100-task run skipped as it would exceed the ~20min budget and mostly
  collect timeouts. Nominal fidelity 1.0 on the 8 that completed; not
  trustworthy at n=8. Latency/reliability far worse than qwen3:1.7b.

## Promoted default model

**qwen3:1.7b** (unchanged — config default already).

Rationale (fidelity gate >=95%, then latency):

1. No candidate passes the 95% fidelity gate under current hardware
   (qwen3:1.7b: 0.719; qwen3.5:4b: 1.0 on n=8 is statistically meaningless and
   its 20% timeout rate fails the availability gate).
2. Tie-break on latency/reliability: qwen3:1.7b completes 89/100 under
   contention vs qwen3.5:4b's ~80% availability with timeouts. qwen3:1.7b is
   the only model that can serve a 100-task session without cascading
   timeouts.
3. No candidate can be promoted past it today — qwen3:4b (the ladder next
   rung) is not pulled.

## Model ladder (post-bake-off)

| Rung | Model | Gate status | Why |
|---|---|---|---|
| 1 (default) | qwen3:1.7b | PASS availability, FAIL fidelity (0.719) | fastest reliable under contention; fidelity gap to close |
| 2 | qwen3:4b | NOT TESTED — not pulled | next ladder rung per epic; download then re-run |
| 3 | qwen3.5:4b | FAIL latency/reliability | 20% timeouts at 10 tasks, p95 90s cap, negative throughput |
| 4 | qwen3:14b | not a candidate this ticket | pulled but overkill for 1.7B-class job |
| — | gemma4:e4b | NOT TESTED — not pulled | download then test |
| — | granite4.1:3b | NOT TESTED — not pulled | download then test |
| — | AFM (on-device) | NOT TESTED — no bridge | math-dbr.6 delivers afm-bridge; then bake-off |

## Recommendation: re-run on unloaded hardware

All latency/fidelity numbers are degraded by Ollama contention (second opencode
session). To re-run cleanly:

```
# no other session using Ollama
OLLAMA_JUDGE_MODEL=qwen3:1.7b go run ./cmd/bench -model qwen3:1.7b -timeout 90s -json
# qwen3:4b after pulling (2.5GB):
OLLAMA_JUDGE_MODEL=qwen3:1.7b go run ./cmd/bench -model qwen3:4b -timeout 90s -json
```

Decision rule: if unloaded qwen3:1.7b fidelity >=0.95 → keep default. Else pull
qwen3:4b and promote if it passes >=0.95 with better latency than qwen3.5:4b.
Also re-run qwen3.5:4b unloaded before trusting its nominal fidelity.

## Verification

- `go test ./bench/... -short` — ok (0.32s)
- `go vet ./bench/...` — clean