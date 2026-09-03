package processors

import (
	"context"
	"errors"
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
	// Empty source ⇒ no async refine job ⇒ born COMPLETE (mirrors DescribeJob==nil).
	if attrs["status"] != block.BlockStatusComplete {
		t.Errorf("expected status=COMPLETE for empty source, got %v", attrs["status"])
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

func TestCodeBlockProcessor_IsBlock_unfencedMarkdownIsNotCode(t *testing.T) {
	p := NewCodeBlockProcessor(block.BlockServices{})
	// Markdown is a detectable "language" (explicit ```markdown fences work), but
	// a smart-paste of raw markdown is document content — code must decline it so
	// it enters the document as markdown, not a code block.
	md := "# Release Notes\n\n- fixed the parser\n- improved paste handling\n\nSee [the docs](https://example.com/docs) for **details**."
	if p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: md}}).Has(block.ActionPaste) {
		t.Fatal("IsSupportedContent must not claim unfenced markdown as code")
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
	assets := services.NewAssetService(fs, "")
	state, err := services.NewStateService(fs, "", nil)
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
	job := p.DescribeJob(block.JobContext{Ctx: ctx, UUID: "", Block: blk})
	if job.Category != block.CategoryAI {
		t.Fatalf("expected CategoryAI, got %q", job.Category)
	}
	res, werr := job.Work()
	if werr != nil {
		t.Fatalf("Work failed: %v", werr)
	}
	job.Apply(res, blk)

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

// When the AI declines ("text") but the heuristic already found a confident
// language while the user was typing, RunJob must KEEP the heuristic's language
// rather than overwrite it with the AI's non-answer.
func TestCodeBlockProcessor_RunJob_aiNonAnswerKeepsHeuristic(t *testing.T) {
	ds, fs := newTestDocumentService(t)
	assets := services.NewAssetService(fs, "")
	state, err := services.NewStateService(fs, "", nil)
	if err != nil {
		t.Fatalf("NewStateService: %v", err)
	}
	prompts, err := ai.NewPromptService(fs)
	if err != nil {
		t.Fatalf("NewPromptService: %v", err)
	}

	// Mock CLI that declines to identify the language.
	tmpDir := t.TempDir()
	cliPath := filepath.Join(tmpDir, "mock_cli.sh")
	if err := os.WriteFile(cliPath, []byte("#!/bin/sh\necho \"text\"\n"), 0755); err != nil {
		t.Fatalf("WriteFile mock CLI: %v", err)
	}

	settings := domain.DefaultSettings()
	settings.CLI = cliPath
	if err := state.SaveSettings(settings); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}
	_, _ = fs.CreateText(domain.Prompts, "refine.txt", []byte("Refine this: {content}"))

	aiSvc := ai.NewAIService(state, prompts, ds, tmpDir)
	p := NewCodeBlockProcessor(block.BlockServices{AI: aiSvc, Documents: ds, Assets: assets})

	blk := &block.SieveBlock{
		ID:   "cod-9999",
		Kind: "code",
		Attrs: map[string]interface{}{
			"id":              "cod-9999",
			"status":          block.BlockStatusPending,
			"source":          "def greet(self):\n    return self.name",
			"language":        "python", // confident heuristic, found while typing
			"detectionMethod": "heuristic",
		},
	}

	job := p.DescribeJob(block.JobContext{Ctx: context.Background(), UUID: "", Block: blk})
	res, werr := job.Work()
	if werr != nil {
		t.Fatalf("Work failed: %v", werr)
	}
	job.Apply(res, blk)

	if blk.Attrs["language"] != "python" {
		t.Errorf("AI non-answer clobbered the heuristic: expected python, got %v", blk.Attrs["language"])
	}
	if blk.Attrs["detectionMethod"] != "heuristic" {
		t.Errorf("expected detectionMethod=heuristic (untouched), got %v", blk.Attrs["detectionMethod"])
	}
	if blk.Attrs["status"] != block.BlockStatusComplete {
		t.Errorf("expected status COMPLETE, got %v", blk.Attrs["status"])
	}
}

func TestCodeBlockProcessor_RunJob_aiFallback(t *testing.T) {
	ds, fs := newTestDocumentService(t)
	assets := services.NewAssetService(fs, "")
	state, err := services.NewStateService(fs, "", nil)
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
	job := p.DescribeJob(block.JobContext{Ctx: ctx, UUID: "", Block: blk})

	// AI failure must surface from Work as an error so the framework (EditorService
	// finish closure) can set status=ERROR — the error path is no longer the
	// processor's job (Apply is success-only).
	if _, werr := job.Work(); werr == nil {
		t.Fatal("expected Work to return an error when the AI CLI fails")
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
	// nil AI service — Work must return an error rather than silently succeeding.
	job := proc.DescribeJob(block.JobContext{Ctx: context.Background(), UUID: "test-uuid", Block: blk})
	if job.Work == nil {
		t.Fatal("expected an AI Work job for a non-empty source")
	}
	if _, werr := job.Work(); werr == nil {
		t.Error("expected Work to return an error when AI service is unavailable")
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

func TestOnChange_manualLanguageSurvivesHeuristicRedetection(t *testing.T) {
	proc := NewCodeBlockProcessor(block.BlockServices{})

	// The same Go-looking source the test above proves heuristics rewrite —
	// with the language picked by hand, nothing may touch it.
	blk := &block.SieveBlock{
		ID:   "co-0002",
		Kind: "code",
		Attrs: map[string]interface{}{
			"id":              "co-0002",
			"language":        "python",
			"detectionMethod": "manual",
			"status":          block.BlockStatusComplete,
			"source":          strings.Repeat("fmt.Println(\"hello\")\nif err != nil { return err }\n", 5),
		},
	}

	proc.OnChange(blk)

	if lang, _ := blk.Attrs["language"].(string); lang != "python" {
		t.Errorf("expected manual language=python to survive, got %q", lang)
	}
	if method, _ := blk.Attrs["detectionMethod"].(string); method != "manual" {
		t.Errorf("expected detectionMethod=manual to survive, got %q", method)
	}
}

func TestOnChange_manualPlainDoesNotDispatchDetection(t *testing.T) {
	proc := NewCodeBlockProcessor(block.BlockServices{})

	// "Plain" by hand is an empty language with a manual method: the empty
	// language must not re-enter the detection pipeline as a PENDING dispatch.
	blk := &block.SieveBlock{
		ID:   "co-0003",
		Kind: "code",
		Attrs: map[string]interface{}{
			"id":              "co-0003",
			"language":        "",
			"detectionMethod": "manual",
			"status":          block.BlockStatusComplete,
			"source":          "some short opaque text that heuristics cannot place",
		},
	}

	proc.OnChange(blk)

	if status, _ := blk.Attrs["status"].(string); status != block.BlockStatusComplete {
		t.Errorf("expected status to stay COMPLETE for a manual Plain, got %q", status)
	}
	if lang, _ := blk.Attrs["language"].(string); lang != "" {
		t.Errorf("expected manual Plain to keep an empty language, got %q", lang)
	}
}

// An AI-authored language must survive a later source update even when the
// heuristic disagrees. The AI refine step exists precisely because the heuristic
// is unreliable (it reads a Java `package` line as Go). When the AI corrects the
// language to java/ai, a spurious source `block-update` (fired by the syntax-
// highlight re-render) must NOT let OnChange revert it to the heuristic's go.
func TestOnChange_doesNotClobberAIAuthoredLanguage(t *testing.T) {
	proc := NewCodeBlockProcessor(block.BlockServices{})

	// Java source the Go heuristic mis-detects as "go" (the `package` line).
	java := "package com.example.demo;\n\nimport java.util.List;\n\npublic class Greeter {\n\tprivate final String name;\n}"
	blk := &block.SieveBlock{
		ID:   "cod-0007",
		Kind: "code",
		Attrs: map[string]interface{}{
			"id":              "cod-0007",
			"language":        "java",
			"detectionMethod": "ai",
			"status":          block.BlockStatusComplete,
			"source":          java,
		},
	}

	proc.OnChange(blk)

	if lang, _ := blk.Attrs["language"].(string); lang != "java" {
		t.Errorf("AI-authored language clobbered by heuristic: expected java, got %q", lang)
	}
	if method, _ := blk.Attrs["detectionMethod"].(string); method != "ai" {
		t.Errorf("detectionMethod clobbered: expected ai, got %q", method)
	}
}

// A NON-ANSWER AI verdict ("text") is not sticky: when the user adds content and
// the heuristic now finds a real language, OnChange must take it. This is the
// mirror of the clobber guard — the guard protects a CONFIDENT AI language only.
func TestOnChange_replacesNonAnswerAIWithConfidentHeuristic(t *testing.T) {
	proc := NewCodeBlockProcessor(block.BlockServices{})

	blk := &block.SieveBlock{
		ID:   "cod-0008",
		Kind: "code",
		Attrs: map[string]interface{}{
			"id":              "cod-0008",
			"language":        "text", // AI previously declined to identify
			"detectionMethod": "ai",
			"status":          block.BlockStatusComplete,
			// user has now pasted enough Go for the heuristic to be confident
			"source": strings.Repeat("fmt.Println(\"hello\")\nif err != nil { return err }\n", 5),
		},
	}

	proc.OnChange(blk)

	if lang, _ := blk.Attrs["language"].(string); lang != "go" {
		t.Errorf("non-answer AI verdict should yield to a confident heuristic: expected go, got %q", lang)
	}
	if method, _ := blk.Attrs["detectionMethod"].(string); method != "heuristic" {
		t.Errorf("expected detectionMethod=heuristic, got %q", method)
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

// What a code block projects into the text substrate. Its source is CODE — a
// spell checker reads prose and nothing else, which is how an identifier
// escapes a dictionary it was never in — and a filename it carries is a
// label. The locator is minted (mintLocator), not the bare slot name — see
// TestCodeBlockProcessor_NormalisedTextLocatorIsMintedNotBare — so this table
// asserts Text and Class only.
func TestCodeBlockProcessor_NormalisedText(t *testing.T) {
	p := NewCodeBlockProcessor(block.BlockServices{})
	const source = "func recieve() { retrn nil }"

	cases := []struct {
		name  string
		attrs map[string]interface{}
		want  []domain.TextSegment
	}{
		{
			name:  "the source alone",
			attrs: map[string]interface{}{"source": source, "language": "go"},
			want:  []domain.TextSegment{{Text: source, Class: domain.TextClassCode}},
		},
		{
			name:  "a named file adds the label",
			attrs: map[string]interface{}{"source": source, "filename": "reciever.go"},
			want: []domain.TextSegment{
				{Text: source, Class: domain.TextClassCode},
				{Text: "reciever.go", Class: domain.TextClassLabel},
			},
		},
		{
			name:  "an empty filename is no segment, not an empty one",
			attrs: map[string]interface{}{"source": source, "filename": ""},
			want:  []domain.TextSegment{{Text: source, Class: domain.TextClassCode}},
		},
		{
			name:  "a sourceless block still bears its one segment",
			attrs: map[string]interface{}{},
			want:  []domain.TextSegment{{Text: "", Class: domain.TextClassCode}},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			blk := block.SieveBlock{Kind: "code", Attrs: tc.attrs}
			got := p.NormalisedText(&blk)
			if len(got) != len(tc.want) {
				t.Fatalf("got %d segments, want %d: %#v", len(got), len(tc.want), got)
			}
			for i := range got {
				if got[i].Text != tc.want[i].Text || got[i].Class != tc.want[i].Class {
					t.Errorf("segment %d = %#v, want text %q class %q", i, got[i], tc.want[i].Text, tc.want[i].Class)
				}
				if got[i].Locator == "" {
					t.Errorf("segment %d has no locator", i)
				}
			}
		})
	}
}

// The locator is minted from the slot AND the bytes read out of it, exactly
// as prose's is (prose_processor_test.go's
// TestProseProcessor_NormalisedTextBearsOneSegmentOfProsesOwnReading): it is
// never the bare slot name, source and filename never share one, and
// different content mints a different one.
func TestCodeBlockProcessor_NormalisedTextLocatorIsMintedNotBare(t *testing.T) {
	p := NewCodeBlockProcessor(block.BlockServices{})
	blk := block.SieveBlock{Kind: "code", Attrs: map[string]interface{}{"source": "a", "filename": "f"}}
	segs := p.NormalisedText(&blk)
	if segs[0].Locator == CodeSourceLocator || segs[1].Locator == CodeFilenameLocator {
		t.Errorf("locator must not be the bare slot name: %q, %q", segs[0].Locator, segs[1].Locator)
	}
	if segs[0].Locator == segs[1].Locator {
		t.Errorf("source and filename minted the same locator %q", segs[0].Locator)
	}
	other := block.SieveBlock{Kind: "code", Attrs: map[string]interface{}{"source": "b", "filename": "f"}}
	if p.NormalisedText(&other)[0].Locator == segs[0].Locator {
		t.Error("different source content minted the same locator")
	}
}

// codeBlockFrom builds a code block over exactly the two slots UpdateText
// can write: source, and filename when non-empty.
func codeBlockFrom(source, filename string) block.SieveBlock {
	attrs := map[string]interface{}{"source": source}
	if filename != "" {
		attrs["filename"] = filename
	}
	return block.SieveBlock{Kind: "code", ID: "co-1", Attrs: attrs}
}

// codeAnchoredEdit mints an anchor the way the substrate does — read slot's
// current text, mint its locator, name a quote at an occurrence in that
// reading.
func codeAnchoredEdit(t *testing.T, source, filename, slot, quote string, occurrence int, grain, replacement string) domain.TextEdit {
	t.Helper()
	p := NewCodeBlockProcessor(block.BlockServices{})
	text := source
	if slot == CodeFilenameLocator {
		text = filename
	}
	return domain.TextEdit{
		BlockID: "co-1", Locator: p.mintLocator(slot, text), Quote: quote, Occurrence: occurrence,
		Grain: grain, Replacement: replacement,
	}
}

// codeSpend applies edits to a fresh block built from source/filename and
// reports what the block now holds.
func codeSpend(t *testing.T, source, filename string, edits ...domain.TextEdit) (block.SieveBlock, error) {
	t.Helper()
	p := NewCodeBlockProcessor(block.BlockServices{})
	blk := codeBlockFrom(source, filename)
	err := p.UpdateText(&blk, edits)
	return blk, err
}

// Code has no parse, so a resolved run addresses the stored slot bytes
// directly — a splice, not a map back through markup. Both grains land on
// those same bytes, and a filename slot splices independently of source.
func TestCodeBlockProcessor_UpdateTextSplicesTheNamedSlot(t *testing.T) {
	cases := []struct {
		name                     string
		slot                     string
		source, filename         string
		quote                    string
		occurrence               int
		grain, replacement       string
		wantSource, wantFilename string
	}{
		{
			name: "word grain replaces a whole word run in source",
			slot: CodeSourceLocator, source: "func recieve() {}",
			quote: "recieve", occurrence: 0, grain: domain.GrainWord, replacement: "receive",
			wantSource: "func receive() {}",
		},
		{
			name: "literal grain replaces a non-word-aligned run",
			slot: CodeSourceLocator, source: "aaaa",
			quote: "aa", occurrence: 1, grain: domain.GrainLiteral, replacement: "B",
			wantSource: "aaB",
		},
		{
			name: "a filename slot splices independently of source",
			slot: CodeFilenameLocator, source: "x", filename: "reciever.go",
			quote: "reciever", occurrence: 0, grain: domain.GrainWord, replacement: "receiver",
			wantSource: "x", wantFilename: "receiver.go",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			edit := codeAnchoredEdit(t, tc.source, tc.filename, tc.slot, tc.quote, tc.occurrence, tc.grain, tc.replacement)
			got, err := codeSpend(t, tc.source, tc.filename, edit)
			if err != nil {
				t.Fatalf("UpdateText: %v", err)
			}
			if s, _ := got.Attrs["source"].(string); s != tc.wantSource {
				t.Errorf("source = %q, want %q", s, tc.wantSource)
			}
			if f, _ := got.Attrs["filename"].(string); tc.wantFilename != "" && f != tc.wantFilename {
				t.Errorf("filename = %q, want %q", f, tc.wantFilename)
			}
		})
	}
}

// A batch is resolved against every named slot's CURRENT text and only then
// spliced, back to front within a slot — so two edits made at the same
// moment both land where they were read, and one edit's failure leaves every
// slot (not just its own) untouched.
func TestCodeBlockProcessor_UpdateTextBatchIsAllOrNothingAndBackToFront(t *testing.T) {
	const source = "teh cat sat on teh mat"
	first := codeAnchoredEdit(t, source, "", CodeSourceLocator, "teh", 0, domain.GrainWord, "the")
	second := codeAnchoredEdit(t, source, "", CodeSourceLocator, "teh", 1, domain.GrainWord, "THE")

	got, err := codeSpend(t, source, "", first, second)
	if err != nil {
		t.Fatalf("UpdateText: %v", err)
	}
	if want := "the cat sat on THE mat"; got.Attrs["source"] != want {
		t.Errorf("source = %q, want %q", got.Attrs["source"], want)
	}

	stale := codeAnchoredEdit(t, source, "", CodeSourceLocator, "wolrd", 0, domain.GrainWord, "world")
	got2, err := codeSpend(t, source, "", first, stale)
	if !errors.Is(err, block.ErrTextStale) {
		t.Fatalf("err = %v, want ErrTextStale", err)
	}
	if s, _ := got2.Attrs["source"].(string); s != source {
		t.Errorf("a failed batch must leave source untouched: %q", s)
	}

	// CROSS-SLOT: one edit per slot, one of them stale — all-or-nothing spans
	// slots, not just the one a failure happens to name.
	const filename = "reciever.go"
	sourceEdit := codeAnchoredEdit(t, source, filename, CodeSourceLocator, "teh", 0, domain.GrainWord, "the")
	filenameStale := codeAnchoredEdit(t, source, filename, CodeFilenameLocator, "wolrd", 0, domain.GrainWord, "world")
	got3, err := codeSpend(t, source, filename, sourceEdit, filenameStale)
	if !errors.Is(err, block.ErrTextStale) {
		t.Fatalf("err = %v, want ErrTextStale", err)
	}
	if s, _ := got3.Attrs["source"].(string); s != source {
		t.Errorf("a failed cross-slot batch must leave source untouched: %q", s)
	}
	if f, _ := got3.Attrs["filename"].(string); f != filename {
		t.Errorf("a failed cross-slot batch must leave filename untouched: %q", f)
	}
}

// What UpdateText refuses as STALE (the payload moved on) versus MALFORMED
// (no text could ever make the request resolve) — mirroring
// prose_reading_test.go's TestProseReading_AChangedPayloadStalesEveryAnchorIntoIt
// and TestProseReading_MalformedSpends for code's slotted, parse-free shape.
func TestCodeBlockProcessor_UpdateTextStaleAndMalformed(t *testing.T) {
	const source = "teh cat"
	edit := codeAnchoredEdit(t, source, "", CodeSourceLocator, "teh", 0, domain.GrainWord, "the")

	t.Run("the payload moved on since the anchor was read", func(t *testing.T) {
		const changed = "the cat, already fixed"
		got, err := codeSpend(t, changed, "", edit)
		if !errors.Is(err, block.ErrTextStale) {
			t.Errorf("err = %v, want ErrTextStale", err)
		}
		if s, _ := got.Attrs["source"].(string); s != changed {
			t.Errorf("content changed: %q", s)
		}
	})

	cases := []struct {
		name string
		edit domain.TextEdit
	}{
		{
			name: "a locator naming only the slot",
			edit: domain.TextEdit{Locator: CodeSourceLocator, Quote: "teh", Grain: domain.GrainWord, Replacement: "the"},
		},
		{
			name: "no locator at all",
			edit: domain.TextEdit{Quote: "teh", Grain: domain.GrainWord, Replacement: "the"},
		},
		{
			name: "a locator naming a slot code does not bear",
			edit: domain.TextEdit{Locator: `{"slot":"nonsense","hash":"abc"}`, Quote: "teh", Grain: domain.GrainWord, Replacement: "the"},
		},
		{
			name: "code's own locator, but the anchor declares no grain",
			edit: domain.TextEdit{Locator: edit.Locator, Quote: "teh", Replacement: "the"},
		},
		{
			name: "code's own locator, but a grain nothing counts in",
			edit: domain.TextEdit{Locator: edit.Locator, Quote: "teh", Grain: "sentence", Replacement: "the"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := codeSpend(t, source, "", tc.edit)
			if !errors.Is(err, block.ErrTextMalformed) {
				t.Errorf("err = %v, want ErrTextMalformed", err)
			}
			if errors.Is(err, block.ErrTextStale) {
				t.Error("a malformed request reported as stale")
			}
			if s, _ := got.Attrs["source"].(string); s != source {
				t.Errorf("content changed: %q", s)
			}
		})
	}
}

// A block with nothing to write to, and a batch with nothing to write.
func TestCodeBlockProcessor_UpdateTextNoBlockIsMalformedAndAnEmptyBatchIsANoOp(t *testing.T) {
	p := NewCodeBlockProcessor(block.BlockServices{})
	if err := p.UpdateText(nil, []domain.TextEdit{{Grain: domain.GrainWord}}); !errors.Is(err, block.ErrTextMalformed) {
		t.Errorf("err = %v, want ErrTextMalformed", err)
	}
	blk := codeBlockFrom("untouched", "")
	if err := p.UpdateText(&blk, nil); err != nil {
		t.Errorf("an empty batch: %v", err)
	}
	if s, _ := blk.Attrs["source"].(string); s != "untouched" {
		t.Errorf("empty batch changed content: %q", s)
	}
}
