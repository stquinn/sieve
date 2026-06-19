package sieve

import (
	"strings"
	"testing"
)

func TestHandles_Bijection(t *testing.T) {
	RegisterProcessor("code", NewCodeBlockProcessor(BlockServices{}))
	t.Cleanup(func() { UnregisterProcessor("code") })

	md := "<!--s:pr-aaaa-->\nFirst paragraph.\n<!--/s:pr-aaaa-->\n\n" +
		"<!--s:pr-bbbb-->\nSecond paragraph.\n<!--/s:pr-bbbb-->\n\n" +
		"```code\nid: co-1\nsource: x = 1\n```\n\n" +
		"<!--s:pr-cccc-->\nTail.\n<!--/s:pr-cccc-->"

	doc, err := NewDocumentCodec(globalRegistry()).Deserialize(md)
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

	out, err := NewDocumentCodec(globalRegistry()).Serialize(doc)
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
	doc := []SieveBlock{
		{ID: "pr-aaaa", Kind: KindProse, Attrs: map[string]interface{}{"content": "Merged block."}, Aliases: []string{"pr-bbbb", "pr-cccc"}},
	}
	md, err := NewDocumentCodec(globalRegistry()).Serialize(doc)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	want := "<!--s:pr-aaaa pr-bbbb pr-cccc-->\nMerged block.\n<!--/s:pr-aaaa-->"
	if md != want {
		t.Fatalf("handle-set marker:\n got: %q\nwant: %q", md, want)
	}

	got, err := NewDocumentCodec(globalRegistry()).Deserialize(md)
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
	doc, err := NewDocumentCodec(globalRegistry()).Deserialize(md)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	// Edit the first block's prose content in isolation.
	doc[0].setContent("Edited text.")

	out, err := NewDocumentCodec(globalRegistry()).Serialize(doc)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	want := "<!--s:pr-aaaa-->\nEdited text.\n<!--/s:pr-aaaa-->\n\n" +
		"<!--s:pr-bbbb-->\nUntouched.\n<!--/s:pr-bbbb-->"
	if out != want {
		t.Fatalf("edited block lost handle:\n got: %q\nwant: %q", out, want)
	}
}
