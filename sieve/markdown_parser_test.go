package sieve

import (
	"testing"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

func TestBlockAnchorParsesSimpleRegion(t *testing.T) {
	md := "[!block] id=\"blk-1234\"\n\nSome content\n\n[!block-end]\n"
	doc := mdParser().Parser().Parse(text.NewReader([]byte(md)))

	var found *blockAnchorNode
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if ba, ok := n.(*blockAnchorNode); ok {
				found = ba
				return ast.WalkStop, nil
			}
		}
		return ast.WalkContinue, nil
	})

	if found == nil {
		t.Fatal("expected blockAnchorNode, got nil")
	}
	if found.AnchorID != "blk-1234" {
		t.Errorf("expected AnchorID=blk-1234, got %q", found.AnchorID)
	}
}

func TestBlockAnchorHasChildren(t *testing.T) {
	md := "[!block] id=\"blk-1234\"\n\nSome content here\n\n[!block-end]\n"
	doc := mdParser().Parser().Parse(text.NewReader([]byte(md)))

	var anchor *blockAnchorNode
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if ba, ok := n.(*blockAnchorNode); ok {
				anchor = ba
				return ast.WalkStop, nil
			}
		}
		return ast.WalkContinue, nil
	})
	if anchor == nil {
		t.Fatal("no anchor found")
	}
	if anchor.ChildCount() == 0 {
		t.Error("expected anchor to have at least one child node")
	}
}

func TestBlockAnchorMissingIDIsIgnored(t *testing.T) {
	// [!block] without id= should NOT produce a blockAnchorNode — falls through to plain text
	md := "[!block] notanid\n\nSome content\n\n[!block-end]\n"
	doc := mdParser().Parser().Parse(text.NewReader([]byte(md)))

	var found *blockAnchorNode
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if ba, ok := n.(*blockAnchorNode); ok {
				found = ba
				return ast.WalkStop, nil
			}
		}
		return ast.WalkContinue, nil
	})
	if found != nil {
		t.Error("expected no blockAnchorNode for malformed anchor line")
	}
}

func TestBlockAnchorChildSieveBlockIsPromoted(t *testing.T) {
	RegisterProcessor("code", &CodeBlockProcessor{})
	t.Cleanup(func() { UnregisterProcessor("code") })
	// A fenced SieveBlock inside a BlockAnchor should be promoted to sieveBlockNode
	// by the existing sieveBlockASTTransformer.
	md := "[!block] id=\"blk-1234\"\n\n```code\nid: co-abcd\nstatus: COMPLETE\nsource: fmt.Println()\n```\n\n[!block-end]\n"
	doc := mdParser().Parser().Parse(text.NewReader([]byte(md)))

	var anchor *blockAnchorNode
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if ba, ok := n.(*blockAnchorNode); ok {
				anchor = ba
				return ast.WalkStop, nil
			}
		}
		return ast.WalkContinue, nil
	})
	if anchor == nil {
		t.Fatal("no anchor found")
	}

	var sieveChild *sieveBlockNode
	for child := anchor.FirstChild(); child != nil; child = child.NextSibling() {
		if sb, ok := child.(*sieveBlockNode); ok {
			sieveChild = sb
			break
		}
	}
	if sieveChild == nil {
		t.Error("expected sieveBlockNode child inside blockAnchorNode")
	}
}

func TestBlockAnchorDoesNotInterruptParagraph(t *testing.T) {
	// [!block] immediately following text (no blank line) must NOT open an anchor;
	// the line should stay in the paragraph. This prevents the parser from firing
	// mid-prose when users write [!block] as literal text.
	md := "Some prose here\n[!block] id=\"blk-9999\"\nmore prose\n\n[!block-end]\n"
	doc := mdParser().Parser().Parse(text.NewReader([]byte(md)))

	var found *blockAnchorNode
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if ba, ok := n.(*blockAnchorNode); ok {
				found = ba
				return ast.WalkStop, nil
			}
		}
		return ast.WalkContinue, nil
	})
	if found != nil {
		t.Error("blockAnchorNode must not be opened when [!block] interrupts a paragraph")
	}
}

func TestBlockAnchorMultipleParagraphs(t *testing.T) {
	md := "[!block] id=\"blk-5678\"\n\nFirst paragraph.\n\nSecond paragraph.\n\n[!block-end]\n"
	doc := mdParser().Parser().Parse(text.NewReader([]byte(md)))

	var anchor *blockAnchorNode
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if ba, ok := n.(*blockAnchorNode); ok {
				anchor = ba
				return ast.WalkStop, nil
			}
		}
		return ast.WalkContinue, nil
	})
	if anchor == nil {
		t.Fatal("no anchor found")
	}
	if anchor.ChildCount() < 2 {
		t.Errorf("expected at least 2 children, got %d", anchor.ChildCount())
	}
}

func TestTargetHighlightNodeParsesMarker(t *testing.T) {
	md := "[!block] id=\"blk-1234\"\n\nThe patient showed ==acute== symptoms.\n\n[!block-end]\n"
	doc := mdParser().Parser().Parse(text.NewReader([]byte(md)))

	var anchor *blockAnchorNode
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if ba, ok := n.(*blockAnchorNode); ok {
				anchor = ba
				return ast.WalkStop, nil
			}
		}
		return ast.WalkContinue, nil
	})
	if anchor == nil {
		t.Fatal("no blockAnchorNode found")
	}
	if len(anchor.Targets) != 1 {
		t.Fatalf("expected 1 target, got %d: %v", len(anchor.Targets), anchor.Targets)
	}
	if anchor.Targets[0] != "acute" {
		t.Errorf("expected target 'acute', got %q", anchor.Targets[0])
	}
}

func TestTargetHighlightNodeMultipleTargets(t *testing.T) {
	md := "[!block] id=\"blk-5678\"\n\nThe ==quick== brown ==fox== jumps.\n\n[!block-end]\n"
	doc := mdParser().Parser().Parse(text.NewReader([]byte(md)))

	var anchor *blockAnchorNode
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if ba, ok := n.(*blockAnchorNode); ok {
				anchor = ba
				return ast.WalkStop, nil
			}
		}
		return ast.WalkContinue, nil
	})
	if anchor == nil {
		t.Fatal("no blockAnchorNode found")
	}
	if len(anchor.Targets) != 2 {
		t.Fatalf("expected 2 targets, got %d: %v", len(anchor.Targets), anchor.Targets)
	}
	if anchor.Targets[0] != "quick" || anchor.Targets[1] != "fox" {
		t.Errorf("expected [quick fox], got %v", anchor.Targets)
	}
}

func TestTargetHighlightOutsideAnchorProducesNoTargets(t *testing.T) {
	// ==marks== outside a BlockAnchor don't crash and produce no blockAnchorNode
	md := "The ==highlighted== word outside any anchor.\n"
	doc := mdParser().Parser().Parse(text.NewReader([]byte(md)))

	var found *blockAnchorNode
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if ba, ok := n.(*blockAnchorNode); ok {
				found = ba
				return ast.WalkStop, nil
			}
		}
		return ast.WalkContinue, nil
	})
	if found != nil {
		t.Error("unexpected blockAnchorNode for content outside any anchor")
	}
}

func TestParseBlockAnchors(t *testing.T) {
	md := "[!block] id=\"blk-abc\"\n\nFoo ==bar== baz.\n\n[!block-end]\n\n[!block] id=\"blk-def\"\n\nNo targets here.\n\n[!block-end]\n"
	anchors := ParseBlockAnchors(md)
	if len(anchors) != 2 {
		t.Fatalf("expected 2 anchors, got %d", len(anchors))
	}
	byID := make(map[string]*BlockAnchor)
	for _, a := range anchors {
		byID[a.AnchorID] = a
	}
	if a := byID["blk-abc"]; a == nil || len(a.Targets) != 1 || a.Targets[0] != "bar" {
		t.Errorf("blk-abc: expected Targets=[bar], got %v", a)
	}
	if a := byID["blk-def"]; a == nil || len(a.Targets) != 0 {
		t.Errorf("blk-def: expected no targets, got %v", a.Targets)
	}
}

