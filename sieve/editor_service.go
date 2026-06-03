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
	UUID     string
	Markdown string                 // full document from TipTap; block rawYaml may be stale
	Blocks   map[string]*SieveBlock // user-edited blocks; authoritative over shadow.Markdown
	Mode     string                 // "wysiwyg" (default) or "markdown"
	debounce time.Duration
	closed   bool // set by stopDebounce; prevents re-arming after Close
	mu       sync.Mutex
	timer    *time.Timer
	onFlush  func()
}

func newShadow(uuid, body string, debounce time.Duration, onFlush func()) *ShadowDocument {
	return &ShadowDocument{
		UUID:     uuid,
		Markdown: body,
		Blocks:   ParseAllBlocks(body),
		Mode:     "wysiwyg",
		debounce: debounce,
		onFlush:  onFlush,
	}
}

func (s *ShadowDocument) setMarkdown(md string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Markdown = md
	s.resetDebounce()
}

// setBlock creates or merges attrs into the named block. kind is only used
// when creating a new entry; subsequent calls preserve the existing Kind.
func (s *ShadowDocument) setBlock(block SieveBlock) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if blk, ok := s.Blocks[block.ID]; ok {
		for k, v := range block.Attrs {
			blk.Attrs[k] = v
		}
	} else {
		merged := make(map[string]interface{}, len(block.Attrs))
		for k, v := range block.Attrs {
			merged[k] = v
		}
		s.Blocks[block.ID] = &SieveBlock{ID: block.ID, Kind: block.Kind, Attrs: merged}
	}
	s.resetDebounce()
}

// replaceBlock atomically replaces the attrs map for an existing block.
// Unlike setBlock (additive merge), deleted keys in attrs are propagated —
// the old map is discarded entirely. No-op if the block does not exist.
func (s *ShadowDocument) replaceBlock(blockID string, block SieveBlock) {
	s.mu.Lock()
	defer s.mu.Unlock()
	blk, ok := s.Blocks[blockID]
	if !ok {
		return
	}
	blk.Attrs = block.Attrs
	s.resetDebounce()
}

// deleteBlockAttr removes a single key from an existing block's attrs.
// Used to expunge transient fields (e.g. hint) that a job has consumed.
func (s *ShadowDocument) deleteBlockAttr(blockID, key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if blk, ok := s.Blocks[blockID]; ok {
		delete(blk.Attrs, key)
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
// In WYSIWYG mode each block in shadow.Blocks is substituted into shadow.Markdown
// so authoritative block state overwrites any stale rawYaml from TipTap.
func (s *ShadowDocument) contentForSave() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Mode == "markdown" {
		return s.Markdown
	}
	return InjectBlocks(s.Markdown, s.Blocks)
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

// Open loads a document from disk and creates an in-memory ShadowDocument.
// notifySaved is called (if non-nil) after each successful debounce flush so the
// WebSocket connection can send a flush-ack to the client.
func (es *EditorService) Open(uuid string, notifySaved func()) error {
	doc, err := es.documents.LoadByUUID(uuid)
	if err != nil {
		return err
	}
	// Declare shadow before the closure so the closure can capture the variable.
	var shadow *ShadowDocument
	shadow = newShadow(uuid, string(doc.Body()), es.debounce, func() {
		if err := es.flushShadow(shadow, "debounce"); err == nil && notifySaved != nil {
			notifySaved()
		}
	})

	es.mu.Lock()
	es.shadows[uuid] = shadow
	es.mu.Unlock()
	logger.Info("editor: open", "uuid", uuid, "body_bytes", len(doc.Body()))
	return nil
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
// It re-parses shadow.Blocks from the current shadow.Markdown so that any block
// YAML the user edited directly in markdown mode is picked up for future Remux calls.
func (es *EditorService) EnterWysiwyg(uuid string) {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		logger.Warn("editor: enter-wysiwyg — no shadow", "uuid", uuid)
		return
	}
	shadow.mu.Lock()
	blocks := ParseAllBlocks(shadow.Markdown)
	shadow.Blocks = blocks
	shadow.Mode = "wysiwyg"
	shadow.mu.Unlock()
	logger.Info("editor: enter-wysiwyg", "uuid", uuid, "blocks_reparsed", len(blocks))
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

func (es *EditorService) SetServices(svc BlockServices) {
	es.services = svc
}

// CreateBlock is the canonical block creation path. It initialises a new block
// via the registered processor's InitAttrs, registers it in the shadow, and
// returns the serialised rawYaml for the JS to insert as a sieveBlock node.
// overrides may be nil for a zero-state block (UI command, keyboard shortcut).
func (es *EditorService) CreateBlock(uuid, kind string, overrides map[string]interface{}) (id string, rawYaml string, err error) {
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
	id = GenerateBlockID(kind)
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
func (es *EditorService) HandlePaste(uuid string, entries []PasteEntry) (kind, id, rawYaml string, matched bool) {
	registryMu.RLock()
	matchers := pasteMatchers
	registryMu.RUnlock()

	for _, pm := range matchers {
		ok, overrides := pm.Processor.PasteMatch(entries)
		if !ok {
			continue
		}
		blockID, raw, err := es.CreateBlock(uuid, pm.Kind, overrides)
		if err != nil {
			return "", "", "", false
		}
		return pm.Kind, blockID, raw, true
	}
	return "", "", "", false
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

	processor.OnChange(blkCopy, es.services)

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
		shadow.mu.Lock()
		blk2, ok2 := shadow.Blocks[blockID]
		var attrsCopy map[string]interface{}
		if ok2 {
			attrsCopy = make(map[string]interface{}, len(blk2.Attrs))
			for k, v := range blk2.Attrs {
				attrsCopy[k] = v
			}
		}
		shadow.mu.Unlock()
		if ok2 {
			// rawYaml, _ := fencedblock.SerializeYaml[map[string]interface{}](attrsCopy)
			es.notifyBlockUpdated(uuid, updatedBlock)
		}
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

	if err := processor.RunJob(ctx, uuid, blkCopy, es.services); err != nil {
		shadow.setBlock(SieveBlock{ID: blockID, Kind: kind, Attrs: map[string]interface{}{"status": BlockStatusError}})
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

		if len(updates) > 0 {
			shadow.setBlock(SieveBlock{ID: blockID, Kind: kind, Attrs: updates})
		}
		for _, k := range deletes {
			shadow.deleteBlockAttr(blockID, k)
		}
	}

	_ = es.flushShadow(shadow, "job-complete")

	shadow.mu.Lock()
	blk2, ok2 := shadow.Blocks[blockID]
	var attrsCopy map[string]interface{}
	if ok2 {
		attrsCopy = make(map[string]interface{}, len(blk2.Attrs))
		for k, v := range blk2.Attrs {
			attrsCopy[k] = v
		}
	}
	shadow.mu.Unlock()
	if ok2 {
		blkCopy2 := SieveBlock{ID: blockID, Kind: kind, Attrs: attrsCopy}
		es.notifyBlockUpdated(uuid, blkCopy2)
	}
}
