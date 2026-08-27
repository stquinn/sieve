package processors

import (
	"strings"
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/domain"
)

// chainUUID is the container the chain fixtures live in — the naming authority
// their question elements are addressed against. chainOtherUUID is a second
// container, so a chain that leaves this one can be written down.
const (
	chainUUID      = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4aff"
	chainOtherUUID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4afe"
)

// chainAsk builds an ai-block in its current form: a question list naming the
// blocks in THIS container it is about, then its text. The handles stay readable
// — an address's leaf is whatever the container will be asked to look up.
func chainAsk(id, question string, targets ...string) block.SieveBlock {
	return chainAskIn(chainUUID, id, question, targets...)
}

// chainAskIn is chainAsk with the container its targets are named against, so a
// fixture can point at a block in another document.
func chainAskIn(container, id, question string, targets ...string) block.SieveBlock {
	blk := block.NewSieveBlock("ai-block", id, map[string]interface{}{"id": id, "type": "ASK"})
	var els block.Elements
	for _, t := range targets {
		els = append(els, block.NewSieveBlock(block.KindReference, "", map[string]interface{}{
			"uri": domain.NewLeafAddress(container, t).String(), "rel": block.RelTarget,
		}))
	}
	if question != "" {
		els = append(els, block.NewSieveBlock(block.KindProse, "", map[string]interface{}{"content": question}))
	}
	blk.SetElements(block.QuestionAttr, els)
	return blk
}

// A multi-block selection: the action's direct targets are a MANY of leaf blocks
// (the selected prose). All become the TARGET; there is no thread. This is the
// reported defect — previously the first block became TARGET and the rest were
// mis-filed as THREAD (prior Q&A history).
func TestResolveChain_multiBlockSelection_allTargetsNoThread(t *testing.T) {
	doc := block.DocView{UUID: chainUUID, Blocks: []block.SieveBlock{
		{ID: "pr-a", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "alpha"}},
		{ID: "pr-b", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "beta"}},
		{ID: "pr-c", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "gamma"}},
	}}
	w := (&AIBlockProcessor{}).resolveChain(chainAsk("ai-x", "", "pr-a", "pr-b", "pr-c"), doc)
	if strings.Join(w.local, ",") != "pr-a,pr-b,pr-c" {
		t.Fatalf("targets = %v, want all three leaves", w.local)
	}
	if len(w.thread) != 0 {
		t.Fatalf("thread = %v, want empty", w.thread)
	}
}

// A deep point-to-point chain (ai-d8ce -> ai-8af1 -> ai-cef2 -> [pr-1, pr-2]).
// The walk must descend the interior ai-blocks (THREAD) and reach the terminal MANY
// of leaves (TARGET) — the one-level expandAIBlockRefs could not, so the source data
// was unreachable on a pointer chain.
func TestResolveChain_deepPointerChain_terminalManyIsTarget(t *testing.T) {
	doc := block.DocView{UUID: chainUUID, Blocks: []block.SieveBlock{
		chainAsk("ai-cef2", "q1", "pr-1", "pr-2"),
		chainAsk("ai-8af1", "q2", "ai-cef2"),
		{ID: "pr-1", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "alpha"}},
		{ID: "pr-2", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "beta"}},
	}}
	w := (&AIBlockProcessor{}).resolveChain(chainAsk("ai-d8ce", "", "ai-8af1"), doc)
	if strings.Join(w.local, ",") != "pr-1,pr-2" {
		t.Fatalf("targets = %v, want the terminal MANY leaves [pr-1, pr-2]", w.local)
	}
	// Thread oldest-first: the deepest interior (ai-cef2) is oldest, then ai-8af1.
	if strings.Join(w.thread, ",") != "ai-cef2,ai-8af1" {
		t.Fatalf("thread = %v, want [ai-cef2, ai-8af1] oldest-first", w.thread)
	}
}

// A cyclic graph must terminate (the seen-guard) rather than loop forever.
func TestResolveChain_cycle_terminates(t *testing.T) {
	doc := block.DocView{UUID: chainUUID, Blocks: []block.SieveBlock{
		chainAsk("ai-1", "", "ai-2"),
		chainAsk("ai-2", "", "ai-1"),
	}}
	// Returning at all (no hang) is the assertion; order is meaningless in a cycle,
	// so just require each interior node exactly once and no leaf.
	w := (&AIBlockProcessor{}).resolveChain(chainAsk("ai-start", "", "ai-1"), doc)
	if len(w.local) != 0 || len(w.foreign) != 0 {
		t.Fatalf("a pure cycle has no leaf; targets = %v / %v", w.local, w.foreign)
	}
	if len(w.thread) != 2 || !strings.Contains(strings.Join(w.thread, ","), "ai-1") || !strings.Contains(strings.Join(w.thread, ","), "ai-2") {
		t.Fatalf("thread = %v, want both interior nodes exactly once", w.thread)
	}
}

// The action block itself is already seen, so a chain that points back at it
// terminates rather than re-walking it — and the guard recognises it by ADDRESS,
// which is how a node is named once a chain can leave its container.
func TestResolveChain_selfReferenceTerminates(t *testing.T) {
	doc := block.DocView{UUID: chainUUID, Blocks: []block.SieveBlock{
		chainAsk("ai-1", "", "ai-self"),
	}}
	self := chainAsk("ai-self", "", "ai-1")
	w := (&AIBlockProcessor{}).resolveChain(self, doc)
	if len(w.local) != 0 || len(w.foreign) != 0 {
		t.Fatalf("targets = %v / %v, want none", w.local, w.foreign)
	}
	if strings.Join(w.thread, ",") != "ai-1" {
		t.Fatalf("thread = %v, want just the one interior node", w.thread)
	}
}

// A chain link in ANOTHER container terminates the walk on that branch: reading
// a foreign document is how deeper history would be reached, and nothing foreign
// is read to compose a prompt. The link renders in place instead.
//
// The foreign target's leaf deliberately names a block that also exists HERE, so
// a walk that keyed on the bare handle rather than the address would descend
// into the local block and cross the boundary unnoticed.
func TestResolveChain_foreignLinkTerminatesTheWalk(t *testing.T) {
	doc := block.DocView{UUID: chainUUID, Blocks: []block.SieveBlock{
		chainAsk("ai-mine", "", "pr-1"),
		{ID: "pr-1", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "alpha"}},
	}}
	w := (&AIBlockProcessor{}).resolveChain(chainAskIn(chainOtherUUID, "ai-x", "", "ai-mine"), doc)

	if len(w.thread) != 0 {
		t.Errorf("the walk crossed the container boundary; thread = %v", w.thread)
	}
	if len(w.local) != 0 {
		t.Errorf("a foreign link resolved as a local handle; targets = %v", w.local)
	}
	if len(w.foreign) != 1 || w.foreign[0].StringAttr("uri") != domain.NewLeafAddress(chainOtherUUID, "ai-mine").String() {
		t.Fatalf("the foreign link is not a terminal target rendered in place: %+v", w.foreign)
	}
}

// The whole document is a leaf — a valid target terminus.
func TestResolveChain_docSentinelIsATargetLeaf(t *testing.T) {
	blk := block.NewSieveBlock("ai-block", "ai-x", map[string]interface{}{"type": "ASK"})
	blk.SetElements(block.QuestionAttr, block.Elements{
		block.NewSieveBlock(block.KindReference, "", map[string]interface{}{
			"uri": domain.NewContainerAddress(chainUUID).String(), "rel": block.RelTarget,
		}),
	})
	w := (&AIBlockProcessor{}).resolveChain(blk, block.DocView{UUID: chainUUID})
	if strings.Join(w.local, ",") != block.WholeDocumentRef || len(w.thread) != 0 {
		t.Fatalf("doc must be a target leaf; targets=%v thread=%v", w.local, w.thread)
	}
}

// The action ai-block's QUESTION ABOUT must reference its FULL direct ref (the MANY),
// not just the last segment — under the pointer model the whole ref is what it asks
// about, so a 3-block selection shows all three, not just the last.
func TestAIBlockBuildContext_questionAboutUsesFullDirectRef(t *testing.T) {
	resetRegistry()
	t.Cleanup(resetRegistry)

	p := &AIBlockProcessor{}
	blk := chainAsk("ai-cef2", "Multi span", "pr-c2dc", "pr-e51a", "pr-f405")
	ctx := p.BuildContext(blk, block.DocView{UUID: chainUUID}, map[string]bool{})
	if !strings.Contains(ctx.String(), "pr-c2dc,pr-e51a,pr-f405") {
		t.Fatalf("QUESTION ABOUT should reference the full direct ref, got: %q", ctx)
	}
}
