package sieve

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
	"gopkg.in/yaml.v3"
)

var (
	// Matches [!kind] { "json":"here" } [!somekind-end]
	inlineBlockRegex = regexp.MustCompile(`^\[!([A-Za-z0-9_-]+)\]\s*(\{.*?\})\s*\[!([A-Za-z0-9_-]+)-end\]`)
)

// sieveNode is the interface that all custom Sieve AST nodes implement.
type sieveNode interface {
	ast.Node
	GetSieveBlock() *SieveBlock
	StartByte() int
	EndByte() int
}

// sieveBlockNode represents a fenced block
type sieveBlockNode struct {
	ast.BaseBlock
	SieveBlock
	start int
	end   int
}

func (n *sieveBlockNode) Dump(source []byte, level int) {
	ast.DumpHelper(n, source, level, nil, nil)
}

var kindSieveBlock = ast.NewNodeKind("SieveBlock")

func (n *sieveBlockNode) Kind() ast.NodeKind         { return kindSieveBlock }
func (n *sieveBlockNode) GetSieveBlock() *SieveBlock { return &n.SieveBlock }
func (n *sieveBlockNode) StartByte() int             { return n.start }
func (n *sieveBlockNode) EndByte() int               { return n.end }

// sieveInlineNode represents [TEXT](URL) { ... }
type sieveInlineNode struct {
	ast.BaseInline
	SieveBlock
	start int
	end   int
}

func (n *sieveInlineNode) Dump(source []byte, level int) {
	ast.DumpHelper(n, source, level, nil, nil)
}

var kindSieveInline = ast.NewNodeKind("SieveInline")

func (n *sieveInlineNode) Kind() ast.NodeKind         { return kindSieveInline }
func (n *sieveInlineNode) GetSieveBlock() *SieveBlock { return &n.SieveBlock }
func (n *sieveInlineNode) StartByte() int             { return n.start }
func (n *sieveInlineNode) EndByte() int               { return n.end }

// --- AST Transformer for Block Nodes ---

type sieveBlockASTTransformer struct{}

func (t *sieveBlockASTTransformer) Transform(node *ast.Document, reader text.Reader, pc parser.Context) {
	source := reader.Source()

	// First pass: collect candidates without touching the tree.
	// Calling ReplaceChild inside ast.Walk clears the replaced node's sibling
	// pointers, which breaks the walk loop (NextSibling returns nil early).
	type pending struct {
		cb   *ast.FencedCodeBlock
		node *sieveBlockNode
	}
	var candidates []pending

	_ = ast.Walk(node, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		cb, ok := n.(*ast.FencedCodeBlock)
		if !ok {
			return ast.WalkContinue, nil
		}

		kind := string(cb.Language(source))
		if kind == "" {
			return ast.WalkContinue, nil
		}
		processor := GetProcessor(kind)
		if processor == nil || processor.Mode() != BlockModeBlock {
			return ast.WalkContinue, nil
		}

		var buf bytes.Buffer
		l := cb.Lines().Len()
		for i := 0; i < l; i++ {
			seg := cb.Lines().At(i)
			buf.Write(seg.Value(source))
		}

		var attrs map[string]interface{}
		if err := yaml.Unmarshal(buf.Bytes(), &attrs); err != nil {
			return ast.WalkContinue, nil
		}
		id, _ := attrs["id"].(string)
		if id == "" {
			return ast.WalkContinue, nil
		}

		startIdx := 0
		if cb.Lines().Len() > 0 {
			startIdx = cb.Lines().At(0).Start
			if startIdx > 0 && source[startIdx-1] == '\n' {
				startIdx--
			}
			for startIdx > 0 && source[startIdx-1] != '\n' {
				startIdx--
			}
		}
		endIdx := len(source)
		if cb.Lines().Len() > 0 {
			endIdx = cb.Lines().At(cb.Lines().Len() - 1).Stop
			if endIdx < len(source) && source[endIdx] == '\n' {
				endIdx++
			}
			for endIdx < len(source) && source[endIdx] != '\n' {
				endIdx++
			}
		}

		candidates = append(candidates, pending{
			cb: cb,
			node: &sieveBlockNode{
				SieveBlock: SieveBlock{ID: id, Kind: kind, Attrs: attrs},
				start:      startIdx,
				end:        endIdx,
			},
		})
		return ast.WalkContinue, nil
	})

	// Second pass: apply replacements now that the walk is complete.
	for _, p := range candidates {
		parent := p.cb.Parent()
		if parent == nil {
			continue
		}
		parent.ReplaceChild(parent, p.cb, p.node)
	}
}

// --- Inline Parser ---

type sieveInlineParser struct{}

func (s *sieveInlineParser) Trigger() []byte {
	return []byte{'['}
}

func (s *sieveInlineParser) Parse(parent ast.Node, reader text.Reader, pc parser.Context) ast.Node {
	line, segment := reader.PeekLine()
	match := inlineBlockRegex.FindSubmatchIndex(line)
	if match == nil {
		return nil
	}

	startKind := string(line[match[2]:match[3]])
	jsonStr := string(line[match[4]:match[5]])
	endKind := string(line[match[6]:match[7]])

	if startKind != endKind {
		return nil
	}

	var attrs map[string]interface{}
	if err := json.Unmarshal([]byte(jsonStr), &attrs); err != nil {
		return nil
	}

	id, _ := attrs["id"].(string)
	if id == "" {
		return nil
	}

	processor := GetProcessor(startKind)
	if processor == nil || processor.Mode() != BlockModeInline {
		return nil
	}

	start := segment.Start
	end := segment.Start + match[1]

	node := &sieveInlineNode{
		SieveBlock: SieveBlock{
			ID:    id,
			Kind:  startKind,
			Attrs: attrs,
		},
		start: start,
		end:   end,
	}

	reader.Advance(match[1])
	return node
}

// --- Extension ---

type sieveExtension struct{}

func (e *sieveExtension) Extend(m goldmark.Markdown) {
	m.Parser().AddOptions(
		parser.WithASTTransformers(
			util.Prioritized(&sieveBlockASTTransformer{}, 100),
		),
		parser.WithInlineParsers(
			util.Prioritized(&sieveInlineParser{}, 100),
		),
	)
}

var sieveExtensionPlugin = &sieveExtension{}

// --- Public API for EditorService ---

var sharedMDParser = sync.OnceValue(func() goldmark.Markdown {
	return goldmark.New(
		goldmark.WithExtensions(blockAnchorExtensionPlugin, sieveExtensionPlugin),
	)
})

func mdParser() goldmark.Markdown { return sharedMDParser() }

// ParseAllBlocks parses markdown and extracts all Sieve blocks
func ParseAllBlocks(markdown string) map[string]*SieveBlock {
	blocks := make(map[string]*SieveBlock)
	doc := mdParser().Parser().Parse(text.NewReader([]byte(markdown)))

	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		if sn, ok := n.(sieveNode); ok {
			blk := sn.GetSieveBlock()

			copyBlk := &SieveBlock{
				ID:    blk.ID,
				Kind:  blk.Kind,
				Attrs: make(map[string]interface{}),
			}
			for k, v := range blk.Attrs {
				copyBlk.Attrs[k] = v
			}
			blocks[blk.ID] = copyBlk
		}
		return ast.WalkContinue, nil
	})
	return blocks
}

// ParseAllBlocks parses markdown and extracts all Sieve blocks
func ParseFirstBlock(markdown string) *SieveBlock {
	var block *SieveBlock
	doc := mdParser().Parser().Parse(text.NewReader([]byte(markdown)))

	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		if sn, ok := n.(sieveNode); ok {
			blk := sn.GetSieveBlock()

			copyBlk := &SieveBlock{
				ID:    blk.ID,
				Kind:  blk.Kind,
				Attrs: make(map[string]interface{}),
			}
			for k, v := range blk.Attrs {
				copyBlk.Attrs[k] = v
			}
			block = copyBlk
		}
		return ast.WalkContinue, nil
	})
	return block
}

// serializeInlineBlock renders an inline-mode block as [!kind] {json} [!kind-end]
// — the form the inline parser (inlineBlockRegex) reads back. It is owned by
// InlineSerializer, which inline-mode flavours embed; there is no kind-switching
// serializer function anymore — each flavour serializes itself (Serialize).
func serializeInlineBlock(block SieveBlock) (string, error) {
	b, err := json.Marshal(block.Attrs)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("[!%s] %s [!%s-end]", block.Kind, string(b), block.Kind), nil
}

// --- BlockAnchor Parsers and AST Nodes ---

// blockAnchorNode is a Goldmark container AST node representing a
// [!block] id="…" … [!block-end] region.
// Its children are the parsed Markdown blocks within the region.
// Any fenced SieveBlocks inside will be promoted to sieveBlockNode by
// the existing sieveBlockASTTransformer.
type blockAnchorNode struct {
	ast.BaseBlock
	BlockAnchor
}

func (n *blockAnchorNode) Dump(source []byte, level int) {
	ast.DumpHelper(n, source, level, map[string]string{"AnchorID": n.AnchorID}, nil)
}

// kindBlockAnchor is the unique Goldmark NodeKind for blockAnchorNode.
var kindBlockAnchor = ast.NewNodeKind("BlockAnchor")

func (n *blockAnchorNode) Kind() ast.NodeKind { return kindBlockAnchor }

// targetHighlightNode is an inline AST node representing a ==...== target mark.
// It stores the raw text content between the delimiters.
type targetHighlightNode struct {
	ast.BaseInline
	Content string
}

func (n *targetHighlightNode) Dump(source []byte, level int) {
	ast.DumpHelper(n, source, level, map[string]string{"Content": n.Content}, nil)
}

var kindTargetHighlight = ast.NewNodeKind("TargetHighlight")

func (n *targetHighlightNode) Kind() ast.NodeKind { return kindTargetHighlight }

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
	return &blockAnchorNode{
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

// blockAnchorExtensionPlugin is the Goldmark extension to register with goldmark.New().
var blockAnchorExtensionPlugin = &blockAnchorExtension{}

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
	return &targetHighlightNode{Content: string(content)}
}

// blockAnchorTargetTransformer walks blockAnchorNodes and collects
// all targetHighlightNode text into the anchor's Targets slice.
type blockAnchorTargetTransformer struct{}

func (t *blockAnchorTargetTransformer) Transform(node *ast.Document, reader text.Reader, pc parser.Context) {
	_ = ast.Walk(node, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		ba, ok := n.(*blockAnchorNode)
		if !ok {
			return ast.WalkContinue, nil
		}
		_ = ast.Walk(ba, func(child ast.Node, childEntering bool) (ast.WalkStatus, error) {
			if !childEntering {
				return ast.WalkContinue, nil
			}
			if ht, ok := child.(*targetHighlightNode); ok {
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
			if ba, ok := n.(*blockAnchorNode); ok {
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

// FindBlockByID parses markdown and returns the SieveBlock for the given ID.
// For block anchors returns SieveBlock{Kind: "block-anchor"}.
// Returns (SieveBlock{}, false) if not found.
func FindBlockByID(markdown string, id string) (SieveBlock, bool) {
	source := []byte(markdown)
	doc := mdParser().Parser().Parse(text.NewReader(source))

	var result SieveBlock
	found := false
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		if ba, ok := n.(*blockAnchorNode); ok && ba.AnchorID == id {
			result = SieveBlock{ID: id, Kind: "block-anchor", Attrs: map[string]interface{}{"id": id}}
			found = true
			return ast.WalkStop, nil
		}
		if sn, ok := n.(*sieveBlockNode); ok && sn.SieveBlock.ID == id {
			result = sn.SieveBlock
			found = true
			return ast.WalkStop, nil
		}
		return ast.WalkContinue, nil
	})
	return result, found
}

// PromoteBlock replaces a block with plain markdown content.
func PromoteBlock(markdown string, blockID string, replacement string) (string, bool) {
	doc := mdParser().Parser().Parse(text.NewReader([]byte(markdown)))

	var target sieveNode
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		if sn, ok := n.(sieveNode); ok {
			if sn.GetSieveBlock().ID == blockID {
				target = sn
				return ast.WalkStop, nil
			}
		}
		return ast.WalkContinue, nil
	})

	if target == nil {
		return markdown, false
	}

	var out strings.Builder
	out.WriteString(markdown[:target.StartByte()])
	out.WriteString(replacement)
	out.WriteString(markdown[target.EndByte():])
	return out.String(), true
}
