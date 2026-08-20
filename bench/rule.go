// RuleProvider mirror — deterministic, no-model compression to a SQZ line.
// Go port of src/providers.ts encodeLine() (v2). Never fails: unencodable
// clauses go into v"..." verbatim segments.

package bench

import (
	"regexp"
	"strings"
)

var ruleFileRE = regexp.MustCompile(`[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|rb|java|swift|c|h|cpp|hpp|sh|yml|yaml|toml|css|html)`)

var ruleTriggers = map[string][]string{
	"Δ": {"may modify", "modify file", "change file", "touch", "edit file"},
	"≋": {"preserve", "same behavior", "behavior(new)", "behavior(old)", "equivalent", "behavior"},
	"∂": {"edge case", "edge-case"},
	"μ": {"minimal diff", "smallest change", "minimal change", "minimal"},
	"⌁": {"complete coverage", "all paths", "all branches", "all cases", "coverage"},
	"→": {"pipeline", "stages", "stage", "sequence", "then"},
	"✓": {"verified", "verify", "checked", "acceptance criteria"},
	"⏭": {"skip", "leave untouched", "ignore", "omit", "do not touch"},
}

var ruleModeKeywords = []struct {
	mode     string
	keywords []string
}{
	{"refactor", []string{"refactor", "rewrite"}},
	{"api", []string{"api", "endpoint"}},
	{"debug", []string{"debug", "bug"}},
	{"docs", []string{"documentation", "docs"}},
	{"test", []string{"test", "tests", "testing"}},
	{"review", []string{"review"}},
	{"arch", []string{"architecture", "architect"}},
}

var ruleEdgeWords = []string{"empty", "null", "overflow", "boundary", "invalid", "error", "missing"}
var rulePipelineWords = []string{"lint", "build", "test", "typecheck", "deploy", "publish"}

func ruleDetectMode(prose string) string {
	lower := strings.ToLower(prose)
	for _, pair := range ruleModeKeywords {
		for _, k := range pair.keywords {
			if strings.Contains(lower, k) {
				return pair.mode
			}
		}
	}
	return "general"
}

func ruleDetectFiles(prose string) []string {
	seen := map[string]bool{}
	var out []string
	for _, f := range ruleFileRE.FindAllString(prose, -1) {
		if !seen[f] {
			seen[f] = true
			out = append(out, f)
		}
	}
	return out
}

func ruleHasAny(prose string, words []string) bool {
	lower := strings.ToLower(prose)
	for _, w := range words {
		if strings.Contains(lower, w) {
			return true
		}
	}
	return false
}

func ruleMatchedTrigger(prose string, symbol string) (string, bool) {
	lower := strings.ToLower(prose)
	for _, t := range ruleTriggers[symbol] {
		if strings.Contains(lower, t) {
			return t, true
		}
	}
	return "", false
}

func ruleClause(symbol, prose string) (LineClause, bool) {
	lower := strings.ToLower(prose)
	if _, ok := ruleMatchedTrigger(prose, symbol); !ok {
		return LineClause{}, false
	}
	switch symbol {
	case "≋":
		return LineClause{Symbol: "≋", Operand: "behavior(new) = behavior(old)"}, true
	case "∂":
		var found []string
		for _, w := range ruleEdgeWords {
			if strings.Contains(lower, w) {
				found = append(found, w)
			}
		}
		if len(found) == 0 {
			found = []string{"edge cases"}
		}
		return LineClause{Symbol: "∂", Operand: strings.Join(found, ", ")}, true
	case "μ":
		return LineClause{Symbol: "μ"}, true
	case "⌁":
		return LineClause{Symbol: "⌁", Operand: "all"}, true
	case "→":
		var steps []string
		for _, w := range rulePipelineWords {
			if strings.Contains(lower, w) {
				steps = append(steps, w)
			}
		}
		if len(steps) == 0 {
			steps = []string{"lint", "build", "test"}
		}
		return LineClause{Symbol: "→", Operand: strings.Join(steps, " → ")}, true
	case "✓":
		return LineClause{Symbol: "✓", Operand: "examples run"}, true
	case "⏭":
		re := regexp.MustCompile(`(?:skip|ignore|leave untouched|omit|do not touch)\s+([\w./-]+)`)
		if m := re.FindStringSubmatch(lower); m != nil {
			return LineClause{Symbol: "⏭", Operand: m[1]}, true
		}
		return LineClause{Symbol: "⏭", Operand: "vendor/"}, true
	}
	return LineClause{}, false
}

func ruleVerbatim(prose, mode string, files []string, used map[string]bool) []string {
	var chunks []string
	for _, c := range strings.FieldsFunc(prose, func(r rune) bool { return r == '.' || r == ';' || r == '\n' }) {
		if t := strings.TrimSpace(c); t != "" {
			chunks = append(chunks, t)
		}
	}
	var modeKeywords []string
	for _, pair := range ruleModeKeywords {
		if pair.mode == mode {
			modeKeywords = pair.keywords
		}
	}
	var out []string
	for _, chunk := range chunks {
		cl := strings.ToLower(chunk)
		isFileFragment := false
		for _, f := range files {
			if strings.Contains(cl, strings.ToLower(f)) || strings.Contains(strings.ToLower(f), strings.TrimSpace(cl)) {
				isFileFragment = true
				break
			}
		}
		matched := isFileFragment || ruleFileRE.MatchString(chunk)
		if !matched {
			for t := range used {
				if strings.Contains(cl, t) {
					matched = true
					break
				}
			}
		}
		if !matched {
			for _, k := range modeKeywords {
				if strings.Contains(cl, k) {
					matched = true
					break
				}
			}
		}
		if !matched {
			out = append(out, chunk)
		}
	}
	return out
}

func escapeVerbatimGo(text string) string {
	text = strings.ReplaceAll(text, "\\", "\\\\")
	return strings.ReplaceAll(text, `"`, `\"`)
}

// EncodeLine compresses prose into a v2 SQZ line deterministically.
func EncodeLine(prose string) string {
	if prose == "" {
		return `general Δ["-"] L:text`
	}
	mode := ruleDetectMode(prose)
	files := ruleDetectFiles(prose)
	if len(files) == 0 {
		files = []string{"-"}
	}

	used := map[string]bool{}
	var clauses []LineClause
	for _, symbol := range []string{"≋", "∂", "μ", "⌁", "→", "✓", "⏭"} {
		if c, ok := ruleClause(symbol, prose); ok {
			clauses = append(clauses, c)
			if t, ok := ruleMatchedTrigger(prose, symbol); ok {
				used[t] = true
			}
		}
	}
	verbatim := ruleVerbatim(prose, mode, files, used)

	var b strings.Builder
	b.WriteString(mode)
	b.WriteString(" Δ[")
	for i, f := range files {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`"` + f + `"`)
	}
	b.WriteString("] L:ts")
	for _, c := range clauses {
		if c.Operand != "" {
			b.WriteString(" " + c.Symbol + "[" + c.Operand + "]")
		} else {
			b.WriteString(" " + c.Symbol)
		}
	}
	for _, v := range verbatim {
		b.WriteString(` v"` + escapeVerbatimGo(v) + `"`)
	}
	return b.String()
}
