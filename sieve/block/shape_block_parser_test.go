package block

import (
	"testing"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	gmparser "github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// shapesFor builds the two shapes used across these tests.
func shapesFor() []RegionShape {
	return []RegionShape{
		{Kind: "diagram", Head: "```diagram", Tail: "```"},
		{Kind: KindProse, Head: "<!--s:", Tail: "<!--/s:"},
	}
}

func parseShapeNodes(t *testing.T, src string, shapes []RegionShape) ([]*shapeNode, []byte) {
	t.Helper()
	md := goldmark.New(goldmark.WithParserOptions(
		gmparser.WithBlockParsers(util.Prioritized(newShapeParser(shapes), 50)),
	))
	source := []byte(src)
	root := md.Parser().Parse(text.NewReader(source))
	var nodes []*shapeNode
	_ = ast.Walk(root, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		if sn, ok := n.(*shapeNode); ok {
			nodes = append(nodes, sn)
		}
		return ast.WalkContinue, nil
	})
	return nodes, source
}

func TestShapeParser_proseMarkerSpanIsOneOpaqueNode(t *testing.T) {
	src := "<!--s:pr-1-->\nSome notes.\n\n```mermaid\ngraph\n```\n\nMore.\n<!--/s:pr-1-->\n"
	nodes, source := parseShapeNodes(t, src, shapesFor())
	if len(nodes) != 1 {
		t.Fatalf("want 1 shape node, got %d", len(nodes))
	}
	if nodes[0].ShapeKind != KindProse {
		t.Fatalf("want prose, got %q", nodes[0].ShapeKind)
	}
	got := string(source[nodes[0].Start:nodes[0].Stop])
	want := "<!--s:pr-1-->\nSome notes.\n\n```mermaid\ngraph\n```\n\nMore.\n<!--/s:pr-1-->\n"
	if got != want {
		t.Fatalf("span mismatch:\n got %q\nwant %q", got, want)
	}
}

func TestShapeParser_registeredFenceIsANode_standardFenceIsNot(t *testing.T) {
	src := "```diagram\nid: dg-1\n```\n\n```java\nx();\n```\n"
	nodes, source := parseShapeNodes(t, src, shapesFor())
	if len(nodes) != 1 {
		t.Fatalf("want 1 shape node (diagram only), got %d", len(nodes))
	}
	if nodes[0].ShapeKind != "diagram" {
		t.Fatalf("want diagram, got %q", nodes[0].ShapeKind)
	}
	got := string(source[nodes[0].Start:nodes[0].Stop])
	if got != "```diagram\nid: dg-1\n```\n" {
		t.Fatalf("diagram span: got %q", got)
	}
}
