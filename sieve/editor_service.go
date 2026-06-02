package sieve

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
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
		Blocks:   parseAllBlocks(body),
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
func (s *ShadowDocument) setBlock(kind, blockID string, attrs map[string]interface{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if blk, ok := s.Blocks[blockID]; ok {
		for k, v := range attrs {
			blk.Attrs[k] = v
		}
	} else {
		merged := make(map[string]interface{}, len(attrs))
		for k, v := range attrs {
			merged[k] = v
		}
		s.Blocks[blockID] = &SieveBlock{ID: blockID, Kind: kind, Attrs: merged}
	}
	s.resetDebounce()
}

// replaceBlock atomically replaces the attrs map for an existing block.
// Unlike setBlock (additive merge), deleted keys in attrs are propagated —
// the old map is discarded entirely. No-op if the block does not exist.
func (s *ShadowDocument) replaceBlock(blockID string, attrs map[string]interface{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	blk, ok := s.Blocks[blockID]
	if !ok {
		return
	}
	blk.Attrs = attrs
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
	out := s.Markdown
	for _, blk := range s.Blocks {
		updated, err := fencedblock.Replace[map[string]interface{}](out, blk.Kind, blk.ID, blk.Attrs)
		if err == nil {
			out = updated
		}
	}
	return out
}

// parseAllBlocks scans body for all named fenced blocks (```kind where kind != "")
// and returns them keyed by block ID. Used when re-entering WYSIWYG mode so that
// any block YAML the user edited directly in markdown mode is picked up.
func parseAllBlocks(body string) map[string]*SieveBlock {
	blocks := make(map[string]*SieveBlock)
	lines := strings.Split(body, "\n")
	i := 0
	for i < len(lines) {
		line := lines[i]
		if strings.HasPrefix(line, "```") && len(line) > 3 {
			kind := strings.TrimPrefix(line, "```")
			j := i + 1
			for j < len(lines) && lines[j] != "```" {
				j++
			}
			if j < len(lines) {
				content := strings.Join(lines[i+1:j], "\n")
				var attrs map[string]interface{}
				if yaml.Unmarshal([]byte(content), &attrs) == nil {
					if id, ok := attrs["id"].(string); ok && id != "" {
						blocks[id] = &SieveBlock{ID: id, Kind: kind, Attrs: attrs}
					}
				}
				i = j + 1
				continue
			}
		}
		i++
	}
	return blocks
}

// EditorService is the Go-side editor model. It holds one ShadowDocument per
// open document and coordinates all save operations. DocumentService owns disk.
type EditorService struct {
	documents *DocumentService
	services  Services
	debounce  time.Duration
	mu        sync.RWMutex
	shadows   map[string]*ShadowDocument
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
func (es *EditorService) UpdateBlock(uuid, kind, blockID string, attrs map[string]interface{}) {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		logger.Warn("editor: block-update dropped — no shadow", "uuid", uuid, "block", blockID)
		return
	}
	shadow.setBlock(kind, blockID, attrs)
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
	blocks := parseAllBlocks(shadow.Markdown)
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

func (es *EditorService) SetServices(svc Services) {
	es.services = svc
}

// CreateBlock is the canonical block creation path. It initialises a new block
// via the registered processor's InitAttrs, registers it in the shadow, and
// returns the serialised rawYaml for the JS to insert as a sieveBlock node.
// overrides may be nil for a zero-state block (UI command, keyboard shortcut).
func (es *EditorService) CreateBlock(uuid, kind string, overrides map[string]interface{}) (id, rawYaml string, err error) {
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
	es.UpdateBlock(uuid, kind, id, attrs)
	raw, err := fencedblock.Serialize[map[string]interface{}](attrs)
	if err != nil {
		return "", "", err
	}
	return id, raw, nil
}

// HandlePaste runs paste matchers and delegates to CreateBlock on the first match.
// It is the secondary creation path — prefer CreateBlock directly for UI-triggered creation.
func (es *EditorService) HandlePaste(uuid, content string) (kind, id, rawYaml string, matched bool) {
	registryMu.RLock()
	matchers := pasteMatchers
	registryMu.RUnlock()

	for _, pm := range matchers {
		ok, overrides := pm.Processor.PasteMatch(content)
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
// attr patch into the shadow, then calls OnUpdate on the processor so it can
// react synchronously (e.g. re-run heuristics) or schedule a RunJob.
// notify is called when a job completes and JS needs to update its node attrs.
func (es *EditorService) HandleBlockUpdate(uuid, kind, blockID string, attrs map[string]interface{}, notify func(id, rawYaml string)) {
	es.UpdateBlock(uuid, kind, blockID, attrs)

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
	// Copy the current merged state (user patch + existing attrs) for OnUpdate.
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

	scheduleJob := processor.OnUpdate(blkCopy, es.services)

	// Compute which attrs OnUpdate changed and merge only those back.
	attrsChanged := make(map[string]interface{})
	for k, v := range blkCopy.Attrs {
		if attrsBefore[k] != v {
			attrsChanged[k] = v
		}
	}

	if len(attrsChanged) > 0 {
		shadow.setBlock(kind, blockID, attrsChanged)
		if notify != nil {
			shadow.mu.Lock()
			blk2, ok2 := shadow.Blocks[blockID]
			shadow.mu.Unlock()
			if ok2 {
				rawYaml, _ := fencedblock.Serialize[map[string]interface{}](blk2.Attrs)
				notify(blockID, rawYaml)
			}
		}
	}

	if scheduleJob {
		go es.RunJob(context.Background(), uuid, blockID, notify)
	}
}

// RunJob executes the background job for blockID, merges results into the shadow,
// flushes to disk, and calls notify with the updated rawYaml.
func (es *EditorService) RunJob(ctx context.Context, uuid, blockID string, notify func(id, rawYaml string)) {
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
	for k, v := range blk.Attrs {
		blkCopy.Attrs[k] = v
	}
	shadow.mu.Unlock()

	processor := GetProcessor(kind)
	if processor == nil {
		return
	}

	if err := processor.RunJob(ctx, blkCopy, es.services); err != nil {
		shadow.setBlock(kind, blockID, map[string]interface{}{"status": "ERROR"})
	} else {
		// Merge only the fields the job updated (language, status, detectionMethod).
		// Do NOT use replaceBlock here — that would overwrite source with the copy
		// taken at job-start, discarding any edits the user made while AI was running.
		shadow.setBlock(kind, blockID, map[string]interface{}{
			"language":        blkCopy.Attrs["language"],
			"status":          blkCopy.Attrs["status"],
			"detectionMethod": blkCopy.Attrs["detectionMethod"],
		})
		shadow.deleteBlockAttr(blockID, "hint")
	}

	_ = es.Flush(uuid)

	if notify != nil {
		shadow.mu.Lock()
		blk2, ok2 := shadow.Blocks[blockID]
		shadow.mu.Unlock()
		if ok2 {
			rawYaml, _ := fencedblock.Serialize[map[string]interface{}](blk2.Attrs)
			notify(blockID, rawYaml)
		}
	}
}

