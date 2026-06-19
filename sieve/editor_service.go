package sieve

import (
	"context"
	"fmt"
	"reflect"
	"sync"
	"time"

	"sieve/logger"
	"sieve/sieve/fencedblock"
)

const defaultAutosaveDebounce = 30 * time.Second

// ShadowDocument holds the in-memory editor state for one open document.
// Mode controls how Flush and Remux behave ("wysiwyg" or "markdown").
type ShadowDocument struct {
	UUID string
	// Blocks is the authoritative ordered block tree (spec §2), held DIRECTLY —
	// no BlockDoc wrapper, no nested "document inside a document". In WYSIWYG mode
	// it is the single source of truth for what gets saved (contentForSave just
	// serializes it); markdown is derived on demand, never stored.
	Blocks []SieveBlock
	// mdModeBuffer holds the raw text the user edits in MARKDOWN MODE ONLY. In
	// WYSIWYG mode the tree (Doc) is authoritative and whole-doc markdown is
	// derived on demand (deriveMarkdown) — there is no stored markdown to drift
	// (the old Markdown field drifted: a prose-only session left it stale).
	mdModeBuffer string
	Mode         string // "wysiwyg" (default) or "markdown"
	debounce     time.Duration
	closed       bool // set by stopDebounce; prevents re-arming after Close
	mu           sync.Mutex
	timer        *time.Timer
	onFlush      func()
	// notifySaved is invoked after each successful debounce flush (flush-ack to
	// the WS client). It is rewired when an already-open shadow is reused by a
	// later Open (idempotent Open), so the debounce closure reads it live.
	notifySaved func()
}

// setNotifySaved rewires the post-flush callback (idempotent Open reuse).
func (s *ShadowDocument) setNotifySaved(fn func()) {
	s.mu.Lock()
	s.notifySaved = fn
	s.mu.Unlock()
}

// getNotifySaved reads the post-flush callback under lock for the debounce timer.
func (s *ShadowDocument) getNotifySaved() func() {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.notifySaved
}

func newShadow(uuid, body string, debounce time.Duration, onFlush func()) *ShadowDocument {
	// ParseBlockDocWithHandles constructs every block via newSieveBlock, which mints
	// an id for any id-less (marker-less) prose at construction — so the shadow's
	// tree is disciplined the moment it exists, with no separate mint sweep.
	blocks, err := ParseBlockDocWithHandles(body)
	if err != nil {
		logger.Warn("editor: parse block doc failed", "uuid", uuid, "err", err)
	}
	s := &ShadowDocument{
		UUID:     uuid,
		Blocks:   blocks,
		Mode:     "wysiwyg",
		debounce: debounce,
		onFlush:  onFlush,
	}
	return s
}

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
}

// getBlock resolves a block by id from the snapshot tree, regardless of kind. It
// is the SOLE accessor: "everything is a block", so lookup never discriminates on
// kind; only context/serialisation does. Returns the block and true, or nil/false.
func (d DocView) getBlock(id string) (*SieveBlock, bool) {
	if id == "" {
		return nil, false
	}
	if b := findBlockIn(d.Blocks, id); b != nil {
		return b, true
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
	md, err := SerializeBlockDocWithHandles(d.Blocks)
	if err != nil {
		logger.Warn("editor: serialize block doc failed", "uuid", d.UUID, "err", err)
		return ""
	}
	return md
}

// reparseDoc replaces the block tree from the given markdown (WYSIWYG only).
// Caller holds s.mu. The parser constructs every block via newSieveBlock, so
// id-less prose arriving on the doc-update fallback is minted at construction —
// it can never reach contentForSave id-less.
func (s *ShadowDocument) reparseDoc(md string) {
	if blocks, err := ParseBlockDocWithHandles(md); err == nil {
		s.Blocks = blocks
	} else {
		logger.Warn("editor: reparse block doc failed", "uuid", s.UUID, "err", err)
	}
}

// deriveMarkdown derives the whole-doc markdown from the LIVE document. Caller
// holds s.mu; the transient DocView shares the slice read-only under that lock,
// so the single derivation logic lives on DocView.
func (s *ShadowDocument) deriveMarkdown() string {
	return DocView{UUID: s.UUID, Mode: s.Mode, mdModeBuffer: s.mdModeBuffer, Blocks: s.Blocks}.deriveMarkdown()
}

func (s *ShadowDocument) setMarkdown(md string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Mode == "wysiwyg" {
		s.reparseDoc(md)
	} else {
		s.mdModeBuffer = md
	}
	s.resetDebounce()
}

// setBlock creates or merges attrs into the named block in Doc. kind is only
// used when creating a new entry; subsequent calls preserve the existing Kind.
func (s *ShadowDocument) setBlock(block SieveBlock) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if b := findBlockIn(s.Blocks, block.ID); b != nil {
		if b.Attrs == nil {
			b.Attrs = make(map[string]interface{}, len(block.Attrs))
		}
		for k, v := range block.Attrs {
			b.Attrs[k] = v
		}
	} else {
		merged := make(map[string]interface{}, len(block.Attrs))
		for k, v := range block.Attrs {
			merged[k] = v
		}
		s.Blocks = append(s.Blocks, SieveBlock{ID: block.ID, Kind: block.Kind, Attrs: merged})
	}
	s.resetDebounce()
}

// replaceBlock atomically replaces the attrs map for an existing block.
// Unlike setBlock (additive merge), deleted keys in attrs are propagated —
// the old map is discarded entirely. No-op if the block does not exist.
func (s *ShadowDocument) replaceBlock(blockID string, block SieveBlock) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b := findBlockIn(s.Blocks, blockID)
	if b == nil {
		return
	}
	b.Attrs = block.Attrs
	s.resetDebounce()
}

// deleteBlockAttr removes a single key from an existing block's attrs.
// Used to expunge transient fields (e.g. hint) that a job has consumed.
func (s *ShadowDocument) deleteBlockAttr(blockID, key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if b := findBlockIn(s.Blocks, blockID); b != nil {
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
		d = defaultAutosaveDebounce
	}
	s.timer = time.AfterFunc(d, s.onFlush)
}

func (s *ShadowDocument) stopDebounce() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
}

// contentForSave returns the content that should be written to disk: in markdown
// mode the raw buffer verbatim, in WYSIWYG the tree serialized fresh. Both come
// from deriveMarkdown — the single whole-doc markdown source.
func (s *ShadowDocument) contentForSave() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.deriveMarkdown()
}

// Markdown parsing is now handled by markdown_parser.go

// EditorService is the Go-side editor model. It holds one ShadowDocument per
// open document and coordinates all save operations. DocumentService owns disk.
type EditorService struct {
	documents *DocumentService
	services  BlockServices
	debounce  time.Duration
	mu        sync.RWMutex
	shadows   map[string]*ShadowDocument
	listener  BlockLifecycleListener
}

// NewEditorService creates an EditorService backed by the given DocumentService.
// debounce controls the autosave delay; pass 0 to use the default (30s).
func NewEditorService(documents *DocumentService, debounce time.Duration) *EditorService {
	d := debounce
	if d <= 0 {
		d = defaultAutosaveDebounce
	}
	logger.Info("editor: initialized", "autosave_debounce", d)
	return &EditorService{
		documents: documents,
		debounce:  d,
		shadows:   make(map[string]*ShadowDocument),
	}
}

// SetLifecycleListener registers the block lifecycle event listener.
func (es *EditorService) SetLifecycleListener(l BlockLifecycleListener) {
	es.mu.Lock()
	defer es.mu.Unlock()
	es.listener = l
}

func (es *EditorService) notifyBlockCreated(uuid string, block SieveBlock) {
	es.mu.RLock()
	l := es.listener
	es.mu.RUnlock()
	if l != nil {
		serialisedForm := ""
		if processor := GetProcessor(block.Kind); processor != nil {
			serialisedForm, _ = SerializeBlock(processor, &block)
		}
		l.OnBlockCreated(uuid, block.Kind, block.ID, block.Attrs, serialisedForm)
	}
}

func (es *EditorService) notifyBlockUpdated(uuid string, block SieveBlock) {
	es.mu.RLock()
	l := es.listener
	es.mu.RUnlock()
	if l != nil {
		serialisedForm := ""
		if processor := GetProcessor(block.Kind); processor != nil {
			serialisedForm, _ = SerializeBlock(processor, &block)
		}
		l.OnBlockUpdated(uuid, block.ID, block.Attrs, serialisedForm)
	}
}

func (es *EditorService) notifyBlockPromoted(uuid, blockID, replacement string) {
	es.mu.RLock()
	l := es.listener
	es.mu.RUnlock()
	if l != nil {
		l.OnBlockPromoted(uuid, blockID, replacement)
	}
}

// dispatchedStuckThreshold is how old a DISPATCHED block must be before it is
// assumed stuck (server crash, OOM) and reset to PENDING on reconnect.
const dispatchedStuckThreshold = 10 * time.Minute

// Open loads a document from disk and creates an in-memory ShadowDocument.
// notifySaved is called (if non-nil) after each successful debounce flush so the
// WebSocket connection can send a flush-ack to the client.
func (es *EditorService) Open(uuid string, notifySaved func()) error {
	// Idempotent: reuse an already-open shadow (the HTTP load ensures-open before
	// the WS connection does, so both share ONE identity — minted ids stay
	// stable). Just rewire the post-flush callback for this caller.
	es.mu.Lock()
	if existing, ok := es.shadows[uuid]; ok {
		es.mu.Unlock()
		existing.setNotifySaved(notifySaved)
		return nil
	}
	es.mu.Unlock()

	doc, err := es.documents.LoadByUUID(uuid)
	if err != nil {
		return err
	}
	// Declare shadow before the closure so the closure can capture the variable.
	var shadow *ShadowDocument
	shadow = newShadow(uuid, string(doc.Body()), es.debounce, func() {
		if err := es.flushShadow(shadow, "debounce"); err == nil {
			if ns := shadow.getNotifySaved(); ns != nil {
				ns()
			}
		}
	})
	shadow.notifySaved = notifySaved
	// Handle minting now happens in newShadow (the constructor invariant: no block
	// without an id) and on every reparse — no separate mint pass needed here.

	es.mu.Lock()
	// Another goroutine may have opened the same uuid between the check above and
	// here; if so, discard ours and reuse theirs (rewiring the callback).
	if existing, ok := es.shadows[uuid]; ok {
		es.mu.Unlock()
		shadow.stopDebounce()
		existing.setNotifySaved(notifySaved)
		return nil
	}
	es.shadows[uuid] = shadow
	es.mu.Unlock()

	// Reset any DISPATCHED blocks that pre-date this session — they are stuck
	// (server crash or restart). Re-queue them so they run again on reconnect.
	es.resetStuckDispatched(uuid, shadow)

	logger.Info("editor: open", "uuid", uuid, "body_bytes", len(doc.Body()))
	return nil
}

// FrontendBlocks projects the OPEN shadow's authoritative Doc into the wire
// shape the WYSIWYG load renders from — the load-through-shadow path, so the
// client sees the shadow's minted handles (real data-id) and identity is shared.
// Returns false when the uuid has no open shadow.
func (es *EditorService) FrontendBlocks(uuid string) ([]FrontendBlock, bool) {
	es.mu.Lock()
	shadow := es.shadows[uuid]
	es.mu.Unlock()
	if shadow == nil {
		return nil, false
	}
	shadow.mu.Lock()
	tree := append([]SieveBlock(nil), shadow.Blocks...)
	shadow.mu.Unlock()
	blocks, err := BlockDocToFrontendBlocks(tree)
	if err != nil {
		return nil, false
	}
	return blocks, true
}

// resetStuckDispatched finds DISPATCHED blocks older than dispatchedStuckThreshold
// and resets them to PENDING so DispatchJobIfNeeded will re-run their jobs.
func (es *EditorService) resetStuckDispatched(uuid string, shadow *ShadowDocument) {
	shadow.mu.Lock()
	var stuck []string
	for i := range shadow.Blocks {
		blk := &shadow.Blocks[i]
		if blk.Status() != BlockStatusDispatched {
			continue
		}
		createdAt := blk.StringAttr("createdAt")
		stale := createdAt == ""
		if !stale {
			if t, err := time.Parse(time.RFC3339, createdAt); err == nil && time.Since(t) > dispatchedStuckThreshold {
				stale = true
			}
		}
		if stale {
			blk.Attrs["status"] = BlockStatusPending
			stuck = append(stuck, blk.ID)
		}
	}
	shadow.mu.Unlock()

	for _, id := range stuck {
		logger.Info("editor: resetting stuck DISPATCHED block", "uuid", uuid, "block", id)
		es.DispatchJobIfNeeded(uuid, id)
	}
}

// Close atomically removes the shadow and flushes it. Capturing the pointer
// before deleting prevents a concurrent Open() from being deleted by mistake.
func (es *EditorService) Close(uuid string) {
	es.mu.Lock()
	shadow, ok := es.shadows[uuid]
	delete(es.shadows, uuid)
	es.mu.Unlock()

	if !ok {
		return
	}
	logger.Info("editor: close", "uuid", uuid)
	shadow.stopDebounce()
	_ = es.flushShadow(shadow, "close")
}

// UpdateMarkdown stores the latest full markdown from TipTap and resets the debounce.
func (es *EditorService) UpdateMarkdown(uuid, markdown string) {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		logger.Warn("editor: doc-update dropped — no shadow", "uuid", uuid)
		return
	}
	shadow.setMarkdown(markdown)
}

// HandleBlockOp applies a granular wire op (create/update/delete/move) to the
// open document's authoritative block tree and re-arms the autosave debounce.
func (es *EditorService) HandleBlockOp(uuid string, op BlockOp) error {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return fmt.Errorf("block-op: no open document for uuid %q", uuid)
	}

	shadow.mu.Lock()
	defer shadow.mu.Unlock()
	if err := ApplyOp(&shadow.Blocks, op); err != nil {
		return err
	}
	shadow.resetDebounce()
	return nil
}

// UpdateBlock merges attrs into the named block, creating it if needed.
// kind is only used when creating a new block entry.
func (es *EditorService) UpdateBlock(uuid string, block SieveBlock) {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		logger.Warn("editor: block-update dropped — no shadow", "uuid", uuid, "block", block.ID)
		return
	}
	shadow.setBlock(block)
}

// EnterMarkdown switches the shadow to markdown mode. It derives whole-doc
// markdown from the tree, seeds the markdown-mode raw buffer with it, then flips
// mode so subsequent Flush calls save the raw buffer verbatim. Returns the seed.
func (es *EditorService) EnterMarkdown(uuid string) string {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		logger.Warn("editor: enter-markdown — no shadow", "uuid", uuid)
		return ""
	}
	merged := shadow.contentForSave() // derives from the tree before the mode switch
	shadow.mu.Lock()
	shadow.mdModeBuffer = merged
	shadow.Mode = "markdown"
	shadow.mu.Unlock()
	logger.Info("editor: enter-markdown", "uuid", uuid, "bytes", len(merged))
	return merged
}

// EnterWysiwyg switches the shadow back to WYSIWYG mode. It re-parses the
// authoritative Doc from the markdown-mode raw buffer so any block YAML the user
// edited directly in markdown mode is picked up for save.
func (es *EditorService) EnterWysiwyg(uuid string) {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		logger.Warn("editor: enter-wysiwyg — no shadow", "uuid", uuid)
		return
	}
	shadow.mu.Lock()
	shadow.reparseDoc(shadow.mdModeBuffer)
	shadow.Mode = "wysiwyg"
	n := len(shadow.Blocks)
	shadow.mu.Unlock()
	logger.Info("editor: enter-wysiwyg", "uuid", uuid, "blocks_reparsed", n)
}

// Flush writes the shadow's contentForSave to disk via DocumentService.
func (es *EditorService) Flush(uuid string) error {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		logger.Warn("editor: flush called but no shadow", "uuid", uuid)
		return nil
	}
	return es.flushShadow(shadow, "explicit")
}

func (es *EditorService) flushShadow(shadow *ShadowDocument, source string) error {
	merged := shadow.contentForSave()
	doc, err := es.documents.LoadByUUID(shadow.UUID)
	if err != nil {
		logger.Warn("editor: flush load failed", "uuid", shadow.UUID, "source", source, "err", err)
		return err
	}
	doc.SetBody([]byte(merged))
	if _, err = es.documents.Save(doc); err != nil {
		logger.Warn("editor: flush save failed", "uuid", shadow.UUID, "source", source, "err", err)
		return err
	}
	logger.Info("editor: saved", "uuid", shadow.UUID, "source", source, "bytes", len(merged))
	return nil
}

// FlushAll writes all open shadows to disk. Called on application shutdown.
func (es *EditorService) FlushAll() {
	es.mu.RLock()
	uuids := make([]string, 0, len(es.shadows))
	for uuid := range es.shadows {
		uuids = append(uuids, uuid)
	}
	es.mu.RUnlock()
	logger.Info("editor: flush-all", "count", len(uuids))
	for _, uuid := range uuids {
		_ = es.Flush(uuid)
	}
}

// CloseAll stops every shadow's autosave timer, flushes it to disk, and drops
// all shadows. Use this (not FlushAll) when the EditorService itself is being
// retired — e.g. a library switch replaces it via ServiceProvider.Init. FlushAll
// leaves the armed time.AfterFunc timers running; they capture the old
// DocumentService/FileStore and would fire a delayed write against the previous
// library after the switch, leaking the old store handle until they do.
func (es *EditorService) CloseAll() {
	es.mu.Lock()
	shadows := make([]*ShadowDocument, 0, len(es.shadows))
	for _, sh := range es.shadows {
		shadows = append(shadows, sh)
	}
	es.shadows = make(map[string]*ShadowDocument)
	es.mu.Unlock()
	logger.Info("editor: close-all", "count", len(shadows))
	for _, sh := range shadows {
		sh.stopDebounce()
		_ = es.flushShadow(sh, "close-all")
	}
}

func (es *EditorService) SetServices(svc BlockServices) {
	es.services = svc
}

// CreateBlock is the canonical block creation path for UI-triggered creation
// (keyboard shortcut, toolbar button). Generates a fresh block ID.
func (es *EditorService) CreateBlock(uuid, kind string, overrides map[string]interface{}) (id string, rawYaml string, err error) {
	return es.createBlockWithID(uuid, kind, GenerateBlockIDFor(kind), overrides)
}

// createBlockWithID creates a block using a caller-supplied ID. Used by
// HandlePaste so the pre-generated ID (passed to PasteMatch) is reused.
func (es *EditorService) createBlockWithID(uuid, kind, blockID string, overrides map[string]interface{}) (id string, rawYaml string, err error) {
	defer func() {
		if err == nil {
			es.DispatchJobIfNeeded(uuid, id)
		}
	}()

	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return "", "", fmt.Errorf("create-block: no open document for uuid %q", uuid)
	}
	processor := GetProcessor(kind)
	if processor == nil {
		return "", "", fmt.Errorf("no processor registered for kind %q", kind)
	}
	id = blockID
	attrs := processor.InitAttrs(id, overrides)
	sieveBlock := SieveBlock{ID: id, Kind: kind, Attrs: attrs}
	es.UpdateBlock(uuid, sieveBlock)
	rawYaml, err = fencedblock.SerializeYaml[map[string]interface{}](attrs)
	if err != nil {
		return "", "", err
	}

	es.notifyBlockCreated(uuid, sieveBlock)

	return id, rawYaml, nil
}

// SerializeBlock encodes the block based on its processor mode.
func (es *EditorService) SerializeBlock(processor BlockProcessor, block SieveBlock) (string, error) {
	return SerializeBlock(processor, &block)
}

// HandlePaste runs paste matchers and delegates to CreateBlock on the first match.
// It is the secondary creation path — prefer CreateBlock directly for UI-triggered creation.
func (es *EditorService) HandlePaste(uuid string, entries []ContentEntry) (kind, id, rawYaml string, matched bool) {
	registryMu.RLock()
	matchers := pasteMatchers
	registryMu.RUnlock()

	for _, pm := range matchers {
		if !pm.Processor.IsBlock(entries) {
			continue
		}

		blockID := GenerateBlockIDFor(pm.Kind)
		overrides := pm.Processor.Transform(entries, uuid, blockID)

		id, raw, err := es.createBlockWithID(uuid, pm.Kind, blockID, overrides)
		if err != nil {
			return "", "", "", false
		}
		return pm.Kind, id, raw, true
	}
	return "", "", "", false
}

// CreateBlockFromEntries is the extraction creation path. It is identical to Paste
// except the backend skips detection — the frontend explicitly requested this Kind.
func (es *EditorService) CreateBlockFromEntries(uuid, kind string, entries []ContentEntry) (id, rawYaml string, err error) {
	processor := GetProcessor(kind)
	if processor == nil {
		return "", "", fmt.Errorf("no processor registered for kind %q", kind)
	}

	blockID := GenerateBlockIDFor(kind)
	// Execute the transformation (e.g. smart-image saves the file synchronously)
	overrides := processor.Transform(entries, uuid, blockID)
	if overrides == nil {
		return "", "", fmt.Errorf("extract: processor %q could not transform entries into a block", kind)
	}

	return es.createBlockWithID(uuid, kind, blockID, overrides)
}

// HandleBlockUpdate processes a block-update from the client: merges the user's
// attr patch into the shadow, then calls OnChange on the processor so it can
// react synchronously (e.g. re-run heuristics). Any resulting async work is
// dispatched automatically if the block status is set to PENDING.
func (es *EditorService) HandleBlockUpdate(uuid, kind, blockID string, attrs map[string]interface{}) {
	sieveBlock := SieveBlock{
		ID:    blockID,
		Kind:  kind,
		Attrs: attrs,
	}
	es.UpdateBlock(uuid, sieveBlock)

	processor := GetProcessor(kind)
	if processor == nil {
		return
	}

	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return
	}

	shadow.mu.Lock()
	blk := findBlockIn(shadow.Blocks, blockID)
	if blk == nil {
		shadow.mu.Unlock()
		return
	}
	// Copy the current merged state (user patch + existing attrs) for OnChange.
	blkCopy := &SieveBlock{
		ID:    blk.ID,
		Kind:  blk.Kind,
		Attrs: make(map[string]interface{}, len(blk.Attrs)),
	}
	attrsBefore := make(map[string]interface{}, len(blk.Attrs))
	for k, v := range blk.Attrs {
		blkCopy.Attrs[k] = v
		attrsBefore[k] = v
	}
	shadow.mu.Unlock()

	processor.OnChange(blkCopy)

	// Compute which attrs OnChange changed and merge only those back.
	attrsChanged := make(map[string]interface{})
	for k, v := range blkCopy.Attrs {
		if attrsBefore[k] != v {
			attrsChanged[k] = v
		}
	}

	if len(attrsChanged) > 0 {
		updatedBlock := SieveBlock{ID: blockID, Kind: kind, Attrs: attrsChanged}
		shadow.setBlock(updatedBlock)
	}

	// Always notify client so it gets the re-computed serialisedForm and UI updates
	shadow.mu.Lock()
	blkFinal := findBlockIn(shadow.Blocks, blockID)
	okFinal := blkFinal != nil
	var finalAttrs map[string]interface{}
	if okFinal {
		finalAttrs = make(map[string]interface{}, len(blkFinal.Attrs))
		for k, v := range blkFinal.Attrs {
			finalAttrs[k] = v
		}
	}
	shadow.mu.Unlock()

	if okFinal {
		es.notifyBlockUpdated(uuid, SieveBlock{ID: blockID, Kind: kind, Attrs: finalAttrs})
	}

	es.DispatchJobIfNeeded(uuid, blockID)
}

// DispatchJobIfNeeded checks if the block has status PENDING. If so, it transitions the block
// to DISPATCHED, notifies the listener of the transition, flushes to disk, and runs the job.
func (es *EditorService) DispatchJobIfNeeded(uuid, blockID string) {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return
	}

	shadow.mu.Lock()
	blk := findBlockIn(shadow.Blocks, blockID)
	if blk == nil {
		shadow.mu.Unlock()
		return
	}
	if blk.Status() == BlockStatusPending {
		blk.Attrs["status"] = BlockStatusDispatched

		// Take copy of attributes under lock to serialize and notify listener
		attrsCopy := make(map[string]interface{}, len(blk.Attrs))
		for k, v := range blk.Attrs {
			attrsCopy[k] = v
		}
		shadow.mu.Unlock()

		blkCopy := SieveBlock{ID: blockID, Kind: blk.Kind, Attrs: attrsCopy}
		es.notifyBlockUpdated(uuid, blkCopy)

		// Flush state to disk
		_ = es.Flush(uuid)

		go es.RunJob(context.Background(), uuid, blockID)
	} else {
		shadow.mu.Unlock()
	}
}

// applyJobUpdate safely applies block updates resulting from a background job.
// It looks up the current active shadow (which may have been recreated) or updates disk directly if closed.
func (es *EditorService) applyJobUpdate(uuid, blockID, kind string, updates map[string]interface{}, deletes []string, flushReason string) {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()

	if shadow != nil {
		if len(updates) > 0 {
			shadow.setBlock(SieveBlock{ID: blockID, Kind: kind, Attrs: updates})
		}
		for _, k := range deletes {
			shadow.deleteBlockAttr(blockID, k)
		}
		if flushReason != "" {
			_ = es.flushShadow(shadow, flushReason)
		}

		shadow.mu.Lock()
		blk := findBlockIn(shadow.Blocks, blockID)
		ok := blk != nil
		var attrsCopy map[string]interface{}
		if ok {
			attrsCopy = make(map[string]interface{}, len(blk.Attrs))
			for k, v := range blk.Attrs {
				attrsCopy[k] = v
			}
		}
		shadow.mu.Unlock()
		if ok {
			es.notifyBlockUpdated(uuid, SieveBlock{ID: blockID, Kind: kind, Attrs: attrsCopy})
		}
	} else {
		// No active shadow in memory. We must update the document on disk directly.
		doc, err := es.documents.LoadByUUID(uuid)
		if err != nil {
			logger.Warn("editor: job update failed to load doc", "uuid", uuid, "err", err)
			return
		}
		body := string(doc.Body())
		diskBlocks, err := ParseBlockDocWithHandles(body)
		if err != nil {
			logger.Warn("editor: job update failed to parse doc", "uuid", uuid, "err", err)
			return
		}
		blk := findBlockIn(diskBlocks, blockID)
		if blk == nil {
			logger.Warn("editor: job update target block missing from disk", "uuid", uuid, "block", blockID)
			return
		}

		if blk.Attrs == nil {
			blk.Attrs = make(map[string]interface{}, len(updates))
		}
		for k, v := range updates {
			blk.Attrs[k] = v
		}
		for _, k := range deletes {
			delete(blk.Attrs, k)
		}

		newBody, err := SerializeBlockDocWithHandles(diskBlocks)
		if err != nil {
			logger.Warn("editor: job update failed to serialize doc", "uuid", uuid, "err", err)
			return
		}
		doc.SetBody([]byte(newBody))
		if _, err := es.documents.Save(doc); err != nil {
			logger.Warn("editor: job update save to disk failed", "uuid", uuid, "err", err)
		} else {
			logger.Info("editor: job update applied to disk directly", "uuid", uuid, "block", blockID)
		}
	}
}

// RunJob executes the background job for blockID, merges results into the shadow,
// flushes to disk, and notifies the listener with the updated rawYaml.
func (es *EditorService) RunJob(ctx context.Context, uuid, blockID string) {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return
	}

	shadow.mu.Lock()
	blk := findBlockIn(shadow.Blocks, blockID)
	if blk == nil {
		shadow.mu.Unlock()
		return
	}
	kind := blk.Kind
	blkCopy := &SieveBlock{
		ID:    blk.ID,
		Kind:  blk.Kind,
		Attrs: make(map[string]interface{}, len(blk.Attrs)),
	}
	attrsBefore := make(map[string]interface{}, len(blk.Attrs))
	for k, v := range blk.Attrs {
		blkCopy.Attrs[k] = v
		attrsBefore[k] = v
	}
	mdBuf := shadow.mdModeBuffer
	mode := shadow.Mode
	// Snapshot the authoritative block tree so the job can resolve ANY block by id
	// (prose included) via getBlock. Top-level slice copy under lock; Content is
	// value-copied (race-free), matching the existing Attrs aliasing.
	blocksCopy := append([]SieveBlock(nil), shadow.Blocks...)
	shadow.mu.Unlock()

	processor := GetProcessor(kind)
	if processor == nil {
		return
	}

	label := processor.JobLabel(blkCopy)
	if label != "" && es.services.Jobs != nil {
		es.services.Jobs.Start(JobInfo{
			JobID:   blockID,
			Label:   label,
			DocID:   uuid,
			SpinTab: false,
		})
		defer es.services.Jobs.End(blockID)
	}

	// notify lets the processor push intermediate attr updates mid-job
	// (e.g. push src immediately after saving, before slow AI describe).
	notify := func(bID string, partialAttrs map[string]interface{}) {
		es.applyJobUpdate(uuid, bID, kind, partialAttrs, nil, "job-progress")
	}

	jctx := JobContext{
		Ctx:    ctx,
		UUID:   uuid,
		Doc: DocView{UUID: uuid, mdModeBuffer: mdBuf, Mode: mode, Blocks: blocksCopy},
		Block:  blkCopy,
		Notify: notify,
	}
	if err := processor.RunJob(jctx); err != nil {
		es.applyJobUpdate(uuid, blockID, kind, map[string]interface{}{"status": BlockStatusError}, nil, "job-complete")
	} else {
		// Dynamically determine what attributes the job updated.
		updates := make(map[string]interface{})
		var deletes []string

		for k, vAfter := range blkCopy.Attrs {
			vBefore, exists := attrsBefore[k]
			if !exists || !reflect.DeepEqual(vBefore, vAfter) {
				updates[k] = vAfter
			}
		}
		for k := range attrsBefore {
			if _, exists := blkCopy.Attrs[k]; !exists {
				deletes = append(deletes, k)
			}
		}

		es.applyJobUpdate(uuid, blockID, kind, updates, deletes, "job-complete")
	}
}

func (es *EditorService) PromoteBlock(uuid, blockID string) error {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return fmt.Errorf("no open document")
	}

	shadow.mu.Lock()
	blk := findBlockIn(shadow.Blocks, blockID)
	if blk == nil {
		shadow.mu.Unlock()
		return fmt.Errorf("block not found")
	}
	processor := GetProcessor(blk.Kind)
	if processor == nil {
		shadow.mu.Unlock()
		return fmt.Errorf("processor not found")
	}

	blkCopy := SieveBlock{ID: blk.ID, Kind: blk.Kind, Attrs: make(map[string]interface{}, len(blk.Attrs))}
	for k, v := range blk.Attrs {
		blkCopy.Attrs[k] = v
	}
	shadow.mu.Unlock()

	plainContent := processor.MarkdownRepresentation(blkCopy)
	if plainContent == "" {
		return fmt.Errorf("block cannot be promoted")
	}

	markdownReplacement := fmt.Sprintf("[!block] id=%q\n\n%s\n\n[!block-end]", blockID, plainContent)

	shadow.mu.Lock()
	// Source markdown is derived fresh from the tree (WYSIWYG) or the raw buffer
	// (markdown mode) — never a stale stored field, which is exactly what drifted.
	newMarkdown, ok := PromoteBlock(shadow.deriveMarkdown(), blockID, markdownReplacement)
	if !ok {
		shadow.mu.Unlock()
		return fmt.Errorf("block not found in markdown AST")
	}
	// In WYSIWYG mode the authoritative Doc drives the save, so refresh it from
	// the promoted markdown (this also drops the promoted block from the tree).
	if shadow.Mode == "wysiwyg" {
		shadow.reparseDoc(newMarkdown)
	} else {
		// Markdown mode serializes the raw buffer verbatim; update it, and keep the
		// tree honest by dropping the promoted block so a later flush can't resurrect it.
		shadow.mdModeBuffer = newMarkdown
		removeBlock(&shadow.Blocks, blockID)
	}
	shadow.resetDebounce()
	shadow.mu.Unlock()

	_ = es.Flush(uuid)
	es.notifyBlockPromoted(uuid, blockID, plainContent)
	return nil
}
