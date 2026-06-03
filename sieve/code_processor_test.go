package sieve

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ── InitAttrs ────────────────────────────────────────────────────────────────

func TestCodeBlockProcessor_InitAttrs_zeroState(t *testing.T) {
	p := &CodeBlockProcessor{}
	attrs := p.InitAttrs("co-0001", nil)
	if attrs["id"] != "co-0001" {
		t.Errorf("expected id=co-0001, got %v", attrs["id"])
	}
	if attrs["status"] != BlockStatusPending {
		t.Errorf("expected status=PENDING, got %v", attrs["status"])
	}
	if attrs["source"] != "" {
		t.Errorf("expected empty source, got %v", attrs["source"])
	}
	// No source → heuristics return nothing → language empty
	if attrs["language"] != "" {
		t.Errorf("expected empty language with no source, got %v", attrs["language"])
	}
	if attrs["detectionMethod"] != "" {
		t.Errorf("expected empty detectionMethod, got %v", attrs["detectionMethod"])
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
	if attrs["detectionMethod"] != "heuristic" {
		t.Errorf("expected detectionMethod=heuristic, got %v", attrs["detectionMethod"])
	}
	// Status stays PENDING — AI enrichment still runs in RunJob
	if attrs["status"] != BlockStatusPending {
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
	matched, overrides := p.PasteMatch([]PasteEntry{{MIMEType: "text/plain", Content: "```python\nprint('hello')\nprint('world')\n```"}})
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
	matched, overrides := p.PasteMatch([]PasteEntry{{MIMEType: "text/plain", Content: "```\nsome code\n```"}})
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
	if matched, _ := p.PasteMatch([]PasteEntry{{MIMEType: "text/plain", Content: "just plain text"}}); matched {
		t.Fatal("expected no match for plain text")
	}
	if matched, _ := p.PasteMatch([]PasteEntry{{MIMEType: "text/plain", Content: "`inline code`"}}); matched {
		t.Fatal("expected no match for inline code")
	}
}

func TestCodeBlockProcessor_PasteMatch_multiline(t *testing.T) {
	p := &CodeBlockProcessor{}
	matched, overrides := p.PasteMatch([]PasteEntry{{MIMEType: "text/plain", Content: "```go\npackage main\n\nfunc main() {\n\tfmt.Println(\"hi\")\n}\n```"}})
	if !matched {
		t.Fatal("expected match for multiline fence")
	}
	if src, _ := overrides["source"].(string); src == "" {
		t.Error("expected non-empty source")
	}
}

func TestCodeBlockProcessor_PasteMatch_noTextPlain(t *testing.T) {
	p := &CodeBlockProcessor{}
	matched, _ := p.PasteMatch([]PasteEntry{{MIMEType: "text/html", Content: "<b>hello</b>"}})
	if matched {
		t.Fatal("expected no match when no text/plain entry is present")
	}
}

func TestCodeBlockProcessor_RunJob_ai(t *testing.T) {
	ds, fs := newTestDocumentService(t)
	assets := NewAssetService(fs)
	state, err := NewStateService(fs)
	if err != nil {
		t.Fatalf("NewStateService: %v", err)
	}
	prompts, err := NewPromptService(fs)
	if err != nil {
		t.Fatalf("NewPromptService: %v", err)
	}

	// Write mock CLI script
	tmpDir := t.TempDir()
	cliPath := filepath.Join(tmpDir, "mock_cli.sh")
	err = os.WriteFile(cliPath, []byte("#!/bin/sh\necho \"go\"\n"), 0755)
	if err != nil {
		t.Fatalf("WriteFile mock CLI: %v", err)
	}

	// Set CLI path in settings
	settings := DefaultSettings()
	settings.CLI = cliPath
	if err := state.SaveSettings(settings); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}

	// Write the "refine" prompt content (needed by RefineLanguage)
	_, _ = fs.CreateText(Prompts, "refine.txt", []byte("Refine this: {content}"))

	ai := NewAIService(state, prompts, ds, tmpDir)
	svc := Services{
		AI:        ai,
		Documents: ds,
		Assets:    assets,
	}

	p := &CodeBlockProcessor{}
	block := &SieveBlock{
		ID:   "co-1234",
		Kind: "code",
		Attrs: map[string]interface{}{
			"id":              "co-1234",
			"status":          BlockStatusPending,
			"source":          "package main",
			"language":        "",
			"detectionMethod": "",
		},
	}

	ctx := context.Background()
	if err := p.RunJob(ctx, "", block, svc); err != nil {
		t.Fatalf("RunJob failed: %v", err)
	}

	if block.Attrs["status"] != BlockStatusComplete {
		t.Errorf("expected status COMPLETE, got %v", block.Attrs["status"])
	}
	if block.Attrs["language"] != "go" {
		t.Errorf("expected language refined to 'go', got %v", block.Attrs["language"])
	}
	if block.Attrs["detectionMethod"] != BlockStatusPending && block.Attrs["detectionMethod"] != "ai" {
		t.Errorf("expected detectionMethod refined to 'ai', got %v", block.Attrs["detectionMethod"])
	}
}

func TestCodeBlockProcessor_RunJob_aiFallback(t *testing.T) {
	ds, fs := newTestDocumentService(t)
	assets := NewAssetService(fs)
	state, err := NewStateService(fs)
	if err != nil {
		t.Fatalf("NewStateService: %v", err)
	}
	prompts, err := NewPromptService(fs)
	if err != nil {
		t.Fatalf("NewPromptService: %v", err)
	}

	// Write mock CLI script that exits with non-zero
	tmpDir := t.TempDir()
	cliPath := filepath.Join(tmpDir, "mock_cli.sh")
	err = os.WriteFile(cliPath, []byte("#!/bin/sh\nexit 1\n"), 0755)
	if err != nil {
		t.Fatalf("WriteFile mock CLI: %v", err)
	}

	settings := DefaultSettings()
	settings.CLI = cliPath
	if err := state.SaveSettings(settings); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}

	ai := NewAIService(state, prompts, ds, tmpDir)
	svc := Services{
		AI:        ai,
		Documents: ds,
		Assets:    assets,
	}

	p := &CodeBlockProcessor{}
	block := &SieveBlock{
		ID:   "co-1234",
		Kind: "code",
		Attrs: map[string]interface{}{
			"id":              "co-1234",
			"status":          BlockStatusPending,
			"source":          "package main",
			"language":        "heuristic-detected-lang",
			"detectionMethod": "heuristic",
		},
	}

	ctx := context.Background()
	err = p.RunJob(ctx, "", block, svc)

	// AI failure must surface as an error so EditorService can set status=ERROR.
	if err == nil {
		t.Fatal("expected RunJob to return an error when the AI CLI fails")
	}
	// The block's status must be ERROR so callers know the job did not complete.
	if block.Attrs["status"] != BlockStatusError {
		t.Errorf("expected status ERROR, got %v", block.Attrs["status"])
	}
}

func TestCodeBlockProcessor_RunJob_returnsErrorOnAIFailure(t *testing.T) {
	proc := &CodeBlockProcessor{}
	block := &SieveBlock{
		ID:   "co-test",
		Kind: "code",
		Attrs: map[string]interface{}{
			"id":     "co-test",
			"source": "fmt.Println(\"hello\")",
			"status": BlockStatusPending,
		},
	}
	// Pass nil AI service — this should cause RunJob to return an error
	// rather than silently setting status=COMPLETE.
	err := proc.RunJob(context.Background(), "", block, Services{AI: nil})
	if err == nil {
		t.Error("expected RunJob to return an error when AI service is unavailable")
	}
}

// ── OnChange ─────────────────────────────────────────────────────────────────

func TestOnChange_alwaysRunsHeuristicsWhenLanguageAlreadySet(t *testing.T) {
	proc := &CodeBlockProcessor{}

	block := &SieveBlock{
		ID:   "co-0001",
		Kind: "code",
		Attrs: map[string]interface{}{
			"id":       "co-0001",
			"language": "python",
			"status":   BlockStatusComplete,
			"source":   strings.Repeat("fmt.Println(\"hello\")\nif err != nil { return err }\n", 5),
		},
	}

	proc.OnChange(block, Services{})

	if status, _ := block.Attrs["status"].(string); status == BlockStatusPending {
		t.Error("expected status not to be PENDING: heuristics should identify Go without AI")
	}
	if lang, _ := block.Attrs["language"].(string); lang != "go" {
		t.Errorf("expected language=go after heuristics, got %q", lang)
	}
}

func TestOnChange_doesNotScheduleAIWhenLanguageSetAndHeuristicsBlind(t *testing.T) {
	proc := &CodeBlockProcessor{}

	block := &SieveBlock{
		ID:   "co-0002",
		Kind: "code",
		Attrs: map[string]interface{}{
			"id":       "co-0002",
			"language": "rust",
			"status":   BlockStatusComplete,
			"source":   "x = 1\ny = 2\nz = x + y",
		},
	}

	proc.OnChange(block, Services{})

	if status, _ := block.Attrs["status"].(string); status == BlockStatusPending {
		t.Error("expected status not to be PENDING: AI result should be trusted when heuristics are silent")
	}
	if lang, _ := block.Attrs["language"].(string); lang != "rust" {
		t.Errorf("expected language=rust (untouched), got %q", lang)
	}
}

func TestOnChange_schedulesAIWhenNoLanguageAndHeuristicsBlind(t *testing.T) {
	proc := &CodeBlockProcessor{}

	block := &SieveBlock{
		ID:   "co-0003",
		Kind: "code",
		Attrs: map[string]interface{}{
			"id":       "co-0003",
			"language": "unknown",
			"status":   BlockStatusComplete,
			"source":   strings.Repeat("x = 1\ny = 2\n", 10),
		},
	}

	proc.OnChange(block, Services{})

	if status, _ := block.Attrs["status"].(string); status != BlockStatusPending {
		t.Errorf("expected status to transition to PENDING, got %q", status)
	}
}
