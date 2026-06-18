package sieve

import (
	"strings"

	"sieve/sieve/fencedblock"

	"github.com/yuin/goldmark/text"
)

// DocBlock is a node in the unified, ordered block tree (spec §2). It supersedes
// the flat map[id]*SieveBlock model for serialization. A Sieve Block is a
// kind-homogeneous LEAF — one content kind per block. Which payload field is
// meaningful depends on Kind:
//   - prose kind       → Content holds verbatim markdown; Attrs/Children nil
//   - structured kinds → Attrs holds the fenced YAML payload; Content ""; Children nil
//   - container kinds  → Children holds the subtree; Attrs may hold layout (e.g. widths)
//
// ID is the block's primary handle, minted on Open. A prose block's content is
// arbitrary markdown (multiple paragraphs); whitespace inside it is content, not
// a structural boundary.
type DocBlock struct {
	ID       string
	Kind     string
	Content  string
	Attrs    map[string]interface{}
	Children []DocBlock
	// Aliases are additional handles this block answers to, accumulated when
	// other blocks merge into it (spec §7). ID is the primary handle; a ref
	// resolves against ID or any alias.
	Aliases []string
}

// answersTo returns every handle this block resolves to — its primary ID plus
// any aliases absorbed via merges (spec §7).
func (b DocBlock) answersTo() []string {
	out := make([]string, 0, 1+len(b.Aliases))
	if b.ID != "" {
		out = append(out, b.ID)
	}
	return append(out, b.Aliases...)
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

// SerializeBlockDoc assembles markdown from the block tree WITHOUT handle
// delimiters — a handle-less convenience over the spine (the delimited writer is
// SerializeBlockDocWithHandles). Prose blocks emit their verbatim Content;
// structured blocks emit a fenced YAML block. Blocks are joined by a blank line.
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

// ParseBlockDoc parses markdown into an ordered BlockDoc using the paired-
// delimiter tree rules (handle-less convenience over scanBlocks; the handle-
// aware loader is ParseBlockDocWithHandles). Top-level structured fences become
// structured blocks; paired `<!--s:ID-->` regions and undelimited runs become
// prose blocks. Blank lines never split.
func ParseBlockDoc(markdown string) (BlockDoc, error) {
	return BlockDoc{Blocks: scanBlocks(markdown)}, nil
}

// scanBlocks is the D.4 spine scanner. Structure derives ONLY from delimiters:
//   - a top-level structured fence (registered block-mode kind + id) is an
//     atomic, opaque structured block — goldmark already isolates it, so a
//     literal marker inside it is fence content, never a prose boundary (leaf
//     opacity);
//   - the byte gaps between fences are prose regions, scanned for paired
//     `<!--s:ID-->` / `<!--/s:ID-->` delimiters (scanProseRegion).
//
// Whitespace is never read for structure; blank lines carry no signal.
func scanBlocks(markdown string) []DocBlock {
	source := []byte(markdown)
	root := mdParser().Parser().Parse(text.NewReader(source))

	var out []DocBlock
	cursor := 0
	emitProse := func(end int) {
		if end <= cursor {
			return
		}
		out = append(out, scanProseRegion(string(source[cursor:end]))...)
	}

	for n := root.FirstChild(); n != nil; n = n.NextSibling() {
		sn, ok := n.(*sieveBlockNode)
		if !ok {
			continue // prose/anchor: absorbed into the surrounding prose region
		}
		emitProse(sn.StartByte())
		out = append(out, DocBlock{
			ID:    sn.SieveBlock.ID,
			Kind:  sn.SieveBlock.Kind,
			Attrs: sn.SieveBlock.Attrs,
		})
		cursor = sn.EndByte()
	}
	emitProse(len(source))
	return out
}

// scanProseRegion splits a non-fenced region into prose blocks using paired
// comment-tag delimiters. A matched `<!--s:ID …-->` / `<!--/s:ID-->` pair is one
// prose block whose interior is taken verbatim (opaque — never re-scanned for
// nested markers; nesting is container-only, Stage E). An open with no matching
// close is unbalanced → literal text. Any maximal run of undelimited lines is a
// SINGLE prose block (never blank-line split); whitespace-only runs are dropped.
func scanProseRegion(region string) []DocBlock {
	lines := strings.Split(region, "\n")
	var out []DocBlock
	var pending []string

	flushPending := func() {
		if len(pending) == 0 {
			return
		}
		content := strings.Trim(strings.Join(pending, "\n"), "\n")
		pending = pending[:0]
		if strings.TrimSpace(content) != "" {
			out = append(out, DocBlock{Kind: KindProse, Content: content})
		}
	}

	for i := 0; i < len(lines); {
		if m := markerOpenRe.FindStringSubmatch(lines[i]); m != nil {
			handles := strings.Fields(m[1])
			primary := handles[0]
			if closeIdx := findClose(lines, i+1, primary); closeIdx != -1 {
				flushPending()
				blk := DocBlock{
					ID:      primary,
					Kind:    KindProse,
					Content: strings.Join(lines[i+1:closeIdx], "\n"),
				}
				if len(handles) > 1 {
					blk.Aliases = append([]string(nil), handles[1:]...)
				}
				out = append(out, blk)
				i = closeIdx + 1
				continue
			}
			// unbalanced open → fall through; the marker line is literal content
		}
		pending = append(pending, lines[i])
		i++
	}
	flushPending()
	return out
}

// findClose returns the index of the first close marker at or after start whose
// primary id matches, or -1 if none (the open is then unbalanced → literal text).
func findClose(lines []string, start int, primary string) int {
	for k := start; k < len(lines); k++ {
		if cm := markerCloseRe.FindStringSubmatch(lines[k]); cm != nil && cm[1] == primary {
			return k
		}
	}
	return -1
}

// mintProseIDs assigns a fresh handle to every prose block with an empty ID,
// recursing into container children. Structured blocks already carry their id in
// YAML, and prose blocks that already hold a handle are left untouched — so it is
// idempotent and silent (IDs are invisible plumbing minted automatically on
// Open). Returns the number of handles minted. Mutates blocks in place.
func mintProseIDs(blocks []DocBlock) int {
	minted := 0
	for i := range blocks {
		if blocks[i].Kind == KindProse && blocks[i].ID == "" {
			blocks[i].ID = GenerateBlockID(KindProse)
			minted++
		}
		minted += mintProseIDs(blocks[i].Children)
	}
	return minted
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
