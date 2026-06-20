package processors

import (
	"os"
	"sieve/sieve/block"
	"strings"
	"testing"
)

// A real user document with a legacy [!block]...[!block-end] anchor (wrapping
// prose with a ==data== highlight) plus two ai-block fences. After the anchor
// retirement it must (a) survive the Doc-authoritative save path
// (Deserialize -> Serialize) with no content loss, (b) silently UPGRADE the
// anchor to an id-bearing prose block (delimiters stripped, the blk-4cea id
// preserved so AI chains resolve), and (c) be a serialization fixpoint.
func TestRoundTrip_LegacyAnchorUpgrade_AiBlockFixture(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor("ai-block", NewAIBlockProcessor(block.BlockServices{}))

	src, err := os.ReadFile("testdata/blockref_aiblock.md")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	original := string(src)

	doc, err := block.NewDocumentCodec(block.GlobalRegistry()).Deserialize(original)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	out1, err := block.NewDocumentCodec(block.GlobalRegistry()).Serialize(doc)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}

	// No content loss: the load-bearing text from every block survives.
	mustContain := []string{
		"test", "==data==", // prose inside the upgraded anchor (highlight preserved)
		"WHat does this do?",          // ai-229a question
		"IS that to standard IO?",     // ai-2b8f question
		"prints to **Standard Output", // ai-2b8f response body
		"ai-229a", "ai-2b8f",          // block ids
		`<!--s:blk-4cea-->`, // anchor id preserved as an id-bearing prose block
	}
	for _, frag := range mustContain {
		if !strings.Contains(out1, frag) {
			t.Errorf("round-trip dropped %q\n--- output ---\n%s", frag, out1)
		}
	}

	// The retired anchor delimiters must be gone — silently upgraded, not leaked.
	for _, gone := range []string{"[!block]", "[!block-end]"} {
		if strings.Contains(out1, gone) {
			t.Errorf("legacy anchor delimiter %q leaked into output\n--- output ---\n%s", gone, out1)
		}
	}

	// Stability: parse -> serialize is a fixpoint after the first normalization.
	doc2, err := block.NewDocumentCodec(block.GlobalRegistry()).Deserialize(out1)
	if err != nil {
		t.Fatalf("reparse: %v", err)
	}
	out2, err := block.NewDocumentCodec(block.GlobalRegistry()).Serialize(doc2)
	if err != nil {
		t.Fatalf("reserialize: %v", err)
	}
	if out1 != out2 {
		t.Fatalf("serialization not stable:\n--- first ---\n%s\n--- second ---\n%s", out1, out2)
	}
}
