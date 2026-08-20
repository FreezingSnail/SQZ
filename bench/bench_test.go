// Go integration suite for the SQZ benchmark fixture + Ollama provider
// (math-dbr.3). Runs with `go test ./bench/...` from the repo root.
//
// Skip policy: tests that need a real model call requireModel() and
// t.Skip() gracefully when the daemon or ladder is missing — the suite is
// green on machines without Ollama.

package bench

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------- fixture

func TestFixtureIntegrity(t *testing.T) {
	fix, err := LoadFixture()
	if err != nil {
		t.Fatalf("load fixture: %v", err)
	}
	if fix.Version != 1 || fix.Count != 100 || len(fix.Tasks) != 100 {
		t.Fatalf("fixture must be version 1 with exactly 100 tasks, got v=%d count=%d len=%d", fix.Version, fix.Count, len(fix.Tasks))
	}
	ids := map[string]bool{}
	counts := map[string]int{}
	for _, task := range fix.Tasks {
		if ids[task.ID] {
			t.Errorf("duplicate id %s", task.ID)
		}
		ids[task.ID] = true
		if !regexp.MustCompile(`^sqz-\d{3}$`).MatchString(task.ID) {
			t.Errorf("bad id shape %q", task.ID)
		}
		if task.Domain != task.Mode || !modes[task.Mode] {
			t.Errorf("task %s: domain/mode invalid (%q/%q)", task.ID, task.Domain, task.Mode)
		}
		counts[task.Mode]++
		if len(task.Prose) < 40 {
			t.Errorf("task %s: prose too short", task.ID)
		}
		if len(task.ExpectedSymbols) == 0 {
			t.Errorf("task %s: no expectedSymbols", task.ID)
		}
	}
	for m := range modes {
		if counts[m] < 10 {
			t.Errorf("mode %s has only %d tasks", m, counts[m])
		}
	}
}

// ---------------------------------------------------------------- client unit (no daemon)

func newTestServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv
}

func TestClientPingAndHasModel(t *testing.T) {
	srv := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tags" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"models": []map[string]any{
				{"name": "qwen3:4b"},
				{"name": "qwen3.5:4b"},
			},
		})
	})
	c := NewOllamaClient(srv.URL, "qwen3:1.7b", 2*time.Second)
	if !c.Ping() {
		t.Fatal("ping should be true")
	}
	if !c.HasModel("qwen3:4b") || !c.HasModel("qwen3.5:4b") {
		t.Fatal("pulled model should be found")
	}
	if c.HasModel("missing:1b") {
		t.Fatal("missing model must not be found")
	}
	if got := c.AvailableModel(); got != "qwen3:4b" {
		t.Fatalf("ladder substitute expected qwen3:4b, got %q", got)
	}
}

func TestClientPingDown(t *testing.T) {
	c := NewOllamaClient("http://127.0.0.1:1", "qwen3:1.7b", 500*time.Millisecond)
	if c.Ping() {
		t.Fatal("ping must be false for unreachable daemon")
	}
	if got := c.AvailableModel(); got != "" {
		t.Fatalf("AvailableModel must be empty, got %q", got)
	}
}

func TestClientChatRequestAndParse(t *testing.T) {
	var gotBody map[string]any
	srv := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/chat" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode body: %v", err)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"message": map[string]any{"content": "```json\n{\"v\":1}\n```"},
		})
	})
	c := NewOllamaClient(srv.URL, "qwen3:1.7b", 2*time.Second)
	got, err := c.Chat([]Message{{Role: "user", Content: "hi"}}, map[string]any{"type": "object"})
	if err != nil {
		t.Fatalf("chat: %v", err)
	}
	if gotBody["format"] != "json" {
		t.Errorf("format must be json, got %v", gotBody["format"])
	}
	if gotBody["stream"] != false {
		t.Errorf("stream must be false")
	}
	messages, ok := gotBody["messages"].([]any)
	if !ok || len(messages) == 0 {
		t.Fatalf("messages missing: %v", gotBody)
	}
	first := messages[0].(map[string]any)
	if first["role"] != "system" {
		t.Errorf("schema prompt must ride on a system message")
	}
	obj, ok := got.(map[string]any)
	if !ok || obj["v"] != float64(1) {
		t.Errorf("expected parsed {v:1}, got %#v", got)
	}
}

func TestClientChatHTTPError(t *testing.T) {
	srv := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "model not found", http.StatusNotFound)
	})
	c := NewOllamaClient(srv.URL, "qwen3:1.7b", 2*time.Second)
	if _, err := c.Chat(nil, map[string]any{}); err == nil {
		t.Fatal("expected HTTP error")
	}
}

func TestExpandRoundtrip(t *testing.T) {
	line := `refactor Δ["src/a.ts"] L:ts ≋ μ ∂[(edge cases)] v"Keep the diff minimal."`
	out := Expand(line)
	for _, want := range []string{"Refactor src/a.ts in ts.", "Preserve behavior:", "Minimal diff.", "Handle edge cases: (edge cases).", "Keep the diff minimal."} {
		if !strings.Contains(out, want) {
			t.Errorf("expand output missing %q:\n%s", want, out)
		}
	}
}

func TestLineValidation(t *testing.T) {
	known := lineKnownSymbols()
	valid := `refactor Δ["src/a.ts"] L:ts ≋ μ ∂ v"raw prose"`
	if ok, errs := ValidateLine(valid, known); !ok {
		t.Fatalf("valid line rejected: %v", errs)
	}
	bad := []string{
		"",                                          // empty
		`Δ["src/a.ts"] μ`,                           // missing mode
		`bogus Δ["src/a.ts"]`,                       // bad mode
		`refactor μ`,                                // missing target
		`refactor Δ[]`,                              // no files
		`refactor Δ["src/a.ts"] λ`,                  // unknown symbol
		`refactor Δ["src/a.ts"] ∂[unclosed`,         // unbalanced
		`refactor Δ["src/a.ts] v"oops`,              // unterminated quote
		`refactor Δ["src/a.ts"] gazonk`,             // stray token
	}
	for _, line := range bad {
		if ok, _ := ValidateLine(line, known); ok {
			t.Errorf("malformed line accepted: %q", line)
		}
	}
}

func TestClientChatPlain(t *testing.T) {
	var gotBody map[string]any
	srv := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/chat" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode body: %v", err)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"message": map[string]any{"content": "refactor Δ[\"src/a.ts\"] L:ts μ"},
		})
	})
	c := NewOllamaClient(srv.URL, "qwen3:1.7b", 2*time.Second)
	got, err := c.Chat([]Message{{Role: "user", Content: "hi"}}, nil)
	if err != nil {
		t.Fatalf("chat: %v", err)
	}
	if _, hasFormat := gotBody["format"]; hasFormat {
		t.Errorf("v2 compress must not set format, got %v", gotBody["format"])
	}
	if line, ok := got.(string); !ok || line == "" {
		t.Errorf("expected raw line string, got %#v", got)
	}
}

// ---------------------------------------------------------------- gates (skip w/o model)

// requireModel returns an available model or skips the test.
func requireModel(t *testing.T, client *OllamaClient) string {
	t.Helper()
	if !client.Ping() {
		t.Skip("ollama daemon not reachable — skipping model gate")
	}
	if m := client.AvailableModel(); m != "" {
		return m
	}
	t.Skip("no model pulled from ladder qwen3:1.7b → qwen3:4b → qwen3.5:4b → qwen3:14b — skipping model gate")
	return ""
}

func TestBenchmarkGates(t *testing.T) {
	if testing.Short() {
		t.Skip("model benchmark gate — run `go test ./bench/... -run TestBenchmarkGates` (or cmd/bench) explicitly; -short skips it")
	}
	fix, err := LoadFixture()
	if err != nil {
		t.Fatal(err)
	}
	baseURL, model := EnvOverrides()
	probe := NewOllamaClient(baseURL, model, 3*time.Second)
	chosen := requireModel(t, probe)

	// Sequential run: one request at a time (local runner serializes anyway).
	// SQZ_BENCH_LIMIT bounds the smoke run (default 10); set 0 or >=100 for
	// the full fixture.
	tasks := fix.Tasks
	limit := 10
	if v := os.Getenv("SQZ_BENCH_LIMIT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && (n == 0 || n >= len(tasks)) {
			limit = len(tasks)
		} else if err == nil && n > 0 {
			limit = n
		}
	}
	if limit < len(tasks) {
		tasks = tasks[:limit]
	}
	t.Logf("benchmark gate: %d/%d tasks (SQZ_BENCH_LIMIT=%q)", len(tasks), len(fix.Tasks), os.Getenv("SQZ_BENCH_LIMIT"))

	client := NewOllamaClient(baseURL, chosen, 120*time.Second)
	res := RunBenchmark(client, tasks, BenchmarkOptions{Concurrency: 1, Judge: true, JudgeModel: os.Getenv("OLLAMA_JUDGE_MODEL")})
	t.Logf("metrics model=%s parse-pass=%.3f p95=%.1fms savings=%.3f fidelity=%.3f meanScore=%.2f judged=%d judgeFailed=%d transport=%d invalid=%d",
		chosen, res.ParsePass, res.P95MS, res.MeanSavings, res.Fidelity, res.MeanScore,
		res.Judged, res.JudgeFailed, res.TransportErrors, res.InvalidPayloads)

	// Hard gate on any model: schema-valid parse rate.
	if res.ParsePass < 0.98 {
		t.Errorf("parse-pass %f < 0.98", res.ParsePass)
	}
	// Strict acceptance gates apply on the ladder default only; substitutes
	// are advisory (model-ladder rule: document, don't hide).
	if chosen == DefaultModel {
		if res.P95MS >= 300 {
			t.Errorf("p95 %fms >= 300ms", res.P95MS)
		}
		if res.MeanSavings < 0.40 {
			t.Errorf("token savings %f < 0.40", res.MeanSavings)
		}
		if res.Fidelity < 0.95 {
			t.Errorf("fidelity %f < 0.95", res.Fidelity)
		}
	} else {
		t.Logf("advisory (substitute %s): p95=%.1fms savings=%.3f fidelity=%.3f — re-run with %s for acceptance gates",
			chosen, res.P95MS, res.MeanSavings, res.Fidelity, DefaultModel)
	}
}
