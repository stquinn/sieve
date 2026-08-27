package processors

import (
	"strings"
	"testing"

	"sieve/sieve/block"
)

// questionElements builds a question composed of a target reference and the
// authored text — the two element shapes an ai-block holds.
func questionElements() block.Elements {
	return block.Elements{
		block.NewSieveBlock("reference", "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01", map[string]interface{}{
			"uri": "sieve://0197b1f4-1111-7222-8333-444455556666/0197b1f4-2222-7222-8333-444455556666",
			"rel": "target",
		}),
		block.NewSieveBlock(block.KindProse, "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02", map[string]interface{}{
			"content": "What does this mean?",
		}),
	}
}

func aiBlockWithQuestion() block.SieveBlock {
	blk := block.NewSieveBlock("ai-block", "0197b1f4-0000-7888-8999-aaaabbbbcccc", map[string]interface{}{
		"type": "ASK",
	})
	blk.SetElements(block.QuestionAttr, questionElements())
	return blk
}

// Implementing the capability IS the has-children predicate: a caller asserts it
// off the registry and never names the kinds that nest.
func TestAIBlock_IsABlockParent(t *testing.T) {
	resetRegistry()
	defer resetRegistry()
	block.RegisterProcessor(NewAIBlockProcessor(block.BlockServices{}))

	parent, ok := block.GetProcessor("ai-block").(block.BlockParent)
	if !ok {
		t.Fatal("the ai-block processor does not implement BlockParent")
	}
	if _, isParent := block.GetProcessor(block.KindProse).(block.BlockParent); isParent {
		t.Error("prose implements BlockParent; only kinds that hold elements may")
	}

	blk := aiBlockWithQuestion()
	children := parent.Children(&blk)
	if len(children) != 2 {
		t.Fatalf("Children returned %d elements, want 2", len(children))
	}
	if children[0].Kind != "reference" || children[1].Kind != block.KindProse {
		t.Errorf("element order was not preserved: %q, %q", children[0].Kind, children[1].Kind)
	}
}

// An element carries the block's own attrs, so an attr written through one is an
// edit to what the block holds.
func TestAIBlock_ChildrenAreLive(t *testing.T) {
	p := &AIBlockProcessor{}
	blk := aiBlockWithQuestion()

	p.Children(&blk)[1].Attrs["content"] = "edited"

	if got := p.Children(&blk)[1].Content(); got != "edited" {
		t.Errorf("the edit was lost: content = %q", got)
	}
}

func TestAIBlock_ChildrenOfAQuestionlessBlock(t *testing.T) {
	p := &AIBlockProcessor{}
	blk := block.NewSieveBlock("ai-block", "ai-1", map[string]interface{}{"type": "ASK"})
	if got := p.Children(&blk); got != nil {
		t.Errorf("Children = %v for a block holding no question", got)
	}
}

// The element list rides the shared fenced serdes, so it round-trips through the
// block's own on-disk form with kinds, ids and payloads intact.
func TestAIBlock_QuestionElementsRoundTripThroughTheFence(t *testing.T) {
	p := NewAIBlockProcessor(block.BlockServices{})
	fence, err := p.Serialize(aiBlockWithQuestion())
	if err != nil {
		t.Fatalf("Serialize: %v", err)
	}

	blocks, err := p.Deserialize(block.Region{Kind: "ai-block", Raw: fence})
	if err != nil {
		t.Fatalf("Deserialize: %v", err)
	}
	got := blocks[0].Elements(block.QuestionAttr)
	want := questionElements()
	if len(got) != len(want) {
		t.Fatalf("round trip returned %d elements, want %d\n%s", len(got), len(want), fence)
	}
	for i := range want {
		if got[i].Kind != want[i].Kind || got[i].ID != want[i].ID {
			t.Errorf("element %d = %q/%q, want %q/%q", i, got[i].Kind, got[i].ID, want[i].Kind, want[i].ID)
		}
	}
	if got[0].Attrs["uri"] != want[0].Attrs["uri"] {
		t.Errorf("reference element uri = %v", got[0].Attrs["uri"])
	}
	if got[1].Content() != "What does this mean?" {
		t.Errorf("prose element content = %q", got[1].Content())
	}
}

// A question is user text and may hold a fence of its own; the serialized parent
// must not be torn apart by it.
func TestAIBlock_QuestionElementCannotCloseTheParentFence(t *testing.T) {
	p := NewAIBlockProcessor(block.BlockServices{})
	const authored = "Why does this fail?\n\n```go\nfunc main() {}\n```\n"
	blk := block.NewSieveBlock("ai-block", "ai-1", map[string]interface{}{"type": "ASK"})
	blk.SetElements(block.QuestionAttr, block.Elements{
		block.NewSieveBlock(block.KindProse, "el-1", map[string]interface{}{"content": authored}),
	})

	fence, err := p.Serialize(blk)
	if err != nil {
		t.Fatalf("Serialize: %v", err)
	}
	body := strings.TrimSuffix(strings.TrimPrefix(fence, "```ai-block\n"), "\n```")
	if strings.Contains(body, "\n```") {
		t.Fatalf("the element body closes the parent fence:\n%s", fence)
	}

	blocks, err := p.Deserialize(block.Region{Kind: "ai-block", Raw: fence})
	if err != nil {
		t.Fatalf("Deserialize: %v", err)
	}
	got := blocks[0].Elements(block.QuestionAttr)
	if len(got) != 1 || got[0].Content() != authored {
		t.Errorf("fenced question content did not round-trip verbatim: %q", got[0].Content())
	}
}
