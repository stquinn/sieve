package sieve

import (
	"os"
	"strings"
	"testing"
)

// The user's real document that triggered thousands of errors: a legacy
// [!block]...[!block-end] blockRef plus two ai-block fences. It must survive the
// new Doc-authoritative save path (Deserialize -> Serialize) with no
// content loss, and serialization must be stable (a fixpoint).
func TestRoundTrip_BlockRefAiBlockFixture(t *testing.T) {
	resetRegistry()
	RegisterProcessor("ai-block", &testRunJobProcessor{})

	src, err := os.ReadFile("testdata/blockref_aiblock.md")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	original := string(src)

	doc, err := NewDocumentCodec(globalRegistry()).Deserialize(original)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	out1, err := NewDocumentCodec(globalRegistry()).Serialize(doc)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}

	// No content loss: the load-bearing text from every block survives.
	mustContain := []string{
		"test", "data", // prose inside the [!block] region
		"WHat does this do?",          // ai-229a question
		"IS that to standard IO?",     // ai-2b8f question
		"prints to **Standard Output", // ai-2b8f response body
		"ai-229a", "ai-2b8f",          // block ids
	}
	for _, frag := range mustContain {
		if !strings.Contains(out1, frag) {
			t.Errorf("round-trip dropped %q\n--- output ---\n%s", frag, out1)
		}
	}

	// Stability: parse -> serialize is a fixpoint after the first normalization.
	doc2, err := NewDocumentCodec(globalRegistry()).Deserialize(out1)
	if err != nil {
		t.Fatalf("reparse: %v", err)
	}
	out2, err := NewDocumentCodec(globalRegistry()).Serialize(doc2)
	if err != nil {
		t.Fatalf("reserialize: %v", err)
	}
	if out1 != out2 {
		t.Fatalf("serialization not stable:\n--- first ---\n%s\n--- second ---\n%s", out1, out2)
	}
}
