// Package bench — SQZ benchmark harness + integration gates (math-dbr.3).
//
// Reads fixtures/tasks.json, exercises Ollama's /api/chat (format=json +
// schema prompt), and reports: parse-pass rate, p95 latency, token savings
// vs the prose baseline, and MT-Bench-style LLM-judge semantic fidelity.
// Permanent counterpart of tests/integration/ollama.test.ts, in Go per the
// task requirement (bench/integration suite must be Go, not vitest/JS).

package bench

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Task is one canonical fixture entry.
type Task struct {
	ID              string   `json:"id"`
	Domain          string   `json:"domain"`
	Mode            string   `json:"mode"`
	Prose           string   `json:"prose"`
	ExpectedSymbols []string `json:"expectedSymbols"`
}

// Fixture mirrors fixtures/tasks.json.
type Fixture struct {
	Version int    `json:"version"`
	Count   int    `json:"count"`
	Tasks   []Task `json:"tasks"`
}

// ---------------------------------------------------------------- fixture I/O

// LoadFixture reads fixtures/tasks.json. Tries root-relative and bench-relative
// paths so both `go test ./bench/...` (from repo root) and `go test` (from
// bench/) work.
func LoadFixture() (*Fixture, error) {
	candidates := []string{
		"fixtures/tasks.json",
		"bench/../fixtures/tasks.json",
		"../fixtures/tasks.json",
	}
	var lastErr error
	for _, p := range candidates {
		b, err := os.ReadFile(p)
		if err != nil {
			lastErr = err
			continue
		}
		var f Fixture
		if err := json.Unmarshal(b, &f); err != nil {
			return nil, fmt.Errorf("parse %s: %w", p, err)
		}
		return &f, nil
	}
	return nil, fmt.Errorf("open fixtures/tasks.json: %w", lastErr)
}

// ---------------------------------------------------------------- token est.

// Mirrors src/tokens.ts: word-like runs + punctuation/symbol runs.
var (
	wordRe = regexp.MustCompile(`[\p{L}\p{N}]+`)
	symRe  = regexp.MustCompile(`[\p{P}\p{S}]+`)
)

func estimateTokens(s string) int {
	return len(wordRe.FindAllString(s, -1)) + len(symRe.FindAllString(s, -1))
}

// tokenSavings is 1 - tokens(compressed)/tokens(prose); negative when the
// JSON envelope outweighs the prose.
func tokenSavings(compressed, prose string) float64 {
	base := estimateTokens(prose)
	if base == 0 {
		return 0
	}
	return 1 - float64(estimateTokens(compressed))/float64(base)
}

// ---------------------------------------------------------------- validation

var modes = map[string]bool{
	"refactor": true, "api": true, "debug": true, "docs": true,
	"test": true, "review": true, "arch": true, "general": true,
}

// ---------------------------------------------------------------- ollama client

// Message mirrors src/types.ts ChatMessage.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

const (
	DefaultModel   = "qwen3:1.7b"
	DefaultBaseURL = "http://127.0.0.1:11434"
	chatPath       = "/api/chat"
)

// ModelLadder is the promotion ladder from the epic design.
var ModelLadder = []string{"qwen3:1.7b", "qwen3:4b", "qwen3.5:4b", "qwen3:14b"}

// OllamaClient is a minimal /api/chat client (stdlib only).
type OllamaClient struct {
	BaseURL string
	Model   string
	HTTP    *http.Client
}

func NewOllamaClient(baseURL, model string, timeout time.Duration) *OllamaClient {
	return &OllamaClient{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Model:   model,
		HTTP:    &http.Client{Timeout: timeout},
	}
}

// EnvOverrides applies OLLAMA_BASE_URL / OLLAMA_MODEL when set.
func EnvOverrides() (baseURL, model string) {
	baseURL = DefaultBaseURL
	model = DefaultModel
	if v := os.Getenv("OLLAMA_BASE_URL"); v != "" {
		baseURL = v
	}
	if v := os.Getenv("OLLAMA_MODEL"); v != "" {
		model = v
	}
	return baseURL, model
}

func (c *OllamaClient) tags() ([]map[string]any, error) {
	res, err := c.HTTP.Get(c.BaseURL + "/api/tags")
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	var body struct {
		Models []map[string]any `json:"models"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return nil, err
	}
	return body.Models, nil
}

// Ping reports whether the daemon answers on the base URL.
func (c *OllamaClient) Ping() bool {
	_, err := c.tags()
	return err == nil
}

// HasModel reports whether tag is pulled (default: c.Model).
func (c *OllamaClient) HasModel(tag string) bool {
	if tag == "" {
		tag = c.Model
	}
	models, err := c.tags()
	if err != nil {
		return false
	}
	for _, m := range models {
		if name, _ := m["name"].(string); name == tag {
			return true
		}
	}
	return false
}

// AvailableModel walks ModelLadder and returns the first pulled model, or "".
func (c *OllamaClient) AvailableModel() string {
	if !c.Ping() {
		return ""
	}
	if c.HasModel(c.Model) {
		return c.Model
	}
	for _, m := range ModelLadder {
		if c.HasModel(m) {
			return m
		}
	}
	return ""
}

// compressSystem is the v2 compress prompt: lexicon table + grammar + example.
// No JSON schema — the small model emits one plain SQZ line.
const compressSystem = "You are the SQZ compressor. Encode the user's request into ONE SQZ line using this grammar:\n" +
	`<mode> Δ["file1","file2"] [L:<lang>] <symbol>[operand]... v"verbatim clause"` + "\n" +
	"Modes: refactor api debug docs test review arch general.\n" +
	"Lexicon:\n" +
	"Δ = change-set: files this payload may modify\n" +
	"≋ = behavior-equivalence: preserve runtime behavior\n" +
	"∂ = edge-cases: cases that must be handled\n" +
	"μ = minimal diff\n" +
	"⌁ = complete coverage\n" +
	"→ = pipeline of stages\n" +
	"✓ = verified against acceptance criteria\n" +
	"⏭ = deliberately skipped / leave untouched\n" +
	"Lossless policy: if a clause does not map cleanly to a symbol, put the ENTIRE clause verbatim into v\"...\" — never drop, reword, or summarize content.\n" +
	`Example: refactor Δ["src/a.ts"] L:ts ≋ μ ∂ v"keep log messages identical"` + "\n" +
	"Emit ONLY the line."

func schemaPrompt(schema any) string {
	b, _ := json.Marshal(schema)
	return "Respond with a single JSON object conforming to this JSON Schema:\n" +
		string(b) +
		"\nOutput only the JSON object — no commentary, no markdown fences."
}

// withSchemaPrompt appends the schema instruction to the last system message.
func withSchemaPrompt(messages []Message, schema any) []Message {
	out := make([]Message, len(messages))
	copy(out, messages)
	idx := -1
	for i := len(out) - 1; i >= 0; i-- {
		if out[i].Role == "system" {
			idx = i
			break
		}
	}
	if idx == -1 {
		out = append([]Message{{Role: "system", Content: schemaPrompt(schema)}}, out...)
	} else {
		out[idx] = Message{Role: "system", Content: out[idx].Content + "\n\n" + schemaPrompt(schema)}
	}
	return out
}

// parseContent strips fences and JSON-parses; returns the raw string when
// unparseable (retry ladder decides), mirroring src/providers/ollama.ts.
func parseContent(content string) any {
	s := strings.TrimSpace(content)
	s = fenceRe.ReplaceAllString(s, "$1")
	s = strings.TrimSpace(s)
	var v any
	if err := json.Unmarshal([]byte(s), &v); err == nil {
		return v
	}
	return s
}

var fenceRe = regexp.MustCompile("(?s)^```(?:json)?\\s*([\\s\\S]*?)\\s*```$")

// Chat posts to /api/chat. When schema is nil (v2 compress path) the request
// is plain text — no format:json, no schema prompt. When schema is given
// (judge-style calls) format=json + schema prompt are applied.
func (c *OllamaClient) Chat(messages []Message, schema any) (any, error) {
	body := map[string]any{
		"model":      c.Model,
		"messages":   messages,
		"stream":     false,
		"think":      false,
		"keep_alive": "30m",
		"options":    map[string]any{"temperature": 0},
	}
	if schema != nil {
		body["messages"] = withSchemaPrompt(messages, schema)
		body["format"] = "json"
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	res, err := c.HTTP.Post(c.BaseURL+chatPath, "application/json", bytes.NewReader(encoded))
	if err != nil {
		return nil, fmt.Errorf("ollama request failed: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return nil, fmt.Errorf("ollama HTTP %d %s", res.StatusCode, strings.TrimSpace(string(b)))
	}
	var reply struct {
		Message *struct {
			Content string `json:"content"`
		} `json:"message"`
		Error string `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&reply); err != nil {
		return nil, fmt.Errorf("ollama decode: %w", err)
	}
	if reply.Error != "" {
		return nil, fmt.Errorf("ollama error: %s", reply.Error)
	}
	if reply.Message == nil {
		return nil, errors.New("ollama: empty response")
	}
	return parseContent(reply.Message.Content), nil
}

// ---------------------------------------------------------------- benchmark

// Row is per-task outcome.
type Row struct {
	Task    Task
	OK      bool
	Latency time.Duration
	Payload any
	Err     string
}

// Result aggregates metrics across the fixture.
type Result struct {
	Model           string
	Tasks           int
	ParsePass       float64
	P95MS           float64
	MeanSavings     float64
	Fidelity        float64
	MeanScore       float64
	Judged          int
	JudgeFailed     int
	TransportErrors int
	InvalidPayloads int
}

// BenchmarkOptions controls the run.
type BenchmarkOptions struct {
	Concurrency int
	Judge       bool   // run MT-Bench-style fidelity judge roundtrip
	JudgeModel  string // model for the judge (MT-Bench uses a strong judge); "" = same as client
	Rule        bool   // deterministic RuleProvider compress (no model, µs) instead of Ollama
}

// RunBenchmark exercises `tasks` against the client and aggregates metrics.
// Concurrency is capped at 1 unless the caller explicitly asks for more:
// a local Ollama runner serializes parallel requests anyway, and sequential
// runs keep latency measurements honest (one task at a time).
func RunBenchmark(c *OllamaClient, tasks []Task, opts BenchmarkOptions) Result {
	if opts.Concurrency != 1 {
		opts.Concurrency = 1
	}
	rows := mapLimit(tasks, opts.Concurrency, func(t Task) Row {
		s := time.Now()

		// Deterministic path: no model, microseconds per task.
		if opts.Rule {
			line := EncodeLine(t.Prose)
			valid, errs := ValidateLine(line, lineKnownSymbols())
			return Row{Task: t, OK: valid, Latency: time.Since(s), Payload: line, Err: strings.Join(errs, "; ")}
		}

		// Retry ladder mirrors src/translator.ts generateValidLine: up to 2
		// retries with error injection, then the row is marked invalid.
		const maxRetries = 2
		var (
			line  string
			errs  []string
			err   error
			valid bool
		)
		history := []Message{
			{Role: "system", Content: compressSystem},
			{Role: "user", Content: t.Prose},
		}
		for attempt := 0; attempt <= maxRetries; attempt++ {
			var raw any
			raw, err = c.Chat(history, nil) // v2 plain-line compress: no schema, no format:json
			if err != nil {
				break
			}
			var ok bool
			line, ok = raw.(string)
			if !ok {
				err = errors.New("compress output is not text")
				break
			}
			line = strings.TrimSpace(line)
			valid, errs = ValidateLine(line, lineKnownSymbols())
			if valid {
				break
			}
			history = append(history,
				Message{Role: "assistant", Content: line},
				Message{Role: "system", Content: "Grammar validation failed: " + strings.Join(errs, "; ") + ". Respond again with a single valid SQZ line only."},
			)
		}
		lat := time.Since(s)
		if err != nil {
			return Row{Task: t, OK: false, Latency: lat, Err: err.Error()}
		}
		return Row{Task: t, OK: valid, Latency: lat, Payload: line, Err: strings.Join(errs, "; ")}
	})

	var (
		valid     []Row
		lats      []float64
		validRows = 0
	)
	for _, r := range rows {
		lats = append(lats, float64(r.Latency.Milliseconds()))
		if r.OK {
			validRows++
			valid = append(valid, r)
		}
	}
	res := Result{Model: c.Model, Tasks: len(tasks)}
	if len(tasks) > 0 {
		res.ParsePass = float64(validRows) / float64(len(tasks))
	}
	sort.Float64s(lats)
	if len(lats) > 0 {
		res.P95MS = lats[minInt(len(lats)-1, int(float64(len(lats))*0.95))]
	}

	var savings []float64
	for _, r := range valid {
		line, ok := r.Payload.(string)
		if !ok {
			continue
		}
		savings = append(savings, tokenSavings(line, r.Task.Prose))
	}
	if len(savings) > 0 {
		total := 0.0
		for _, s := range savings {
			total += s
		}
		res.MeanSavings = total / float64(len(savings))
	}

	if opts.Judge && len(valid) > 0 {
		judgeSchema := map[string]any{
			"type":       "object",
			"properties": map[string]any{"score": map[string]any{"type": "number", "minimum": 1, "maximum": 10}},
			"required":   []any{"score"},
		}
		judgeClient := c
		if opts.JudgeModel != "" && opts.JudgeModel != c.Model {
			judgeClient = NewOllamaClient(c.BaseURL, opts.JudgeModel, c.HTTP.Timeout)
		}
		judgeRows := mapLimit(valid, opts.Concurrency, func(r Row) judgeOutcome {
			line, ok := r.Payload.(string)
			if !ok {
				return judgeOutcome{score: 0, err: errors.New("judge: payload not a line")}
			}
			roundtrip := Expand(line)
			raw, err := judgeClient.Chat(
				[]Message{
					{Role: "system", Content: "You are an impartial judge. Compare the ORIGINAL task and its ROUNDTRIPPED version. Rate intent preservation from 1 to 10. Reply with JSON {\"score\": number} only."},
					{Role: "user", Content: "ORIGINAL:\n" + r.Task.Prose + "\n\nROUNDTRIPPED:\n" + roundtrip},
				},
				judgeSchema,
			)
			if err != nil {
				return judgeOutcome{score: 0, err: err}
			}
			obj, ok := raw.(map[string]any)
			if !ok {
				return judgeOutcome{score: 0, err: errors.New("judge: not an object")}
			}
			score, ok := obj["score"].(float64)
			if !ok || score < 1 || score > 10 {
				return judgeOutcome{score: 0, err: errors.New("judge: bad score")}
			}
			return judgeOutcome{score: int(score)}
		})
		var scores []int
		for _, jr := range judgeRows {
			if jr.score > 0 {
				scores = append(scores, jr.score)
				res.Judged++
			} else {
				res.JudgeFailed++
			}
		}
		if len(scores) > 0 {
			total := 0
			preserved := 0
			for _, s := range scores {
				total += s
				if s >= 8 {
					preserved++
				}
			}
			res.Fidelity = float64(preserved) / float64(len(scores))
			res.MeanScore = float64(total) / float64(len(scores))
		}
	}

	for _, r := range rows {
		if !r.OK {
			if strings.Contains(r.Err, "ollama") || strings.Contains(r.Err, "HTTP") {
				res.TransportErrors++
			} else {
				res.InvalidPayloads++
			}
		}
	}
	return res
}

type judgeOutcome struct {
	score int
	err   error
}

// mapLimit runs fn over items with a fixed concurrency pool.
func mapLimit[T any, R any](items []T, limit int, fn func(T) R) []R {
	out := make([]R, len(items))
	if len(items) == 0 {
		return out
	}
	var wg sync.WaitGroup
	idx := make(chan int, len(items))
	for i := range items {
		idx <- i
	}
	close(idx)
	limit = minInt(limit, len(items))
	for w := 0; w < limit; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range idx {
				out[i] = fn(items[i])
			}
		}()
	}
	wg.Wait()
	return out
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
