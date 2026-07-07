package block

import "sieve/logger"

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
	UUID         string
	Mode         string
	mdModeBuffer string
	Blocks       []SieveBlock
	codec        *DocumentCodec
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
	if d.Mode == "markdown" {
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
// markdown. Accept returns true to keep a block. It lives in block/ because the
// filtered derive it drives is a DocView concern; the policy (which kinds to drop)
// belongs to the consumer that implements it (e.g. AIBlockProcessor drops ai-blocks
// so prior answers don't leak into the AI TARGET slot).
type BlockFilter interface {
	Accept(b SieveBlock) bool
}

// deriveMarkdownFiltered is deriveMarkdown with a per-block filter: a block is
// serialized only when f.Accept(b). A nil filter accepts everything, so it is
// byte-identical to deriveMarkdown (existing behaviour unchanged). AI TARGET
// assembly uses this to exclude ai-blocks — otherwise every prior answer's raw
// YAML fence (response: …) lands in the slot the model treats as document truth,
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
	if d.Mode == "markdown" {
		return d.mdModeBuffer
	}
	kept := make([]SieveBlock, 0, len(d.Blocks))
	for _, b := range d.Blocks {
		if f.Accept(b) {
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
