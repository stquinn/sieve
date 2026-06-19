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
			raw := string(source[cursor:end])
			regions = append(regions, Region{Body: raw, Raw: raw})
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
//
// For an empty-body fence (zero content lines), goldmark provides no line
// segments at all, so we anchor on cb.Info.Segment.Start — the start of the
// info string (e.g. "code" in "```code\n```\n"). Walking back from there to
// the beginning of the line gives us the opening fence. We then scan forward
// to consume the opening fence line and the closing fence line.
func fenceBounds(cb *ast.FencedCodeBlock, source []byte) (int, int) {
	if cb.Lines().Len() > 0 {
		// Normal path: anchor on content lines.
		start := cb.Lines().At(0).Start
		if start > 0 && source[start-1] == '\n' {
			start--
		}
		for start > 0 && source[start-1] != '\n' {
			start--
		}
		end := cb.Lines().At(cb.Lines().Len() - 1).Stop
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
		return start, end
	}

	// Empty-body fence: use the info-string segment to locate the opening fence.
	// cb.Info is non-nil for a named fence (e.g. ```code); for an unnamed empty
	// fence (``` ```), Info may be nil — in that case Start falls back to 0 which
	// is safe because the fence is the first thing in the document.
	infoStart := 0
	if cb.Info != nil {
		infoStart = cb.Info.Segment.Start
	}
	// Walk back to the beginning of the opening fence line (the ``` prefix).
	start := infoStart
	for start > 0 && source[start-1] != '\n' {
		start--
	}
	// Walk forward to consume the opening fence line (past its newline).
	end := infoStart
	for end < len(source) && source[end] != '\n' {
		end++
	}
	if end < len(source) { // consume the '\n' at end of opening fence
		end++
	}
	// Now consume the closing fence line (e.g. "```\n").
	for end < len(source) && source[end] != '\n' {
		end++
	}
	if end < len(source) { // consume the '\n' at end of closing fence
		end++
	}
	return start, end
}
