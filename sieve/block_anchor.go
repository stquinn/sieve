package sieve

import (
	"bytes"
	"regexp"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// BlockAnchor is the business object representing a block anchor region and its targets.
type BlockAnchor struct {
	AnchorID string
	Targets  []string
}

// BlockAnchorNode is a Goldmark container AST node representing a
// [!block] id="…" … [!block-end] region.
// Its children are the parsed Markdown blocks within the region.
// Any fenced SieveBlocks inside will be promoted to SieveBlockNode by
// the existing sieveBlockASTTransformer.
type BlockAnchorNode struct {
	ast.BaseBlock
	BlockAnchor
}

func (n *BlockAnchorNode) Dump(source []byte, level int) {
	ast.DumpHelper(n, source, level, map[string]string{"AnchorID": n.AnchorID}, nil)
}

// KindBlockAnchor is the unique Goldmark NodeKind for BlockAnchorNode.
var KindBlockAnchor = ast.NewNodeKind("BlockAnchor")

func (n *BlockAnchorNode) Kind() ast.NodeKind { return KindBlockAnchor }

// TargetHighlightNode is an inline AST node representing a ==...== target mark.
// It stores the raw text content between the delimiters.
type TargetHighlightNode struct {
	ast.BaseInline
	Content string
}

func (n *TargetHighlightNode) Dump(source []byte, level int) {
	ast.DumpHelper(n, source, level, map[string]string{"Content": n.Content}, nil)
}

var KindTargetHighlight = ast.NewNodeKind("TargetHighlight")

func (n *TargetHighlightNode) Kind() ast.NodeKind { return KindTargetHighlight }

// blockAnchorOpenRegex matches [!block] id="blk-XXXX" at the start of a line.
var blockAnchorOpenRegex = regexp.MustCompile(`^\[!block\]\s+id="([^"]+)"`)

// blockAnchorParser is a Goldmark BlockParser that recognises [!block] regions.
type blockAnchorParser struct{}

// Trigger returns '[' so the parser is only considered on lines starting with '['.
func (p *blockAnchorParser) Trigger() []byte { return []byte{'['} }

// Open fires when Goldmark encounters a line starting with '['.
// It returns the node and HasChildren if the line is a valid [!block] opener.
func (p *blockAnchorParser) Open(parent ast.Node, reader text.Reader, pc parser.Context) (ast.Node, parser.State) {
	line, _ := reader.PeekLine()
	match := blockAnchorOpenRegex.FindSubmatch(bytes.TrimRight(line, "\n\r"))
	if match == nil {
		return nil, parser.NoChildren
	}
	reader.Advance(len(line))
	return &BlockAnchorNode{
		BlockAnchor: BlockAnchor{AnchorID: string(match[1])},
	}, parser.HasChildren
}

// Continue is called for each subsequent line while the node is open.
// It closes the node when it encounters [!block-end].
func (p *blockAnchorParser) Continue(node ast.Node, reader text.Reader, pc parser.Context) parser.State {
	line, _ := reader.PeekLine()
	if bytes.Equal(bytes.TrimSpace(line), []byte("[!block-end]")) {
		reader.Advance(len(line))
		return parser.Close
	}
	return parser.Continue | parser.HasChildren
}

// Close finalises the node. No action needed.
func (p *blockAnchorParser) Close(node ast.Node, reader text.Reader, pc parser.Context) {}

func (p *blockAnchorParser) CanInterruptParagraph() bool { return false }

// CanAcceptIndentedLine returns false — the block anchor uses an explicit end marker.
func (p *blockAnchorParser) CanAcceptIndentedLine() bool { return false }

// blockAnchorExtension adds blockAnchorParser to a Goldmark Markdown instance.
type blockAnchorExtension struct{}

func (e *blockAnchorExtension) Extend(m goldmark.Markdown) {
	m.Parser().AddOptions(
		parser.WithBlockParsers(
			util.Prioritized(&blockAnchorParser{}, 100),
		),
		parser.WithInlineParsers(
			util.Prioritized(&targetHighlightParser{}, 50),
		),
		parser.WithASTTransformers(
			util.Prioritized(&blockAnchorTargetTransformer{}, 50),
		),
	)
}

// BlockAnchorExtension is the Goldmark extension to register with goldmark.New().
var BlockAnchorExtension = &blockAnchorExtension{}

// targetHighlightParser is a Goldmark inline parser for ==...== markers.
type targetHighlightParser struct{}

func (p *targetHighlightParser) Trigger() []byte { return []byte{'='} }

func (p *targetHighlightParser) Parse(parent ast.Node, reader text.Reader, pc parser.Context) ast.Node {
	line, _ := reader.PeekLine()
	if len(line) < 4 || line[0] != '=' || line[1] != '=' {
		return nil
	}
	rest := line[2:]
	end := bytes.Index(rest, []byte("=="))
	if end <= 0 {
		return nil
	}
	content := bytes.TrimSpace(rest[:end])
	if len(content) == 0 {
		return nil
	}
	reader.Advance(end + 4) // ==content== → 2 + end + 2
	return &TargetHighlightNode{Content: string(content)}
}

// blockAnchorTargetTransformer walks BlockAnchorNodes and collects
// all TargetHighlightNode text into the anchor's Targets slice.
type blockAnchorTargetTransformer struct{}

func (t *blockAnchorTargetTransformer) Transform(node *ast.Document, reader text.Reader, pc parser.Context) {
	_ = ast.Walk(node, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		ba, ok := n.(*BlockAnchorNode)
		if !ok {
			return ast.WalkContinue, nil
		}
		_ = ast.Walk(ba, func(child ast.Node, childEntering bool) (ast.WalkStatus, error) {
			if !childEntering {
				return ast.WalkContinue, nil
			}
			if ht, ok := child.(*TargetHighlightNode); ok {
				ba.Targets = append(ba.Targets, ht.Content)
			}
			return ast.WalkContinue, nil
		})
		return ast.WalkContinue, nil
	})
}

// ParseBlockAnchors parses markdown and returns all BlockAnchors.
// This returns only the business objects, keeping Goldmark AST internal.
func ParseBlockAnchors(markdown string) []*BlockAnchor {
	doc := mdParser().Parser().Parse(text.NewReader([]byte(markdown)))
	var anchors []*BlockAnchor
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if ba, ok := n.(*BlockAnchorNode); ok {
				// Deep copy the business object so mutations don't affect the AST
				copyAnchor := &BlockAnchor{
					AnchorID: ba.AnchorID,
					Targets:  make([]string, len(ba.Targets)),
				}
				copy(copyAnchor.Targets, ba.Targets)
				anchors = append(anchors, copyAnchor)
			}
		}
		return ast.WalkContinue, nil
	})
	return anchors
}
