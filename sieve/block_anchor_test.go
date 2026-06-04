package sieve

import (
	"testing"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

func TestBlockAnchorParsesSimpleRegion(t *testing.T) {
	md := "[!block] id=\"blk-1234\"\n\nSome content\n\n[!block-end]\n"
	doc := mdParser().Parser().Parse(text.NewReader([]byte(md)))

	var found *BlockAnchorNode
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if ba, ok := n.(*BlockAnchorNode); ok {
				found = ba
				return ast.WalkStop, nil
			}
		}
		return ast.WalkContinue, nil
	})

	if found == nil {
		t.Fatal("expected BlockAnchorNode, got nil")
	}
	if found.AnchorID != "blk-1234" {
		t.Errorf("expected AnchorID=blk-1234, got %q", found.AnchorID)
	}
}

func TestBlockAnchorHasChildren(t *testing.T) {
	md := "[!block] id=\"blk-1234\"\n\nSome content here\n\n[!block-end]\n"
	doc := mdParser().Parser().Parse(text.NewReader([]byte(md)))

	var anchor *BlockAnchorNode
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if ba, ok := n.(*BlockAnchorNode); ok {
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
	// [!block] without id= should NOT produce a BlockAnchorNode — falls through to plain text
	md := "[!block] notanid\n\nSome content\n\n[!block-end]\n"
	doc := mdParser().Parser().Parse(text.NewReader([]byte(md)))

	var found *BlockAnchorNode
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if ba, ok := n.(*BlockAnchorNode); ok {
				found = ba
				return ast.WalkStop, nil
			}
		}
		return ast.WalkContinue, nil
	})
	if found != nil {
		t.Error("expected no BlockAnchorNode for malformed anchor line")
	}
}

func TestBlockAnchorChildSieveBlockIsPromoted(t *testing.T) {
	RegisterProcessor("code", &CodeBlockProcessor{})
	t.Cleanup(func() { UnregisterProcessor("code") })
	// A fenced SieveBlock inside a BlockAnchor should be promoted to SieveBlockNode
	// by the existing sieveBlockASTTransformer.
	md := "[!block] id=\"blk-1234\"\n\n```code\nid: co-abcd\nstatus: COMPLETE\nsource: fmt.Println()\n```\n\n[!block-end]\n"
	doc := mdParser().Parser().Parse(text.NewReader([]byte(md)))

	var anchor *BlockAnchorNode
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if ba, ok := n.(*BlockAnchorNode); ok {
				anchor = ba
				return ast.WalkStop, nil
			}
		}
		return ast.WalkContinue, nil
	})
	if anchor == nil {
		t.Fatal("no anchor found")
	}

	var sieveChild *SieveBlockNode
	for child := anchor.FirstChild(); child != nil; child = child.NextSibling() {
		if sb, ok := child.(*SieveBlockNode); ok {
			sieveChild = sb
			break
		}
	}
	if sieveChild == nil {
		t.Error("expected SieveBlockNode child inside BlockAnchorNode")
	}
}

func TestBlockAnchorDoesNotInterruptParagraph(t *testing.T) {
	// [!block] immediately following text (no blank line) must NOT open an anchor;
	// the line should stay in the paragraph. This prevents the parser from firing
	// mid-prose when users write [!block] as literal text.
	md := "Some prose here\n[!block] id=\"blk-9999\"\nmore prose\n\n[!block-end]\n"
	doc := mdParser().Parser().Parse(text.NewReader([]byte(md)))

	var found *BlockAnchorNode
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if ba, ok := n.(*BlockAnchorNode); ok {
				found = ba
				return ast.WalkStop, nil
			}
		}
		return ast.WalkContinue, nil
	})
	if found != nil {
		t.Error("BlockAnchorNode must not be opened when [!block] interrupts a paragraph")
	}
}

func TestBlockAnchorMultipleParagraphs(t *testing.T) {
	md := "[!block] id=\"blk-5678\"\n\nFirst paragraph.\n\nSecond paragraph.\n\n[!block-end]\n"
	doc := mdParser().Parser().Parse(text.NewReader([]byte(md)))

	var anchor *BlockAnchorNode
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if ba, ok := n.(*BlockAnchorNode); ok {
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
