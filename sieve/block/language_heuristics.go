package block

import (
	"encoding/json"
	"regexp"
	"strings"
)

// CanonicalLanguages maps language hints or aliases to their canonical, lowercase names.
var CanonicalLanguages = map[string]string{
	"python":     "python",
	"py":         "python",
	"go":         "go",
	"golang":     "go",
	"javascript": "javascript",
	"js":         "javascript",
	"typescript": "typescript",
	"ts":         "typescript",
	"rust":       "rust",
	"rs":         "rust",
	"java":       "java",
	"kotlin":     "kotlin",
	"kt":         "kotlin",
	"dart":       "dart",
	"swift":      "swift",
	"c":          "c",
	"cpp":        "cpp",
	"c++":        "cpp",
	"h":          "c",
	"hpp":        "cpp",
	"csharp":     "csharp",
	"cs":         "csharp",
	"sql":        "sql",
	"bash":       "bash",
	"sh":         "bash",
	"shell":      "bash",
	"zsh":        "bash",
	"yaml":       "yaml",
	"yml":        "yaml",
	"json":       "json",
	"toml":       "toml",
	"ini":        "ini",
	"dockerfile": "dockerfile",
	"docker":     "dockerfile",
	"makefile":   "makefile",
	"make":       "makefile",
	"lua":        "lua",
	"powershell": "powershell",
	"ps1":        "powershell",
	"xml":        "xml",
	"html":       "html",
	"css":        "css",
	"ruby":       "ruby",
	"rb":         "ruby",
	"php":        "php",
	"markdown":   "markdown",
	"md":         "markdown",
	"mermaid":    "mermaid",
	"plantuml":   "plantuml",
	"text":       "text",
	"txt":        "text",
}

// KnownLanguages is the set of canonical language names this system recognises.
// A hint that is in this set is trusted directly without pattern matching.
var KnownLanguages = map[string]bool{
	"python": true, "go": true, "javascript": true, "typescript": true,
	"rust": true, "java": true, "kotlin": true, "dart": true,
	"swift": true, "c": true, "cpp": true, "sql": true,
	"bash": true, "sh": true, "shell": true, "yaml": true, "json": true,
	"xml": true, "html": true, "css": true, "ruby": true, "php": true,
	"mermaid": true, "plantuml": true, "text": true,
	"markdown": true, "csharp": true, "toml": true, "ini": true,
	"dockerfile": true, "makefile": true, "lua": true, "powershell": true,
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
	// A Go package clause is a single bare identifier on its own line ("package
	// main"). Anchoring to end-of-line keeps this from matching Java/Kotlin's
	// dotted, semicolon-terminated "package com.example;" — which, sitting above
	// the Java rules, used to steal every package-led Java file as Go.
	{regexp.MustCompile(`(?m)^package\s+\w+\s*(?://.*)?$`), "go"},
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
	{regexp.MustCompile(`(?i)(?m)^\s*SELECT\s+.+\bFROM\b`), "sql"},
	{regexp.MustCompile(`(?i)(?m)^\s*(?:INSERT\s+INTO|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE)\b`), "sql"},
	// Bash shebang
	{regexp.MustCompile(`^#!.*(?:bash|sh|zsh)\b`), "bash"},
	// TypeScript (must be before JS — more specific)
	{regexp.MustCompile(`(?m)^(?:export\s+)?interface\s+\w+\s*\{`), "typescript"},
	{regexp.MustCompile(`(?m)^(?:export\s+)?type\s+\w+\s*=`), "typescript"},
	// Markdown (Tier 1 unambiguous)
	{regexp.MustCompile(`(?m)^[\t ]*\|(?:\s*:?-+:?\s*\|)+\s*$`), "markdown"},
	{regexp.MustCompile(`\[[^\]\n]+\]\(https?://[^"'\s)]+\)`), "markdown"},
	{regexp.MustCompile(`(?m)^[\t ]*[-*+]\s+.+\n[\t ]*[-*+]\s+`), "markdown"},
	{regexp.MustCompile(`(?m)^[\t ]*\d+\.\s+.+\n[\t ]*\d+\.\s+`), "markdown"},
	{regexp.MustCompile("(?m)^\\x60{3,4}[a-zA-Z0-9_-]*\\r?\\n"), "markdown"},
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
	// Markdown (Tier 2 signals)
	{regexp.MustCompile(`(?m)^##+\s+`), "markdown"},
	{regexp.MustCompile(`(?m)^>\s+`), "markdown"},
	{regexp.MustCompile(`(?m)\*\*([^\*\n]+)\*\*|__([^\_\n]+)__`), "markdown"},
	{regexp.MustCompile(`(?m)\\x60([^\\x60\\n]+)\\x60`), "markdown"},
	{regexp.MustCompile(`(?m)!\[([^\]\n]*)\]\([^)\n]+\)`), "markdown"},
}

// LooksLikeCode is the tier-3 gate. It returns true when source has structural
// signals that make it code-likely, even when no specific language can be
// identified. This preserves the original paste-pipeline behaviour where:
//   - tier 1/2 → language identified → code block
//   - tier 3   → structurally code   → code block (AI detects language)
//   - tier 4   → no signals          → plain text, falls through to TipTap
//
// Mirrors the JS tier-3 check: braceCount>2 || semicolonCount>2 ||
// anyWeakSignal || indentedLines > 40% of total lines.
func LooksLikeCode(source string) bool {
	trimmed := strings.TrimSpace(source)
	lines := strings.Split(trimmed, "\n")
	if len(lines) <= 2 {
		return false // too short to be confident
	}

	braceCount := strings.Count(trimmed, "{") + strings.Count(trimmed, "}")
	semicolonCount := strings.Count(trimmed, ";")

	indented := 0
	for _, line := range lines {
		if len(line) >= 2 && (line[0] == ' ' || line[0] == '\t') {
			indented++
		}
	}

	// Any single tier2 hit is a weak signal worth acting on
	anyWeakSignal := false
	for _, rule := range tier2 {
		if rule.re.MatchString(trimmed) {
			anyWeakSignal = true
			break
		}
	}

	// indented > 40% of lines  →  indented*10 > len(lines)*4
	return braceCount > 2 || semicolonCount > 2 || anyWeakSignal || indented*10 > len(lines)*4
}

// IsConfidentLanguage reports whether lang names a specific programming language
// rather than a non-answer. "", "unknown" and "text" are non-answers: a detector
// returning one of them has DECLINED to identify the content. A non-answer must
// never overwrite a confident language (whoever produced it), and must never be
// treated as sticky against re-detection — so a replay after the user adds content
// is free to take the newly detected language.
func IsConfidentLanguage(lang string) bool {
	switch strings.ToLower(strings.TrimSpace(lang)) {
	case "", "unknown", "text":
		return false
	}
	return true
}

// DetectByHeuristics returns the detected language and true if confident,
// or ("", false) if no strong signal was found.
// hint is the fence info string (e.g. "python" from ```python). If it is a
// known language name it is trusted unconditionally — no pattern matching needed.
func DetectByHeuristics(source, hint string) (string, bool) {
	h := strings.ToLower(strings.TrimSpace(hint))
	if h != "" {
		if canonical, ok := CanonicalLanguages[h]; ok {
			return canonical, true
		}
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
