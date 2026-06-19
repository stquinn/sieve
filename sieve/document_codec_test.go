package sieve

import "testing"

func TestFencedDeserializer_AcceptsOnlyMatchingKind(t *testing.T) {
	d := FencedDeserializer{Kind: "code"}
	if !d.Accepts(Region{Kind: "code", Body: "id: co-1\n"}) {
		t.Error("must accept a region whose Kind matches")
	}
	if d.Accepts(Region{Kind: "diagram", Body: "id: dg-1\n"}) {
		t.Error("must reject a region of a different kind")
	}
	if d.Accepts(Region{Kind: "", Body: "plain text"}) {
		t.Error("must reject a text region (empty Kind)")
	}
}

func TestFencedDeserializer_DeserializeBuildsOneBlock(t *testing.T) {
	d := FencedDeserializer{Kind: "code"}
	blocks, err := d.Deserialize(Region{Kind: "code", Body: "id: co-1\nsource: hi\n"})
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 1 {
		t.Fatalf("want 1 block, got %d", len(blocks))
	}
	if blocks[0].ID != "co-1" || blocks[0].Kind != "code" {
		t.Errorf("got id=%q kind=%q, want co-1/code", blocks[0].ID, blocks[0].Kind)
	}
	if blocks[0].Source() != "hi" {
		t.Errorf("source = %q, want hi", blocks[0].Source())
	}
}

func TestInlineDeserializer_NeverClaimsDuringDocParse(t *testing.T) {
	// inline != block: inline flavours are not recognised from disk this pass.
	var d InlineDeserializer
	if d.Accepts(Region{Kind: "smart-link", Body: "{}"}) {
		t.Error("inline deserializer must never accept a document region")
	}
}
