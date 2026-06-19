package sieve

import (
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

// Region is the portable, library-agnostic unit the codec dispatches on — the
// inverse of what a processor's Serialize emits. A fenced region carries its
// info string in Kind and its interior in Body; a text run has empty Kind and
// its content in Body. Raw is the exact source bytes of the region; regions tile
// the source gaplessly, so concatenating every Raw reproduces the input. That is
// what lets prose absorb an unclaimed fence verbatim.
type Region struct {
	Kind string
	Body string
	Raw  string
}

// RegionScanner splits raw markdown into ordered regions. It is KIND-BLIND: it
// knows nothing about which fences are Sieve blocks — it only distinguishes a
// top-level fenced code block (a fence region) from everything else (text). The
// dispatch decides what claims each region. goldmark is an implementation detail
// hidden entirely behind Scan.
type RegionScanner struct{}

func NewRegionScanner() *RegionScanner { return &RegionScanner{} }

// vanilla goldmark — NO sieve extension, so every fence stays a plain
// *ast.FencedCodeBlock (the sieve extension would rewrite some into custom nodes).
var regionMDParser = goldmark.New()

// Scan returns regions covering the entire source with no gaps. Top-level
// fenced code blocks become fence regions; the byte spans between them become
// text regions.
func (s *RegionScanner) Scan(markdown string) []Region {
	source := []byte(markdown)
	root := regionMDParser.Parser().Parse(text.NewReader(source))

	var regions []Region
	cursor := 0
	emitText := func(end int) {
		if end > cursor {
			regions = append(regions, Region{Raw: string(source[cursor:end])})
		}
	}

	for n := root.FirstChild(); n != nil; n = n.NextSibling() {
		cb, ok := n.(*ast.FencedCodeBlock)
		if !ok {
			continue // absorbed into the surrounding text span via byte offsets
		}
		start, end := fenceBounds(cb, source)
		emitText(start)
		regions = append(regions, Region{
			Kind: string(cb.Language(source)),
			Body: fenceBody(cb, source),
			Raw:  string(source[start:end]),
		})
		cursor = end
	}
	emitText(len(source))
	return regions
}

// fenceBody concatenates the interior content lines of a fenced code block.
func fenceBody(cb *ast.FencedCodeBlock, source []byte) string {
	var b []byte
	l := cb.Lines().Len()
	for i := 0; i < l; i++ {
		seg := cb.Lines().At(i)
		b = append(b, seg.Value(source)...)
	}
	return string(b)
}

// fenceBounds returns the [start,end) byte offsets of the WHOLE fenced block
// including its ``` delimiter lines. Mirrors the offset walk in the old
// sieveBlockASTTransformer: from the first content line, walk back over the
// opening fence line; from the last content line, walk forward over the closing
// fence line.
func fenceBounds(cb *ast.FencedCodeBlock, source []byte) (int, int) {
	start := 0
	end := len(source)
	if cb.Lines().Len() > 0 {
		start = cb.Lines().At(0).Start
		if start > 0 && source[start-1] == '\n' {
			start--
		}
		for start > 0 && source[start-1] != '\n' {
			start--
		}
		end = cb.Lines().At(cb.Lines().Len() - 1).Stop
		if end < len(source) && source[end] == '\n' {
			end++
		}
		for end < len(source) && source[end] != '\n' {
			end++
		}
		// consume the newline that terminates the closing fence line
		if end < len(source) && source[end] == '\n' {
			end++
		}
	}
	return start, end
}
