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

// SieveBlock is the Go representation of any fenced YAML block.
// Kind comes from the fence info string — it is never written to the YAML body.
type SieveBlock struct {
	ID    string
	Kind  string                 // from fence info string
	Attrs map[string]interface{} // all YAML fields including "id"
}

// ShadowDocument holds the in-memory editor state for one open document.
// Mode controls how Flush and Remux behave ("wysiwyg" or "markdown").
type ShadowDocument struct {
	UUID string
	// Doc is the authoritative ordered block tree (spec §2). In WYSIWYG mode it
	// is the single source of truth for what gets saved — contentForSave just
	// serializes it (blocks 1..N). It replaces the old "markdown is the model"
	// pair (Markdown + Blocks overlaid via InjectBlocks).
	Doc      BlockDoc
	Markdown string                 // last full markdown (markdown mode + raw-markdown consumers)
	Blocks   map[string]*SieveBlock // DERIVED view over Doc (temporary bridge); Attrs aliases Doc's map
	Mode     string                 // "wysiwyg" (default) or "markdown"
	debounce time.Duration
	closed   bool // set by stopDebounce; prevents re-arming after Close
	mu       sync.Mutex
	timer    *time.Timer
	onFlush  func()
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
	doc, err := ParseBlockDocWithHandles(body)
	if err != nil {
		logger.Warn("editor: parse block doc failed", "uuid", uuid, "err", err)
	}
	// Constructor invariant: a block can never exist in the live model without an
	// id. Mint a handle for every id-less prose block as the shadow is built, so
	// the authoritative tree is disciplined from the moment it exists (and stays
	// so on reparse — see reparseDoc — and on create-block — see ApplyOp).
	// Idempotent: a block that already carries a handle keeps it (stable reopen).
	mintProseIDs(doc.Blocks)
	s := &ShadowDocument{
		UUID:     uuid,
		Doc:      doc,
		Markdown: body,
		Mode:     "wysiwyg",
		debounce: debounce,
		onFlush:  onFlush,
	}
	s.syncBlocksView()
	return s
}

// syncBlocksView rebuilds the derived Blocks map from the authoritative Doc.
// Each SieveBlock.Attrs ALIASES the DocBlock.Attrs map (same reference), so the
// existing call sites that mutate attrs in place (AI jobs, lifecycle) propagate
// straight back into Doc. Prose blocks are excluded — the Blocks map has always
// held only fenced (structured) blocks. Temporary bridge (caller holds s.mu).
func (s *ShadowDocument) syncBlocksView() {
	s.Blocks = make(map[string]*SieveBlock)
	var walk func(blocks []DocBlock)
	walk = func(blocks []DocBlock) {
		for i := range blocks {
			b := &blocks[i]
			if b.Kind != KindProse && b.ID != "" {
				s.Blocks[b.ID] = &SieveBlock{ID: b.ID, Kind: b.Kind, Attrs: b.Attrs}
			}
			walk(b.Children)
		}
	}
	walk(s.Doc.Blocks)
}

// reparseDoc replaces Doc from the given markdown (WYSIWYG only) and refreshes
// the derived view. Caller holds s.mu.
func (s *ShadowDocument) reparseDoc(md string) {
	if doc, err := ParseBlockDocWithHandles(md); err == nil {
		s.Doc = doc
		// Discipline: every block in the authoritative tree carries an id. A
		// doc-update may arrive with id-less prose (the pre-mint frontend
		// fallback sends bare markdown), so mint a handle for any block that
		// lacks one — exactly as Open does — before it can ever be persisted.
		// Idempotent: a block that already has an id keeps it (stable across
		// reopen). The granular per-node ids come from the frontend's create-block
		// ops once minting lands there; this guarantees the floor regardless.
		mintProseIDs(s.Doc.Blocks)
		s.syncBlocksView()
	} else {
		logger.Warn("editor: reparse block doc failed", "uuid", s.UUID, "err", err)
	}
}

func (s *ShadowDocument) setMarkdown(md string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Markdown = md
	if s.Mode == "wysiwyg" {
		s.reparseDoc(md)
	}
	s.resetDebounce()
}

// setBlock creates or merges attrs into the named block in Doc. kind is only
// used when creating a new entry; subsequent calls preserve the existing Kind.
func (s *ShadowDocument) setBlock(block SieveBlock) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if b := s.Doc.findBlock(block.ID); b != nil {
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
		s.Doc.Blocks = append(s.Doc.Blocks, DocBlock{ID: block.ID, Kind: block.Kind, Attrs: merged})
	}
	s.syncBlocksView()
	s.resetDebounce()
}

// replaceBlock atomically replaces the attrs map for an existing block.
// Unlike setBlock (additive merge), deleted keys in attrs are propagated —
// the old map is discarded entirely. No-op if the block does not exist.
func (s *ShadowDocument) replaceBlock(blockID string, block SieveBlock) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.Doc.findBlock(blockID)
	if b == nil {
		return
	}
	b.Attrs = block.Attrs
	s.syncBlocksView()
	s.resetDebounce()
}

// deleteBlockAttr removes a single key from an existing block's attrs.
// Used to expunge transient fields (e.g. hint) that a job has consumed.
func (s *ShadowDocument) deleteBlockAttr(blockID, key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if b := s.Doc.findBlock(blockID); b != nil {
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

// contentForSave returns the content that should be written to disk.
// In markdown mode the user is editing raw YAML directly, so shadow.Markdown
// is returned verbatim — no block substitution.
// In WYSIWYG mode the authoritative block tree is serialized (blocks 1..N) via
// the single serialization spine — there is no InjectBlocks overlay anymore.
func (s *ShadowDocument) contentForSave() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Mode == "markdown" {
		return s.Markdown
	}
	md, err := SerializeBlockDocWithHandles(s.Doc)
	if err != nil {
		logger.Warn("editor: serialize block doc failed", "uuid", s.UUID, "err", err)
		return s.Markdown
	}
	return md
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
	doc := shadow.Doc
	shadow.mu.Unlock()
	blocks, err := BlockDocToFrontendBlocks(doc)
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
	for id, blk := range shadow.Blocks {
		if status, _ := blk.Attrs["status"].(string); status != BlockStatusDispatched {
			continue
		}
		createdAt, _ := blk.Attrs["createdAt"].(string)
		if createdAt == "" {
			blk.Attrs["status"] = BlockStatusPending
			stuck = append(stuck, id)
			continue
		}
		if t, err := time.Parse(time.RFC3339, createdAt); err == nil {
			if time.Since(t) > dispatchedStuckThreshold {
				blk.Attrs["status"] = BlockStatusPending
				stuck = append(stuck, id)
			}
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
	if err := shadow.Doc.ApplyOp(op); err != nil {
		return err
	}
	shadow.syncBlocksView()
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

// EnterMarkdown switches the shadow to markdown mode.
// It first computes Remux() to embed all current block state into shadow.Markdown,
// then sets mode = "markdown" so that subsequent Flush calls save verbatim.
// Returns the merged markdown to use as the seed for the markdown editor.
func (es *EditorService) EnterMarkdown(uuid string) string {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		logger.Warn("editor: enter-markdown — no shadow", "uuid", uuid)
		return ""
	}
	merged := shadow.contentForSave() // embeds block state before mode switch
	shadow.mu.Lock()
	shadow.Markdown = merged
	shadow.Mode = "markdown"
	shadow.mu.Unlock()
	logger.Info("editor: enter-markdown", "uuid", uuid, "bytes", len(merged))
	return merged
}

// EnterWysiwyg switches the shadow back to WYSIWYG mode.
// It re-parses the authoritative Doc from the current shadow.Markdown so that any
// block YAML the user edited directly in markdown mode is picked up for save.
func (es *EditorService) EnterWysiwyg(uuid string) {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		logger.Warn("editor: enter-wysiwyg — no shadow", "uuid", uuid)
		return
	}
	shadow.mu.Lock()
	shadow.reparseDoc(shadow.Markdown)
	shadow.Mode = "wysiwyg"
	n := len(shadow.Blocks)
	shadow.mu.Unlock()
	logger.Info("editor: enter-wysiwyg", "uuid", uuid, "blocks_reparsed", n)
}

// Flush writes the Remuxed shadow to disk via DocumentService.
// In markdown mode Remux() returns shadow.Markdown verbatim.
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
	blk, ok := shadow.Blocks[blockID]
	if !ok {
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
	blkFinal, okFinal := shadow.Blocks[blockID]
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
	blk, ok := shadow.Blocks[blockID]
	if !ok {
		shadow.mu.Unlock()
		return
	}
	status, _ := blk.Attrs["status"].(string)
	if status == BlockStatusPending {
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
		blk, ok := shadow.Blocks[blockID]
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
		blockDoc, err := ParseBlockDocWithHandles(body)
		if err != nil {
			logger.Warn("editor: job update failed to parse doc", "uuid", uuid, "err", err)
			return
		}
		blk := blockDoc.findBlock(blockID)
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

		newBody, err := SerializeBlockDocWithHandles(blockDoc)
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
	blk, ok := shadow.Blocks[blockID]
	if !ok {
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
	markdown := shadow.Markdown
	mode := shadow.Mode
	blocksCopy := make(map[string]*SieveBlock, len(shadow.Blocks))
	for k, v := range shadow.Blocks {
		blocksCopy[k] = v
	}
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
		Shadow: ShadowDocument{UUID: uuid, Markdown: markdown, Mode: mode, Blocks: blocksCopy},
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
	blk, ok := shadow.Blocks[blockID]
	if !ok {
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
	newMarkdown, ok := PromoteBlock(shadow.Markdown, blockID, markdownReplacement)
	if !ok {
		shadow.mu.Unlock()
		return fmt.Errorf("block not found in markdown AST")
	}
	shadow.Markdown = newMarkdown
	// In WYSIWYG mode the authoritative Doc drives the save, so refresh it from
	// the promoted markdown (this also drops the promoted block from the tree).
	if shadow.Mode == "wysiwyg" {
		shadow.reparseDoc(newMarkdown)
	} else {
		delete(shadow.Blocks, blockID)
	}
	shadow.resetDebounce()
	shadow.mu.Unlock()

	_ = es.Flush(uuid)
	es.notifyBlockPromoted(uuid, blockID, plainContent)
	return nil
}
