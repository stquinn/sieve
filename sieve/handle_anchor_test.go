package sieve

import "testing"

func TestStripHandles(t *testing.T) {
	md := "<!--s:pr-aaaa-->\nFirst.\n\n<!--s:pr-bbbb-->\nSecond.\n\nNo handle here."
	clean, handles := stripHandles(md)

	wantClean := "First.\n\nSecond.\n\nNo handle here."
	if clean != wantClean {
		t.Fatalf("clean mismatch:\n got: %q\nwant: %q", clean, wantClean)
	}
	if len(handles) != 2 {
		t.Fatalf("want 2 handles, got %d: %+v", len(handles), handles)
	}
	// Each handle's offset must point at the first byte of the block below it.
	if handles[0].handle != "pr-aaaa" || clean[handles[0].offset:handles[0].offset+6] != "First." {
		t.Fatalf("handle 0: %+v -> %q", handles[0], clean[handles[0].offset:])
	}
	if handles[1].handle != "pr-bbbb" || clean[handles[1].offset:handles[1].offset+7] != "Second." {
		t.Fatalf("handle 1: %+v -> %q", handles[1], clean[handles[1].offset:])
	}
}

func TestHandles_Bijection(t *testing.T) {
	RegisterProcessor("code", &CodeBlockProcessor{})
	t.Cleanup(func() { UnregisterProcessor("code") })

	md := "<!--s:pr-aaaa-->\nFirst paragraph.\n\n" +
		"<!--s:pr-bbbb-->\nSecond paragraph.\n\n" +
		"```code\nid: co-1\nsource: x = 1\n```\n\n" +
		"<!--s:pr-cccc-->\nTail."

	doc, err := ParseBlockDocWithHandles(md)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(doc.Blocks) != 4 {
		t.Fatalf("want 4 blocks, got %d: %+v", len(doc.Blocks), doc.Blocks)
	}
	if doc.Blocks[0].ID != "pr-aaaa" || doc.Blocks[0].Content != "First paragraph." {
		t.Fatalf("block 0: %+v", doc.Blocks[0])
	}
	if doc.Blocks[1].ID != "pr-bbbb" {
		t.Fatalf("block 1: %+v", doc.Blocks[1])
	}
	if doc.Blocks[2].Kind != "code" || doc.Blocks[2].ID != "co-1" {
		t.Fatalf("block 2: %+v", doc.Blocks[2])
	}
	if doc.Blocks[3].ID != "pr-cccc" || doc.Blocks[3].Content != "Tail." {
		t.Fatalf("block 3: %+v", doc.Blocks[3])
	}

	out, err := SerializeBlockDocWithHandles(doc)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	if out != md {
		t.Fatalf("bijection broken:\n got: %q\nwant: %q", out, md)
	}
}

func TestHandles_IsolatedEditKeepsHandle(t *testing.T) {
	md := "<!--s:pr-aaaa-->\nOriginal text.\n\n<!--s:pr-bbbb-->\nUntouched."
	doc, err := ParseBlockDocWithHandles(md)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	// Edit the first block's prose content in isolation.
	doc.Blocks[0].Content = "Edited text."

	out, err := SerializeBlockDocWithHandles(doc)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	want := "<!--s:pr-aaaa-->\nEdited text.\n\n<!--s:pr-bbbb-->\nUntouched."
	if out != want {
		t.Fatalf("edited block lost handle:\n got: %q\nwant: %q", out, want)
	}
}
