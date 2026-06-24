package processors

import (
	"testing"

	"sieve/sieve/block"
)

func TestProse_IsSupportedContent_anySieveSource_offersTransform(t *testing.T) {
	p := NewProseProcessor(block.BlockServices{})
	// A code block source (not sieve/prose) — prose must offer TRANSFORM (embed).
	got := p.IsSupportedContent([]block.ContentEntry{{MIMEType: "sieve/code", Content: `{"source":"x := 1","language":"go"}`}})
	if !got.Has(block.ActionTransform) {
		t.Fatalf("prose should offer transform for any sieve source, got %v", got.Actions)
	}
}

func TestProse_IsSupportedContent_ownKind_offersPasteAndTransform(t *testing.T) {
	p := NewProseProcessor(block.BlockServices{})
	// A copied prose block round-trips on paste AND can be embedded (transform).
	got := p.IsSupportedContent([]block.ContentEntry{{MIMEType: "sieve/prose", Content: `{"content":"hello"}`}})
	if !got.Has(block.ActionPaste) {
		t.Fatalf("prose should offer paste for sieve/prose source, got %v", got.Actions)
	}
	if !got.Has(block.ActionTransform) {
		t.Fatalf("prose should offer transform for sieve/prose source, got %v", got.Actions)
	}
}

func TestProse_IsSupportedContent_plainText_noMatch(t *testing.T) {
	p := NewProseProcessor(block.BlockServices{})
	got := p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: "hello"}})
	if len(got.Actions) != 0 {
		t.Fatalf("prose must never claim a non-sieve mime, got %v", got.Actions)
	}
}
