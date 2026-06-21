package processors

import (
	"encoding/json"
	"sieve/sieve/block"
	"strings"
	"testing"
)

// C.2c — the WS envelope {type:"block-op", op:{...}} must decode into BlockOp
// with the exact field names the frontend sends. Guards the wire contract.
func TestBlockOp_DecodesWireEnvelope(t *testing.T) {
	raw := []byte(`{
		"type": "block-op",
		"op": {
			"type": "create-block",
			"blockId": "co-1",
			"kind": "code",
			"content": "x = 1",
			"attrs": {"source": "x = 1"},
			"aliases": ["co-old"],
			"index": 2,
			"parentId": "col-1"
		}
	}`)
	var msg struct {
		Op block.BlockOp `json:"op"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	op := msg.Op
	if op.Type != "create-block" || op.BlockID != "co-1" || op.Kind != "code" {
		t.Fatalf("scalar fields wrong: %+v", op)
	}
	if op.Content != "x = 1" || op.Index != 2 || op.ParentID != "col-1" {
		t.Fatalf("content/index/parent wrong: %+v", op)
	}
	if op.Attrs["source"] != "x = 1" {
		t.Fatalf("attrs wrong: %+v", op.Attrs)
	}
	if len(op.Aliases) != 1 || op.Aliases[0] != "co-old" {
		t.Fatalf("aliases wrong: %+v", op.Aliases)
	}
}

// Stage C.2 — block-op apply semantics on the BlockDoc tree.
// These are pure transforms, table-tested, with no editor/WS/browser involved.
// They are the authoritative backend contract that the wire protocol carries.

// C.1 — ContentForSave serializes the authoritative Doc (blocks 1..N), not the
// old InjectBlocks overlay. A change made only to Doc must surface on save.
func TestShadowDocument_ContentForSave_SerializesDoc(t *testing.T) {
	block.RegisterProcessor(NewCodeBlockProcessor(block.BlockServices{}))
	t.Cleanup(func() { block.UnregisterProcessor("code") })

	md := "Hello.\n\n```code\nid: co-1\nsource: x = 1\n```"
	shadow := block.NewShadow("u", md, block.NewDocumentCodec(block.GlobalRegistry()), 0, nil)

	// Mutate ONLY the Doc (not Markdown / Blocks): ContentForSave must reflect it.
	if err := shadow.ApplyOp(block.BlockOp{
		Type: "update-block", BlockID: "co-1", Kind: "code",
		Attrs: map[string]interface{}{"id": "co-1", "source": "y = 2"},
	}); err != nil {
		t.Fatalf("ApplyOp: %v", err)
	}
	out := shadow.ContentForSave()
	if !strings.Contains(out, "source: y = 2") {
		t.Fatalf("ContentForSave did not serialize Doc change:\n%s", out)
	}
	if strings.Contains(out, "source: x = 1") {
		t.Fatalf("ContentForSave still has stale content:\n%s", out)
	}
	if !strings.Contains(out, "Hello.") {
		t.Fatalf("ContentForSave dropped prose:\n%s", out)
	}
}

// Invariant: a block can never enter the tree without an id. create-block is a
// construction point — if the op carries no blockId, ApplyOp GENERATES one
// (given an id or generate one), rather than erroring or admitting an id-less
// block. The frontend mints client-side and supplies it; this is the backend
// floor that guarantees the invariant regardless of caller.
func TestBlockDoc_ApplyOp_CreateBlockGeneratesIdWhenMissing(t *testing.T) {
	s := &block.ShadowDocument{Blocks: []block.SieveBlock{}}
	if err := s.ApplyOp(block.BlockOp{Type: "create-block", Kind: block.KindProse, Content: "fresh", Index: 0}); err != nil {
		t.Fatalf("applyOpTo create-block with no id should generate one, got error: %v", err)
	}
	doc := s.Blocks
	if len(doc) != 1 {
		t.Fatalf("want 1 block, got %d", len(doc))
	}
	if doc[0].ID == "" {
		t.Fatalf("created block has no id — the constructor must generate one")
	}
	if doc[0].Content() != "fresh" {
		t.Fatalf("content = %q, want %q", doc[0].Content(), "fresh")
	}
}

func TestBlockDoc_ApplyOp_CreateBlockKeepsGivenId(t *testing.T) {
	s := &block.ShadowDocument{Blocks: []block.SieveBlock{}}
	if err := s.ApplyOp(block.BlockOp{Type: "create-block", BlockID: "pr-given", Kind: block.KindProse, Content: "x", Index: 0}); err != nil {
		t.Fatalf("applyOpTo: %v", err)
	}
	doc := s.Blocks
	if doc[0].ID != "pr-given" {
		t.Fatalf("id = %q, want the supplied %q", doc[0].ID, "pr-given")
	}
}

func TestBlockDoc_ApplyOp_UpdateProseContent(t *testing.T) {
	s := &block.ShadowDocument{Blocks: []block.SieveBlock{
		{ID: "pr-1", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "old"}},
	}}
	if err := s.ApplyOp(block.BlockOp{Type: "update-block", BlockID: "pr-1", Content: "new"}); err != nil {
		t.Fatalf("applyOpTo: %v", err)
	}
	doc := s.Blocks
	if doc[0].Content() != "new" {
		t.Fatalf("content = %q, want %q", doc[0].Content(), "new")
	}
}

func TestBlockDoc_ApplyOp_UpdateAttrsAndAliases(t *testing.T) {
	s := &block.ShadowDocument{Blocks: []block.SieveBlock{
		{ID: "ai-1", Kind: "ai-block", Attrs: map[string]interface{}{"status": "PENDING"}},
	}}
	op := block.BlockOp{
		Type:    "update-block",
		BlockID: "ai-1",
		Attrs:   map[string]interface{}{"status": "COMPLETE", "response": "hi"},
		Aliases: []string{"ai-old"},
	}
	if err := s.ApplyOp(op); err != nil {
		t.Fatalf("applyOpTo: %v", err)
	}
	doc := s.Blocks
	got := doc[0]
	if got.Attrs["status"] != "COMPLETE" || got.Attrs["response"] != "hi" {
		t.Fatalf("attrs not replaced: %+v", got.Attrs)
	}
	if len(got.Aliases) != 1 || got.Aliases[0] != "ai-old" {
		t.Fatalf("aliases = %+v, want [ai-old]", got.Aliases)
	}
}

func TestBlockDoc_ApplyOp_UnknownBlockErrors(t *testing.T) {
	s := &block.ShadowDocument{Blocks: []block.SieveBlock{{ID: "pr-1", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "x"}}}}
	if err := s.ApplyOp(block.BlockOp{Type: "update-block", BlockID: "nope", Content: "y"}); err == nil {
		t.Fatal("expected error updating a missing block, got nil")
	}
}

func TestBlockDoc_ApplyOp_DeleteTopLevel(t *testing.T) {
	s := &block.ShadowDocument{Blocks: []block.SieveBlock{
		{ID: "pr-1", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "a"}},
		{ID: "pr-2", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "b"}},
		{ID: "pr-3", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "c"}},
	}}
	if err := s.ApplyOp(block.BlockOp{Type: "delete-block", BlockID: "pr-2"}); err != nil {
		t.Fatalf("applyOpTo: %v", err)
	}
	doc := s.Blocks
	if len(doc) != 2 || doc[0].ID != "pr-1" || doc[1].ID != "pr-3" {
		t.Fatalf("after delete: %+v", ids(doc))
	}
}

func TestBlockDoc_ApplyOp_MoveReordersWithinParent(t *testing.T) {
	s := &block.ShadowDocument{Blocks: []block.SieveBlock{
		{ID: "pr-1", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "a"}},
		{ID: "pr-2", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "b"}},
		{ID: "pr-3", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "c"}},
	}}
	// Move pr-3 to the front (index 0).
	if err := s.ApplyOp(block.BlockOp{Type: "move", BlockID: "pr-3", Index: 0}); err != nil {
		t.Fatalf("applyOpTo: %v", err)
	}
	doc := s.Blocks
	got := ids(doc)
	want := []string{"pr-3", "pr-1", "pr-2"}
	if !equalStrs(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
}

func TestBlockDoc_ApplyOp_CreateTopLevelAtIndex(t *testing.T) {
	s := &block.ShadowDocument{Blocks: []block.SieveBlock{
		{ID: "pr-1", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "a"}},
		{ID: "pr-2", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "b"}},
	}}
	op := block.BlockOp{Type: "create-block", BlockID: "pr-mid", Kind: block.KindProse, Content: "mid", Index: 1}
	if err := s.ApplyOp(op); err != nil {
		t.Fatalf("applyOpTo: %v", err)
	}
	doc := s.Blocks
	if got, want := ids(doc), []string{"pr-1", "pr-mid", "pr-2"}; !equalStrs(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
	if doc[1].Content() != "mid" {
		t.Fatalf("new block content = %q", doc[1].Content())
	}
}

// Nesting into a parent is rejected until Stage E re-introduces containers.
func TestBlockDoc_ApplyOp_CreateIntoParentRejected(t *testing.T) {
	s := &block.ShadowDocument{Blocks: []block.SieveBlock{
		{ID: "pr-1", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "a"}},
	}}
	op := block.BlockOp{
		Type: "create-block", BlockID: "co-1", Kind: "code",
		Attrs: map[string]interface{}{"source": "x = 1"}, Index: 0, ParentID: "pr-1",
	}
	if err := s.ApplyOp(op); err == nil {
		t.Fatal("expected create-block with ParentID to be rejected (no Children until Stage E)")
	}
	doc := s.Blocks
	if len(doc) != 1 {
		t.Fatalf("rejected op must not mutate the tree: %+v", ids(doc))
	}
}

// ShadowDocument.ApplyOp must lock, apply, arm debounce, and leave the tree
// consistent — same semantics as applyOpTo but through the live-doc entry point.
func TestShadowDocument_ApplyOp_UpdatesTree(t *testing.T) {
	block.RegisterProcessor(NewCodeBlockProcessor(block.BlockServices{}))
	t.Cleanup(func() { block.UnregisterProcessor("code") })

	md := "Hello.\n\n```code\nid: co-1\nsource: x = 1\n```"
	shadow := block.NewShadow("u", md, block.NewDocumentCodec(block.GlobalRegistry()), 0, nil)

	if err := shadow.ApplyOp(block.BlockOp{
		Type: "update-block", BlockID: "co-1", Kind: "code",
		Attrs: map[string]interface{}{"id": "co-1", "source": "z = 99"},
	}); err != nil {
		t.Fatalf("shadow.ApplyOp: %v", err)
	}

	blk, ok := shadow.SnapshotBlock("co-1")
	if !ok {
		t.Fatal("block co-1 not found after ApplyOp")
	}
	got, _ := blk.Attrs["source"].(string)

	if got != "z = 99" {
		t.Fatalf("source = %q, want %q", got, "z = 99")
	}
}

func ids(blocks []block.SieveBlock) []string {
	out := make([]string, len(blocks))
	for i, b := range blocks {
		out[i] = b.ID
	}
	return out
}

func equalStrs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
