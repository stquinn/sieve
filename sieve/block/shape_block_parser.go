package block

import (
	"strings"

	"github.com/yuin/goldmark/ast"
	gmparser "github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
)

// shapeNode is the opaque AST block a matched shape produces: a kind-tagged span
// carrying its exact source byte range [Start,Stop). Its interior is NOT parsed —
// the whole span is taken verbatim, so an inner ``` inside a prose marker span is
// never split out.
type shapeNode struct {
	ast.BaseBlock
	ShapeKind string
	Start     int
	Stop      int
}

func (n *shapeNode) Dump(src []byte, level int) { ast.DumpHelper(n, src, level, nil, nil) }

var kindShapeNode = ast.NewNodeKind("SieveShape")

func (n *shapeNode) Kind() ast.NodeKind { return kindShapeNode }

// shapeBlockParser recognises every registered shape — fenced and marker alike —
// as one opaque raw block. ONE parser for all shapes (no fenced/marker split).
// Registered at priority < 700 so it wins over goldmark's fenced-code (700) and
// HTML-comment (900) parsers when a registered head opens.
type shapeBlockParser struct {
	shapes []RegionShape
}

func newShapeParser(shapes []RegionShape) *shapeBlockParser {
	return &shapeBlockParser{shapes: shapes}
}

// shapeParseState rides on the parser context while a span is open.
type shapeParseState struct {
	tail string
	stop int
}

var shapeStateKey = gmparser.NewContextKey()

// Trigger: the distinct first bytes of every registered head (e.g. '`' and '<').
func (p *shapeBlockParser) Trigger() []byte {
	seen := map[byte]bool{}
	var out []byte
	for _, s := range p.shapes {
		if s.Head == "" {
			continue
		}
		if b := s.Head[0]; !seen[b] {
			seen[b] = true
			out = append(out, b)
		}
	}
	return out
}

// matchHead returns the shape whose Head the trimmed line begins with, or false.
func (p *shapeBlockParser) matchHead(line string) (RegionShape, bool) {
	t := strings.TrimSpace(line)
	for _, s := range p.shapes {
		if s.Head != "" && strings.HasPrefix(t, s.Head) {
			return s, true
		}
	}
	return RegionShape{}, false
}

func (p *shapeBlockParser) Open(parent ast.Node, reader text.Reader, pc gmparser.Context) (ast.Node, gmparser.State) {
	line, segment := reader.PeekLine()
	shape, ok := p.matchHead(string(line))
	if !ok {
		return nil, gmparser.NoChildren
	}
	// Do NOT call reader.Advance here: goldmark's parseBlocks calls AdvanceLine()
	// once after Open returns, which is sufficient to move past the head line.
	// Calling Advance inside Open causes a double-skip (Advance's internal
	// AdvanceLine on the trailing \n + parseBlocks' AdvanceLine), which loses
	// the first body line.
	node := &shapeNode{ShapeKind: shape.Kind, Start: segment.Start, Stop: segment.Stop}
	pc.Set(shapeStateKey, &shapeParseState{tail: shape.Tail, stop: segment.Stop})
	return node, gmparser.NoChildren
}

func (p *shapeBlockParser) Continue(node ast.Node, reader text.Reader, pc gmparser.Context) gmparser.State {
	st, _ := pc.Get(shapeStateKey).(*shapeParseState)
	line, segment := reader.PeekLine()
	if st == nil || line == nil {
		return gmparser.Close
	}
	st.stop = segment.Stop
	// Use AdvanceToEOL (not Advance(segment.Len())) to position the reader AT
	// the line's trailing \n without crossing into the next line. parseBlocks
	// calls AdvanceLine() after Continue returns, which is what moves to the
	// next line. Advance(segment.Len()) would trigger an internal AdvanceLine
	// on the \n, and parseBlocks' AdvanceLine would then double-skip a line.
	reader.AdvanceToEOL()
	// The tail must be at column zero. Serialized blocks always write the closing
	// delimiter flush-left, and a fenced block's YAML body indents its content
	// (e.g. a literal scalar) by 4 spaces precisely so an INNER ``` is kept off
	// column zero — TrimSpace-ing here would defeat that protection and close the
	// span at the first nested fence, tearing the block apart (regression: ai-block
	// responses carrying code fences, artefact dispute-id block ai-b42a).
	if strings.HasPrefix(string(line), st.tail) {
		return gmparser.Close
	}
	return gmparser.Continue | gmparser.NoChildren
}

func (p *shapeBlockParser) Close(node ast.Node, reader text.Reader, pc gmparser.Context) {
	if st, ok := pc.Get(shapeStateKey).(*shapeParseState); ok && st != nil {
		if sn, ok := node.(*shapeNode); ok {
			sn.Stop = st.stop
		}
	}
	pc.Set(shapeStateKey, nil)
}

// CanInterruptParagraph: a shape head may begin right after a paragraph line.
func (p *shapeBlockParser) CanInterruptParagraph() bool { return true }

// CanAcceptIndentedLine: heads are column-0; never open on an indented line.
func (p *shapeBlockParser) CanAcceptIndentedLine() bool { return false }
