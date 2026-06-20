package processors

import (
	"sieve/sieve/block"
	"strings"
	"testing"
)

func TestHandles_Bijection(t *testing.T) {
	block.RegisterProcessor("code", NewCodeBlockProcessor(block.BlockServices{}))
	t.Cleanup(func() { block.UnregisterProcessor("code") })

	md := "<!--s:pr-aaaa-->\nFirst paragraph.\n<!--/s:pr-aaaa-->\n\n" +
		"<!--s:pr-bbbb-->\nSecond paragraph.\n<!--/s:pr-bbbb-->\n\n" +
		"```code\nid: co-1\nsource: x = 1\n```\n\n" +
		"<!--s:pr-cccc-->\nTail.\n<!--/s:pr-cccc-->"

	doc, err := block.NewDocumentCodec(block.GlobalRegistry()).Deserialize(md)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(doc) != 4 {
		t.Fatalf("want 4 blocks, got %d: %+v", len(doc), doc)
	}
	if doc[0].ID != "pr-aaaa" || doc[0].Content() != "First paragraph." {
		t.Fatalf("block 0: %+v", doc[0])
	}
	if doc[1].ID != "pr-bbbb" {
		t.Fatalf("block 1: %+v", doc[1])
	}
	if doc[2].Kind != "code" || doc[2].ID != "co-1" {
		t.Fatalf("block 2: %+v", doc[2])
	}
	if doc[3].ID != "pr-cccc" || doc[3].Content() != "Tail." {
		t.Fatalf("block 3: %+v", doc[3])
	}

	out, err := block.NewDocumentCodec(block.GlobalRegistry()).Serialize(doc)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	if out != md {
		t.Fatalf("bijection broken:\n got: %q\nwant: %q", out, md)
	}
}

func TestHandles_MergedHandleSetPersists(t *testing.T) {
	// A block that answers to a primary handle plus absorbed aliases (post-merge,
	// spec §7) must persist every handle to disk so refs survive reopen. In the
	// paired-delimiter format the whole handle-set rides in the open marker.
	doc := []block.SieveBlock{
		{ID: "pr-aaaa", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "Merged block."}, Aliases: []string{"pr-bbbb", "pr-cccc"}},
	}
	md, err := block.NewDocumentCodec(block.GlobalRegistry()).Serialize(doc)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	want := "<!--s:pr-aaaa pr-bbbb pr-cccc-->\nMerged block.\n<!--/s:pr-aaaa-->"
	if md != want {
		t.Fatalf("handle-set marker:\n got: %q\nwant: %q", md, want)
	}

	got, err := block.NewDocumentCodec(block.GlobalRegistry()).Deserialize(md)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 block, got %d: %+v", len(got), got)
	}
	b := got[0]
	if b.ID != "pr-aaaa" || strings.Join(b.Aliases, ",") != "pr-bbbb,pr-cccc" {
		t.Fatalf("handle-set not restored: %+v", b)
	}
}

func TestHandles_IsolatedEditKeepsHandle(t *testing.T) {
	md := "<!--s:pr-aaaa-->\nOriginal text.\n<!--/s:pr-aaaa-->\n\n" +
		"<!--s:pr-bbbb-->\nUntouched.\n<!--/s:pr-bbbb-->"
	// Edit the first prose block's content through the PUBLIC block op (update-block
	// carries prose content) — no poking SieveBlock internals.
	shadow := block.NewShadow("u", md, block.NewDocumentCodec(block.GlobalRegistry()), 0, nil)
	if err := shadow.ApplyOp(block.BlockOp{Type: "update-block", BlockID: "pr-aaaa", Content: "Edited text."}); err != nil {
		t.Fatalf("apply op: %v", err)
	}
	out := shadow.ContentForSave()
	want := "<!--s:pr-aaaa-->\nEdited text.\n<!--/s:pr-aaaa-->\n\n" +
		"<!--s:pr-bbbb-->\nUntouched.\n<!--/s:pr-bbbb-->"
	if out != want {
		t.Fatalf("edited block lost handle:\n got: %q\nwant: %q", out, want)
	}
}
