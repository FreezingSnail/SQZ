// SQZ expand (SQZ line → prose) — Go mirror of src/translator.ts expand() (v2).
// Used for the MT-Bench-style LLM-judge roundtrip in the fidelity gate.
// Wire format: plain SQZ line, no JSON envelope.

package bench

import "strings"

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
	"≋": func(op string) string {
		if strings.TrimSpace(op) == "" {
			return "Preserve behavior: same as before."
		}
		return "Preserve behavior: " + strings.TrimSpace(op) + "."
	},
	"Δ": func(op string) string { return "Change files: " + strings.TrimSpace(op) + "." },
	"∂": func(op string) string {
		if strings.TrimSpace(op) == "" {
			return "Handle edge cases: edge cases."
		}
		return "Handle edge cases: " + strings.TrimSpace(op) + "."
	},
	"μ": func(string) string { return "Minimal diff." },
	"⌁": func(op string) string {
		if strings.TrimSpace(op) == "" {
			return "Coverage: complete."
		}
		return "Coverage: " + strings.TrimSpace(op) + "."
	},
	"→": func(op string) string { return "Pipeline: " + strings.TrimSpace(op) + "." },
	"✓": func(op string) string {
		if strings.TrimSpace(op) == "" {
			return "Verified: acceptance criteria."
		}
		return "Verified: " + strings.TrimSpace(op) + "."
	},
	"⏭": func(op string) string {
		if strings.TrimSpace(op) == "" {
			return "Skip: leave untouched."
		}
		return "Skip: " + strings.TrimSpace(op) + "."
	},
}

// renderLineClause expands a symbol clause; unknown symbols render literally.
func renderLineClause(c LineClause) string {
	if t, ok := clauseTemplates[c.Symbol]; ok {
		return t(c.Operand)
	}
	if c.Operand != "" {
		return c.Symbol + " " + c.Operand
	}
	return c.Symbol
}

// Expand renders a validated SQZ line back to prose.
func Expand(line string) string {
	ast := ParseLine(line, lineKnownSymbols())
	if ast.Mode == "" && len(ast.Files) == 0 && len(ast.Verbatim) == 0 {
		return line // not SQZ at all: untouched (lossless invariant)
	}
	tmpl, ok := modeTemplates[ast.Mode]
	if !ok {
		tmpl = modeTemplates["general"]
	}
	files := "-"
	if len(ast.Files) > 0 {
		files = strings.Join(ast.Files, ", ")
	}
	lang := ast.Lang
	if lang == "" {
		lang = "text"
	}
	tmpl = strings.ReplaceAll(tmpl, "{files}", files)
	tmpl = strings.ReplaceAll(tmpl, "{lang}", lang)

	parts := []string{tmpl}
	for _, c := range ast.Clauses {
		parts = append(parts, renderLineClause(c))
	}
	for _, v := range ast.Verbatim {
		parts = append(parts, v)
	}
	return strings.Join(parts, "\n")
}
