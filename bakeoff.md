# SQZ Bake-off — v2 plain-line era (math-dbr.5 → math-dbr.8)

Date: 2026-08-20. Harness: `go run ./cmd/bench` (sequential, concurrency=1,
`think:false`, `temperature:0`, `keep_alive:30m`, per-request timeout 60s,
error-injection retry ladder max 2 — mirrors translator.ts). Fixture:
`fixtures/tasks.json` (100 tasks). Judge: qwen3:1.7b for all runs.

## v1 era (JSON envelope) — superseded

qwen3:1.7b: parse-pass 0.89, p95 60s+, savings **-0.43** (envelope larger than
prose), fidelity 0.72. The JSON AST wrapper defeated the whole point: slower
than prose and bigger than prose. That finding drove the v2 redesign
(math-dbr.7): plain SQZ line, no schema on the wire, local grammar validation.

## v2 results (plain line)

| Provider | Parse-pass | p95 | Savings | Fidelity | Mean score | Full run |
|---|---|---|---|---|---|---|
| **rule (no model)** | **1.000** | **0ms** | 0.196 | 0.53 | 7.37 | 2:01 (judge-bound) |
| qwen3:1.7b | 0.97 | 2.3s | 0.415 | 0.37 | 7.26 | 4:45 |
| qwen3.5:4b | 0.95 | 10.5s | 0.468 | 0.67 | 7.38 | 19:17 |
| qwen3:4b / gemma4:e4b / granite4.1:3b | not pulled — skipped | | | | | |
| Apple AFM | bridge built (math-dbr.6); Apple Intelligence disabled on this Mac — untestable | | | | | |

Gates (parse-pass>=0.98, p95<300ms, savings>=0.40, fidelity>=0.95):

- **parse-pass**: rule 1.0 ✓; qwen3:1.7b 0.97 (3 invalid after retries)
- **p95 <300ms**: only rule ✓ (0ms, deterministic). Models 2.3s/10.5s — model
  inference cannot hit 300ms on this hardware; decode alone exceeds it.
- **savings >=0.40**: models ✓ (0.415/0.468); rule 0.196 (positive but verbatim
  segments keep it modest)
- **fidelity >=0.95**: nobody. Best 0.67 (qwen3.5:4b). All candidates sit at
  mean judge ~7.4/10 — lossy symbol compression judged against full content
  by a 1.7b judge cannot reach MT-Bench-grade 0.95. Gate is not achievable
  with any local candidate; needs a stronger compressor (or stronger judge,
  e.g. gpt-oss:20b) and likely a relaxed content-preservation target.

## Promoted default

**RuleProvider** — deterministic, no model.

Rationale:
1. "Fast" is a hard requirement: rule compress is microseconds (p95 0ms) —
   the only candidate that clears the 300ms gate.
2. Rule fidelity (0.53) beats qwen3:1.7b (0.37); qwen3.5:4b's 0.67 costs
   10.5s p95 — unacceptable for interactive use.
3. Rule parse-pass 1.000, never fails, zero dependencies (works offline,
   provider down, everywhere).
4. Model compress (qwen3:1.7b) remains opt-in for long messages where
   savings (0.415 vs 0.196) matter more than the ~2.3s cost.

## Ladder status

| Provider | Role |
|---|---|
| rule | DEFAULT — deterministic fast path |
| qwen3:1.7b | optional compress upgrade (better savings, 2.3s cost, lower fidelity) |
| qwen3.5:4b | best fidelity locally (0.67) but 10.5s p95 — non-interactive |
| qwen3:4b, gemma4:e4b, granite4.1:3b | not pulled — untested |
| AFM | bridge ready; Apple Intelligence off on this Mac — untestable |

## Deployment profiles

| Profile | Config | Why |
|---|---|---|
| **interactive (default)** | `squeeze.config.json` — provider `rule`, threshold 60 | p95 0ms; the only path that meets the "fast" requirement |
| **batch / overnight** | `squeeze.config.batch.json` — provider `ollama`, model `qwen3.5:4b`, threshold 0, audit true, timeoutMs 30000 | latency irrelevant; 4b gives best fidelity (0.67) + savings (0.468) |

Batch guidance: qwen3.5:4b takes ~10.5s p95 per compress — fine for unattended
runs; `audit: true` keeps the original prose in the message so nothing is ever
lost in an overnight job. `timeoutMs: 30000` is required — the interactive
default (500ms) would time out the 4b model on every call.

## Open items

1. Fidelity gate (>=0.95) unattained by all local candidates — revisit with
   stronger judge (gpt-oss:20b) or relaxed target; decision recorded here.
2. Rule savings (0.196) below 0.40 — hybrid (rule + model when message long)
   is the practical answer; plugin threshold already supports this.
3. qwen3:4b pull (~2.5GB) + re-bake if fidelity becomes the priority.
