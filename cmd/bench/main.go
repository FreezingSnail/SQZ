// Command bench — SQZ model benchmark harness (math-dbr.3).
//
//   go run ./bench            # full 100-task fixture + fidelity judge
//   go run ./bench -model qwen3:1.7b -limit 10 -skip-judge
//
// Prints parse-pass rate, p95 latency, token savings vs prose baseline, and
// MT-Bench-style LLM-judge semantic fidelity. Skips gracefully (exit 0 with
// a message) when the Ollama daemon or model is unavailable.

package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"sqz/bench"
)

func main() {
	var (
		model     = flag.String("model", "", "model tag (default: env OLLAMA_MODEL or qwen3:1.7b; falls back through ladder)")
		baseURL   = flag.String("url", "", "ollama base URL (default: env OLLAMA_BASE_URL or http://127.0.0.1:11434)")
		limit     = flag.Int("limit", 0, "max tasks to run (0 = all)")
		conc      = flag.Int("concurrency", 1, "parallel requests (1 = sequential; local runner serializes anyway)")
		rule      = flag.Bool("rule", false, "use deterministic RuleProvider compress (no model, µs) instead of Ollama")
		skipJudge = flag.Bool("skip-judge", false, "skip the LLM-judge fidelity roundtrip")
		timeout   = flag.Duration("timeout", 60*time.Second, "per-request timeout")
		jsonOut   = flag.Bool("json", false, "emit machine-readable JSON summary")
	)
	flag.Parse()

	if *baseURL == "" {
		*baseURL, _ = bench.EnvOverrides()
	}
	if *model == "" {
		_, m := bench.EnvOverrides()
		*model = m
	}

	fix, err := bench.LoadFixture()
	if err != nil {
		fmt.Fprintln(os.Stderr, "bench: "+err.Error())
		os.Exit(1)
	}

	client := bench.NewOllamaClient(*baseURL, *model, *timeout)

	tasks := fix.Tasks
	if *limit > 0 && *limit < len(tasks) {
		tasks = tasks[:*limit]
	}

	if *rule {
		// Deterministic path: no model needed for compress; judge (if on) still
		// needs the daemon — allowed to fail per-row.
		fmt.Printf("bench: model=rule tasks=%d concurrency=%d judge=%v\n", len(tasks), *conc, !*skipJudge)
		res := bench.RunBenchmark(client, tasks, bench.BenchmarkOptions{
			Concurrency: *conc,
			Judge:       !*skipJudge,
			JudgeModel:  os.Getenv("OLLAMA_JUDGE_MODEL"),
			Rule:        true,
		})
		if *jsonOut {
			b, _ := json.MarshalIndent(res, "", "  ")
			fmt.Println(string(b))
			return
		}
		fmt.Printf("bench: parse-pass=%.3f p95=%.1fms savings=%.3f fidelity=%.3f meanScore=%.2f judged=%d judgeFailed=%d transportErrors=%d invalidPayloads=%d\n",
			res.ParsePass, res.P95MS, res.MeanSavings, res.Fidelity, res.MeanScore,
			res.Judged, res.JudgeFailed, res.TransportErrors, res.InvalidPayloads)
		return
	}

	if !client.Ping() {
		fmt.Println("bench: ollama daemon not reachable at " + *baseURL + " — skipping (install/start ollama to benchmark)")
		return
	}
	chosen := client.AvailableModel()
	if chosen == "" {
		fmt.Println("bench: no model available (ladder: qwen3:1.7b → qwen3:4b → qwen3.5:4b → qwen3:14b) — pull one to benchmark")
		return
	}
	if chosen != *model {
		fmt.Printf("bench: %s not pulled; using ladder substitute %s\n", *model, chosen)
		*model = chosen
	}
	client.Model = chosen

	fmt.Printf("bench: model=%s tasks=%d concurrency=%d judge=%v\n", chosen, len(tasks), *conc, !*skipJudge)

	res := bench.RunBenchmark(client, tasks, bench.BenchmarkOptions{
		Concurrency: *conc,
		Judge:       !*skipJudge,
		JudgeModel:  os.Getenv("OLLAMA_JUDGE_MODEL"),
		Rule:        *rule,
	})

	if *jsonOut {
		b, _ := json.MarshalIndent(res, "", "  ")
		fmt.Println(string(b))
		return
	}
	fmt.Printf("bench: parse-pass=%.3f p95=%.1fms savings=%.3f fidelity=%.3f meanScore=%.2f judged=%d judgeFailed=%d transportErrors=%d invalidPayloads=%d\n",
		res.ParsePass, res.P95MS, res.MeanSavings, res.Fidelity, res.MeanScore,
		res.Judged, res.JudgeFailed, res.TransportErrors, res.InvalidPayloads)
}
