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
// id=="doc" AI ask, block-anchor context). Mode-aware, stores nothing: in
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
