package sieve

import (
	"testing"
)

func TestDetectByHeuristics_json(t *testing.T) {
	lang, ok := detectByHeuristics(`{"key": "value", "num": 42}`, "")
	if !ok || lang != "json" {
		t.Errorf("expected json/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_yamlK8s(t *testing.T) {
	src := "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: my-app"
	lang, ok := detectByHeuristics(src, "")
	if !ok || lang != "yaml" {
		t.Errorf("expected yaml/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_go_tier1(t *testing.T) {
	lang, ok := detectByHeuristics("package main\n\nfunc main() {}", "")
	if !ok || lang != "go" {
		t.Errorf("expected go/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_go_struct(t *testing.T) {
	lang, ok := detectByHeuristics("type User struct {\n\tName string `json:\"name\"`\n}", "")
	if !ok || lang != "go" {
		t.Errorf("expected go/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_java_tier1(t *testing.T) {
	lang, ok := detectByHeuristics("public class Foo {\n\tpublic static void main(String[] args) {}\n}", "")
	if !ok || lang != "java" {
		t.Errorf("expected java/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_python(t *testing.T) {
	lang, ok := detectByHeuristics("def greet(self):\n    return self.name", "")
	if !ok || lang != "python" {
		t.Errorf("expected python/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_sql(t *testing.T) {
	lang, ok := detectByHeuristics("SELECT id, name FROM users WHERE active = 1", "")
	if !ok || lang != "sql" {
		t.Errorf("expected sql/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_bash_shebang(t *testing.T) {
	lang, ok := detectByHeuristics("#!/bin/bash\necho hello", "")
	if !ok || lang != "bash" {
		t.Errorf("expected bash/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_typescript(t *testing.T) {
	lang, ok := detectByHeuristics("export interface User {\n  name: string\n  age: number\n}", "")
	if !ok || lang != "typescript" {
		t.Errorf("expected typescript/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_hint_trusted(t *testing.T) {
	// A known hint bypasses pattern matching
	lang, ok := detectByHeuristics("x = 1", "python")
	if !ok || lang != "python" {
		t.Errorf("expected python/true from hint, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_unknownHint_falls_through(t *testing.T) {
	// Unrecognised hint does not short-circuit; heuristics still run
	_, ok := detectByHeuristics("x = 1", "weirdlang")
	// We don't assert lang here — just that it doesn't panic and returns a bool
	_ = ok
}

func TestDetectByHeuristics_noMatch(t *testing.T) {
	_, ok := detectByHeuristics("hello world", "")
	if ok {
		t.Error("expected no match for plain prose")
	}
}

// ── looksLikeCode ────────────────────────────────────────────────────────────

func TestLooksLikeCode_braces(t *testing.T) {
	src := "function foo() {\n  var x = 1\n  return x\n}"
	if !looksLikeCode(src) {
		t.Error("expected braces to trigger tier-3")
	}
}

func TestLooksLikeCode_semicolons(t *testing.T) {
	src := "int x = 1;\nint y = 2;\nreturn x + y;"
	if !looksLikeCode(src) {
		t.Error("expected semicolons to trigger tier-3")
	}
}

func TestLooksLikeCode_indentation(t *testing.T) {
	src := "if condition:\n    do_something()\n    do_more()\n    final_step()"
	if !looksLikeCode(src) {
		t.Error("expected heavy indentation to trigger tier-3")
	}
}

func TestLooksLikeCode_weakSignal(t *testing.T) {
	// Single := hit — too weak for detectByHeuristics but enough for looksLikeCode
	src := "x := getValue()\nresult := process(x)\nreturn result"
	if !looksLikeCode(src) {
		t.Error("expected single tier-2 weak signal to trigger tier-3")
	}
}

func TestLooksLikeCode_prose(t *testing.T) {
	src := "This is a normal paragraph.\nIt has two sentences.\nNo code here at all."
	if looksLikeCode(src) {
		t.Error("expected plain prose to NOT trigger tier-3")
	}
}

func TestLooksLikeCode_tooShort(t *testing.T) {
	src := "x := 1\nreturn x"
	if looksLikeCode(src) {
		t.Error("expected two-line snippet to NOT trigger tier-3 (below length threshold)")
	}
}
