package sieve

import "testing"

// fakeRegistry lets us exercise the codec dispatch with a controlled processor set.
type fakeRegistry struct {
	byKind  map[string]BlockProcessor
	ordered []BlockProcessor
}

func (f fakeRegistry) Get(kind string) BlockProcessor { return f.byKind[kind] }
func (f fakeRegistry) Ordered() []BlockProcessor      { return f.ordered }

func newFakeRegistry() fakeRegistry {
	prose := &ProseProcessor{}
	code := NewCodeBlockProcessor(BlockServices{})
	return fakeRegistry{
		byKind:  map[string]BlockProcessor{KindProse: prose, "code": code},
		ordered: []BlockProcessor{code, prose}, // structured first, prose terminal
	}
}

func TestDocumentCodec_DeserializeStructuredAndProse(t *testing.T) {
	c := NewDocumentCodec(newFakeRegistry())
	md := "intro prose\n\n```code\nid: co-1\nsource: x\n```\n\ntrailing prose"
	blocks, err := c.Deserialize(md)
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 3 {
		t.Fatalf("want prose, code, prose = 3 blocks, got %d: %#v", len(blocks), blocks)
	}
	if blocks[0].Kind != KindProse || blocks[1].Kind != "code" || blocks[2].Kind != KindProse {
		t.Errorf("kinds = %q/%q/%q", blocks[0].Kind, blocks[1].Kind, blocks[2].Kind)
	}
	if blocks[1].ID != "co-1" {
		t.Errorf("code id = %q, want co-1", blocks[1].ID)
	}
}

func TestDocumentCodec_UnclaimedFenceCoalescesIntoProse(t *testing.T) {
	c := NewDocumentCodec(newFakeRegistry())
	// ```python is unclaimed → it must stay as ONE prose block with its neighbours.
	md := "before\n```python\nprint(1)\n```\nafter"
	blocks, err := c.Deserialize(md)
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 1 || blocks[0].Kind != KindProse {
		t.Fatalf("want a single prose block, got %#v", blocks)
	}
	if blocks[0].Content() != md {
		t.Errorf("prose content = %q, want verbatim %q", blocks[0].Content(), md)
	}
}

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

func TestDocumentCodec_AllProse(t *testing.T) {
	c := NewDocumentCodec(newFakeRegistry())
	md := "just a paragraph\n\nand another"
	blocks, err := c.Deserialize(md)
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) < 1 {
		t.Fatalf("want at least 1 prose block, got 0")
	}
	for i, b := range blocks {
		if b.Kind != KindProse {
			t.Errorf("block[%d] kind = %q, want %q", i, b.Kind, KindProse)
		}
	}
}

func TestDocumentCodec_OnlyStructuredNoSpuriousProse(t *testing.T) {
	c := NewDocumentCodec(newFakeRegistry())
	md := "```code\nid: co-1\nsource: x\n```"
	blocks, err := c.Deserialize(md)
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 1 {
		t.Fatalf("want exactly 1 block, got %d: %#v", len(blocks), blocks)
	}
	if blocks[0].Kind != "code" {
		t.Errorf("block[0] kind = %q, want \"code\"", blocks[0].Kind)
	}
	if blocks[0].ID != "co-1" {
		t.Errorf("block[0] id = %q, want \"co-1\"", blocks[0].ID)
	}
}

func TestDocumentCodec_BackToBackStructured(t *testing.T) {
	c := NewDocumentCodec(newFakeRegistry())
	md := "```code\nid: co-1\nsource: a\n```\n\n```code\nid: co-2\nsource: b\n```"
	blocks, err := c.Deserialize(md)
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 2 {
		t.Fatalf("want exactly 2 blocks, got %d: %#v", len(blocks), blocks)
	}
	if blocks[0].Kind != "code" || blocks[0].ID != "co-1" {
		t.Errorf("block[0] kind=%q id=%q, want code/co-1", blocks[0].Kind, blocks[0].ID)
	}
	if blocks[1].Kind != "code" || blocks[1].ID != "co-2" {
		t.Errorf("block[1] kind=%q id=%q, want code/co-2", blocks[1].Kind, blocks[1].ID)
	}
}

func TestGlobalRegistry_GetAndOrdered(t *testing.T) {
	reg := globalRegistry()
	if reg.Get(KindProse) == nil {
		t.Fatal("prose must always be resolvable")
	}
	if reg.Get("definitely-not-a-kind") != nil {
		t.Error("unknown kind must resolve to nil")
	}
	if len(reg.Ordered()) == 0 {
		t.Error("Ordered must return the registered processors")
	}
}
