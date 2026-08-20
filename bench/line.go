// SQZ v2 line grammar — Go mirror of src/line.ts (tokenizer + validator).
// The wire format is ONE plain line: <mode> Δ["f1","f2"] [L:<lang>]
// <symbol>[operand]... v"verbatim clause"... — no JSON envelope.

package bench

import "strings"

// LineClause is one symbol clause in a SQZ line.
type LineClause struct {
	Symbol  string
	Operand string
}

// LineAST is the parsed form of a SQZ line.
type LineAST struct {
	Mode     string
	Files    []string
	Lang     string
	Clauses  []LineClause
	Verbatim []string
	Errors   []string
}

var lineGlyphs = []rune{'Δ', '≋', '∂', 'μ', '⌁', '→', '✓', '⏭'}

func isLineGlyphRune(r rune) bool {
	for _, g := range lineGlyphs {
		if r == g {
			return true
		}
	}
	return false
}

// readLineQuoted reads a "..." quoted string starting at rs[i] (the quote).
func readLineQuoted(rs []rune, i int, errors *[]string) (string, int) {
	var out strings.Builder
	j := i + 1
	for j < len(rs) {
		ch := rs[j]
		if ch == '\\' && j+1 < len(rs) {
			out.WriteRune(rs[j+1])
			j += 2
			continue
		}
		if ch == '"' {
			return out.String(), j + 1
		}
		out.WriteRune(ch)
		j++
	}
	*errors = append(*errors, "unterminated quote")
	return out.String(), len(rs)
}

// readLineGroup reads a [..] or (..) balanced group starting at rs[i].
func readLineGroup(rs []rune, i int, errors *[]string) (string, int) {
	open := rs[i]
	close := rune(']')
	if open == '(' {
		close = ')'
	}
	depth := 0
	var inner strings.Builder
	for j := i; j < len(rs); j++ {
		ch := rs[j]
		if ch == '"' {
			q, next := readLineQuoted(rs, j, errors)
			inner.WriteRune('"')
			inner.WriteString(q)
			inner.WriteRune('"')
			j = next - 1
			continue
		}
		if ch == open {
			depth++
			if depth > 1 {
				inner.WriteRune(ch)
			}
			continue
		}
		if ch == close {
			depth--
			if depth == 0 {
				return inner.String(), j + 1
			}
			inner.WriteRune(ch)
			continue
		}
		inner.WriteRune(ch)
	}
	*errors = append(*errors, "unbalanced "+string(open))
	return inner.String(), len(rs)
}

// splitLineFiles splits a Δ[...] group inner into file strings.
func splitLineFiles(inner string) []string {
	rs := []rune(inner)
	var parts []string
	var cur strings.Builder
	i := 0
	for i < len(rs) {
		ch := rs[i]
		if ch == '"' {
			var errs []string
			q, next := readLineQuoted(rs, i, &errs)
			parts = append(parts, q)
			i = next
			continue
		}
		if ch == ',' {
			if strings.TrimSpace(cur.String()) != "" {
				parts = append(parts, strings.TrimSpace(cur.String()))
			}
			cur.Reset()
			i++
			continue
		}
		cur.WriteRune(ch)
		i++
	}
	if strings.TrimSpace(cur.String()) != "" {
		parts = append(parts, strings.TrimSpace(cur.String()))
	}
	return parts
}

func isSpaceRune(r rune) bool { return r == ' ' || r == '\t' }
func isStopRune(r rune) bool {
	return isSpaceRune(r) || r == '"' || r == '[' || r == ']' || r == '(' || r == ')'
}

// ParseLine tokenizes a v2 SQZ line into an AST. Never panics, never loops.
func ParseLine(line string, knownSymbols map[string]bool) LineAST {
	ast := LineAST{}
	rs := []rune(strings.TrimSpace(line))
	i := 0
	for i < len(rs) {
		ch := rs[i]
		if isSpaceRune(ch) {
			i++
			continue
		}

		// Verbatim segment: v"raw prose"
		if ch == 'v' && i+1 < len(rs) && rs[i+1] == '"' {
			q, next := readLineQuoted(rs, i+1, &ast.Errors)
			ast.Verbatim = append(ast.Verbatim, q)
			i = next
			continue
		}

		// Stray quoted string — flag it.
		if ch == '"' {
			q, next := readLineQuoted(rs, i, &ast.Errors)
			ast.Errors = append(ast.Errors, `stray quoted token "`+q+`"`)
			i = next
			continue
		}

		// Glyph (possibly with bracket/paren operand).
		if isLineGlyphRune(ch) {
			j := i + 1
			for j < len(rs) && !isStopRune(rs[j]) {
				j++
			}
			symbol := string(rs[i:j])
			if j < len(rs) && (rs[j] == '[' || rs[j] == '(') {
				inner, next := readLineGroup(rs, j, &ast.Errors)
				if symbol == "Δ" && len(ast.Files) == 0 {
					ast.Files = splitLineFiles(inner)
					if len(ast.Files) == 0 {
						ast.Errors = append(ast.Errors, "Δ target has no files")
					}
				} else {
					ast.Clauses = append(ast.Clauses, LineClause{Symbol: symbol, Operand: strings.TrimSpace(inner)})
				}
				i = next
				continue
			}
			if !knownSymbols[symbol] {
				ast.Errors = append(ast.Errors, "unknown symbol "+symbol)
			}
			ast.Clauses = append(ast.Clauses, LineClause{Symbol: symbol})
			i = j
			continue
		}

		// Lang token: L:<token>
		if ch == 'L' && i+1 < len(rs) && rs[i+1] == ':' {
			j := i + 2
			for j < len(rs) && !isSpaceRune(rs[j]) {
				j++
			}
			lang := string(rs[i+2 : j])
			if lang != "" {
				ast.Lang = lang
			} else {
				ast.Errors = append(ast.Errors, "L: has no lang token")
			}
			i = j
			continue
		}

		// Bare word — first one must be a valid mode.
		j := i
		for j < len(rs) && !isStopRune(rs[j]) {
			j++
		}
		if j == i {
			// Stray structural char ([ ] ( )): skip it, flag it — never loop.
			ast.Errors = append(ast.Errors, `unexpected token "`+string(rs[i])+`"`)
			i++
			continue
		}
		word := string(rs[i:j])
		if ast.Mode == "" && modes[word] {
			ast.Mode = word
			i = j
			continue
		}
		ast.Errors = append(ast.Errors, `unexpected token "`+word+`"`)
		i = j
	}
	if ast.Mode == "" {
		ast.Errors = append(ast.Errors, "missing mode")
	}
	if len(ast.Files) == 0 {
		ast.Errors = append(ast.Errors, "missing Δ target")
	}
	return ast
}

// ValidateLine checks a v2 SQZ line against the lexicon symbol set.
func ValidateLine(line string, knownSymbols map[string]bool) (bool, []string) {
	ast := ParseLine(line, knownSymbols)
	if len(ast.Errors) > 0 {
		return false, ast.Errors
	}
	return true, nil
}

// lineKnownSymbols builds the lexicon symbol whitelist used for validation.
func lineKnownSymbols() map[string]bool {
	m := make(map[string]bool, len(lineGlyphs))
	for _, g := range lineGlyphs {
		m[string(g)] = true
	}
	return m
}
