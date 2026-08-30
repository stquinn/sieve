package block

import (
	"strings"

	"sieve/logger"
)

// DocView is an immutable, lock-free SNAPSHOT of a document's data: the block
// tree plus the bits needed to derive markdown. It is what a background job or a
// context provider reasons about — WITHOUT the live editor machinery (mutex,
// timers, debounce). The stateful ShadowDocument builds one at the boundary;
// passing a DocView by value copies no lock (unlike ShadowDocument, whose
// embedded sync.Mutex made every by-value pass a `go vet` copylocks hazard, and
// — worse — passing the live *ShadowDocument would leak the mutable cell into a
// concurrent job; the copy is deliberate isolation).
//
// CONTRACT (load-bearing): a DocView is READ-ONLY, job-creation-time context. A
// background job (any async task — only AI even reads it today) consults it ONLY to
// assemble its prompt/context BEFORE its long operation, and NEVER writes back
// through it. Results flow as a delta that EditorService merges into the LIVE shadow
// (RunJob diffs the job's block copy → applyJobUpdate → SetBlock). So a DocView going
// stale during a minutes-long job is correct by design — nothing past job creation
// reads it, and no live state is mutated through it. Do NOT route writes or
// post-completion decisions through a DocView; if you need live state, look the
// ShadowDocument up again.
type DocView struct {
	UUID string
	// rawAuthoritative mirrors ShadowDocument.rawAuthoritative at snapshot time:
	// true means the mdModeBuffer is the document's truth (the retired Mode ==
	// "markdown"). A DocView is a pure value, so it carries the derived boolean.
	rawAuthoritative bool
	mdModeBuffer     string
	Blocks           []SieveBlock
	codec            *DocumentCodec
}

// GetBlock resolves a block by id from the snapshot tree, regardless of kind. It
// is the SOLE accessor: "everything is a block", so lookup never discriminates on
// kind; only context/serialisation does. Returns the block and true, or nil/false.
func (d DocView) GetBlock(id string) (*SieveBlock, bool) {
	if id == "" {
		return nil, false
	}
	for i := range d.Blocks {
		if d.Blocks[i].ID == id {
			return &d.Blocks[i], true
		}
	}
	return nil, false
}

// deriveMarkdown returns the whole-doc markdown a consumer needs (save, an
// id=="doc" AI ask, block context). Mode-aware, stores nothing: in
// markdown mode the raw buffer IS the document; in WYSIWYG the tree is serialized
// fresh, so it can never drift.
func (d DocView) deriveMarkdown() string {
	if d.rawAuthoritative {
		return d.mdModeBuffer
	}
	md, err := d.codec.Serialize(d.Blocks)
	if err != nil {
		logger.Warn("editor: serialize block doc failed", "uuid", d.UUID, "err", err)
		return ""
	}
	return md
}

// BlockFilter decides which blocks a consumer includes when deriving whole-doc
// markdown; return true to keep a block. It is a func type, not an interface: the
// policy (which kinds to drop) belongs to the CALLER, which passes a closure at the
// call site — TARGET assembly drops ai-blocks so prior answers don't leak into the
// document-truth slot; the export handler drops ai-blocks from "Copy as Markdown".
// Nil accepts everything.
type BlockFilter func(b SieveBlock) bool

// deriveMarkdownFiltered is deriveMarkdown with a per-block filter: a block is
// serialized only when f.Accept(b). A nil filter accepts everything, so it is
// byte-identical to deriveMarkdown (existing behaviour unchanged). AI TARGET
// assembly uses this to exclude ai-blocks — otherwise every prior answer's raw
// YAML fence (answer: …) lands in the slot the model treats as document truth,
// and it fixates on / resurrects stale text.
//
// MARKDOWN-MODE GAP — conscious decision: in breakglass markdown mode there is no
// block tree to filter (the raw buffer IS the document), so the filter cannot be
// applied. We return the raw buffer as-is rather than regex-stripping ai-block
// fences: the 4-space inner-fence protection makes naive fence matching dangerous
// (it tears ai-blocks apart — see the region-scanner tail-column-zero defect), and
// markdown mode is breakglass anyway. The prompt's TARGET/THREAD rules partially
// mitigate the resulting leak.
func (d DocView) deriveMarkdownFiltered(f BlockFilter) string {
	if f == nil {
		return d.deriveMarkdown()
	}
	if d.rawAuthoritative {
		return d.mdModeBuffer
	}
	kept := make([]SieveBlock, 0, len(d.Blocks))
	for _, b := range d.Blocks {
		if f(b) {
			kept = append(kept, b)
		}
	}
	md, err := d.codec.Serialize(kept)
	if err != nil {
		logger.Warn("editor: serialize filtered block doc failed", "uuid", d.UUID, "err", err)
		return ""
	}
	return md
}

// deriveExportMarkdown renders the whole document as CLEAN markdown for "Copy as
// Markdown": apply the caller's filter first, then render each SURVIVING block via
// its MarkdownRepresentation — NOT the on-disk Serialize. A block has ONE markdown
// representation; the only export policy hook is the caller's BlockFilter. Empty
// renders (a pending block, an ai-block with no answer) are skipped; survivors join
// with a blank line. No frontmatter, no prose <!--s:--> sentinels, no fenced YAML —
// that is the Serialize (on-disk) form, which this deliberately avoids.
//
// MARKDOWN-MODE — unlike deriveMarkdownFiltered, this does NOT return the raw buffer
// verbatim (which would leak prose sentinels and cannot honour the filter). It
// re-parses the raw buffer through the codec (mirroring findBlockByID) so the same
// per-block export render and filter apply. On a re-parse error it falls back to the
// raw buffer rather than losing the user's content (breakglass-mode best effort).
func (d DocView) deriveExportMarkdown(f BlockFilter) string {
	blocks := d.Blocks
	if d.rawAuthoritative {
		parsed, err := d.codec.Deserialize(d.mdModeBuffer)
		if err != nil {
			logger.Warn("editor: export re-parse of markdown buffer failed", "uuid", d.UUID, "err", err)
			return d.mdModeBuffer
		}
		blocks = parsed
	}
	parts := make([]string, 0, len(blocks))
	for _, b := range blocks {
		if f != nil && !f(b) {
			continue
		}
		md := d.renderBlockExport(b)
		if strings.TrimSpace(md) == "" {
			continue
		}
		parts = append(parts, md)
	}
	return strings.Join(parts, "\n\n")
}

// renderBlockExport asks a single block's processor for its MarkdownRepresentation.
// A kind with no registered processor contributes nothing (it has no representation).
func (d DocView) renderBlockExport(b SieveBlock) string {
	p := d.codec.registry.Get(b.Kind)
	if p == nil {
		return ""
	}
	return p.MarkdownRepresentation(b, d.UUID)
}
