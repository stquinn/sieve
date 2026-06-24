package processors

import (
	"testing"

	"sieve/sieve/block"
)

func hasAction(s block.SupportedActions, a block.Action) bool { return s.Has(a) }

func TestCodeProcessor_IsSupportedContent_nativeFence_offersPasteAndTransform(t *testing.T) {
	p := NewCodeBlockProcessor(block.BlockServices{})
	got := p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: "```go\nx := 1\n```"}})
	if !hasAction(got, block.ActionPaste) || !hasAction(got, block.ActionTransform) {
		t.Fatalf("native fence should offer paste+transform, got %v", got.Actions)
	}
	if hasAction(got, block.ActionExtract) {
		t.Fatalf("native fence must not offer extract, got %v", got.Actions)
	}
}

func TestCodeProcessor_IsSupportedContent_sieveDiagram_offersPasteAndExtract(t *testing.T) {
	p := NewCodeBlockProcessor(block.BlockServices{})
	got := p.IsSupportedContent([]block.ContentEntry{{
		MIMEType: "sieve/diagram",
		Content:  `{"diagramType":"mermaid","source":"graph TD;A-->B"}`,
	}})
	if !hasAction(got, block.ActionPaste) {
		t.Fatalf("sieve source should also offer paste, got %v", got.Actions)
	}
	if !hasAction(got, block.ActionExtract) {
		t.Fatalf("sieve source should offer extract, got %v", got.Actions)
	}
}

func TestCodeProcessor_IsSupportedContent_noMatch_emptyActions(t *testing.T) {
	p := NewCodeBlockProcessor(block.BlockServices{})
	got := p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: "just prose"}})
	if len(got.Actions) != 0 {
		t.Fatalf("prose text must not match code, got %v", got.Actions)
	}
	if got.Kind != "code" {
		t.Fatalf("Kind should always be set, got %q", got.Kind)
	}
}
