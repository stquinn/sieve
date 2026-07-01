package lang

import (
	"testing"
)

func TestDetectByHeuristics_json(t *testing.T) {
	lang, ok := DetectByHeuristics(`{"key": "value", "num": 42}`, "")
	if !ok || lang != "json" {
		t.Errorf("expected json/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_yamlK8s(t *testing.T) {
	src := "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: my-app"
	lang, ok := DetectByHeuristics(src, "")
	if !ok || lang != "yaml" {
		t.Errorf("expected yaml/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_go_tier1(t *testing.T) {
	lang, ok := DetectByHeuristics("package main\n\nfunc main() {}", "")
	if !ok || lang != "go" {
		t.Errorf("expected go/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_go_struct(t *testing.T) {
	lang, ok := DetectByHeuristics("type User struct {\n\tName string `json:\"name\"`\n}", "")
	if !ok || lang != "go" {
		t.Errorf("expected go/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_java_tier1(t *testing.T) {
	lang, ok := DetectByHeuristics("public class Foo {\n\tpublic static void main(String[] args) {}\n}", "")
	if !ok || lang != "java" {
		t.Errorf("expected java/true, got %q/%v", lang, ok)
	}
}

// A package-led Java class must NOT be claimed as Go. A Go package clause is a
// single bare identifier ("package main"); Java's is dotted with a semicolon
// ("package com.example;"). The old greedy `^package\s+\w+` matched both and,
// sitting above the Java rules, stole every package-led Java/Kotlin file as Go.
func TestDetectByHeuristics_javaWithPackage_notGo(t *testing.T) {
	java := "package com.example.demo;\n\nimport java.util.List;\nimport lombok.Getter;\n\n@Getter\npublic class Greeter {\n\tprivate final String name;\n}"
	lang, ok := DetectByHeuristics(java, "")
	if !ok || lang != "java" {
		t.Errorf("expected java/true for package-led Java, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_python(t *testing.T) {
	lang, ok := DetectByHeuristics("def greet(self):\n    return self.name", "")
	if !ok || lang != "python" {
		t.Errorf("expected python/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_sql(t *testing.T) {
	lang, ok := DetectByHeuristics("SELECT id, name FROM users WHERE active = 1", "")
	if !ok || lang != "sql" {
		t.Errorf("expected sql/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_bash_shebang(t *testing.T) {
	lang, ok := DetectByHeuristics("#!/bin/bash\necho hello", "")
	if !ok || lang != "bash" {
		t.Errorf("expected bash/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_typescript(t *testing.T) {
	lang, ok := DetectByHeuristics("export interface User {\n  name: string\n  age: number\n}", "")
	if !ok || lang != "typescript" {
		t.Errorf("expected typescript/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_hint_trusted(t *testing.T) {
	// A known hint bypasses pattern matching
	lang, ok := DetectByHeuristics("x = 1", "python")
	if !ok || lang != "python" {
		t.Errorf("expected python/true from hint, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_unknownHint_falls_through(t *testing.T) {
	// Unrecognised hint does not short-circuit; heuristics still run
	_, ok := DetectByHeuristics("x = 1", "weirdlang")
	// We don't assert lang here — just that it doesn't panic and returns a bool
	_ = ok
}

func TestDetectByHeuristics_noMatch(t *testing.T) {
	_, ok := DetectByHeuristics("hello world", "")
	if ok {
		t.Error("expected no match for plain prose")
	}
}

// ── LooksLikeCode ────────────────────────────────────────────────────────────

func TestLooksLikeCode_braces(t *testing.T) {
	src := "function foo() {\n  var x = 1\n  return x\n}"
	if !LooksLikeCode(src) {
		t.Error("expected braces to trigger tier-3")
	}
}

func TestLooksLikeCode_semicolons(t *testing.T) {
	src := "int x = 1;\nint y = 2;\nreturn x + y;"
	if !LooksLikeCode(src) {
		t.Error("expected semicolons to trigger tier-3")
	}
}

func TestLooksLikeCode_indentation(t *testing.T) {
	src := "if condition:\n    do_something()\n    do_more()\n    final_step()"
	if !LooksLikeCode(src) {
		t.Error("expected heavy indentation to trigger tier-3")
	}
}

func TestLooksLikeCode_weakSignal(t *testing.T) {
	// Single := hit — too weak for DetectByHeuristics but enough for LooksLikeCode
	src := "x := getValue()\nresult := process(x)\nreturn result"
	if !LooksLikeCode(src) {
		t.Error("expected single tier-2 weak signal to trigger tier-3")
	}
}

func TestLooksLikeCode_prose(t *testing.T) {
	src := "This is a normal paragraph.\nIt has two sentences.\nNo code here at all."
	if LooksLikeCode(src) {
		t.Error("expected plain prose to NOT trigger tier-3")
	}
}

func TestLooksLikeCode_tooShort(t *testing.T) {
	src := "x := 1\nreturn x"
	if LooksLikeCode(src) {
		t.Error("expected two-line snippet to NOT trigger tier-3 (below length threshold)")
	}
}

func TestDetectByHeuristics_sqlWithLeadingComment(t *testing.T) {
	cases := []struct {
		name  string
		input string
	}{
		{
			name:  "SELECT with leading SQL comment",
			input: "-- find active users\nSELECT id, name FROM users WHERE active = 1",
		},
		{
			name:  "SELECT with leading blank line",
			input: "\nSELECT id FROM users",
		},
		{
			name:  "INSERT with leading comment",
			input: "-- add user\nINSERT INTO users (name) VALUES ('alice')",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			lang, ok := DetectByHeuristics(tc.input, "")
			if !ok || lang != "sql" {
				t.Errorf("expected sql detection, got lang=%q ok=%v", lang, ok)
			}
		})
	}
}

func TestDetectByHeuristics_markdown(t *testing.T) {
	cases := []struct {
		name  string
		input string
	}{
		{
			name:  "Markdown Table",
			input: "| Header 1 | Header 2 |\n|---|---|\n| Cell 1 | Cell 2 |\n",
		},
		{
			name:  "Markdown Link",
			input: "Check out this [google link](https://google.com) for details.",
		},
		{
			name:  "Consecutive Bullets",
			input: "- Item one\n- Item two\n- Item three",
		},
		{
			name:  "Consecutive Numbered List",
			input: "1. First step\n2. Second step\n3. Third step",
		},
		{
			name:  "Nested Code Fence",
			input: "### Get User Profile\n```http\nGET https://api.github.com/users/octocat\nAccept: application/vnd.github.v3+json\nAuthorization: Bearer {{GITHUB_TOKEN}}\n```\n",
		},
		{
			name:  "Tier 2 Combination (Header + Bold)",
			input: "## Heading\nThis is some **bold** text to explain concepts.",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			lang, ok := DetectByHeuristics(tc.input, "")
			if !ok || lang != "markdown" {
				t.Errorf("expected markdown detection, got lang=%q ok=%v", lang, ok)
			}
		})
	}
}

func TestDetectByHeuristics_canonicalization(t *testing.T) {
	cases := []struct {
		hint     string
		expected string
	}{
		{"md", "markdown"},
		{"markdown", "markdown"},
		{"cs", "csharp"},
		{"csharp", "csharp"},
		{"js", "javascript"},
		{"ts", "typescript"},
		{"rs", "rust"},
		{"yml", "yaml"},
	}
	for _, tc := range cases {
		lang, ok := DetectByHeuristics("some code block source", tc.hint)
		if !ok || lang != tc.expected {
			t.Errorf("expected hint %q to resolve to %q, got %q (ok=%v)", tc.hint, tc.expected, lang, ok)
		}
	}
}
