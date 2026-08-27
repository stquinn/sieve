package block

import (
	"strings"
	"testing"
)

func TestCollectHandles_IndexesEveryHandle(t *testing.T) {
	doc := []SieveBlock{
		{ID: "pr-a", Kind: KindProse, Aliases: []string{"pr-x"}},
		{ID: "pr-b", Kind: KindProse},
		{ID: "co-1", Kind: "code"},
	}
	sd := ShadowDocument{Blocks: doc}
	got := sd.collectHandles()
	for _, h := range []string{"pr-a", "pr-x", "pr-b", "co-1"} {
		if !got[h] {
			t.Fatalf("collectHandles missing %q (every primary + alias must be indexed): %v", h, got)
		}
	}
}

func TestGCRefs_DropsDangling(t *testing.T) {
	b := SieveBlock{ID: "co-self", Attrs: map[string]interface{}{"ref": "pr-a,pr-gone,co-1,pr-a"}}
	resolvable := map[string]bool{"pr-a": true, "co-1": true}
	got := b.gcRefs("", resolvable)
	want := "pr-a,co-1" // dangling pr-gone stripped, duplicate pr-a deduped, order kept
	if strings.Join(got, ",") != want {
		t.Fatalf("gcRefs: want %q got %v", want, got)
	}
}

// There is no alias GC by design: an alias is durable by intent and a declared
// name has no referrers, so collecting unreferenced ones would drop exactly the
// handles worth keeping. What must hold is that an alias stays resolvable.

// `ref` is the document-local chain and NOTHING else. Attachments are global
// addresses living in their own attr, so the ref machinery — outgoingRefs, the
// GC, and by extension the INTERIOR/LEAF chain classification built on them —
// must not see a coordinate, and must not prune one either.
func TestRefSemanticsUnchangedByAttachments(t *testing.T) {
	b := SieveBlock{ID: "ai-c71e", Kind: "ai-block", Attrs: map[string]interface{}{
		"ref": "pr-a,blk-gone",
		AttachmentsAttr: []interface{}{
			map[string]interface{}{"uri": "sieve://9f2b", "title": "Auth Design"},
		},
	}}

	if got := b.outgoingRefs(""); strings.Join(got, ",") != "pr-a,blk-gone" {
		t.Fatalf("outgoingRefs saw something other than the local chain: %v", got)
	}

	kept := b.gcRefs("", map[string]bool{"pr-a": true})
	if strings.Join(kept, ",") != "pr-a" {
		t.Fatalf("gcRefs = %v, want [pr-a] — no coordinate may enter the ref set", kept)
	}
	for _, r := range kept {
		if strings.Contains(r, ":") {
			t.Fatalf("gcRefs returned a coordinate: %q", r)
		}
	}

	// The GC prunes refs; it neither walks nor drops attachments.
	if got := b.Attachments(); len(got) != 1 || got[0].URI != "sieve://9f2b" {
		t.Fatalf("attachments disturbed by ref GC: %+v", got)
	}
}
