package processors

import (
	"sieve/sieve/block"
	"strings"
	"testing"
)

// fakeRegistry lets us exercise the codec dispatch with a controlled processor set.
type fakeRegistry struct {
	byKind  map[string]block.BlockProcessor
	ordered []block.BlockProcessor
}

func (f fakeRegistry) Get(kind string) block.BlockProcessor { return f.byKind[kind] }
func (f fakeRegistry) Ordered() []block.BlockProcessor      { return f.ordered }

func newFakeRegistry() fakeRegistry {
	prose := &ProseProcessor{}
	code := NewCodeBlockProcessor(block.BlockServices{})
	return fakeRegistry{
		byKind:  map[string]block.BlockProcessor{block.KindProse: prose, "code": code},
		ordered: []block.BlockProcessor{code, prose}, // structured first, prose terminal
	}
}

func TestDocumentCodec_DeserializeStructuredAndProse(t *testing.T) {
	c := block.NewDocumentCodec(newFakeRegistry())
	md := "intro prose\n\n```code\nid: co-1\nsource: x\n```\n\ntrailing prose"
	blocks, err := c.Deserialize(md)
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 3 {
		t.Fatalf("want prose, code, prose = 3 blocks, got %d: %#v", len(blocks), blocks)
	}
	if blocks[0].Kind != block.KindProse || blocks[1].Kind != "code" || blocks[2].Kind != block.KindProse {
		t.Errorf("kinds = %q/%q/%q", blocks[0].Kind, blocks[1].Kind, blocks[2].Kind)
	}
	if blocks[1].ID != "co-1" {
		t.Errorf("code id = %q, want co-1", blocks[1].ID)
	}
}

// TestDocumentCodec_LegacyBlockAnchorUpgradesToProse verifies the retired
// [!block] id="X" … [!block-end] anchor format silently upgrades on read: the
// region becomes a prose block CARRYING the anchor's id (so AI ref chains that
// pointed at "X" still resolve), wrapper delimiters stripped. Anchors were
// prose's id-carrier before native prose ids (D-r.7); prose now carries the id
// directly, so the anchor is redundant and reads as plain id-bearing prose.
func TestDocumentCodec_LegacyBlockAnchorUpgradesToProse(t *testing.T) {
	c := block.NewDocumentCodec(newFakeRegistry())
	md := "[!block] id=\"blk-1\"\n\nHello world.\n\n[!block-end]"
	blocks, err := c.Deserialize(md)
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 1 {
		t.Fatalf("want 1 prose block, got %d: %#v", len(blocks), blocks)
	}
	if blocks[0].Kind != block.KindProse {
		t.Errorf("kind = %q, want prose", blocks[0].Kind)
	}
	if blocks[0].ID != "blk-1" {
		t.Errorf("id = %q, want blk-1 (anchor id preserved)", blocks[0].ID)
	}
	if blocks[0].Content() != "Hello world." {
		t.Errorf("content = %q, want %q (delimiters stripped)", blocks[0].Content(), "Hello world.")
	}
}

// TestDocumentCodec_LegacyAnchorWrappingStructuredBlockStrips: when a retired
// anchor wrapped a STRUCTURED block, the fence splits the open/close into
// separate prose regions that cannot pair. The inner block survives as itself;
// the orphaned delimiter lines are stripped, never leaking as literal prose.
func TestDocumentCodec_LegacyAnchorWrappingStructuredBlockStrips(t *testing.T) {
	c := block.NewDocumentCodec(newFakeRegistry())
	md := "[!block] id=\"blk-1\"\n\n```code\nid: co-1\nsource: x\n```\n\n[!block-end]"
	blocks, err := c.Deserialize(md)
	if err != nil {
		t.Fatal(err)
	}
	var codeCount int
	for _, b := range blocks {
		if b.Kind == block.KindProse && strings.Contains(b.Content(), "[!block") {
			t.Errorf("anchor delimiter leaked into prose: %q", b.Content())
		}
		if b.Kind == "code" {
			codeCount++
			if b.ID != "co-1" {
				t.Errorf("code id = %q, want co-1", b.ID)
			}
		}
	}
	if codeCount != 1 {
		t.Fatalf("want exactly 1 code block, got %d: %#v", codeCount, blocks)
	}
}

func TestDocumentCodec_UnclaimedFenceCoalescesIntoProse(t *testing.T) {
	c := block.NewDocumentCodec(newFakeRegistry())
	// ```python is unclaimed → it must stay as ONE prose block with its neighbours.
	md := "before\n```python\nprint(1)\n```\nafter"
	blocks, err := c.Deserialize(md)
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 1 || blocks[0].Kind != block.KindProse {
		t.Fatalf("want a single prose block, got %#v", blocks)
	}
	if blocks[0].Content() != md {
		t.Errorf("prose content = %q, want verbatim %q", blocks[0].Content(), md)
	}
}

func TestFencedDeserializer_AcceptsOnlyMatchingKind(t *testing.T) {
	d := block.FencedDeserializer{Kind: "code"}
	if !d.Accepts(block.Region{Kind: "code", Body: "id: co-1\n"}) {
		t.Error("must accept a region whose Kind matches")
	}
	if d.Accepts(block.Region{Kind: "diagram", Body: "id: dg-1\n"}) {
		t.Error("must reject a region of a different kind")
	}
	if d.Accepts(block.Region{Kind: "", Body: "plain text"}) {
		t.Error("must reject a text region (empty Kind)")
	}
}

func TestFencedDeserializer_DeserializeBuildsOneBlock(t *testing.T) {
	// In the shape-driven scanner, Body == Raw (verbatim span including delimiters).
	// The FencedDeserializer.fencedBody strips the opening/closing fence lines to
	// recover the YAML interior.
	raw := "```code\nid: co-1\nsource: hi\n```\n"
	d := block.FencedDeserializer{Kind: "code"}
	blocks, err := d.Deserialize(block.Region{Kind: "code", Body: raw, Raw: raw})
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
	var d block.InlineDeserializer
	if d.Accepts(block.Region{Kind: "smart-link", Body: "{}"}) {
		t.Error("inline deserializer must never accept a document region")
	}
}

func TestDocumentCodec_AllProse(t *testing.T) {
	c := block.NewDocumentCodec(newFakeRegistry())
	md := "just a paragraph\n\nand another"
	blocks, err := c.Deserialize(md)
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) < 1 {
		t.Fatalf("want at least 1 prose block, got 0")
	}
	for i, b := range blocks {
		if b.Kind != block.KindProse {
			t.Errorf("block[%d] kind = %q, want %q", i, b.Kind, block.KindProse)
		}
	}
}

func TestDocumentCodec_OnlyStructuredNoSpuriousProse(t *testing.T) {
	c := block.NewDocumentCodec(newFakeRegistry())
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
	c := block.NewDocumentCodec(newFakeRegistry())
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

func TestDocumentCodec_RoundTrip(t *testing.T) {
	// Register the "code" processor in the global registry so GlobalRegistry()
	// can accept code regions during Deserialize. ProseProcessor self-registers
	// via init(), so KindProse is always present.
	block.RegisterProcessor("code", NewCodeBlockProcessor(block.BlockServices{}))
	t.Cleanup(func() { block.UnregisterProcessor("code") })

	c := block.NewDocumentCodec(block.GlobalRegistry()) // REAL registry — production path
	original := []block.SieveBlock{
		block.NewSieveBlock(block.KindProse, "pr-1", "An intro paragraph.", nil),
		block.NewSieveBlock("code", "co-1", "", map[string]interface{}{"id": "co-1", "source": "x := 1"}),
		block.NewSieveBlock(block.KindProse, "pr-2", "A closing paragraph.", nil),
	}
	md, err := c.Serialize(original)
	if err != nil {
		t.Fatal(err)
	}
	got, err := c.Deserialize(md)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(original) {
		t.Fatalf("round-trip changed block count: %d → %d\n%s", len(original), len(got), md)
	}
	for i := range original {
		if got[i].ID != original[i].ID || got[i].Kind != original[i].Kind {
			t.Errorf("block %d: %q/%q → %q/%q", i, original[i].ID, original[i].Kind, got[i].ID, got[i].Kind)
		}
	}
	// Serialize(Deserialize(md)) is idempotent.
	md2, err := c.Serialize(got)
	if err != nil {
		t.Fatal(err)
	}
	if md2 != md {
		t.Errorf("re-serialize not idempotent:\n--- first ---\n%s\n--- second ---\n%s", md, md2)
	}
}

// TestDocumentCodec_ProcessorlessFenceCoalescesToProse verifies that a fenced
// block whose kind has NO registered processor is NOT treated as structured —
// the registry is the sole authority on supported kinds — so it coalesces into
// the prose mop-up with its fence text preserved verbatim. Any future kind that
// registers a processor is claimed and becomes structured automatically.
func TestDocumentCodec_ProcessorlessFenceCoalescesToProse(t *testing.T) {
	// newFakeRegistry registers only code + prose; "mystery" has no processor.
	c := block.NewDocumentCodec(newFakeRegistry())
	md := "```mystery\nfoo: bar\nbaz: 1\n```"
	blocks, err := c.Deserialize(md)
	if err != nil {
		t.Fatal(err)
	}
	for i, b := range blocks {
		if b.Kind != block.KindProse {
			t.Errorf("block[%d] kind = %q, want prose (mystery has no processor)", i, b.Kind)
		}
	}
	var combined string
	for _, b := range blocks {
		combined += b.Content()
	}
	if !strings.Contains(combined, "foo: bar") {
		t.Errorf("processor-less fence text not preserved verbatim in prose: %q", combined)
	}
}

// TestDocumentCodec_PlainLanguageFenceStaysProse verifies that a normal code
// fence (e.g. ```python) whose body is NOT YAML with an "id" field still
// coalesces into prose together with its neighbouring text. The existing
// TestDocumentCodec_UnclaimedFenceCoalescesIntoProse covers a minimal case;
// this test exercises the three-segment (before + fence + after) variant.
func TestDocumentCodec_PlainLanguageFenceStaysProse(t *testing.T) {
	c := block.NewDocumentCodec(newFakeRegistry())
	md := "text\n\n```python\nprint(1)\n```\n\nmore"
	blocks, err := c.Deserialize(md)
	if err != nil {
		t.Fatal(err)
	}
	// All blocks must be prose.
	for i, b := range blocks {
		if b.Kind != block.KindProse {
			t.Errorf("block[%d] kind = %q, want prose (python fence has no YAML id)", i, b.Kind)
		}
	}
	// The python fence text must survive verbatim in at least one prose block.
	var combined string
	for _, b := range blocks {
		combined += b.Content()
	}
	if !strings.Contains(combined, "print(1)") {
		t.Errorf("python fence body not found in prose content: %q", combined)
	}
}

func TestGlobalRegistry_GetAndOrdered(t *testing.T) {
	reg := block.GlobalRegistry()
	if reg.Get(block.KindProse) == nil {
		t.Fatal("prose must always be resolvable")
	}
	if reg.Get("definitely-not-a-kind") != nil {
		t.Error("unknown kind must resolve to nil")
	}
	if len(reg.Ordered()) == 0 {
		t.Error("Ordered must return the registered processors")
	}
}
