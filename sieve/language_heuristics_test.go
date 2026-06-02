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
