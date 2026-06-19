package sieve

import (
	"strings"
	"testing"
)

func TestCollectHandles_IndexesEveryHandle(t *testing.T) {
	doc := BlockDoc{Blocks: []DocBlock{
		{ID: "pr-a", Kind: KindProse, Aliases: []string{"pr-x"}},
		{ID: "pr-b", Kind: KindProse},
		{ID: "co-1", Kind: "code"},
	}}
	got := collectHandles(doc)
	for _, h := range []string{"pr-a", "pr-x", "pr-b", "co-1"} {
		if !got[h] {
			t.Fatalf("collectHandles missing %q (every primary + alias must be indexed): %v", h, got)
		}
	}
}

func TestGCRefs_DropsDangling(t *testing.T) {
	refs := []string{"pr-a", "pr-gone", "co-1", "pr-a"}
	resolvable := map[string]bool{"pr-a": true, "co-1": true}
	got := gcRefs(refs, resolvable)
	want := "pr-a,co-1" // dangling pr-gone stripped, duplicate pr-a deduped, order kept
	if strings.Join(got, ",") != want {
		t.Fatalf("gcRefs: want %q got %v", want, got)
	}
}

func TestGCAliases_DropsUnreferenced(t *testing.T) {
	doc := BlockDoc{Blocks: []DocBlock{
		{ID: "pr-a", Kind: KindProse, Aliases: []string{"pr-x", "pr-y"}},
	}}
	referenced := map[string]bool{"pr-x": true} // nothing points at pr-y
	got := gcAliases(doc, referenced)

	b := got.Blocks[0]
	if b.ID != "pr-a" {
		t.Fatalf("primary id must never be GC'd, got %q", b.ID)
	}
	if strings.Join(b.Aliases, ",") != "pr-x" {
		t.Fatalf("aliases: want [pr-x], got %v", b.Aliases)
	}
}

func TestGCAliases_IsPure(t *testing.T) {
	doc := BlockDoc{Blocks: []DocBlock{
		{ID: "pr-b", Kind: KindProse, Aliases: []string{"pr-stale"}},
	}}
	_ = gcAliases(doc, map[string]bool{}) // nothing referenced

	// Input must be untouched (purity).
	if len(doc.Blocks[0].Aliases) != 1 {
		t.Fatalf("gcAliases mutated input: %+v", doc.Blocks[0].Aliases)
	}
	got := gcAliases(doc, map[string]bool{})
	if len(got.Blocks[0].Aliases) != 0 {
		t.Fatalf("stale alias not GC'd: %+v", got.Blocks[0].Aliases)
	}
}
