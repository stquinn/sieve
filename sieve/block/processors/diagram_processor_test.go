package processors

import (
	"context"
	"sieve/sieve/block"
	"strings"
	"testing"
	"time"
)

func TestDiagramProcessor_InitAttrs_defaults(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	attrs := p.InitAttrs("di-a1b2", nil)

	if attrs["id"] != "di-a1b2" {
		t.Errorf("id: got %v, want di-a1b2", attrs["id"])
	}
	if attrs["status"] != block.BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE", attrs["status"])
	}
	if attrs["diagramType"] != "mermaid" {
		t.Errorf("diagramType: got %v, want mermaid", attrs["diagramType"])
	}
	// empty source → edit mode
	if attrs["mode"] != "edit" {
		t.Errorf("mode with empty source: got %v, want edit", attrs["mode"])
	}
	if attrs["supportsEmbedding"] != true {
		t.Errorf("supportsEmbedding: got %v, want true", attrs["supportsEmbedding"])
	}
	if attrs["createdAt"] == nil || attrs["createdAt"] == "" {
		t.Error("createdAt must be set")
	}
	for _, field := range []string{"source", "diagramType", "mode", "supportsEmbedding", "createdAt"} {
		if _, ok := attrs[field]; !ok {
			t.Errorf("InitAttrs must declare field %q", field)
		}
	}
}

func TestDiagramProcessor_InitAttrs_withSourceSetsRenderMode(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	attrs := p.InitAttrs("di-a1b2", map[string]interface{}{"source": "graph TD\n  A-->B"})
	if attrs["mode"] != "render" {
		t.Errorf("mode with source: got %v, want render", attrs["mode"])
	}
	if attrs["status"] != block.BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE", attrs["status"])
	}
}

func TestDiagramProcessor_InitAttrs_idNotOverridable(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	attrs := p.InitAttrs("di-0001", map[string]interface{}{"id": "injected"})
	if attrs["id"] != "di-0001" {
		t.Error("id must not be overridable via overrides")
	}
}

func TestDiagramProcessor_Mode(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	if p.Mode() != block.BlockModeBlock {
		t.Errorf("Mode: got %v, want block", p.Mode())
	}
}

func TestDiagramProcessor_IsBlock_mermaidFence(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	src := "graph TD\n  A[Start] --> B[End]"
	content := "```mermaid\n" + src + "\n```"
	if !p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: content}}).Has(block.ActionPaste) {
		t.Fatal("IsSupportedContent must offer paste for a mermaid fenced block")
	}
}

func TestDiagramProcessor_Transform_mermaidFence(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	src := "graph TD\n  A[Start] --> B[End]"
	content := "```mermaid\n" + src + "\n```"
	overrides := p.Transform([]block.ContentEntry{{MIMEType: "text/plain", Content: content}}, "", "", block.ActionPaste)
	if overrides == nil {
		t.Fatal("Transform must return non-nil for a mermaid fenced block")
	}
	if overrides["source"] != src {
		t.Errorf("source: got %v, want %q", overrides["source"], src)
	}
	// mode is not set by Transform — InitAttrs derives it from source presence
}

func TestDiagramProcessor_IsBlock_otherFence(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	if p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: "```go\nfunc main() {}\n```"}}).Has(block.ActionPaste) {
		t.Error("IsSupportedContent must not offer paste for non-mermaid fenced block")
	}
}

func TestDiagramProcessor_IsBlock_plainText(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	if p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: "hello world"}}).Has(block.ActionPaste) {
		t.Error("IsSupportedContent must not offer paste for plain text")
	}
}

func TestDiagramProcessor_Transform_notIsBlock(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	overrides := p.Transform([]block.ContentEntry{{MIMEType: "text/plain", Content: "hello world"}}, "", "", block.ActionPaste)
	if overrides != nil {
		t.Error("Transform must return nil when IsSupportedContent offers no paste")
	}
}

func TestDiagramProcessor_BuildContext_withSource(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	blk := block.SieveBlock{
		ID:    "di-0001",
		Kind:  "diagram",
		Attrs: map[string]interface{}{"source": "graph TD\n  A-->B"},
	}
	ctx := p.BuildContext(blk, block.DocView{}, map[string]bool{})
	if ctx.IsEmpty() {
		t.Error("BuildContext must return non-empty string when source is set")
	}
	if !strings.Contains(ctx.String(), "```mermaid") {
		t.Error("BuildContext must include mermaid fence")
	}
	if !strings.Contains(ctx.String(), "di-0001") {
		t.Error("BuildContext must include NODE ID")
	}
}

func TestDiagramProcessor_BuildContext_emptySource(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	blk := block.SieveBlock{ID: "di-0001", Kind: "diagram", Attrs: map[string]interface{}{"source": ""}}
	if ctx := p.BuildContext(blk, block.DocView{}, map[string]bool{}); !ctx.IsEmpty() {
		t.Errorf("BuildContext must return empty for empty source; got %q", ctx)
	}
}

func TestDiagramProcessor_MarkdownRepresentation_withSource(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	blk := block.SieveBlock{Attrs: map[string]interface{}{"source": "graph TD\n  A-->B"}}
	got := p.MarkdownRepresentation(blk, "")
	want := "```mermaid\ngraph TD\n  A-->B\n```"
	if got != want {
		t.Errorf("MarkdownRepresentation: got %q, want %q", got, want)
	}
}

func TestDiagramProcessor_MarkdownRepresentation_emptySource(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	blk := block.SieveBlock{Attrs: map[string]interface{}{"source": ""}}
	if got := p.MarkdownRepresentation(blk, ""); got != "" {
		t.Errorf("MarkdownRepresentation must return empty string for empty source; got %q", got)
	}
}

func TestDiagramProcessor_DescribeJob_noJob(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	blk := &block.SieveBlock{
		ID:   "di-0001",
		Kind: "diagram",
		Attrs: map[string]interface{}{
			"status":    block.BlockStatusComplete,
			"createdAt": time.Now().UTC().Format(time.RFC3339),
		},
	}
	// A diagram has no async work: it renders client-side and is born COMPLETE by
	// InitAttrs, so DescribeJob returns nil (never dispatched, never submitted).
	if job := p.DescribeJob(block.JobContext{Ctx: context.Background(), UUID: "test", Block: blk}); job != nil {
		t.Errorf("diagram must return a nil job, got %+v", job)
	}
}
