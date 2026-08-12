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
	got := b.gcRefs(resolvable)
	want := "pr-a,co-1" // dangling pr-gone stripped, duplicate pr-a deduped, order kept
	if strings.Join(got, ",") != want {
		t.Fatalf("gcRefs: want %q got %v", want, got)
	}
}

// There is no alias GC by design (#75) — an alias is durable by intent, and a
// declared name has no referrers by definition, so collecting unreferenced ones
// would drop exactly the handles worth keeping. What must hold is that an alias
// stays resolvable: collectHandles indexes it, which TestCollectHandles covers.
