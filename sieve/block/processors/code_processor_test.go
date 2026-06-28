package processors

import (
	"context"
	"os"
	"path/filepath"
	"sieve/sieve/ai"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/services"
	"strings"
	"testing"
)

// ── InitAttrs ────────────────────────────────────────────────────────────────

func TestCodeBlockProcessor_InitAttrs_zeroState(t *testing.T) {
	p := NewCodeBlockProcessor(block.BlockServices{})
	attrs := p.InitAttrs("co-0001", nil)
	if attrs["id"] != "co-0001" {
		t.Errorf("expected id=co-0001, got %v", attrs["id"])
	}
	if attrs["status"] != block.BlockStatusPending {
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
	p := NewCodeBlockProcessor(block.BlockServices{})
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
	if attrs["status"] != block.BlockStatusPending {
		t.Errorf("expected PENDING (AI enrichment not done yet), got %v", attrs["status"])
	}
}

func TestCodeBlockProcessor_InitAttrs_withOverrides(t *testing.T) {
	p := NewCodeBlockProcessor(block.BlockServices{})
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

// ── IsSupportedContent + Transform ───────────────────────────────────────────

func TestCodeBlockProcessor_IsBlock_withLanguage(t *testing.T) {
	p := NewCodeBlockProcessor(block.BlockServices{})
	if !p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: "```python\nprint('hello')\nprint('world')\n```"}}).Has(block.ActionPaste) {
		t.Fatal("IsSupportedContent must offer paste for a fenced code block")
	}
}

func TestCodeBlockProcessor_Transform_withLanguage(t *testing.T) {
	p := NewCodeBlockProcessor(block.BlockServices{})
	overrides := p.Transform([]block.ContentEntry{{MIMEType: "text/plain", Content: "```python\nprint('hello')\nprint('world')\n```"}}, "", "", block.ActionPaste)
	if overrides == nil {
		t.Fatal("Transform must return non-nil for a fenced code block")
	}
	if overrides["source"] != "print('hello')\nprint('world')" {
		t.Errorf("unexpected source: %v", overrides["source"])
	}
	if overrides["language"] != "python" {
		t.Errorf("expected language=python, got %v", overrides["language"])
	}
	// Transform must NOT set status or id — those belong to InitAttrs
	if _, ok := overrides["status"]; ok {
		t.Error("Transform must not set status")
	}
	if _, ok := overrides["id"]; ok {
		t.Error("Transform must not set id")
	}
}

func TestCodeBlockProcessor_Transform_wideFenceWithNestedFences(t *testing.T) {
	p := NewCodeBlockProcessor(block.BlockServices{})
	// A native ````markdown block whose content itself contains a ```http fence.
	// The editor sizes the outer fence to 4 backticks; detection/extraction must
	// recognise it and capture the inner content verbatim (inner fences intact).
	content := "````markdown\n### Get User Profile\n```http\nGET /\n```\n````"
	if !p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: content}}).Has(block.ActionPaste) {
		t.Fatal("IsSupportedContent must offer paste for a 4-backtick fence")
	}
	overrides := p.Transform([]block.ContentEntry{{MIMEType: "text/plain", Content: content}}, "", "", block.ActionPaste)
	if overrides == nil {
		t.Fatal("Transform must return non-nil for a 4-backtick fence")
	}
	if overrides["language"] != "markdown" {
		t.Errorf("expected language=markdown, got %v", overrides["language"])
	}
	if overrides["source"] != "### Get User Profile\n```http\nGET /\n```" {
		t.Errorf("unexpected source: %q", overrides["source"])
	}
}

func TestCodeBlockProcessor_IsBlock_unfencedCode(t *testing.T) {
	p := NewCodeBlockProcessor(block.BlockServices{})
	// Smart-paste of raw, unfenced source must still be detected as code
	// (restored from the pre-framework PasteMatch).
	src := "func main() {\n\tfmt.Println(\"hi\")\n\treturn\n}"
	if !p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: src}}).Has(block.ActionPaste) {
		t.Fatal("IsSupportedContent must offer paste for unfenced code that heuristics recognise")
	}
	overrides := p.Transform([]block.ContentEntry{{MIMEType: "text/plain", Content: src}}, "", "", block.ActionPaste)
	if overrides == nil {
		t.Fatal("Transform must return non-nil for unfenced code")
	}
	if overrides["source"] != src {
		t.Errorf("unfenced source must be verbatim, got %q", overrides["source"])
	}
}

func TestCodeBlockProcessor_IsBlock_unfencedProseIsNotCode(t *testing.T) {
	p := NewCodeBlockProcessor(block.BlockServices{})
	prose := "This is a normal paragraph of prose.\nIt spans a couple of lines.\nNothing here resembles source code at all."
	if p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: prose}}).Has(block.ActionPaste) {
		t.Fatal("IsSupportedContent must not offer paste for ordinary multi-line prose")
	}
}

func TestCodeBlockProcessor_IsBlock_noLanguage(t *testing.T) {
	p := NewCodeBlockProcessor(block.BlockServices{})
	if !p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: "```\nsome code\n```"}}).Has(block.ActionPaste) {
		t.Fatal("IsSupportedContent must offer paste for a fence without language")
	}
}

func TestCodeBlockProcessor_Transform_noLanguage(t *testing.T) {
	p := NewCodeBlockProcessor(block.BlockServices{})
	overrides := p.Transform([]block.ContentEntry{{MIMEType: "text/plain", Content: "```\nsome code\n```"}}, "", "", block.ActionPaste)
	if overrides == nil {
		t.Fatal("Transform must return non-nil for a fence without language")
	}
	if overrides["source"] != "some code" {
		t.Errorf("unexpected source: %v", overrides["source"])
	}
	if _, ok := overrides["hint"]; ok {
		t.Errorf("expected no hint when fence has no language")
	}
}

func TestCodeBlockProcessor_IsBlock_noMatch(t *testing.T) {
	p := NewCodeBlockProcessor(block.BlockServices{})
	if p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: "just plain text"}}).Has(block.ActionPaste) {
		t.Fatal("IsSupportedContent must not offer paste for plain text")
	}
	if p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: "`inline code`"}}).Has(block.ActionPaste) {
		t.Fatal("IsSupportedContent must not offer paste for inline code")
	}
}

func TestCodeBlockProcessor_IsBlock_multiline(t *testing.T) {
	p := NewCodeBlockProcessor(block.BlockServices{})
	if !p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: "```go\npackage main\n\nfunc main() {\n\tfmt.Println(\"hi\")\n}\n```"}}).Has(block.ActionPaste) {
		t.Fatal("IsSupportedContent must offer paste for a multiline fence")
	}
}

func TestCodeBlockProcessor_Transform_multiline(t *testing.T) {
	p := NewCodeBlockProcessor(block.BlockServices{})
	overrides := p.Transform([]block.ContentEntry{{MIMEType: "text/plain", Content: "```go\npackage main\n\nfunc main() {\n\tfmt.Println(\"hi\")\n}\n```"}}, "", "", block.ActionPaste)
	if overrides == nil {
		t.Fatal("Transform must return non-nil for a multiline fence")
	}
	if src, _ := overrides["source"].(string); src == "" {
		t.Error("expected non-empty source")
	}
}

func TestCodeBlockProcessor_IsBlock_htmlEntry(t *testing.T) {
	p := NewCodeBlockProcessor(block.BlockServices{})
	if p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/html", Content: "<b>hello</b>"}}).Has(block.ActionPaste) {
		t.Fatal("IsSupportedContent must not offer paste for HTML-only entry with no code content")
	}
}

func TestCodeBlockProcessor_RunJob_ai(t *testing.T) {
	ds, fs := newTestDocumentService(t)
	assets := services.NewAssetService(fs)
	state, err := services.NewStateService(fs)
	if err != nil {
		t.Fatalf("NewStateService: %v", err)
	}
	prompts, err := ai.NewPromptService(fs)
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
	settings := domain.DefaultSettings()
	settings.CLI = cliPath
	if err := state.SaveSettings(settings); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}

	// Write the "refine" prompt content (needed by RefineLanguage)
	_, _ = fs.CreateText(domain.Prompts, "refine.txt", []byte("Refine this: {content}"))

	ai := ai.NewAIService(state, prompts, ds, tmpDir)
	svc := block.BlockServices{
		AI:        ai,
		Documents: ds,
		Assets:    assets,
	}

	p := NewCodeBlockProcessor(svc)
	blk := &block.SieveBlock{
		ID:   "co-1234",
		Kind: "code",
		Attrs: map[string]interface{}{
			"id":              "co-1234",
			"status":          block.BlockStatusPending,
			"source":          "package main",
			"language":        "",
			"detectionMethod": "",
		},
	}

	ctx := context.Background()
	if err := p.RunJob(block.JobContext{Ctx: ctx, UUID: "", Block: blk}); err != nil {
		t.Fatalf("RunJob failed: %v", err)
	}

	if blk.Attrs["status"] != block.BlockStatusComplete {
		t.Errorf("expected status COMPLETE, got %v", blk.Attrs["status"])
	}
	if blk.Attrs["language"] != "go" {
		t.Errorf("expected language refined to 'go', got %v", blk.Attrs["language"])
	}
	if blk.Attrs["detectionMethod"] != block.BlockStatusPending && blk.Attrs["detectionMethod"] != "ai" {
		t.Errorf("expected detectionMethod refined to 'ai', got %v", blk.Attrs["detectionMethod"])
	}
}

func TestCodeBlockProcessor_RunJob_aiFallback(t *testing.T) {
	ds, fs := newTestDocumentService(t)
	assets := services.NewAssetService(fs)
	state, err := services.NewStateService(fs)
	if err != nil {
		t.Fatalf("NewStateService: %v", err)
	}
	prompts, err := ai.NewPromptService(fs)
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

	settings := domain.DefaultSettings()
	settings.CLI = cliPath
	if err := state.SaveSettings(settings); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}

	ai := ai.NewAIService(state, prompts, ds, tmpDir)
	svc := block.BlockServices{
		AI:        ai,
		Documents: ds,
		Assets:    assets,
	}

	p := NewCodeBlockProcessor(svc)
	blk := &block.SieveBlock{
		ID:   "co-1234",
		Kind: "code",
		Attrs: map[string]interface{}{
			"id":              "co-1234",
			"status":          block.BlockStatusPending,
			"source":          "package main",
			"language":        "heuristic-detected-lang",
			"detectionMethod": "heuristic",
		},
	}

	ctx := context.Background()
	err = p.RunJob(block.JobContext{Ctx: ctx, UUID: "", Block: blk})

	// AI failure must surface as an error so EditorService can set status=ERROR.
	if err == nil {
		t.Fatal("expected RunJob to return an error when the AI CLI fails")
	}
	// The block's status must be ERROR so callers know the job did not complete.
	if blk.Attrs["status"] != block.BlockStatusError {
		t.Errorf("expected status ERROR, got %v", blk.Attrs["status"])
	}
}

func TestCodeBlockProcessor_RunJob_returnsErrorOnAIFailure(t *testing.T) {
	proc := NewCodeBlockProcessor(block.BlockServices{})
	blk := &block.SieveBlock{
		ID:   "co-test",
		Kind: "code",
		Attrs: map[string]interface{}{
			"id":     "co-test",
			"source": "fmt.Println(\"hello\")",
			"status": block.BlockStatusPending,
		},
	}
	// nil AI service — this should cause RunJob to return an error
	// rather than silently setting status=COMPLETE.
	err := proc.RunJob(block.JobContext{Ctx: context.Background(), UUID: "test-uuid", Block: blk})
	if err == nil {
		t.Error("expected RunJob to return an error when AI service is unavailable")
	}
}

// ── OnChange ─────────────────────────────────────────────────────────────────

func TestOnChange_alwaysRunsHeuristicsWhenLanguageAlreadySet(t *testing.T) {
	proc := NewCodeBlockProcessor(block.BlockServices{})

	blk := &block.SieveBlock{
		ID:   "co-0001",
		Kind: "code",
		Attrs: map[string]interface{}{
			"id":       "co-0001",
			"language": "python",
			"status":   block.BlockStatusComplete,
			"source":   strings.Repeat("fmt.Println(\"hello\")\nif err != nil { return err }\n", 5),
		},
	}

	proc.OnChange(blk)

	if status, _ := blk.Attrs["status"].(string); status == block.BlockStatusPending {
		t.Error("expected status not to be PENDING: heuristics should identify Go without AI")
	}
	if lang, _ := blk.Attrs["language"].(string); lang != "go" {
		t.Errorf("expected language=go after heuristics, got %q", lang)
	}
}

func TestOnChange_doesNotScheduleAIWhenLanguageSetAndHeuristicsBlind(t *testing.T) {
	proc := NewCodeBlockProcessor(block.BlockServices{})

	blk := &block.SieveBlock{
		ID:   "co-0002",
		Kind: "code",
		Attrs: map[string]interface{}{
			"id":       "co-0002",
			"language": "rust",
			"status":   block.BlockStatusComplete,
			"source":   "x = 1\ny = 2\nz = x + y",
		},
	}

	proc.OnChange(blk)

	if status, _ := blk.Attrs["status"].(string); status == block.BlockStatusPending {
		t.Error("expected status not to be PENDING: AI result should be trusted when heuristics are silent")
	}
	if lang, _ := blk.Attrs["language"].(string); lang != "rust" {
		t.Errorf("expected language=rust (untouched), got %q", lang)
	}
}

func TestOnChange_schedulesAIWhenNoLanguageAndHeuristicsBlind(t *testing.T) {
	proc := NewCodeBlockProcessor(block.BlockServices{})

	blk := &block.SieveBlock{
		ID:   "co-0003",
		Kind: "code",
		Attrs: map[string]interface{}{
			"id":       "co-0003",
			"language": "unknown",
			"status":   block.BlockStatusComplete,
			"source":   strings.Repeat("x = 1\ny = 2\n", 10),
		},
	}

	proc.OnChange(blk)

	if status, _ := blk.Attrs["status"].(string); status != block.BlockStatusPending {
		t.Errorf("expected status to transition to PENDING, got %q", status)
	}
}

func TestCodeBlockProcessor_RawContent_returnsSource(t *testing.T) {
	var p CodeBlockProcessor
	blk := block.NewSieveBlock("code", "co-1", map[string]interface{}{"source": "x = 1\ny = 2"})
	if got := p.RawContent(blk); got != "x = 1\ny = 2" {
		t.Errorf("RawContent = %q, want the source verbatim", got)
	}
	empty := block.NewSieveBlock("code", "co-2", map[string]interface{}{})
	if got := p.RawContent(empty); got != "" {
		t.Errorf("RawContent of source-less block = %q, want empty", got)
	}
}
