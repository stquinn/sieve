package sieve

import (
	"strings"

	"sieve/sieve/fencedblock"

	"github.com/yuin/goldmark/text"
)

// SieveBlock is a node in the unified, ordered block tree (spec §2). EVERY kind —
// prose included — carries its payload in the single Attrs bag, addressed by id;
// kind is consulted only at render/serialise time. There is no per-kind payload
// field: prose's body is Attrs["content"] (read via Content()), exactly as code
// is Attrs["source"], web-clip Attrs["content"], ai Attrs["response"].
//
// There is no Children field: a block is a LEAF. Containers (columns) are a
// distinct structural type — they HOLD blocks but are not blocks (no payload, no
// content) — and arrive in Stage E behind a small Node interface (ID()/Kind())
// both implement. Until then nothing nests at runtime.
type SieveBlock struct {
	ID    string
	Kind  string
	Attrs map[string]interface{}
	// Aliases are additional handles this block answers to, accumulated when
	// other blocks merge into it (spec §7). ID is the primary handle; a ref
	// resolves against ID or any alias.
	Aliases []string
}

// newSieveBlock is the sole sanctioned way to construct a block, and it enforces
// the invariant the type cannot enforce on its own (Go has no constructors): a
// block is GIVEN an id or it GENERATES one — it never exists id-less. Every
// construction site (the parser, ApplyOp create, split) routes through here, so
// the rule lives in ONE place instead of being swept after the fact. Pass id=""
// to mint (GenerateBlockIDFor honors a registered processor's prefix); pass a
// known id (a marker's handle, a frontend-minted blockId) to keep it. The
// serialize-time guard in SerializeBlockDocWithHandles is the runtime backstop
// for any future code path that bypasses this factory with a raw literal.
func newSieveBlock(kind, id, content string, attrs map[string]interface{}) SieveBlock {
	if id == "" {
		id = GenerateBlockIDFor(kind)
	}
	b := SieveBlock{ID: id, Kind: kind, Attrs: attrs}
	if content != "" {
		b.setContent(content)
	}
	return b
}

// Content is the block's authored text payload (Attrs["content"]) — a prose
// block's verbatim markdown, a web-clip's clipped text. "" for kinds that carry
// no content attr. The typed read that replaces the old SieveBlock.Content field.
func (b SieveBlock) Content() string { return b.StringAttr("content") }

// setContent writes the authored text payload into the Attrs bag, lazily
// allocating it. The single write-side counterpart to Content().
func (b *SieveBlock) setContent(content string) {
	if b.Attrs == nil {
		b.Attrs = map[string]interface{}{}
	}
	b.Attrs["content"] = content
}

// StringAttr reads a string-valued attr, returning "" when the key is absent,
// nil, or not a string. It is the single safe primitive the named accessors
// below are built on — replacing brittle b.Attrs["x"].(string) casts (spec #5)
// that panic or silently mis-type. Storage stays kind-agnostic (one Attrs bag);
// only the read is typed.
func (b SieveBlock) StringAttr(key string) string {
	s, _ := b.Attrs[key].(string)
	return s
}

// Source is the code/log/diagram authored payload (Attrs["source"]).
func (b SieveBlock) Source() string { return b.StringAttr("source") }

// Ref is the AI-chain reference list (Attrs["ref"]), comma-separated block ids.
func (b SieveBlock) Ref() string { return b.StringAttr("ref") }

// Status is the job lifecycle state (Attrs["status"]): PENDING/DISPATCHED/…
func (b SieveBlock) Status() string { return b.StringAttr("status") }

// answersTo returns every handle this block resolves to — its primary ID plus
// any aliases absorbed via merges (spec §7).
func (b SieveBlock) answersTo() []string {
	out := make([]string, 0, 1+len(b.Aliases))
	if b.ID != "" {
		out = append(out, b.ID)
	}
	return append(out, b.Aliases...)
}

// The document is an ordered []SieveBlock — the in-memory form the serialization
// spine round-trips against markdown. There is no wrapper type: ShadowDocument
// holds the slice directly (no nested "document inside a document").

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
func SerializeBlockDoc(blocks []SieveBlock) (string, error) {
	parts := make([]string, 0, len(blocks))
	for _, b := range blocks {
		if b.Kind == KindProse {
			parts = append(parts, b.Content())
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
func ParseBlockDoc(markdown string) ([]SieveBlock, error) {
	return scanBlocks(markdown), nil
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
func scanBlocks(markdown string) []SieveBlock {
	source := []byte(markdown)
	root := mdParser().Parser().Parse(text.NewReader(source))

	var out []SieveBlock
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
		b := newSieveBlock(sn.SieveBlock.Kind, sn.SieveBlock.ID, "", sn.SieveBlock.Attrs)
		out = append(out, b)
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
func scanProseRegion(region string) []SieveBlock {
	lines := strings.Split(region, "\n")
	var out []SieveBlock
	var pending []string

	flushPending := func() {
		if len(pending) == 0 {
			return
		}
		content := strings.Trim(strings.Join(pending, "\n"), "\n")
		pending = pending[:0]
		if strings.TrimSpace(content) != "" {
			// Undelimited (marker-less) prose: no id on disk → the factory mints
			// one now (hydration on parse), so the block exists with an id from
			// the moment it is constructed — never swept in afterward.
			out = append(out, newSieveBlock(KindProse, "", content, nil))
		}
	}

	for i := 0; i < len(lines); {
		if m := markerOpenRe.FindStringSubmatch(lines[i]); m != nil {
			handles := strings.Fields(m[1])
			primary := handles[0]
			if closeIdx := findClose(lines, i+1, primary); closeIdx != -1 {
				flushPending()
				// Delimited prose: the marker carries the primary handle, so the
				// factory keeps it (no mint).
				blk := newSieveBlock(KindProse, primary, strings.Join(lines[i+1:closeIdx], "\n"), nil)
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

// mintProseIDs assigns a fresh handle to every prose block with an empty ID.
// Structured blocks already carry their id in YAML, and prose blocks that already
// hold a handle are left untouched — so it is idempotent and silent (IDs are
// invisible plumbing minted automatically on Open). Returns the number of handles
// minted. Mutates blocks in place.
func mintProseIDs(blocks []SieveBlock) int {
	minted := 0
	for i := range blocks {
		if blocks[i].Kind == KindProse && blocks[i].ID == "" {
			blocks[i].ID = GenerateBlockID(KindProse)
			minted++
		}
	}
	return minted
}

// serializeFencedBlock renders any block-mode kind as ```kind\n<yaml>\n```
// using the shared literal-style machinery — registry-free, so it serializes
// code, diagram, column-row, etc. uniformly without needing a BlockProcessor.
func serializeFencedBlock(b SieveBlock) (string, error) {
	body, err := fencedblock.SerializeYaml(b.Attrs)
	if err != nil {
		return "", err
	}
	return "```" + b.Kind + "\n" + body + "\n```", nil
}
