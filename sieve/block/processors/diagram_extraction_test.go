package processors

import (
	"encoding/json"
	"sieve/sieve/block"
	"testing"
)

// sieveDiagramEntries mirrors what the frontend emits when a diagram block is the
// extraction/copy source: the renderer's own custom view (raw source as text/plain)
// PLUS the framework's sieve/<kind> view carrying attrs as a JSON map.
func sieveDiagramEntries(t *testing.T, source string) []block.ContentEntry {
	t.Helper()
	attrs := map[string]interface{}{
		"kind":        "diagram",
		"diagramType": "mermaid",
		"source":      source,
	}
	js, err := json.Marshal(attrs)
	if err != nil {
		t.Fatalf("marshal attrs: %v", err)
	}
	return []block.ContentEntry{
		{MIMEType: "text/plain", Content: source},
		{MIMEType: "sieve/diagram", Content: string(js)},
	}
}

// A diagram block must be extractable as an Image — the regression that went
// missing when serialisedForm was retired and the framework pushed an empty view.
func TestDiagram_ExtractsAsImage(t *testing.T) {
	entries := sieveDiagramEntries(t, "graph TD\n  A-->B")
	if !NewSmartImageProcessor(block.BlockServices{}).IsBlock(entries) {
		t.Fatal("smart-image must offer extraction from a sieve/diagram view (Extract as Image)")
	}
}

// A diagram's source is mermaid code — it must also be extractable as a Code block,
// preserving the mermaid language despite the raw-source text/plain view.
func TestDiagram_ExtractsAsCode(t *testing.T) {
	entries := sieveDiagramEntries(t, "graph TD\n  A-->B")
	code := NewCodeBlockProcessor(block.BlockServices{})
	if !code.IsBlock(entries) {
		t.Fatal("code must offer extraction from a sieve/diagram view (Extract as Code)")
	}
	got := code.Transform(entries, "", "")
	if got == nil {
		t.Fatal("code.Transform returned nil for a diagram view")
	}
	if got["language"] != "mermaid" {
		t.Errorf("language: got %v, want mermaid (typed sieve view must win over raw text)", got["language"])
	}
	if got["source"] != "graph TD\n  A-->B" {
		t.Errorf("source: got %q", got["source"])
	}
}

// A non-image, non-code target must NOT claim a diagram.
func TestDiagram_NotACardOrWebClip(t *testing.T) {
	entries := sieveDiagramEntries(t, "graph TD\n  A-->B")
	if NewSmartCardProcessor(block.BlockServices{}).IsBlock(entries) {
		t.Error("smart-card must not claim a diagram view")
	}
	if NewWebClipBlockProcessor(block.BlockServices{}).IsBlock(entries) {
		t.Error("web-clip must not claim a diagram view")
	}
}

// The reverse conversion still works on the new JSON-attrs wire format: a code
// block whose language is mermaid is recognised + transformed into a diagram.
func TestCodeMermaid_ExtractsAsDiagram(t *testing.T) {
	attrs := map[string]interface{}{"kind": "code", "language": "mermaid", "source": "graph TD\n  A-->B"}
	js, _ := json.Marshal(attrs)
	entries := []block.ContentEntry{{MIMEType: "sieve/code", Content: string(js)}}

	dia := NewDiagramProcessor(block.BlockServices{})
	if !dia.IsBlock(entries) {
		t.Fatal("diagram must recognise a sieve/code view with language mermaid")
	}
	got := dia.Transform(entries, "", "")
	if got == nil || got["source"] != "graph TD\n  A-->B" {
		t.Errorf("diagram.Transform: got %v", got)
	}
}
