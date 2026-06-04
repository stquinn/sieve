package sieve

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
	"gopkg.in/yaml.v3"

	"sieve/sieve/fencedblock"
)

var (
	// Matches [!kind] { "json":"here" } [!somekind-end]
	inlineBlockRegex = regexp.MustCompile(`^\[!([A-Za-z0-9_-]+)\]\s*(\{.*?\})\s*\[!([A-Za-z0-9_-]+)-end\]`)
)

// SieveNode is the interface that all custom Sieve AST nodes implement.
type SieveNode interface {
	ast.Node
	GetSieveBlock() *SieveBlock
	StartByte() int
	EndByte() int
}

// SieveBlockNode represents a fenced block
type SieveBlockNode struct {
	ast.BaseBlock
	SieveBlock
	start int
	end   int
}

func (n *SieveBlockNode) Dump(source []byte, level int) {
	ast.DumpHelper(n, source, level, nil, nil)
}

var KindSieveBlock = ast.NewNodeKind("SieveBlock")

func (n *SieveBlockNode) Kind() ast.NodeKind { return KindSieveBlock }
func (n *SieveBlockNode) GetSieveBlock() *SieveBlock { return &n.SieveBlock }
func (n *SieveBlockNode) StartByte() int { return n.start }
func (n *SieveBlockNode) EndByte() int { return n.end }

// SieveInlineNode represents [TEXT](URL) { ... }
type SieveInlineNode struct {
	ast.BaseInline
	SieveBlock
	start int
	end   int
}

func (n *SieveInlineNode) Dump(source []byte, level int) {
	ast.DumpHelper(n, source, level, nil, nil)
}

var KindSieveInline = ast.NewNodeKind("SieveInline")

func (n *SieveInlineNode) Kind() ast.NodeKind { return KindSieveInline }
func (n *SieveInlineNode) GetSieveBlock() *SieveBlock { return &n.SieveBlock }
func (n *SieveInlineNode) StartByte() int { return n.start }
func (n *SieveInlineNode) EndByte() int { return n.end }

// --- AST Transformer for Block Nodes ---

type sieveBlockASTTransformer struct{}

func (t *sieveBlockASTTransformer) Transform(node *ast.Document, reader text.Reader, pc parser.Context) {
	source := reader.Source()
	
	_ = ast.Walk(node, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}

		if cb, ok := n.(*ast.FencedCodeBlock); ok {
			kind := string(cb.Language(source))
			if kind == "" {
				return ast.WalkContinue, nil
			}

			processor := GetProcessor(kind)
			if processor == nil || processor.Mode() != BlockModeBlock {
				return ast.WalkContinue, nil
			}

			// Parse YAML content
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
			
			// Find precise start and end bytes of the block including fences
			startIdx := 0
			if cb.Lines().Len() > 0 {
				startIdx = cb.Lines().At(0).Start
				// Back up over newline
				if startIdx > 0 && source[startIdx-1] == '\n' {
					startIdx--
				}
				// Back up to start of fence line
				for startIdx > 0 && source[startIdx-1] != '\n' {
					startIdx--
				}
			}

			endIdx := len(source)
			if cb.Lines().Len() > 0 {
				endIdx = cb.Lines().At(cb.Lines().Len() - 1).Stop
				// Move forward over newline
				if endIdx < len(source) && source[endIdx] == '\n' {
					endIdx++
				}
				// Move forward to end of closing fence line
				for endIdx < len(source) && source[endIdx] != '\n' {
					endIdx++
				}
			}

			sieveNode := &SieveBlockNode{
				SieveBlock: SieveBlock{
					ID:    id,
					Kind:  kind,
					Attrs: attrs,
				},
				start: startIdx,
				end:   endIdx,
			}
			parent := cb.Parent()
			parent.ReplaceChild(parent, cb, sieveNode)
		}
		return ast.WalkContinue, nil
	})
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

	node := &SieveInlineNode{
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

var SieveExtension = &sieveExtension{}

// --- Public API for EditorService ---

var sharedMDParser = sync.OnceValue(func() goldmark.Markdown {
	return goldmark.New(
		goldmark.WithExtensions(BlockAnchorExtension, SieveExtension),
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
		if sn, ok := n.(SieveNode); ok {
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

// SerializeBlock safely formats a SieveBlock into markdown string based on its mode
func SerializeBlock(processor BlockProcessor, block *SieveBlock) (string, error) {
	if processor.Mode() == BlockModeInline {
		b, err := json.Marshal(block.Attrs)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("[!%s] %s [!%s-end]", block.Kind, string(b), block.Kind), nil
	}
	
	// BlockModeBlock
	serialized, err := fencedblock.SerializeYaml(block.Attrs)
	if err != nil {
		return "", err
	}
	return "```" + block.Kind + "\n" + serialized + "\n```", nil
}

// InjectBlocks safely replaces block attributes in the AST and outputs the updated markdown.
// It uses precise byte offsets gathered during AST parsing to splice the new strings into the original source.
func InjectBlocks(markdown string, authoritativeBlocks map[string]*SieveBlock) string {
	doc := mdParser().Parser().Parse(text.NewReader([]byte(markdown)))

	// Collect nodes to replace
	var nodes []SieveNode
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if sn, ok := n.(SieveNode); ok {
				nodes = append(nodes, sn)
			}
		}
		return ast.WalkContinue, nil
	})

	// If no authoritative blocks match, we just return the original markdown
	if len(nodes) == 0 {
		return markdown
	}

	// Sort nodes by start byte to safely splice backwards or left-to-right
	sort.Slice(nodes, func(i, j int) bool {
		return nodes[i].StartByte() < nodes[j].StartByte()
	})

	var out strings.Builder
	lastEnd := 0

	for _, n := range nodes {
		blk := n.GetSieveBlock()
		authBlk, exists := authoritativeBlocks[blk.ID]
		if !exists {
			// keep original
			out.WriteString(markdown[lastEnd:n.EndByte()])
			lastEnd = n.EndByte()
			continue
		}

		processor := GetProcessor(authBlk.Kind)
		if processor == nil {
			out.WriteString(markdown[lastEnd:n.EndByte()])
			lastEnd = n.EndByte()
			continue
		}

		serialized, err := SerializeBlock(processor, authBlk)
		if err != nil {
			// fallback to original
			out.WriteString(markdown[lastEnd:n.EndByte()])
			lastEnd = n.EndByte()
			continue
		}

		out.WriteString(markdown[lastEnd:n.StartByte()])
		out.WriteString(serialized)
		lastEnd = n.EndByte()
	}

	out.WriteString(markdown[lastEnd:])
	return out.String()
}
