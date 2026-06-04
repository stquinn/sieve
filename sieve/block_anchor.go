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

// BlockAnchorNode is a Goldmark container AST node representing a
// [!block] id="…" … [!block-end] region.
// Its children are the parsed Markdown blocks within the region.
// Any fenced SieveBlocks inside will be promoted to SieveBlockNode by
// the existing sieveBlockASTTransformer.
type BlockAnchorNode struct {
	ast.BaseBlock
	AnchorID string
}

func (n *BlockAnchorNode) Dump(source []byte, level int) {
	ast.DumpHelper(n, source, level, map[string]string{"AnchorID": n.AnchorID}, nil)
}

// KindBlockAnchor is the unique Goldmark NodeKind for BlockAnchorNode.
var KindBlockAnchor = ast.NewNodeKind("BlockAnchor")

func (n *BlockAnchorNode) Kind() ast.NodeKind { return KindBlockAnchor }

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
	return &BlockAnchorNode{AnchorID: string(match[1])}, parser.HasChildren
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

// CanInterruptParagraph returns true so [!block] can open without a preceding blank line.
func (p *blockAnchorParser) CanInterruptParagraph() bool { return true }

// CanAcceptIndentedCode returns false — the block anchor uses an explicit end marker.
func (p *blockAnchorParser) CanAcceptIndentedCode() bool { return false }

// blockAnchorExtension adds blockAnchorParser to a Goldmark Markdown instance.
type blockAnchorExtension struct{}

func (e *blockAnchorExtension) Extend(m goldmark.Markdown) {
	m.Parser().AddOptions(
		parser.WithBlockParsers(
			util.Prioritized(&blockAnchorParser{}, 100),
		),
	)
}

// BlockAnchorExtension is the Goldmark extension to register with goldmark.New().
var BlockAnchorExtension = &blockAnchorExtension{}
