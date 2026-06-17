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
	source := []byte(markdown)
	root := mdParser().Parser().Parse(text.NewReader(source))

	var out BlockDoc
	cursor := 0

	emitProse := func(end int) {
		if end <= cursor {
			return
		}
		raw := strings.Trim(string(source[cursor:end]), "\n")
		for _, para := range splitProseRun(raw) {
			out.Blocks = append(out.Blocks, DocBlock{Kind: KindProse, Content: para})
		}
	}

	for n := root.FirstChild(); n != nil; n = n.NextSibling() {
		sn, ok := n.(*sieveBlockNode)
		if !ok {
			continue // prose/anchor: absorbed into the surrounding run
		}
		emitProse(sn.StartByte())
		out.Blocks = append(out.Blocks, DocBlock{
			ID:    sn.SieveBlock.ID,
			Kind:  sn.SieveBlock.Kind,
			Attrs: sn.SieveBlock.Attrs,
		})
		cursor = sn.EndByte()
	}
	emitProse(len(source))
	return out, nil
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
	lines := strings.Split(run, "\n")
	var blocks []string
	var cur []string
	inFence := false
	fenceMarker := ""

	flush := func() {
		if len(cur) == 0 {
			return
		}
		para := strings.Trim(strings.Join(cur, "\n"), "\n")
		if strings.TrimSpace(para) != "" {
			blocks = append(blocks, para)
		}
		cur = nil
	}

	for _, ln := range lines {
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
			cur = append(cur, ln)
			continue
		}
		if trimmed == "" && !inFence {
			flush()
			continue
		}
		cur = append(cur, ln)
	}
	flush()
	return blocks
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
