package sieve

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestDiagramProcessor_InitAttrs_defaults(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	attrs := p.InitAttrs("di-a1b2", nil)

	if attrs["id"] != "di-a1b2" {
		t.Errorf("id: got %v, want di-a1b2", attrs["id"])
	}
	if attrs["status"] != BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE", attrs["status"])
	}
	if attrs["diagramType"] != "mermaid" {
		t.Errorf("diagramType: got %v, want mermaid", attrs["diagramType"])
	}
	// empty source → edit mode
	if attrs["mode"] != "edit" {
		t.Errorf("mode with empty source: got %v, want edit", attrs["mode"])
	}
	if attrs["supportsPromotion"] != true {
		t.Errorf("supportsPromotion: got %v, want true", attrs["supportsPromotion"])
	}
	if attrs["createdAt"] == nil || attrs["createdAt"] == "" {
		t.Error("createdAt must be set")
	}
	for _, field := range []string{"source", "diagramType", "mode", "supportsPromotion", "createdAt"} {
		if _, ok := attrs[field]; !ok {
			t.Errorf("InitAttrs must declare field %q", field)
		}
	}
}

func TestDiagramProcessor_InitAttrs_withSourceSetsRenderMode(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	attrs := p.InitAttrs("di-a1b2", map[string]interface{}{"source": "graph TD\n  A-->B"})
	if attrs["mode"] != "render" {
		t.Errorf("mode with source: got %v, want render", attrs["mode"])
	}
	if attrs["status"] != BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE", attrs["status"])
	}
}

func TestDiagramProcessor_InitAttrs_idNotOverridable(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	attrs := p.InitAttrs("di-0001", map[string]interface{}{"id": "injected"})
	if attrs["id"] != "di-0001" {
		t.Error("id must not be overridable via overrides")
	}
}

func TestDiagramProcessor_Mode(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	if p.Mode() != BlockModeBlock {
		t.Errorf("Mode: got %v, want block", p.Mode())
	}
}

func TestDiagramProcessor_PasteMatch_mermaidFence(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	src := "graph TD\n  A[Start] --> B[End]"
	content := "```mermaid\n" + src + "\n```"
	matched, overrides := p.PasteMatch([]PasteEntry{{MIMEType: "text/plain", Content: content}}, "", "")
	if !matched {
		t.Fatal("PasteMatch must return true for a mermaid fenced block")
	}
	if overrides["source"] != src {
		t.Errorf("source: got %v, want %q", overrides["source"], src)
	}
	if overrides["mode"] != "render" {
		t.Errorf("mode override: got %v, want render", overrides["mode"])
	}
}

func TestDiagramProcessor_PasteMatch_otherFence(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	ok, _ := p.PasteMatch([]PasteEntry{{MIMEType: "text/plain", Content: "```go\nfunc main() {}\n```"}}, "", "")
	if ok {
		t.Error("PasteMatch must return false for non-mermaid fenced block")
	}
}

func TestDiagramProcessor_PasteMatch_plainText(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	ok, _ := p.PasteMatch([]PasteEntry{{MIMEType: "text/plain", Content: "hello world"}}, "", "")
	if ok {
		t.Error("PasteMatch must return false for plain text")
	}
}

func TestDiagramProcessor_BuildContext_withSource(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	block := SieveBlock{
		ID:    "di-0001",
		Kind:  "diagram",
		Attrs: map[string]interface{}{"source": "graph TD\n  A-->B"},
	}
	ctx := p.BuildContext(block, ShadowDocument{}, map[string]bool{})
	if ctx == "" {
		t.Error("BuildContext must return non-empty string when source is set")
	}
	if !strings.Contains(ctx, "```mermaid") {
		t.Error("BuildContext must include mermaid fence")
	}
	if !strings.Contains(ctx, "di-0001") {
		t.Error("BuildContext must include NODE ID")
	}
}

func TestDiagramProcessor_BuildContext_emptySource(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	block := SieveBlock{ID: "di-0001", Kind: "diagram", Attrs: map[string]interface{}{"source": ""}}
	if ctx := p.BuildContext(block, ShadowDocument{}, map[string]bool{}); ctx != "" {
		t.Errorf("BuildContext must return empty for empty source; got %q", ctx)
	}
}

func TestDiagramProcessor_MarkdownRepresentation_withSource(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	block := SieveBlock{Attrs: map[string]interface{}{"source": "graph TD\n  A-->B"}}
	got := p.MarkdownRepresentation(block)
	want := "```mermaid\ngraph TD\n  A-->B\n```"
	if got != want {
		t.Errorf("MarkdownRepresentation: got %q, want %q", got, want)
	}
}

func TestDiagramProcessor_MarkdownRepresentation_emptySource(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	block := SieveBlock{Attrs: map[string]interface{}{"source": ""}}
	if got := p.MarkdownRepresentation(block); got != "" {
		t.Errorf("MarkdownRepresentation must return empty string for empty source; got %q", got)
	}
}

func TestDiagramProcessor_RunJob_noopComplete(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	block := &SieveBlock{
		ID:   "di-0001",
		Kind: "diagram",
		Attrs: map[string]interface{}{
			"status":    BlockStatusComplete,
			"createdAt": time.Now().UTC().Format(time.RFC3339),
		},
	}
	if err := p.RunJob(JobContext{Ctx: context.Background(), UUID: "test", Block: block}); err != nil {
		t.Fatalf("RunJob must not error; got %v", err)
	}
	if block.Attrs["status"] != BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE", block.Attrs["status"])
	}
}
