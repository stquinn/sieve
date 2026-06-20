package processors

import (
	"strings"
	"testing"

	"sieve/sieve/block"
)

// A multi-block selection: the action's direct ref is a MANY of leaf blocks (the
// selected prose). All become the TARGET; there is no thread. This is the reported
// defect — previously the first block became TARGET and the rest were mis-filed as
// THREAD (prior Q&A history).
func TestResolveChain_multiBlockSelection_allTargetsNoThread(t *testing.T) {
	doc := block.DocView{Blocks: []block.SieveBlock{
		{ID: "pr-a", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "alpha"}},
		{ID: "pr-b", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "beta"}},
		{ID: "pr-c", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "gamma"}},
	}}
	targets, thread := (&AIBlockProcessor{}).resolveChain("ai-x", "pr-a,pr-b,pr-c", doc)
	if strings.Join(targets, ",") != "pr-a,pr-b,pr-c" {
		t.Fatalf("targets = %v, want all three leaves", targets)
	}
	if len(thread) != 0 {
		t.Fatalf("thread = %v, want empty", thread)
	}
}

// A deep point-to-point chain (ai-d8ce -> ai-8af1 -> ai-cef2 -> [pr-1, pr-2]).
// The walk must descend the interior ai-blocks (THREAD) and reach the terminal MANY
// of leaves (TARGET) — the one-level expandAIBlockRefs could not, so the source data
// was unreachable on a pointer chain.
func TestResolveChain_deepPointerChain_terminalManyIsTarget(t *testing.T) {
	doc := block.DocView{Blocks: []block.SieveBlock{
		{ID: "ai-cef2", Kind: "ai-block", Attrs: map[string]interface{}{"ref": "pr-1,pr-2", "question": "q1"}},
		{ID: "ai-8af1", Kind: "ai-block", Attrs: map[string]interface{}{"ref": "ai-cef2", "question": "q2"}},
		{ID: "pr-1", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "alpha"}},
		{ID: "pr-2", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "beta"}},
	}}
	targets, thread := (&AIBlockProcessor{}).resolveChain("ai-d8ce", "ai-8af1", doc)
	if strings.Join(targets, ",") != "pr-1,pr-2" {
		t.Fatalf("targets = %v, want the terminal MANY leaves [pr-1, pr-2]", targets)
	}
	// Thread oldest-first: the deepest interior (ai-cef2) is oldest, then ai-8af1.
	if strings.Join(thread, ",") != "ai-cef2,ai-8af1" {
		t.Fatalf("thread = %v, want [ai-cef2, ai-8af1] oldest-first", thread)
	}
}

// A cyclic graph must terminate (the seen-guard) rather than loop forever.
func TestResolveChain_cycle_terminates(t *testing.T) {
	doc := block.DocView{Blocks: []block.SieveBlock{
		{ID: "ai-1", Kind: "ai-block", Attrs: map[string]interface{}{"ref": "ai-2"}},
		{ID: "ai-2", Kind: "ai-block", Attrs: map[string]interface{}{"ref": "ai-1"}},
	}}
	// Returning at all (no hang) is the assertion; order is meaningless in a cycle,
	// so just require each interior node exactly once and no leaf.
	targets, thread := (&AIBlockProcessor{}).resolveChain("ai-start", "ai-1", doc)
	if len(targets) != 0 {
		t.Fatalf("a pure cycle has no leaf; targets = %v", targets)
	}
	if len(thread) != 2 || !strings.Contains(strings.Join(thread, ","), "ai-1") || !strings.Contains(strings.Join(thread, ","), "ai-2") {
		t.Fatalf("thread = %v, want both interior nodes exactly once", thread)
	}
}

// "doc" is a leaf (the whole document) — a valid target terminus.
func TestResolveChain_docSentinelIsATargetLeaf(t *testing.T) {
	targets, thread := (&AIBlockProcessor{}).resolveChain("ai-x", "doc", block.DocView{})
	if strings.Join(targets, ",") != "doc" || len(thread) != 0 {
		t.Fatalf("doc must be a target leaf; targets=%v thread=%v", targets, thread)
	}
}

// The action ai-block's QUESTION ABOUT must reference its FULL direct ref (the MANY),
// not just the last segment — under the pointer model the whole ref is what it asks
// about, so a 3-block selection shows all three, not just the last.
func TestAIBlockBuildContext_questionAboutUsesFullDirectRef(t *testing.T) {
	p := &AIBlockProcessor{}
	blk := block.SieveBlock{ID: "ai-cef2", Kind: "ai-block", Attrs: map[string]interface{}{
		"ref": "pr-c2dc,pr-e51a,pr-f405", "question": "Multi span", "type": "ASK",
	}}
	ctx := p.BuildContext(blk, block.DocView{}, map[string]bool{})
	if !strings.Contains(ctx.String(), "pr-c2dc,pr-e51a,pr-f405") {
		t.Fatalf("QUESTION ABOUT should reference the full direct ref, got: %q", ctx)
	}
}
