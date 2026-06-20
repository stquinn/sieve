package block

import (
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	gmparser "github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// Region is the portable unit the codec dispatches on (unchanged contract): a
// shape span carries its kind in Kind and its exact bytes in Raw (Body == Raw);
// a text run between spans has empty Kind. Regions tile the source gaplessly, so
// concatenating every Raw reproduces the input — that is what lets prose absorb
// an unclaimed fence verbatim.
type Region struct {
	Kind string
	Body string
	Raw  string
}

// RegionScanner splits markdown into ordered regions using the registered shapes.
// It is delimiter-aware but kind-blind: a shape's head tells it where a region is;
// what claims the region is the codec's job. goldmark is an implementation detail
// fully hidden behind Scan.
type RegionScanner struct {
	md goldmark.Markdown
}

// NewRegionScanner builds a scanner whose goldmark recognises the given shapes as
// opaque raw blocks (priority 50, ahead of fenced/HTML). Bytes no shape claims are
// parsed natively and surface as gap text.
func NewRegionScanner(shapes []RegionShape) *RegionScanner {
	md := goldmark.New(goldmark.WithParserOptions(
		gmparser.WithBlockParsers(util.Prioritized(newShapeParser(shapes), 50)),
	))
	return &RegionScanner{md: md}
}

// Scan returns gapless regions: each shape node becomes a kind-tagged region; the
// byte spans between shape nodes become text regions.
func (s *RegionScanner) Scan(markdown string) []Region {
	source := []byte(markdown)
	root := s.md.Parser().Parse(text.NewReader(source))

	// Collect shape nodes in document order (they are top-level blocks).
	var spans []*shapeNode
	_ = ast.Walk(root, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		if sn, ok := n.(*shapeNode); ok {
			spans = append(spans, sn)
			return ast.WalkSkipChildren, nil
		}
		return ast.WalkContinue, nil
	})

	var regions []Region
	cursor := 0
	emitText := func(end int) {
		if end > cursor {
			raw := string(source[cursor:end])
			regions = append(regions, Region{Body: raw, Raw: raw})
		}
	}
	for _, sn := range spans {
		emitText(sn.Start)
		raw := string(source[sn.Start:sn.Stop])
		regions = append(regions, Region{Kind: sn.ShapeKind, Body: raw, Raw: raw})
		cursor = sn.Stop
	}
	emitText(len(source))
	return regions
}
