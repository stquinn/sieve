package sieve

import "testing"

// Stage C.2 — block-op apply semantics on the BlockDoc tree.
// These are pure transforms, table-tested, with no editor/WS/browser involved.
// They are the authoritative backend contract that the wire protocol carries.

func TestBlockDoc_ApplyOp_UpdateProseContent(t *testing.T) {
	doc := BlockDoc{Blocks: []DocBlock{
		{ID: "pr-1", Kind: KindProse, Content: "old"},
	}}
	if err := doc.ApplyOp(BlockOp{Type: "update-block", BlockID: "pr-1", Content: "new"}); err != nil {
		t.Fatalf("ApplyOp: %v", err)
	}
	if doc.Blocks[0].Content != "new" {
		t.Fatalf("content = %q, want %q", doc.Blocks[0].Content, "new")
	}
}

func TestBlockDoc_ApplyOp_UpdateAttrsAndAliases(t *testing.T) {
	doc := BlockDoc{Blocks: []DocBlock{
		{ID: "ai-1", Kind: "ai-block", Attrs: map[string]interface{}{"status": "PENDING"}},
	}}
	op := BlockOp{
		Type:    "update-block",
		BlockID: "ai-1",
		Attrs:   map[string]interface{}{"status": "COMPLETE", "response": "hi"},
		Aliases: []string{"ai-old"},
	}
	if err := doc.ApplyOp(op); err != nil {
		t.Fatalf("ApplyOp: %v", err)
	}
	got := doc.Blocks[0]
	if got.Attrs["status"] != "COMPLETE" || got.Attrs["response"] != "hi" {
		t.Fatalf("attrs not replaced: %+v", got.Attrs)
	}
	if len(got.Aliases) != 1 || got.Aliases[0] != "ai-old" {
		t.Fatalf("aliases = %+v, want [ai-old]", got.Aliases)
	}
}

func TestBlockDoc_ApplyOp_UnknownBlockErrors(t *testing.T) {
	doc := BlockDoc{Blocks: []DocBlock{{ID: "pr-1", Kind: KindProse, Content: "x"}}}
	if err := doc.ApplyOp(BlockOp{Type: "update-block", BlockID: "nope", Content: "y"}); err == nil {
		t.Fatal("expected error updating a missing block, got nil")
	}
}

func TestBlockDoc_ApplyOp_DeleteTopLevel(t *testing.T) {
	doc := BlockDoc{Blocks: []DocBlock{
		{ID: "pr-1", Kind: KindProse, Content: "a"},
		{ID: "pr-2", Kind: KindProse, Content: "b"},
		{ID: "pr-3", Kind: KindProse, Content: "c"},
	}}
	if err := doc.ApplyOp(BlockOp{Type: "delete-block", BlockID: "pr-2"}); err != nil {
		t.Fatalf("ApplyOp: %v", err)
	}
	if len(doc.Blocks) != 2 || doc.Blocks[0].ID != "pr-1" || doc.Blocks[1].ID != "pr-3" {
		t.Fatalf("after delete: %+v", ids(doc.Blocks))
	}
}

func TestBlockDoc_ApplyOp_DeleteNested(t *testing.T) {
	doc := BlockDoc{Blocks: []DocBlock{
		{ID: "cr-1", Kind: KindColumnRow, Children: []DocBlock{
			{ID: "col-1", Kind: KindColumn, Children: []DocBlock{
				{ID: "pr-1", Kind: KindProse, Content: "inside"},
			}},
		}},
	}}
	if err := doc.ApplyOp(BlockOp{Type: "delete-block", BlockID: "pr-1"}); err != nil {
		t.Fatalf("ApplyOp: %v", err)
	}
	if len(doc.Blocks[0].Children[0].Children) != 0 {
		t.Fatalf("nested block not deleted: %+v", doc.Blocks[0].Children[0].Children)
	}
}

func TestBlockDoc_ApplyOp_MoveReordersWithinParent(t *testing.T) {
	doc := BlockDoc{Blocks: []DocBlock{
		{ID: "pr-1", Kind: KindProse, Content: "a"},
		{ID: "pr-2", Kind: KindProse, Content: "b"},
		{ID: "pr-3", Kind: KindProse, Content: "c"},
	}}
	// Move pr-3 to the front (index 0).
	if err := doc.ApplyOp(BlockOp{Type: "move", BlockID: "pr-3", Index: 0}); err != nil {
		t.Fatalf("ApplyOp: %v", err)
	}
	got := ids(doc.Blocks)
	want := []string{"pr-3", "pr-1", "pr-2"}
	if !equalStrs(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
}

func TestBlockDoc_ApplyOp_CreateTopLevelAtIndex(t *testing.T) {
	doc := BlockDoc{Blocks: []DocBlock{
		{ID: "pr-1", Kind: KindProse, Content: "a"},
		{ID: "pr-2", Kind: KindProse, Content: "b"},
	}}
	op := BlockOp{Type: "create-block", BlockID: "pr-mid", Kind: KindProse, Content: "mid", Index: 1}
	if err := doc.ApplyOp(op); err != nil {
		t.Fatalf("ApplyOp: %v", err)
	}
	if got, want := ids(doc.Blocks), []string{"pr-1", "pr-mid", "pr-2"}; !equalStrs(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
	if doc.Blocks[1].Content != "mid" {
		t.Fatalf("new block content = %q", doc.Blocks[1].Content)
	}
}

func TestBlockDoc_ApplyOp_CreateStructuredIntoParent(t *testing.T) {
	doc := BlockDoc{Blocks: []DocBlock{
		{ID: "col-1", Kind: KindColumn, Children: []DocBlock{
			{ID: "pr-1", Kind: KindProse, Content: "a"},
		}},
	}}
	op := BlockOp{
		Type: "create-block", BlockID: "co-1", Kind: "code",
		Attrs: map[string]interface{}{"source": "x = 1"}, Index: 0, ParentID: "col-1",
	}
	if err := doc.ApplyOp(op); err != nil {
		t.Fatalf("ApplyOp: %v", err)
	}
	kids := doc.Blocks[0].Children
	if got, want := ids(kids), []string{"co-1", "pr-1"}; !equalStrs(got, want) {
		t.Fatalf("children order = %v, want %v", got, want)
	}
	if kids[0].Kind != "code" || kids[0].Attrs["source"] != "x = 1" {
		t.Fatalf("created block wrong: %+v", kids[0])
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
