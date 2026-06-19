package sieve

import (
	"encoding/json"
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
		Op BlockOp `json:"op"`
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

// C.2b — EditorService.HandleBlockOp applies a wire op to the open shadow's Doc
// and the change persists on flush.
func TestEditorService_HandleBlockOp_UpdatesAndPersists(t *testing.T) {
	resetRegistry()
	RegisterProcessor("code", &CodeBlockProcessor{})

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, 0)
	doc, _ := ds.New()
	doc.SetBody([]byte("Intro.\n\n```code\nid: co-1\nsource: x = 1\n```"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	if err := es.Open(uuid, nil); err != nil {
		t.Fatalf("Open: %v", err)
	}

	err := es.HandleBlockOp(uuid, BlockOp{
		Type: "update-block", BlockID: "co-1", Kind: "code",
		Attrs: map[string]interface{}{"id": "co-1", "source": "y = 2"},
	})
	if err != nil {
		t.Fatalf("HandleBlockOp: %v", err)
	}
	if err := es.Flush(uuid); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	reloaded, _ := ds.LoadByUUID(uuid)
	body := string(reloaded.Body())
	if !strings.Contains(body, "source: y = 2") || strings.Contains(body, "source: x = 1") {
		t.Fatalf("op not persisted, disk body:\n%s", body)
	}
}

func TestEditorService_HandleBlockOp_NoShadowErrors(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, 0)
	if err := es.HandleBlockOp("missing", BlockOp{Type: "update-block", BlockID: "x"}); err == nil {
		t.Fatal("expected error when no document is open")
	}
}

// C.1 — the disk-direct job-update path (no open shadow) must also go through
// the serialization spine, not InjectBlocks. Characterization test: behavior is
// preserved across the refactor.
func TestApplyJobUpdate_NoShadow_WritesViaSpine(t *testing.T) {
	resetRegistry()
	RegisterProcessor("ai-block", &testRunJobProcessor{})

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, 0)
	doc, _ := ds.New()
	doc.SetBody([]byte("```ai-block\nid: ab-1\nresponse: old\nstatus: PENDING\n```"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()

	// No Open → no shadow → disk-direct branch.
	es.applyJobUpdate(uuid, "ab-1", "ai-block",
		map[string]interface{}{"response": "new", "status": "COMPLETE"}, nil, "test")

	reloaded, err := ds.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	body := string(reloaded.Body())
	if !strings.Contains(body, "response: new") {
		t.Fatalf("expected updated response on disk, got:\n%s", body)
	}
	if strings.Contains(body, "response: old") {
		t.Fatalf("stale response still on disk:\n%s", body)
	}
}

// C.1 — contentForSave serializes the authoritative Doc (blocks 1..N), not the
// old InjectBlocks overlay. A change made only to Doc must surface on save.
func TestShadowDocument_ContentForSave_SerializesDoc(t *testing.T) {
	RegisterProcessor("code", &CodeBlockProcessor{})
	t.Cleanup(func() { UnregisterProcessor("code") })

	md := "Hello.\n\n```code\nid: co-1\nsource: x = 1\n```"
	shadow := newShadow("u", md, 0, nil)

	// Mutate ONLY the Doc (not Markdown / Blocks): contentForSave must reflect it.
	if err := ApplyOp(&shadow.Blocks, BlockOp{
		Type: "update-block", BlockID: "co-1", Kind: "code",
		Attrs: map[string]interface{}{"id": "co-1", "source": "y = 2"},
	}); err != nil {
		t.Fatalf("ApplyOp: %v", err)
	}
	out := shadow.contentForSave()
	if !strings.Contains(out, "source: y = 2") {
		t.Fatalf("contentForSave did not serialize Doc change:\n%s", out)
	}
	if strings.Contains(out, "source: x = 1") {
		t.Fatalf("contentForSave still has stale content:\n%s", out)
	}
	if !strings.Contains(out, "Hello.") {
		t.Fatalf("contentForSave dropped prose:\n%s", out)
	}
}

// Invariant: a block can never enter the tree without an id. create-block is a
// construction point — if the op carries no blockId, ApplyOp GENERATES one
// (given an id or generate one), rather than erroring or admitting an id-less
// block. The frontend mints client-side and supplies it; this is the backend
// floor that guarantees the invariant regardless of caller.
func TestBlockDoc_ApplyOp_CreateBlockGeneratesIdWhenMissing(t *testing.T) {
	doc := []DocBlock{}
	if err := ApplyOp(&doc, BlockOp{Type: "create-block", Kind: KindProse, Content: "fresh", Index: 0}); err != nil {
		t.Fatalf("ApplyOp create-block with no id should generate one, got error: %v", err)
	}
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
	doc := []DocBlock{}
	if err := ApplyOp(&doc, BlockOp{Type: "create-block", BlockID: "pr-given", Kind: KindProse, Content: "x", Index: 0}); err != nil {
		t.Fatalf("ApplyOp: %v", err)
	}
	if doc[0].ID != "pr-given" {
		t.Fatalf("id = %q, want the supplied %q", doc[0].ID, "pr-given")
	}
}

func TestBlockDoc_ApplyOp_UpdateProseContent(t *testing.T) {
	doc := []DocBlock{
		{ID: "pr-1", Kind: KindProse, Attrs: map[string]interface{}{"content": "old"}},
	}
	if err := ApplyOp(&doc, BlockOp{Type: "update-block", BlockID: "pr-1", Content: "new"}); err != nil {
		t.Fatalf("ApplyOp: %v", err)
	}
	if doc[0].Content() != "new" {
		t.Fatalf("content = %q, want %q", doc[0].Content(), "new")
	}
}

func TestBlockDoc_ApplyOp_UpdateAttrsAndAliases(t *testing.T) {
	doc := []DocBlock{
		{ID: "ai-1", Kind: "ai-block", Attrs: map[string]interface{}{"status": "PENDING"}},
	}
	op := BlockOp{
		Type:    "update-block",
		BlockID: "ai-1",
		Attrs:   map[string]interface{}{"status": "COMPLETE", "response": "hi"},
		Aliases: []string{"ai-old"},
	}
	if err := ApplyOp(&doc, op); err != nil {
		t.Fatalf("ApplyOp: %v", err)
	}
	got := doc[0]
	if got.Attrs["status"] != "COMPLETE" || got.Attrs["response"] != "hi" {
		t.Fatalf("attrs not replaced: %+v", got.Attrs)
	}
	if len(got.Aliases) != 1 || got.Aliases[0] != "ai-old" {
		t.Fatalf("aliases = %+v, want [ai-old]", got.Aliases)
	}
}

func TestBlockDoc_ApplyOp_UnknownBlockErrors(t *testing.T) {
	doc := []DocBlock{{ID: "pr-1", Kind: KindProse, Attrs: map[string]interface{}{"content": "x"}}}
	if err := ApplyOp(&doc, BlockOp{Type: "update-block", BlockID: "nope", Content: "y"}); err == nil {
		t.Fatal("expected error updating a missing block, got nil")
	}
}

func TestBlockDoc_ApplyOp_DeleteTopLevel(t *testing.T) {
	doc := []DocBlock{
		{ID: "pr-1", Kind: KindProse, Attrs: map[string]interface{}{"content": "a"}},
		{ID: "pr-2", Kind: KindProse, Attrs: map[string]interface{}{"content": "b"}},
		{ID: "pr-3", Kind: KindProse, Attrs: map[string]interface{}{"content": "c"}},
	}
	if err := ApplyOp(&doc, BlockOp{Type: "delete-block", BlockID: "pr-2"}); err != nil {
		t.Fatalf("ApplyOp: %v", err)
	}
	if len(doc) != 2 || doc[0].ID != "pr-1" || doc[1].ID != "pr-3" {
		t.Fatalf("after delete: %+v", ids(doc))
	}
}

func TestBlockDoc_ApplyOp_MoveReordersWithinParent(t *testing.T) {
	doc := []DocBlock{
		{ID: "pr-1", Kind: KindProse, Attrs: map[string]interface{}{"content": "a"}},
		{ID: "pr-2", Kind: KindProse, Attrs: map[string]interface{}{"content": "b"}},
		{ID: "pr-3", Kind: KindProse, Attrs: map[string]interface{}{"content": "c"}},
	}
	// Move pr-3 to the front (index 0).
	if err := ApplyOp(&doc, BlockOp{Type: "move", BlockID: "pr-3", Index: 0}); err != nil {
		t.Fatalf("ApplyOp: %v", err)
	}
	got := ids(doc)
	want := []string{"pr-3", "pr-1", "pr-2"}
	if !equalStrs(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
}

func TestBlockDoc_ApplyOp_CreateTopLevelAtIndex(t *testing.T) {
	doc := []DocBlock{
		{ID: "pr-1", Kind: KindProse, Attrs: map[string]interface{}{"content": "a"}},
		{ID: "pr-2", Kind: KindProse, Attrs: map[string]interface{}{"content": "b"}},
	}
	op := BlockOp{Type: "create-block", BlockID: "pr-mid", Kind: KindProse, Content: "mid", Index: 1}
	if err := ApplyOp(&doc, op); err != nil {
		t.Fatalf("ApplyOp: %v", err)
	}
	if got, want := ids(doc), []string{"pr-1", "pr-mid", "pr-2"}; !equalStrs(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
	if doc[1].Content() != "mid" {
		t.Fatalf("new block content = %q", doc[1].Content())
	}
}

// Nesting into a parent is rejected until Stage E re-introduces containers.
func TestBlockDoc_ApplyOp_CreateIntoParentRejected(t *testing.T) {
	doc := []DocBlock{
		{ID: "pr-1", Kind: KindProse, Attrs: map[string]interface{}{"content": "a"}},
	}
	op := BlockOp{
		Type: "create-block", BlockID: "co-1", Kind: "code",
		Attrs: map[string]interface{}{"source": "x = 1"}, Index: 0, ParentID: "pr-1",
	}
	if err := ApplyOp(&doc, op); err == nil {
		t.Fatal("expected create-block with ParentID to be rejected (no Children until Stage E)")
	}
	if len(doc) != 1 {
		t.Fatalf("rejected op must not mutate the tree: %+v", ids(doc))
	}
}

func ids(blocks []DocBlock) []string {
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
