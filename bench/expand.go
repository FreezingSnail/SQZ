// SQZ expand (SQZ → prose) — Go mirror of src/translator.ts expand().
// Used for the MT-Bench-style LLM-judge roundtrip in the fidelity gate.

package bench

import (
	"fmt"
	"strings"
)

var modeTemplates = map[string]string{
	"refactor": "Refactor {files} in {lang}.",
	"api":      "Implement API for {files} in {lang}.",
	"debug":    "Debug {files} in {lang}.",
	"docs":     "Write docs for {files} in {lang}.",
	"test":     "Write tests for {files} in {lang}.",
	"review":   "Review {files} in {lang}.",
	"arch":     "Architect {files} in {lang}.",
	"general":  "Task on {files} in {lang}.",
}

var clauseTemplates = map[string]func(string) string{
	"≋": func(op string) string { return "Preserve behavior: " + strings.TrimSpace(op) + "." },
	"Δ": func(op string) string { return "Change files: " + strings.TrimSpace(op) + "." },
	"∂": func(op string) string { return "Handle edge cases: " + strings.TrimSpace(op) + "." },
	"μ": func(string) string { return "Minimal diff." },
	"⌁": func(op string) string { return "Coverage: " + strings.TrimSpace(op) + "." },
	"→": func(op string) string { return "Pipeline: " + strings.TrimSpace(op) + "." },
	"✓": func(op string) string { return "Verified: " + strings.TrimSpace(op) + "." },
	"⏭": func(op string) string { return "Skip: " + strings.TrimSpace(op) + "." },
}

var glyphs = []string{"Δ", "≋", "∂", "μ", "⌁", "→", "✓", "⏭"}

// renderClause expands a symbol clause; unknown/misplaced symbols render
// literally (lossless policy, same as the TS core).
func renderClause(clause string) string {
	trimmed := strings.TrimSpace(clause)
	for _, g := range glyphs {
		if strings.Contains(trimmed, g) && !strings.HasPrefix(trimmed, g) {
			return trimmed
		}
	}
	for _, g := range glyphs {
		if strings.HasPrefix(trimmed, g) {
			if t, ok := clauseTemplates[g]; ok {
				return t(trimmed[len(g):])
			}
			return trimmed
		}
	}
	return trimmed
}

// Expand renders a validated SQZ payload back to prose.
func Expand(payload any) string {
	obj, ok := payload.(map[string]any)
	if !ok {
		return fmt.Sprintf("%v", payload)
	}
	mode, _ := obj["mode"].(string)
	tmpl, ok := modeTemplates[mode]
	if !ok {
		tmpl = modeTemplates["general"]
	}
	var files []string
	if target, ok := obj["target"].(map[string]any); ok {
		for _, f := range target["files"].([]any) {
			if s, ok := f.(string); ok {
				files = append(files, s)
			}
		}
		lang, _ := target["lang"].(string)
		tmpl = strings.ReplaceAll(tmpl, "{lang}", lang)
	}
	tmpl = strings.ReplaceAll(tmpl, "{files}", strings.Join(files, ", "))

	parts := []string{tmpl}
	if cons, ok := obj["constraints"].([]any); ok {
		for _, c := range cons {
			if s, ok := c.(string); ok {
				parts = append(parts, renderClause(s))
			}
		}
	}
	if verb, ok := obj["verbatim"].([]any); ok {
		for _, v := range verb {
			if s, ok := v.(string); ok {
				parts = append(parts, s)
			}
		}
	}
	return strings.Join(parts, "\n")
}
