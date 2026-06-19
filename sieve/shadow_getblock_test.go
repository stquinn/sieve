package sieve

import "testing"

// Stopgap for the AI-prompt ref-chain regression + first brick of the ShadowDoc
// refactor: a prose block is resolvable by id from the authoritative block tree
// (everything is a block — no structured-vs-prose discrimination at lookup time;
// kind only matters when turning the block into context text). getBlock(id) is
// the single accessor; BuildContextForID returns a prose block's markdown content.

func TestShadowDocument_getBlock_resolvesProse(t *testing.T) {
	doc := ShadowDocument{Doc: BlockDoc{Blocks: []DocBlock{
		{ID: "pr-1", Kind: KindProse, Attrs: map[string]interface{}{"content": "the quick brown fox"}},
		{ID: "co-1", Kind: "code", Attrs: map[string]interface{}{"id": "co-1", "source": "x=1"}},
	}}}
	b, ok := doc.getBlock("pr-1")
	if !ok || b == nil {
		t.Fatalf("getBlock(pr-1): want found, got ok=%v", ok)
	}
	if b.Kind != KindProse || b.Content() != "the quick brown fox" {
		t.Fatalf("getBlock(pr-1): got %+v", b)
	}
	if _, ok := doc.getBlock("nope"); ok {
		t.Fatalf("getBlock(nope): want not found")
	}
}

func TestBuildContextForID_resolvesProseContentFromDoc(t *testing.T) {
	doc := ShadowDocument{Doc: BlockDoc{Blocks: []DocBlock{
		{ID: "pr-1", Kind: KindProse, Attrs: map[string]interface{}{"content": "the quick brown fox"}},
		{ID: "pr-2", Kind: KindProse, Attrs: map[string]interface{}{"content": "second paragraph"}},
	}}}
	if got := BuildContextForID("pr-1", doc, map[string]bool{}); got != "the quick brown fox" {
		t.Fatalf("prose context: got %q", got)
	}
}

func TestBuildContextForID_gathersProseRefChain(t *testing.T) {
	// A selection-derived ref chain "pr-1,pr-2,pr-3" must gather every block's
	// content — the regression the user hit (chain resolved to nothing for prose).
	doc := ShadowDocument{Doc: BlockDoc{Blocks: []DocBlock{
		{ID: "pr-1", Kind: KindProse, Attrs: map[string]interface{}{"content": "alpha"}},
		{ID: "pr-2", Kind: KindProse, Attrs: map[string]interface{}{"content": "beta"}},
		{ID: "pr-3", Kind: KindProse, Attrs: map[string]interface{}{"content": "gamma"}},
	}}}
	seen := map[string]bool{}
	var got []string
	for _, id := range []string{"pr-1", "pr-2", "pr-3"} {
		if c := BuildContextForID(id, doc, seen); c != "" {
			got = append(got, c)
		}
	}
	if len(got) != 3 || got[0] != "alpha" || got[1] != "beta" || got[2] != "gamma" {
		t.Fatalf("ref chain gather: got %v", got)
	}
}
