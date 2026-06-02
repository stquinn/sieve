package sieve

import (
	"encoding/json"
	"regexp"
	"strings"
)

// knownLanguages is the set of language names this system recognises.
// A hint that is in this set is trusted directly without pattern matching.
var knownLanguages = map[string]bool{
	"python": true, "go": true, "javascript": true, "typescript": true,
	"rust": true, "java": true, "kotlin": true, "dart": true,
	"swift": true, "c": true, "cpp": true, "sql": true,
	"bash": true, "sh": true, "shell": true, "yaml": true, "json": true,
	"xml": true, "html": true, "css": true, "ruby": true, "php": true,
	"mermaid": true, "plantuml": true, "text": true,
}

// tier1 patterns are unambiguous single signals — one match is decisive.
var tier1 = []struct {
	re   *regexp.Regexp
	lang string
}{
	// JSON
	{regexp.MustCompile(`(?s)^\s*[\[{].*[\]}]\s*$`), "json_candidate"}, // handled separately
	// Kubernetes YAML (unambiguous field combo)
	{regexp.MustCompile(`(?m)^apiVersion:\s*\S+`), "yaml"},
	// Go
	{regexp.MustCompile(`(?m)^package\s+\w+`), "go"},
	{regexp.MustCompile(`(?m)^type\s+\w+\s+struct\s*\{`), "go"},
	{regexp.MustCompile(`(?m)^type\s+\w+\s+interface\s*\{`), "go"},
	{regexp.MustCompile("(?m)`(?:json|yaml|db|bson|form|validate):\"[^\"]*\"`"), "go"},
	{regexp.MustCompile(`(?m)^import\s+\(`), "go"},
	// Java
	{regexp.MustCompile(`(?m)^public\s+(?:class|interface|enum|abstract\s+class)\s+\w+`), "java"},
	{regexp.MustCompile(`\bpublic\s+static\s+void\s+main\s*\(\s*String`), "java"},
	{regexp.MustCompile(`(?m)^import\s+java\.`), "java"},
	{regexp.MustCompile(`(?m)^import\s+(?:org|com)\.\w+\.\w+`), "java"},
	// Dart / Flutter
	{regexp.MustCompile(`(?m)^import\s+'(?:package:flutter|dart:)`), "dart"},
	{regexp.MustCompile(`\bextends\s+(?:StatefulWidget|StatelessWidget|State)\b`), "dart"},
	// Python
	{regexp.MustCompile(`(?m)^\s*def\s+\w+\s*\(.*\)\s*:`), "python"},
	// SQL
	{regexp.MustCompile(`(?i)^\s*SELECT\s+.+\bFROM\b`), "sql"},
	{regexp.MustCompile(`(?i)^\s*(?:INSERT\s+INTO|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE)\b`), "sql"},
	// Bash shebang
	{regexp.MustCompile(`^#!.*(?:bash|sh|zsh)\b`), "bash"},
	// TypeScript (must be before JS — more specific)
	{regexp.MustCompile(`(?m)^(?:export\s+)?interface\s+\w+\s*\{`), "typescript"},
	{regexp.MustCompile(`(?m)^(?:export\s+)?type\s+\w+\s*=`), "typescript"},
}

// tier2 patterns require 2+ hits to be confident (weaker individual signals).
var tier2 = []struct {
	re   *regexp.Regexp
	lang string
}{
	{regexp.MustCompile(`\bfunc\s+\(\s*\w+\s+\*?\w+\s*\)\s+\w+\s*\(`), "go"},
	{regexp.MustCompile(`\bfunc\s+\w+\s*\(`), "go"},
	{regexp.MustCompile(`:=\s`), "go"},
	{regexp.MustCompile(`\bfmt\.\w+\(`), "go"},
	{regexp.MustCompile(`\berr\s*!=\s*nil\b`), "go"},
	{regexp.MustCompile(`@(?:Override|SpringBootApplication|Component|Service|Repository|Controller|Autowired|Bean|Test)\b`), "java"},
	{regexp.MustCompile(`\bthrows\s+\w+(?:Exception|Error)\b`), "java"},
	{regexp.MustCompile(`\bSystem\.out\.print`), "java"},
	{regexp.MustCompile(`\bnew\s+\w+\(.*\);`), "java"},
	{regexp.MustCompile(`\bScaffold\s*\(`), "dart"},
	{regexp.MustCompile(`\bColumn\s*\(\s*children:`), "dart"},
	{regexp.MustCompile(`\bfinal\s+\w+\s+\w+\s*=`), "dart"},
	{regexp.MustCompile(`\bconst\s+\w+\s+\w+\s*=`), "typescript"},
	{regexp.MustCompile(`:\s*(?:string|number|boolean|any)\b`), "typescript"},
}

// detectByHeuristics returns the detected language and true if confident,
// or ("", false) if no strong signal was found.
// hint is the fence info string (e.g. "python" from ```python). If it is a
// known language name it is trusted unconditionally — no pattern matching needed.
func detectByHeuristics(source, hint string) (string, bool) {
	h := strings.ToLower(strings.TrimSpace(hint))
	if h != "" && knownLanguages[h] {
		return h, true
	}

	trimmed := strings.TrimSpace(source)
	if trimmed == "" {
		return "", false
	}

	// JSON: try parse before regex to avoid false positives
	if (strings.HasPrefix(trimmed, "{") && strings.HasSuffix(trimmed, "}")) ||
		(strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]")) {
		var v interface{}
		if json.Unmarshal([]byte(trimmed), &v) == nil {
			return "json", true
		}
	}

	// Tier 1: single unambiguous match
	for _, rule := range tier1 {
		if rule.lang == "json_candidate" {
			continue // handled above
		}
		if rule.re.MatchString(trimmed) {
			return rule.lang, true
		}
	}

	// Tier 2: need 2+ hits per language
	hits := map[string]int{}
	for _, rule := range tier2 {
		if rule.re.MatchString(trimmed) {
			hits[rule.lang]++
		}
	}
	for lang, count := range hits {
		if count >= 2 {
			return lang, true
		}
	}

	return "", false
}
