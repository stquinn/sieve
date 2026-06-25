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

// A NATIVE image is a native source → smart-image must offer TRANSFORM (Convert), not
// EXTRACT. The Extract/Convert distinction is purely whether the source is a real Sieve
// view (JSON attrs) vs native content.
func TestSmartImageProcessor_IsSupportedContent_nativeURL_offersTransform(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})
	got := p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/uri-list", Content: "/sieve/x/im-1.svg"}})
	if !hasAction(got, block.ActionTransform) {
		t.Fatalf("native image URL should offer transform, got %v", got.Actions)
	}
	if hasAction(got, block.ActionExtract) {
		t.Fatalf("native image URL must NOT offer extract, got %v", got.Actions)
	}
}

func TestSmartImageProcessor_IsSupportedContent_realSieveView_offersExtract(t *testing.T) {
	// A real smart-image block emits sieve/<Kind()> = "sieve/smart-image" with JSON attrs.
	p := NewSmartImageProcessor(block.BlockServices{})
	got := p.IsSupportedContent([]block.ContentEntry{{MIMEType: "sieve/smart-image", Content: `{"src":"im-1.svg"}`}})
	if !hasAction(got, block.ActionExtract) {
		t.Fatalf("a real sieve/smart-image view (JSON attrs) should offer extract, got %v", got.Actions)
	}
}

// Guards the IsSieveType fix: a native <img> historically arrived as mimeType
// "sieve/image" but with a URL (not JSON) content. IsSieveType requires a JSON attrs
// body, so this must fall through to the image-URL branch → TRANSFORM, never EXTRACT.
func TestSmartImageProcessor_IsSupportedContent_nativeMislabeledSieve_stillTransform(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})
	got := p.IsSupportedContent([]block.ContentEntry{{MIMEType: "sieve/image", Content: "/sieve/x/im-1.svg"}})
	if !hasAction(got, block.ActionTransform) || hasAction(got, block.ActionExtract) {
		t.Fatalf("native image mislabeled sieve/image (URL content) should be transform, got %v", got.Actions)
	}
}
