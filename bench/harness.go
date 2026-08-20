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

// validatePayload is the Go mirror of src/validate.ts (SQZPayload v1).
func validatePayload(v any) (bool, []string) {
	var errs []string
	obj, ok := v.(map[string]any)
	if !ok {
		return false, []string{"/ type must be object"}
	}
	if n, ok := obj["v"].(float64); !ok || n != 1 {
		errs = append(errs, "/v must be 1")
	}
	if m, ok := obj["mode"].(string); !ok || !modes[m] {
		errs = append(errs, "/mode invalid")
	}
	target, ok := obj["target"].(map[string]any)
	if !ok {
		errs = append(errs, "/target type must be object")
	} else {
		if files, ok := target["files"].([]any); !ok || len(files) == 0 {
			errs = append(errs, "/target/files must be non-empty array")
		} else {
			for i, f := range files {
				if _, ok := f.(string); !ok || f.(string) == "" {
					errs = append(errs, fmt.Sprintf("/target/files/%d must be non-empty string", i))
				}
			}
		}
		if lang, ok := target["lang"].(string); !ok || lang == "" {
			errs = append(errs, "/target/lang must be non-empty string")
		}
	}
	if arr, ok := obj["constraints"].([]any); !ok {
		errs = append(errs, "/constraints type must be array")
	} else {
		for i, c := range arr {
			if _, ok := c.(string); !ok {
				errs = append(errs, fmt.Sprintf("/constraints/%d must be string", i))
			}
		}
	}
	if arr, ok := obj["verbatim"].([]any); !ok {
		errs = append(errs, "/verbatim type must be array")
	} else {
		for i, c := range arr {
			if _, ok := c.(string); !ok {
				errs = append(errs, fmt.Sprintf("/verbatim/%d must be string", i))
			}
		}
	}
	if c, ok := obj["confidence"].(float64); !ok || c < 0 || c > 1 {
		errs = append(errs, "/confidence must be number 0..1")
	}
	return len(errs) == 0, errs
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

// Chat posts to /api/chat with format=json. Returns the parsed JSON object or
// raw content string; errors on transport/HTTP/daemon-error.
func (c *OllamaClient) Chat(messages []Message, schema any) (any, error) {
	body, err := json.Marshal(map[string]any{
		"model":    c.Model,
		"messages": withSchemaPrompt(messages, schema),
		"format":   "json",
		"stream":   false,
		// Reasoning models (qwen3.5+) emit chain-of-thought by default; disable
		// it for low-latency structured output. Ignored by non-thinking models.
		"think":     false,
		"keep_alive": "30m", // hold the model in memory across the 100-task run (avoid reload stalls)
		"options":   map[string]any{"temperature": 0},
	})
	if err != nil {
		return nil, err
	}
	res, err := c.HTTP.Post(c.BaseURL+chatPath, "application/json", bytes.NewReader(body))
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
}

// fullSchema is the Go mirror of sqz-schema.json (SQZPayload v1). Passing the
// complete schema in the prompt is what lets a 1.7B model emit a valid payload;
// a minimal schema produces free-form JSON.
var fullSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"v":    map[string]any{"const": 1},
		"mode": map[string]any{"type": "string", "enum": []any{"refactor", "api", "debug", "docs", "test", "review", "arch", "general"}},
		"target": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"files": map[string]any{"type": "array", "items": map[string]any{"type": "string", "minLength": 1}, "minItems": 1},
				"lang":  map[string]any{"type": "string", "minLength": 1},
			},
			"required": []any{"files", "lang"},
		},
		"constraints": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
		"verbatim":    map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
		"confidence":  map[string]any{"type": "number", "minimum": 0, "maximum": 1},
	},
	"required": []any{"v", "mode", "target", "constraints", "verbatim", "confidence"},
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
		raw, err := c.Chat(
			[]Message{
				{Role: "system", Content: `{"task":"compress-prose-to-sqz","lexicon":[]}`},
				{Role: "user", Content: t.Prose},
			},
			fullSchema,
		)
		lat := time.Since(s)
		if err != nil {
			return Row{Task: t, OK: false, Latency: lat, Err: err.Error()}
		}
		valid, errs := validatePayload(raw)
		return Row{Task: t, OK: valid, Latency: lat, Payload: raw, Err: strings.Join(errs, "; ")}
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
		b, _ := json.Marshal(r.Payload)
		savings = append(savings, tokenSavings(string(b), r.Task.Prose))
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
			roundtrip := Expand(r.Payload)
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
