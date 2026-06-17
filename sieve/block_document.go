package sieve

import (
	"strings"

	"sieve/sieve/fencedblock"

	"github.com/yuin/goldmark/text"
)

// DocBlock is a node in the unified, ordered block tree (spec §2). It supersedes
// the flat map[id]*SieveBlock model for serialization. Which payload field is
// meaningful depends on Kind:
//   - prose kinds      → Content holds verbatim markdown; Attrs/Children nil
//   - structured kinds → Attrs holds the fenced YAML payload; Content ""; Children nil
//   - container kinds  → Children holds the subtree; Attrs may hold layout (e.g. widths)
//
// ID is the block's primary handle. In Stage A prose blocks have an empty ID
// (positional); Stage B assigns universal {id=} handles.
type DocBlock struct {
	ID       string
	Kind     string
	Content  string
	Attrs    map[string]interface{}
	Children []DocBlock
}

// BlockDoc is an ordered list of top-level blocks — a tree wherever containers
// nest Children. It is the in-memory form the serialization spine round-trips
// against markdown.
type BlockDoc struct {
	Blocks []DocBlock
}

// Reserved kinds that are not registered BlockProcessors.
const (
	KindProse     = "prose"
	KindColumnRow = "column-row"
	KindColumn    = "column"
)

// SerializeBlockDoc assembles markdown from the block tree — the single
// serialization spine that replaces InjectBlocks (markdown_parser.go:321).
// Prose blocks emit their verbatim Content; structured blocks emit a fenced
// YAML block. Blocks are joined by a blank line (canonical spacing).
func SerializeBlockDoc(doc BlockDoc) (string, error) {
	parts := make([]string, 0, len(doc.Blocks))
	for _, b := range doc.Blocks {
		if b.Kind == KindProse {
			parts = append(parts, b.Content)
			continue
		}
		s, err := serializeFencedBlock(b)
		if err != nil {
			return "", err
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, "\n\n"), nil
}

// ParseBlockDoc parses markdown into an ordered BlockDoc. Only TOP-LEVEL fenced
// Sieve blocks (direct children of the document root) become structured
// DocBlocks; everything between them — prose, headings, lists, and (Stage A)
// legacy block-anchor regions — becomes one verbatim prose DocBlock per run.
// Per-paragraph granularity and {id=} handles arrive in Stage B; container
// child expansion arrives in Stage E.
func ParseBlockDoc(markdown string) (BlockDoc, error) {
	spans, err := segmentBlockDoc(markdown)
	if err != nil {
		return BlockDoc{}, err
	}
	out := BlockDoc{Blocks: make([]DocBlock, len(spans))}
	for i, s := range spans {
		out.Blocks[i] = s.block
	}
	return out, nil
}

// blockSpan is a parsed block plus the byte offset at which its content begins
// in the (clean) source. The offset lets the handle layer (Stage B.2) pair a
// stripped `<!--s:…-->` marker to the block immediately below it.
type blockSpan struct {
	block DocBlock
	start int
}

// segmentBlockDoc is the offset-tracking core shared by ParseBlockDoc and the
// handle-aware loader. Top-level Sieve fences become structured blocks; the
// prose runs between them are split per-paragraph (splitProseRunSpans).
func segmentBlockDoc(markdown string) ([]blockSpan, error) {
	source := []byte(markdown)
	root := mdParser().Parser().Parse(text.NewReader(source))

	var spans []blockSpan
	cursor := 0

	emitProse := func(end int) {
		if end <= cursor {
			return
		}
		base := cursor
		for _, frag := range splitProseRunSpans(string(source[cursor:end])) {
			spans = append(spans, blockSpan{
				block: DocBlock{Kind: KindProse, Content: frag.content},
				start: base + frag.start,
			})
		}
	}

	for n := root.FirstChild(); n != nil; n = n.NextSibling() {
		sn, ok := n.(*sieveBlockNode)
		if !ok {
			continue // prose/anchor: absorbed into the surrounding run
		}
		emitProse(sn.StartByte())
		spans = append(spans, blockSpan{
			block: DocBlock{
				ID:    sn.SieveBlock.ID,
				Kind:  sn.SieveBlock.Kind,
				Attrs: sn.SieveBlock.Attrs,
			},
			start: sn.StartByte(),
		})
		cursor = sn.EndByte()
	}
	emitProse(len(source))
	return spans, nil
}

// splitProseRun divides a verbatim prose run into per-paragraph blocks
// (Stage B.1). It separates on blank lines while treating fenced code regions
// (``` or ~~~) as atomic, so a blank line inside a code block never splits a
// block. Tight lists (no blank lines between items) stay one block; blank-line-
// separated content — including loose lists — becomes separate blocks. This is
// an accepted fidelity cost: every fragment still round-trips verbatim, and the
// spine deliberately avoids fragile goldmark span math (which excludes code
// fences). Empty/whitespace-only paragraphs are dropped.
func splitProseRun(run string) []string {
	frags := splitProseRunSpans(run)
	out := make([]string, len(frags))
	for i, f := range frags {
		out[i] = f.content
	}
	return out
}

// proseFrag is a paragraph plus its byte offset within the run it came from.
type proseFrag struct {
	content string
	start   int
}

// splitProseRunSpans is splitProseRun with byte-offset tracking — see
// splitProseRun for the segmentation contract. start is the offset of the
// fragment's first content character within run.
func splitProseRunSpans(run string) []proseFrag {
	var frags []proseFrag
	var cur []string
	curStart := -1
	inFence := false
	fenceMarker := ""
	pos := 0

	flush := func() {
		if len(cur) > 0 {
			joined := strings.Join(cur, "\n")
			lead := len(joined) - len(strings.TrimLeft(joined, "\n"))
			content := strings.Trim(joined, "\n")
			if strings.TrimSpace(content) != "" {
				frags = append(frags, proseFrag{content: content, start: curStart + lead})
			}
		}
		cur = nil
		curStart = -1
	}

	lines := strings.Split(run, "\n")
	for i, ln := range lines {
		lineStart := pos
		pos += len(ln)
		if i < len(lines)-1 {
			pos++ // the '\n' separator
		}

		trimmed := strings.TrimSpace(ln)
		marker := ""
		switch {
		case strings.HasPrefix(trimmed, "```"):
			marker = "```"
		case strings.HasPrefix(trimmed, "~~~"):
			marker = "~~~"
		}
		if marker != "" {
			if !inFence {
				inFence, fenceMarker = true, marker
			} else if marker == fenceMarker {
				inFence = false
			}
			if curStart == -1 {
				curStart = lineStart
			}
			cur = append(cur, ln)
			continue
		}
		if trimmed == "" && !inFence {
			flush()
			continue
		}
		if curStart == -1 {
			curStart = lineStart
		}
		cur = append(cur, ln)
	}
	flush()
	return frags
}

// serializeFencedBlock renders any block-mode kind as ```kind\n<yaml>\n```
// using the shared literal-style machinery — registry-free, so it serializes
// code, diagram, column-row, etc. uniformly without needing a BlockProcessor.
func serializeFencedBlock(b DocBlock) (string, error) {
	body, err := fencedblock.SerializeYaml(b.Attrs)
	if err != nil {
		return "", err
	}
	return "```" + b.Kind + "\n" + body + "\n```", nil
}
