package sieve

import (
	"testing"
)

// ── InitAttrs ────────────────────────────────────────────────────────────────

func TestCodeBlockProcessor_InitAttrs_zeroState(t *testing.T) {
	p := &CodeBlockProcessor{}
	attrs := p.InitAttrs("co-0001", nil)
	if attrs["id"] != "co-0001" {
		t.Errorf("expected id=co-0001, got %v", attrs["id"])
	}
	if attrs["status"] != "PENDING" {
		t.Errorf("expected status=PENDING, got %v", attrs["status"])
	}
	if attrs["source"] != "" {
		t.Errorf("expected empty source, got %v", attrs["source"])
	}
	// No source → heuristics return nothing → language empty
	if attrs["language"] != "" {
		t.Errorf("expected empty language with no source, got %v", attrs["language"])
	}
}

func TestCodeBlockProcessor_InitAttrs_heuristicsApplied(t *testing.T) {
	p := &CodeBlockProcessor{}
	// InitAttrs must run heuristics synchronously so the user sees a language
	// badge immediately, before RunJob (AI) completes.
	attrs := p.InitAttrs("co-0002", map[string]interface{}{
		"source": "package main\n\nfunc main() {}",
	})
	if attrs["language"] != "go" {
		t.Errorf("expected heuristics to detect 'go', got %v", attrs["language"])
	}
	// Status stays PENDING — AI enrichment still runs in RunJob
	if attrs["status"] != "PENDING" {
		t.Errorf("expected PENDING (AI enrichment not done yet), got %v", attrs["status"])
	}
}

func TestCodeBlockProcessor_InitAttrs_withOverrides(t *testing.T) {
	p := &CodeBlockProcessor{}
	attrs := p.InitAttrs("co-0003", map[string]interface{}{
		"source": "print('hello')",
		"hint":   "python",
	})
	if attrs["source"] != "print('hello')" {
		t.Errorf("expected source from override, got %v", attrs["source"])
	}
	// hint "python" is a known language — heuristics trust it immediately
	if attrs["language"] != "python" {
		t.Errorf("expected language=python from hint, got %v", attrs["language"])
	}
	if attrs["id"] != "co-0003" {
		t.Errorf("expected id=co-0003, got %v", attrs["id"])
	}
	// id must not be overrideable via overrides
	attrs2 := p.InitAttrs("co-0004", map[string]interface{}{"id": "injected"})
	if attrs2["id"] != "co-0004" {
		t.Errorf("id must come from parameter, not overrides; got %v", attrs2["id"])
	}
}

// ── PasteMatch ───────────────────────────────────────────────────────────────

func TestCodeBlockProcessor_PasteMatch_withLanguage(t *testing.T) {
	p := &CodeBlockProcessor{}
	matched, overrides := p.PasteMatch("```python\nprint('hello')\nprint('world')\n```")
	if !matched {
		t.Fatal("expected match for bare code fence")
	}
	if overrides["source"] != "print('hello')\nprint('world')" {
		t.Errorf("unexpected source: %v", overrides["source"])
	}
	if overrides["hint"] != "python" {
		t.Errorf("expected hint=python, got %v", overrides["hint"])
	}
	// PasteMatch must NOT set status or id — those belong to InitAttrs
	if _, ok := overrides["status"]; ok {
		t.Error("PasteMatch must not set status")
	}
	if _, ok := overrides["id"]; ok {
		t.Error("PasteMatch must not set id")
	}
}

func TestCodeBlockProcessor_PasteMatch_noLanguage(t *testing.T) {
	p := &CodeBlockProcessor{}
	matched, overrides := p.PasteMatch("```\nsome code\n```")
	if !matched {
		t.Fatal("expected match for fence without language")
	}
	if overrides["source"] != "some code" {
		t.Errorf("unexpected source: %v", overrides["source"])
	}
	if _, ok := overrides["hint"]; ok {
		t.Errorf("expected no hint when fence has no language")
	}
}

func TestCodeBlockProcessor_PasteMatch_noMatch(t *testing.T) {
	p := &CodeBlockProcessor{}
	if matched, _ := p.PasteMatch("just plain text"); matched {
		t.Fatal("expected no match for plain text")
	}
	if matched, _ := p.PasteMatch("`inline code`"); matched {
		t.Fatal("expected no match for inline code")
	}
}

func TestCodeBlockProcessor_PasteMatch_multiline(t *testing.T) {
	p := &CodeBlockProcessor{}
	matched, overrides := p.PasteMatch("```go\npackage main\n\nfunc main() {\n\tfmt.Println(\"hi\")\n}\n```")
	if !matched {
		t.Fatal("expected match for multiline fence")
	}
	if src, _ := overrides["source"].(string); src == "" {
		t.Error("expected non-empty source")
	}
}
