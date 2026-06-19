package sieve

import (
	"strings"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

// BlockAnchor is the business object representing a block anchor region and its targets.
type BlockAnchor struct {
	AnchorID string
	Targets  []string
}

// BlockAnchorProvider implements ContextProvider for the "block-anchor" kind.
// svc is injected for consistency and future extensibility (e.g. asset lookup).
// For SieveBlock children inside an anchor, it delegates to their own provider
// via BuildContextForID — dispatched by block kind, not hardcoded.
type BlockAnchorProvider struct {
	svc BlockServices
}

func (p *BlockAnchorProvider) BuildContext(block SieveBlock, doc DocView, seen map[string]bool) string {
	source := []byte(doc.deriveMarkdown())
	parsed := mdParser().Parser().Parse(text.NewReader(source))

	var anchor *blockAnchorNode
	_ = ast.Walk(parsed, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if ba, ok := n.(*blockAnchorNode); ok && ba.AnchorID == block.ID {
				anchor = ba
				return ast.WalkStop, nil
			}
		}
		return ast.WalkContinue, nil
	})
	if anchor == nil {
		return ""
	}

	var sb strings.Builder
	for child := anchor.FirstChild(); child != nil; child = child.NextSibling() {
		if sn, ok := child.(*sieveBlockNode); ok {
			// Dispatch to the block's own provider by kind — img-1234 → SmartImageProcessor,
			// co-abcd → CodeBlockProcessor, etc. The caller decides representation.
			if ctx := BuildContextForID(sn.SieveBlock.ID, doc, seen); ctx != "" {
				sb.WriteString(ctx)
				sb.WriteString("\n\n")
			}
			continue
		}
		// Plain markdown child: walk text + target highlight nodes.
		// targetHighlightNode stores the == word as plain text — emit it naturally.
		_ = ast.Walk(child, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
			if entering {
				if t, ok := n.(*ast.Text); ok {
					sb.Write(t.Segment.Value(source))
					if t.SoftLineBreak() {
						sb.WriteByte('\n')
					}
				}
				if ht, ok := n.(*targetHighlightNode); ok {
					sb.WriteString(ht.Content)
				}
			}
			return ast.WalkContinue, nil
		})
		sb.WriteString("\n\n")
	}

	result := "NODE ID: " + block.ID + "\n\n" + strings.TrimSpace(sb.String())

	// Append precision targets as prompt hints when present.
	// Produces: "Specifically regarding: "acute", "rapid onset""
	if len(anchor.Targets) > 0 {
		quoted := make([]string, len(anchor.Targets))
		for i, t := range anchor.Targets {
			quoted[i] = `"` + t + `"`
		}
		result += "\n\nSpecifically regarding: " + strings.Join(quoted, ", ")
	}
	return result
}
