package block

import (
	"fmt"
	"sync"
	"time"

	"sieve/logger"
)

// DefaultAutosaveDebounce is the fallback autosave delay when none is configured.
const DefaultAutosaveDebounce = 30 * time.Second

// ShadowDocument holds the in-memory editor state for one open document.
// Mode controls how Flush and Remux behave ("wysiwyg" or "markdown").
type ShadowDocument struct {
	UUID string
	// Blocks is the authoritative ordered block tree (spec §2), held DIRECTLY —
	// no BlockDoc wrapper, no nested "document inside a document". In WYSIWYG mode
	// it is the single source of truth for what gets saved (ContentForSave just
	// serializes it); markdown is derived on demand, never stored.
	Blocks []SieveBlock
	// mdModeBuffer holds the raw text the user edits in MARKDOWN MODE ONLY. In
	// WYSIWYG mode the tree (Doc) is authoritative and whole-doc markdown is
	// derived on demand (deriveMarkdown) — there is no stored markdown to drift
	// (the old Markdown field drifted: a prose-only session left it stale).
	mdModeBuffer string
	Mode         string // "wysiwyg" (default) or "markdown"
	codec        *DocumentCodec
	debounce     time.Duration
	closed       bool // set by StopDebounce; prevents re-arming after Close
	mu           sync.Mutex
	// flushMu serializes whole-document writes (WithFlushLock). It is SEPARATE from
	// mu so a flush's disk I/O does not block tree mutations (which take mu): the
	// slow part runs under flushMu only, the brief tree snapshot under mu. Scoped to
	// the shadow's lifetime, so per-document serialization needs no external map.
	flushMu sync.Mutex
	timer   *time.Timer
	onFlush func()
	// notifySaved is invoked after each successful debounce flush (flush-ack to
	// the WS client). It is rewired when an already-open shadow is reused by a
	// later Open (idempotent Open), so the debounce closure reads it live.
	notifySaved func()
}

// SetNotifySaved rewires the post-flush callback (idempotent Open reuse).
func (s *ShadowDocument) SetNotifySaved(fn func()) {
	s.mu.Lock()
	s.notifySaved = fn
	s.mu.Unlock()
}

// GetNotifySaved reads the post-flush callback under lock for the debounce timer.
func (s *ShadowDocument) GetNotifySaved() func() {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.notifySaved
}

func NewShadow(uuid, body string, codec *DocumentCodec, debounce time.Duration, onFlush func()) *ShadowDocument {
	// codec.Deserialize constructs every block via NewSieveBlock, which mints
	// an id for any id-less (marker-less) prose at construction — so the shadow's
	// tree is disciplined the moment it exists, with no separate mint sweep.
	blocks, err := codec.Deserialize(body)
	if err != nil {
		logger.Warn("editor: parse block doc failed", "uuid", uuid, "err", err)
	}
	s := &ShadowDocument{
		UUID:     uuid,
		Blocks:   blocks,
		Mode:     "wysiwyg",
		codec:    codec,
		debounce: debounce,
		onFlush:  onFlush,
	}
	return s
}

// reparseDoc replaces the block tree from the given markdown (WYSIWYG only).
// Caller holds s.mu. The parser constructs every block via NewSieveBlock, so
// id-less prose arriving on the doc-update fallback is minted at construction —
// it can never reach ContentForSave id-less.
func (s *ShadowDocument) reparseDoc(md string) {
	if blocks, err := s.codec.Deserialize(md); err == nil {
		s.Blocks = blocks
	} else {
		logger.Warn("editor: reparse block doc failed", "uuid", s.UUID, "err", err)
	}
}

// deriveMarkdown derives the whole-doc markdown from the LIVE document. Caller
// holds s.mu; the transient DocView shares the slice read-only under that lock,
// so the single derivation logic lives on DocView.
func (s *ShadowDocument) deriveMarkdown() string {
	return DocView{UUID: s.UUID, Mode: s.Mode, mdModeBuffer: s.mdModeBuffer, Blocks: s.Blocks, codec: s.codec}.deriveMarkdown()
}

// ExportMarkdown derives CLEAN whole-doc markdown for "Copy as Markdown" from the
// LIVE document: each block surviving the CALLER's filter rendered via its
// MarkdownRepresentation, NOT the on-disk Serialize (see deriveExportMarkdown).
// Takes s.mu like deriveMarkdown; the transient DocView shares the slice read-only
// under the lock. Nil filter exports everything.
func (s *ShadowDocument) ExportMarkdown(filter BlockFilter) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return DocView{UUID: s.UUID, Mode: s.Mode, mdModeBuffer: s.mdModeBuffer, Blocks: s.Blocks, codec: s.codec}.deriveExportMarkdown(filter)
}

func (s *ShadowDocument) SetMarkdown(md string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Mode == "wysiwyg" {
		s.reparseDoc(md)
	} else {
		s.mdModeBuffer = md
	}
	s.resetDebounce()
}

// MergeBlock creates or patches the named block, applying the merge semantic
// (SieveBlock.Merge: attrs additive, aliases replaced when present). For a new id
// it appends a fresh block. kind is only used when creating the entry; subsequent
// merges preserve the existing Kind. The locked entry point for external callers;
// applyOpTo's update-block calls SieveBlock.Merge directly under its own lock.
func (s *ShadowDocument) MergeBlock(patch SieveBlock) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if b := s.findBlock(patch.ID); b != nil {
		b.Merge(patch)
	} else {
		nb := SieveBlock{ID: patch.ID, Kind: patch.Kind}
		nb.Merge(patch)
		s.Blocks = append(s.Blocks, nb)
	}
	s.resetDebounce()
}

// ReplaceBlock swaps the block with id for newBlock AT THE SAME INDEX, preserving
// its document position. It is the primitive promote-to-prose needs: update-block
// cannot change a block's Kind, and delete+insert would lose position. Returns
// false if no block with id exists. Caller must NOT hold s.mu.
func (s *ShadowDocument) ReplaceBlock(id string, newBlock SieveBlock) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.Blocks {
		if s.Blocks[i].ID == id {
			s.Blocks[i] = newBlock
			s.resetDebounce()
			return true
		}
	}
	return false
}

// DeleteBlockAttr removes a single key from an existing block's attrs.
// Used to expunge transient fields (e.g. hint) that a job has consumed.
func (s *ShadowDocument) DeleteBlockAttr(blockID, key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if b := s.findBlock(blockID); b != nil {
		delete(b.Attrs, key)
	}
}

func (s *ShadowDocument) resetDebounce() {
	if s.onFlush == nil || s.closed {
		return
	}
	if s.timer != nil {
		s.timer.Stop()
	}
	d := s.debounce
	if d <= 0 {
		d = DefaultAutosaveDebounce
	}
	s.timer = time.AfterFunc(d, s.onFlush)
}

func (s *ShadowDocument) StopDebounce() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
}

// ContentForSave returns the content that should be written to disk: in markdown
// mode the raw buffer verbatim, in WYSIWYG the tree serialized fresh. Both come
// from deriveMarkdown — the single whole-doc markdown source.
func (s *ShadowDocument) ContentForSave() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.deriveMarkdown()
}

// WithFlushLock runs fn holding the document's flush lock, serializing whole-document
// writes for this shadow against each other (the debounce, an explicit Flush, Close,
// and a background job's flush all funnel through here). The shadow owns *serializing*
// a flush — like it owns mu for tree ops — while the caller supplies *what* the flush
// does (the store I/O lives in EditorService; block must not depend on the store). fn
// may take mu itself (e.g. ContentForSave): flushMu is a distinct lock, so no
// reentrancy, and the slow I/O never blocks tree mutations.
func (s *ShadowDocument) WithFlushLock(fn func() error) error {
	s.flushMu.Lock()
	defer s.flushMu.Unlock()
	return fn()
}

// ApplyOp applies a granular block mutation to the live tree, taking s.mu and
// arming the debounce. The wire layer's single entry point for block ops.
func (s *ShadowDocument) ApplyOp(op BlockOp) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.applyOpTo(op); err != nil {
		return err
	}
	s.resetDebounce()
	return nil
}

// findBlock returns a pointer to the block with the given ID within the live
// tree, or nil. ASSUMES s.mu is held by the caller — the returned pointer
// aliases the live slice and the caller must mutate it under that lock.
func (s *ShadowDocument) findBlock(id string) *SieveBlock {
	return s.findBlockIn(id)
}

// BlockOp is a granular mutation of the BlockDoc tree, carried over the wire
// (Stage C, spec §4). One op == one user-visible block change.
type BlockOp struct {
	Type    string `json:"type"` // "create-block","update-block","delete-block","move"
	BlockID string `json:"blockId"`
	Kind    string `json:"kind,omitempty"`
	// Attrs is the block's payload bag — uniform across kinds. Every kind's body
	// rides here (prose's at Attrs["content"], code's at Attrs["source"]); there is
	// no kind-special-cased Content field. update merges it, create constructs from it.
	Attrs    map[string]interface{} `json:"attrs,omitempty"`
	Aliases  []string               `json:"aliases,omitempty"`
	Index    int                    `json:"index"`
	ParentID string                 `json:"parentId,omitempty"`
	// Token is a TRANSIENT frontend correlation handle (tok-…) for a prose create —
	// NOT a durable id. Go mints the durable id (GenerateBlockIDFor) and echoes the
	// token back on insert-block so the client can swap its pending node's token for
	// the authoritative id. Never persisted.
	Token string `json:"token,omitempty"`
}

// applyOpTo mutates the ordered block slice in place according to op. It returns
// an error (never silently no-ops) so callers can surface failures. Pure slice
// logic — no locks, no debounce. Use ShadowDocument.ApplyOp for the live tree.
func (s *ShadowDocument) applyOpTo(op BlockOp) error {
	switch op.Type {
	case "update-block":
		b := s.findBlockIn(op.BlockID)
		if b == nil {
			return fmt.Errorf("update-block: block %q not found", op.BlockID)
		}
		// One block-patch semantic for every kind: attrs MERGE (a partial patch keeps
		// existing keys), aliases REPLACE when present. Prose's body is just
		// Attrs["content"], carried in the merge like any other key — no kind branch.
		b.Merge(SieveBlock{Attrs: op.Attrs, Aliases: op.Aliases})
		return nil

	case "create-block":
		// create-block is a construction point: route through the factory so an
		// op with no blockId gets one minted (given an id or generate one) rather
		// than admitting an id-less block. The frontend normally supplies the id.
		// The payload (incl. prose's content) rides in op.Attrs.
		if op.ParentID != "" {
			return fmt.Errorf("create-block: nesting into parent %q is Stage E (no Children yet)", op.ParentID)
		}
		nb := NewSieveBlock(op.Kind, op.BlockID, op.Attrs)
		nb.Aliases = op.Aliases
		s.insertBlockAt(op.Index, nb)
		return nil

	case "delete-block":
		if _, ok := s.removeBlock(op.BlockID); !ok {
			return fmt.Errorf("delete-block: block %q not found", op.BlockID)
		}
		return nil

	case "move", "reorder":
		if op.ParentID != "" {
			return fmt.Errorf("move: nesting into parent %q is Stage E (no Children yet)", op.ParentID)
		}
		removed, ok := s.removeBlock(op.BlockID)
		if !ok {
			return fmt.Errorf("move: block %q not found", op.BlockID)
		}
		s.insertBlockAt(op.Index, removed)
		return nil

	default:
		return fmt.Errorf("unknown block op type %q", op.Type)
	}
}

// removeBlock deletes the block with id from the tree rooted at *blocks,
// returning the removed block and whether it was found.
func (s *ShadowDocument) removeBlock(id string) (SieveBlock, bool) {
	for i := range s.Blocks {
		if (s.Blocks)[i].ID == id {
			removed := (s.Blocks)[i]
			s.Blocks = append((s.Blocks)[:i], (s.Blocks)[i+1:]...)
			return removed, true
		}
	}
	return SieveBlock{}, false
}

// insertBlockAt inserts b at index in *blocks, clamping out-of-range indices to
// the ends (a robustness choice — the wire layer may send a stale index).
func (s *ShadowDocument) insertBlockAt(index int, b SieveBlock) {
	if index < 0 {
		index = 0
	}
	if index > len(s.Blocks) {
		index = len(s.Blocks)
	}
	s.Blocks = append(s.Blocks, SieveBlock{})
	copy(s.Blocks[index+1:], s.Blocks[index:])
	s.Blocks[index] = b
}

// findBlockIn returns a pointer to the block with the given ID, or nil. The
// pointer aliases the live slice so callers can mutate it.
func (s *ShadowDocument) findBlockIn(id string) *SieveBlock {
	for i := range s.Blocks {
		if s.Blocks[i].ID == id {
			return &s.Blocks[i]
		}
	}
	return nil
}
