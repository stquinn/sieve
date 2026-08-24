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
// Whether the markdown-mode raw buffer is authoritative (rawAuthoritative)
// controls how Flush and Remux behave — see rawAuthoritative below.
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
	// rawAuthoritative reports whether the mdModeBuffer is the document's truth
	// (the old Mode == "markdown"). It IS the format-blind in-flight signal: set
	// when the user enters markdown mode (EnterMarkdownMode seeds the buffer and
	// raises it), cleared when they commit back to WYSIWYG (EnterWysiwygMode
	// reparses the tree from the buffer, then clears BOTH the flag and the buffer
	// so a stale buffer can never be mistaken for authoritative after a round-trip).
	// Default false = WYSIWYG, the tree is authoritative. Derived, never persisted:
	// Mode as a stored string retired in issue #49 Phase 2.
	rawAuthoritative bool
	// migratedOnLoad records that a DocumentMigrator step rewrote something while
	// parsing this document — an id (#75) or an asset URL (#19) — so the opener
	// knows the tree owes disk a rewrite.
	migratedOnLoad bool
	codec          *DocumentCodec
	debounce       time.Duration
	closed         bool // set by StopDebounce; prevents re-arming after Close
	mu             sync.Mutex
	// flushMu serializes whole-document writes (WithFlushLock). It is SEPARATE from
	// mu so a flush's disk I/O does not block tree mutations (which take mu): the
	// slow part runs under flushMu only, the brief tree snapshot under mu. Scoped to
	// the shadow's lifetime, so per-document serialization needs no external map.
	flushMu sync.Mutex
	timer   *time.Timer
	onFlush func()
}

func NewShadow(uuid, body string, codec *DocumentCodec, debounce time.Duration, onFlush func()) *ShadowDocument {
	// codec.Deserialize constructs every block via NewSieveBlock, which mints
	// an id for any id-less (marker-less) prose at construction — so the shadow's
	// tree is disciplined the moment it exists, with no separate mint sweep.
	blocks, err := codec.Deserialize(body)
	if err != nil {
		logger.Warn("editor: parse block doc failed", "uuid", uuid, "err", err)
	}
	// Lazy load-time migration (#75 ids, #19 asset routes): a legacy short
	// handle becomes a UUID and in-document refs follow it; a legacy /sieve/…
	// asset URL is rewritten to the current route. This is the load path — the
	// one place minting/rewriting can be followed by a save — which is why
	// DocumentMigrator is not run inside Deserialize.
	blocks, migrated := DocumentMigrator{}.Migrate(blocks)
	s := &ShadowDocument{
		UUID:     uuid,
		Blocks:   blocks,
		codec:    codec,
		debounce: debounce,
		onFlush:  onFlush,
	}
	if migrated {
		// The upgrade MUST reach disk, or a legacy document would mint different
		// ids on every open (or keep serving a dead asset route) and any address
		// taken from it would die — including a block id captured by a dispatched
		// job, whose result would then be applied to a block that no longer
		// exists. EditorService.open flushes synchronously on MigratedOnLoad;
		// arming the debounce here is the fallback for callers that construct a
		// shadow directly. Safe unlocked: nothing else holds s yet.
		logger.Info("migrate: document upgraded on load", "uuid", uuid, "blocks", len(blocks))
		s.migratedOnLoad = true
		s.resetDebounce()
	}
	return s
}

// MigratedOnLoad reports that a load-time migration changed this document —
// upgraded a block id, repaired a duplicate, or rewrote a legacy asset URL. The
// opener uses it to force the rewrite to disk immediately, so ids and asset
// routes are correct from the first open rather than from whenever the autosave
// next fires.
func (s *ShadowDocument) MigratedOnLoad() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.migratedOnLoad
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
	return DocView{UUID: s.UUID, rawAuthoritative: s.rawAuthoritative, mdModeBuffer: s.mdModeBuffer, Blocks: s.Blocks, codec: s.codec}.deriveMarkdown()
}

// ExportMarkdown derives CLEAN whole-doc markdown for "Copy as Markdown" from the
// LIVE document: each block surviving the CALLER's filter rendered via its
// MarkdownRepresentation, NOT the on-disk Serialize (see deriveExportMarkdown).
// Takes s.mu like deriveMarkdown; the transient DocView shares the slice read-only
// under the lock. Nil filter exports everything.
func (s *ShadowDocument) ExportMarkdown(filter BlockFilter) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return DocView{UUID: s.UUID, rawAuthoritative: s.rawAuthoritative, mdModeBuffer: s.mdModeBuffer, Blocks: s.Blocks, codec: s.codec}.deriveExportMarkdown(filter)
}

func (s *ShadowDocument) SetMarkdown(md string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rawAuthoritative {
		s.mdModeBuffer = md
	} else {
		s.reparseDoc(md)
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

// BlockIDs returns the top-level child ids in document order — the container's
// order as a value, without the blocks hanging off it.
func (s *ShadowDocument) BlockIDs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids := make([]string, len(s.Blocks))
	for i, b := range s.Blocks {
		ids[i] = b.ID
	}
	return ids
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
	Type    string `json:"type"` // "create-block","update-block","delete-block","move","set-order"
	BlockID string `json:"blockId"`
	Kind    string `json:"kind,omitempty"`
	// Attrs is the block's payload bag — uniform across kinds. Every kind's body
	// rides here (prose's at Attrs["content"], code's at Attrs["source"]); there is
	// no kind-special-cased Content field. update merges it, create constructs from it.
	Attrs    map[string]interface{} `json:"attrs,omitempty"`
	Aliases  []string               `json:"aliases,omitempty"`
	Index    int                    `json:"index"`
	ParentID string                 `json:"parentId,omitempty"`
	// Order is the COMPLETE top-level block order a set-order op installs, newest
	// first position to last. It is the whole order rather than a delta because
	// applying it is idempotent: a duplicate or out-of-sequence frame lands the
	// document in the same place, so the op is safe to send last in a batch that
	// also created or deleted blocks.
	Order []string `json:"order,omitempty" doc:"set-order only: the complete top-level block id order to install"`
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

	case "set-order":
		return s.setOrder(op.Order)

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

// setOrder rearranges the top-level blocks into exactly the given id order. It is
// a PERMUTATION and refuses anything else: the op replaces the whole order, so a
// list that omits a block, names an unknown one, or repeats one would silently
// drop content — the difference between a reorder and a mass delete. Nothing is
// mutated unless the whole order validates. ASSUMES s.mu is held by the caller.
func (s *ShadowDocument) setOrder(order []string) error {
	if len(order) != len(s.Blocks) {
		return fmt.Errorf("set-order: names %d blocks, document has %d", len(order), len(s.Blocks))
	}
	byID := make(map[string]SieveBlock, len(s.Blocks))
	for _, b := range s.Blocks {
		byID[b.ID] = b
	}
	reordered := make([]SieveBlock, 0, len(order))
	seen := make(map[string]bool, len(order))
	for _, id := range order {
		b, ok := byID[id]
		if !ok {
			return fmt.Errorf("set-order: block %q not found", id)
		}
		if seen[id] {
			return fmt.Errorf("set-order: block %q named twice", id)
		}
		seen[id] = true
		reordered = append(reordered, b)
	}
	s.Blocks = reordered
	return nil
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
