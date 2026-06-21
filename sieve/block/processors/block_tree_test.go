package processors

import (
	"sieve/sieve/block"
	"testing"
)

// D.4 spine: blocks are delimited by matched open/close comment-tag pairs.
// A prose block serializes as `<!--s:ID-->\n<content>\n<!--/s:ID-->`; structure
// derives ONLY from these delimiters, never from blank lines.

func TestPairedDelimiter_SerializeProse(t *testing.T) {
	doc := []block.SieveBlock{
		{ID: "pr-1", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "Hello."}},
	}
	got, err := block.NewDocumentCodec(block.GlobalRegistry()).Serialize(doc)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	want := "<!--s:pr-1-->\nHello.\n<!--/s:pr-1-->"
	if got != want {
		t.Fatalf("serialize mismatch:\n got: %q\nwant: %q", got, want)
	}
}

func TestPairedDelimiter_RoundTripProse(t *testing.T) {
	md := "<!--s:pr-1-->\nHello.\n<!--/s:pr-1-->"
	doc, err := block.NewDocumentCodec(block.GlobalRegistry()).Deserialize(md)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(doc) != 1 {
		t.Fatalf("want 1 block, got %d: %+v", len(doc), doc)
	}
	b := doc[0]
	if b.ID != "pr-1" || b.Kind != block.KindProse || b.Content() != "Hello." {
		t.Fatalf("block: %+v", b)
	}
	out, err := block.NewDocumentCodec(block.GlobalRegistry()).Serialize(doc)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	if out != md {
		t.Fatalf("not a fixpoint:\n got: %q\nwant: %q", out, md)
	}
}

// Aliases (post-merge handle-set, spec §7) ride in the open marker as a
// space-separated handle list; the close marker carries the primary id only.
func TestPairedDelimiter_AliasesRoundTrip(t *testing.T) {
	doc := []block.SieveBlock{
		{ID: "pr-1", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "Merged."}, Aliases: []string{"pr-0", "pr-9"}},
	}
	md, err := block.NewDocumentCodec(block.GlobalRegistry()).Serialize(doc)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	want := "<!--s:pr-1 pr-0 pr-9-->\nMerged.\n<!--/s:pr-1-->"
	if md != want {
		t.Fatalf("alias serialize:\n got: %q\nwant: %q", md, want)
	}
	got, err := block.NewDocumentCodec(block.GlobalRegistry()).Deserialize(md)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	b := got[0]
	if b.ID != "pr-1" || len(b.Aliases) != 2 || b.Aliases[0] != "pr-0" || b.Aliases[1] != "pr-9" {
		t.Fatalf("alias not restored: %+v", b)
	}
}

// A delimited prose block holds ANY amount of markdown content verbatim,
// including blank lines (multiple paragraphs). Whitespace is content, not a
// structural boundary.
func TestPairedDelimiter_MultiParagraphIsOneBlock(t *testing.T) {
	md := "<!--s:pr-1-->\nA\n\nB\n<!--/s:pr-1-->"
	doc, err := block.NewDocumentCodec(block.GlobalRegistry()).Deserialize(md)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(doc) != 1 {
		t.Fatalf("want 1 block, got %d: %+v", len(doc), doc)
	}
	if doc[0].Content() != "A\n\nB" {
		t.Fatalf("content not verbatim: %q", doc[0].Content())
	}
}

// Undelimited content (no surrounding pair) is carried as a SINGLE prose block —
// never blank-line split. Blank lines carry no structural signal.
func TestUndelimited_IsSingleBlock(t *testing.T) {
	md := "First.\n\nSecond.\n\nThird."
	doc, err := block.NewDocumentCodec(block.GlobalRegistry()).Deserialize(md)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(doc) != 1 {
		t.Fatalf("want 1 block (no blank-line split), got %d: %+v", len(doc), doc)
	}
	// The run is one block whose content is verbatim. It is minted an id at
	// construction (the invariant: a block never exists id-less) — hydration of a
	// marker-less doc on parse.
	if doc[0].ID == "" || doc[0].Content() != md {
		t.Fatalf("undelimited block should be one minted block: %+v", doc[0])
	}
}

// An open marker with no matching close is unbalanced → literal text, not a
// block boundary. The marker line stays verbatim in the prose content.
func TestUnbalancedOpen_IsLiteralText(t *testing.T) {
	md := "<!--s:pr-1-->\nHello."
	doc, err := block.NewDocumentCodec(block.GlobalRegistry()).Deserialize(md)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(doc) != 1 {
		t.Fatalf("want 1 block, got %d: %+v", len(doc), doc)
	}
	// The marker line stays verbatim in content; the block is minted an id at
	// construction (the invariant) since it carries no usable handle of its own.
	if doc[0].ID == "" || doc[0].Content() != md {
		t.Fatalf("unbalanced open should be literal (one minted block): %+v", doc[0])
	}
}

// Leaf opacity: a literal `<!--s:…-->`/`<!--/s:…-->` inside a structured fence
// is fence content, never re-scanned as a prose-block boundary.
func TestOpacity_MarkerInsideCodeFenceNotParsed(t *testing.T) {
	block.RegisterProcessor(NewCodeBlockProcessor(block.BlockServices{}))
	t.Cleanup(func() { block.UnregisterProcessor("code") })

	md := "<!--s:pr-1-->\nIntro.\n<!--/s:pr-1-->\n\n" +
		"```code\nid: co-1\nsource: |\n    <!--s:evil-->\n    not a block\n    <!--/s:evil-->\n```\n\n" +
		"<!--s:pr-2-->\nOutro.\n<!--/s:pr-2-->"
	doc, err := block.NewDocumentCodec(block.GlobalRegistry()).Deserialize(md)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(doc) != 3 {
		t.Fatalf("want 3 blocks (prose, code, prose), got %d: %+v", len(doc), doc)
	}
	if doc[0].ID != "pr-1" || doc[1].Kind != "code" || doc[1].ID != "co-1" || doc[2].ID != "pr-2" {
		t.Fatalf("structure wrong: %+v", doc)
	}
}

// Full bijection: prose + structured fence + prose round-trips byte-stable.
func TestPairedDelimiter_BijectionWithFence(t *testing.T) {
	block.RegisterProcessor(NewCodeBlockProcessor(block.BlockServices{}))
	t.Cleanup(func() { block.UnregisterProcessor("code") })

	md := "<!--s:pr-a-->\nFirst.\n<!--/s:pr-a-->\n\n" +
		"```code\nid: co-1\nsource: x = 1\n```\n\n" +
		"<!--s:pr-c-->\nTail.\n<!--/s:pr-c-->"
	doc, err := block.NewDocumentCodec(block.GlobalRegistry()).Deserialize(md)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(doc) != 3 {
		t.Fatalf("want 3 blocks, got %d: %+v", len(doc), doc)
	}
	out, err := block.NewDocumentCodec(block.GlobalRegistry()).Serialize(doc)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	if out != md {
		t.Fatalf("bijection broken:\n got: %q\nwant: %q", out, md)
	}
}
