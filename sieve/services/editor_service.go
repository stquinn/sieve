package services

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"time"

	"sieve/logger"
	"sieve/sieve/block"
	"sieve/sieve/fencedblock"
)

// EditorService is the Go-side editor model. It holds one ShadowDocument per
// open document and coordinates all save operations. DocumentService owns disk.
type EditorService struct {
	documents *DocumentService
	codec     *block.DocumentCodec
	services  block.BlockServices
	jobs      *JobTracker // not a processor concern; EditorService tracks job spinners directly
	debounce  time.Duration
	mu        sync.RWMutex
	shadows   map[string]*block.ShadowDocument
	listener  block.BlockLifecycleListener
}

// NewEditorService creates an EditorService backed by the given DocumentService.
// codec owns document serialization/deserialization; debounce controls the
// autosave delay (pass 0 to use the default 30s).
func NewEditorService(documents *DocumentService, codec *block.DocumentCodec, debounce time.Duration) *EditorService {
	d := debounce
	if d <= 0 {
		d = block.DefaultAutosaveDebounce
	}
	logger.Info("editor: initialized", "autosave_debounce", d)
	return &EditorService{
		documents: documents,
		codec:     codec,
		debounce:  d,
		shadows:   make(map[string]*block.ShadowDocument),
	}
}

// SetLifecycleListener registers the block lifecycle event listener.
func (es *EditorService) SetLifecycleListener(l block.BlockLifecycleListener) {
	es.mu.Lock()
	defer es.mu.Unlock()
	es.listener = l
}

func (es *EditorService) notifyBlockCreated(uuid string, blk block.SieveBlock) {
	es.mu.RLock()
	l := es.listener
	es.mu.RUnlock()
	if l != nil {
		serialisedForm := ""
		if processor := block.GetProcessor(blk.Kind); processor != nil {
			serialisedForm, _ = processor.Serialize(blk)
		}
		l.OnBlockCreated(uuid, blk.Kind, blk.ID, blk.Attrs, serialisedForm)
	}
}

func (es *EditorService) notifyBlockUpdated(uuid string, blk block.SieveBlock) {
	es.mu.RLock()
	l := es.listener
	es.mu.RUnlock()
	if l != nil {
		serialisedForm := ""
		if processor := block.GetProcessor(blk.Kind); processor != nil {
			serialisedForm, _ = processor.Serialize(blk)
		}
		l.OnBlockUpdated(uuid, blk.ID, blk.Attrs, serialisedForm)
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
// Open ensures a shadow for uuid (idempotent) and recovers stuck DISPATCHED
// blocks — the user-open path. Background callers that must not trigger recovery
// (a transient open to apply a job result) use open() with recoverStuck=false.
func (es *EditorService) Open(uuid string, notifySaved func()) error {
	return es.open(uuid, notifySaved, true)
}

// open ensures a shadow for uuid. recoverStuck gates stuck-job recovery: a
// transient background open passes false so it does NOT spawn recovery jobs —
// that would both churn (the doc would reopen ~10s later) and RACE the immediate
// Close. Recovery is a user-open concern.
func (es *EditorService) open(uuid string, notifySaved func(), recoverStuck bool) error {
	// Idempotent: reuse an already-open shadow (the HTTP load ensures-open before
	// the WS connection does, so both share ONE identity — minted ids stay
	// stable). Just rewire the post-flush callback for this caller.
	es.mu.Lock()
	if existing, ok := es.shadows[uuid]; ok {
		es.mu.Unlock()
		existing.SetNotifySaved(notifySaved)
		return nil
	}
	es.mu.Unlock()

	doc, err := es.documents.LoadByUUID(uuid)
	if err != nil {
		return err
	}
	// Declare shadow before the closure so the closure can capture the variable.
	var shadow *block.ShadowDocument
	shadow = block.NewShadow(uuid, string(doc.Body()), es.codec, es.debounce, func() {
		// notifySaved is posted inside flushShadow now (every save path notifies),
		// so the debounce closure just flushes.
		_ = es.flushShadow(shadow, "debounce")
	})
	shadow.SetNotifySaved(notifySaved)
	// Handle minting now happens in NewShadow (the constructor invariant: no block
	// without an id) and on every reparse — no separate mint pass needed here.

	es.mu.Lock()
	// Another goroutine may have opened the same uuid between the check above and
	// here; if so, discard ours and reuse theirs (rewiring the callback).
	if existing, ok := es.shadows[uuid]; ok {
		es.mu.Unlock()
		shadow.StopDebounce()
		existing.SetNotifySaved(notifySaved)
		return nil
	}
	es.shadows[uuid] = shadow
	es.mu.Unlock()

	// Reset any DISPATCHED blocks that pre-date this session — they are stuck
	// (server crash or restart). Re-queue them so they run again on reconnect.
	// Skipped for transient background opens (recoverStuck=false): they must not
	// spawn jobs that race the immediate Close.
	if recoverStuck {
		es.resetStuckDispatched(uuid, shadow)
	}

	logger.Info("editor: open", "uuid", uuid, "body_bytes", len(doc.Body()))
	return nil
}

// FrontendBlocks projects the OPEN shadow's authoritative Doc into the wire
// shape the WYSIWYG load renders from — the load-through-shadow path, so the
// client sees the shadow's minted handles (real data-id) and identity is shared.
// Returns false when the uuid has no open shadow.
func (es *EditorService) FrontendBlocks(uuid string) ([]block.FrontendBlock, bool) {
	es.mu.Lock()
	shadow := es.shadows[uuid]
	es.mu.Unlock()
	if shadow == nil {
		return nil, false
	}
	tree := shadow.SnapshotBlocks()
	blocks, err := block.BlockDocToFrontendBlocks(tree)
	if err != nil {
		return nil, false
	}
	return blocks, true
}

// resetStuckDispatched finds DISPATCHED blocks older than dispatchedStuckThreshold
// and resets them to PENDING so DispatchJobIfNeeded will re-run their jobs.
func (es *EditorService) resetStuckDispatched(uuid string, shadow *block.ShadowDocument) {
	stuck := shadow.ResetStuckDispatched(dispatchedStuckThreshold)
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
	shadow.StopDebounce()
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
	shadow.SetMarkdown(markdown)
}

// HandleBlockOp applies a granular wire op (create/update/delete/move) to the
// open document's authoritative block tree and re-arms the autosave debounce.
func (es *EditorService) HandleBlockOp(uuid string, op block.BlockOp) error {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return fmt.Errorf("block-op: no open document for uuid %q", uuid)
	}

	return shadow.ApplyOp(op)
}

// UpdateBlock merges attrs into the named block, creating it if needed.
// kind is only used when creating a new block entry.
func (es *EditorService) UpdateBlock(uuid string, blk block.SieveBlock) {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		logger.Warn("editor: block-update dropped — no shadow", "uuid", uuid, "block", blk.ID)
		return
	}
	shadow.SetBlock(blk)
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
	merged := shadow.ContentForSave() // derives from the tree before the mode switch
	shadow.EnterMarkdownMode(merged)
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
	n := shadow.EnterWysiwygMode()
	logger.Info("editor: enter-wysiwyg", "uuid", uuid, "blocks_reparsed", n)
}

// Flush writes the shadow's ContentForSave to disk via DocumentService.
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

func (es *EditorService) flushShadow(shadow *block.ShadowDocument, source string) error {
	merged := shadow.ContentForSave()
	doc, err := es.documents.LoadByUUID(shadow.UUID)
	if err != nil {
		logger.Warn("editor: flush load failed", "uuid", shadow.UUID, "source", source, "err", err)
		return err
	}
	// DATA-LOSS GUARD: never overwrite a non-empty document with empty content.
	// Empty `merged` here means a failed serialize (deriveMarkdown returns "" on a
	// codec error) or a transient empty markdown-mode buffer — NOT a user genuinely
	// clearing the doc through the tree. Refuse the save so the on-disk content
	// survives; the next good flush persists normally.
	if strings.TrimSpace(merged) == "" && strings.TrimSpace(string(doc.Body())) != "" {
		logger.Warn("editor: REFUSED empty overwrite of non-empty doc (failed serialize/roundtrip)", "uuid", shadow.UUID, "source", source)
		return nil
	}
	doc.SetBody([]byte(merged))
	if _, err = es.documents.Save(doc); err != nil {
		logger.Warn("editor: flush save failed", "uuid", shadow.UUID, "source", source, "err", err)
		return err
	}
	logger.Info("editor: saved", "uuid", shadow.UUID, "source", source, "bytes", len(merged))
	// Post the saved event on EVERY successful save — not just the debounce path.
	// flushShadow is the single chokepoint every saver funnels through (Flush,
	// the debounce closure, FlushAll, applyJobUpdate, PromoteBlock), so notifying
	// here makes "the frontend hears about the save" a property of the save itself.
	// The data-loss-guard early-return above does NOT reach here, so a refused
	// (non-)save correctly posts nothing.
	if ns := shadow.GetNotifySaved(); ns != nil {
		ns()
	}
	return nil
}

// ReloadFromDisk replaces the open shadow's content with the on-disk document,
// reparsed through the codec (so marker ids survive — the frontend can't recover
// them). Used after an OUT-OF-BAND disk change such as a version restore, which
// writes the file behind the shadow's back: without this the stale shadow is both
// served to the editor AND overwrites the restored file on the next flush. No-op
// when the doc isn't open. It does NOT flush — the disk is already authoritative.
func (es *EditorService) ReloadFromDisk(uuid string) error {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return nil
	}
	doc, err := es.documents.LoadByUUID(uuid)
	if err != nil {
		logger.Warn("editor: reload-from-disk load failed", "uuid", uuid, "err", err)
		return err
	}
	shadow.SetMarkdown(string(doc.Body()))
	logger.Info("editor: reloaded shadow from disk", "uuid", uuid, "bytes", len(doc.Body()))
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
	shadows := make([]*block.ShadowDocument, 0, len(es.shadows))
	for _, sh := range es.shadows {
		shadows = append(shadows, sh)
	}
	es.shadows = make(map[string]*block.ShadowDocument)
	es.mu.Unlock()
	logger.Info("editor: close-all", "count", len(shadows))
	for _, sh := range shadows {
		sh.StopDebounce()
		_ = es.flushShadow(sh, "close-all")
	}
}

// SetJobs wires the JobTracker EditorService uses for job-spinner lifecycle.
// Separate from BlockServices (a processor bundle) because no processor needs it.
func (es *EditorService) SetJobs(j *JobTracker) {
	es.jobs = j
}

func (es *EditorService) SetServices(svc block.BlockServices) {
	es.services = svc
}

// CreateBlock is the canonical block creation path for UI-triggered creation
// (keyboard shortcut, toolbar button). Generates a fresh block ID.
func (es *EditorService) CreateBlock(uuid, kind string, overrides map[string]interface{}) (id string, rawYaml string, err error) {
	return es.createBlockWithID(uuid, kind, block.GenerateBlockIDFor(kind), overrides)
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
	processor := block.GetProcessor(kind)
	if processor == nil {
		return "", "", fmt.Errorf("no processor registered for kind %q", kind)
	}
	id = blockID
	attrs := processor.InitAttrs(id, overrides)
	sieveBlock := block.SieveBlock{ID: id, Kind: kind, Attrs: attrs}
	es.UpdateBlock(uuid, sieveBlock)
	rawYaml, err = fencedblock.SerializeYaml[map[string]interface{}](attrs)
	if err != nil {
		return "", "", err
	}

	es.notifyBlockCreated(uuid, sieveBlock)

	return id, rawYaml, nil
}

// HandlePaste runs paste matchers and delegates to CreateBlock on the first match.
// It is the secondary creation path — prefer CreateBlock directly for UI-triggered creation.
func (es *EditorService) HandlePaste(uuid string, entries []block.ContentEntry) (kind, id, rawYaml string, matched bool) {
	matchKind, processor, ok := block.FirstPasteMatch(entries)
	if !ok {
		return "", "", "", false
	}
	blockID := block.GenerateBlockIDFor(matchKind)
	overrides := processor.Transform(entries, uuid, blockID)
	id, raw, err := es.createBlockWithID(uuid, matchKind, blockID, overrides)
	if err != nil {
		return "", "", "", false
	}
	return matchKind, id, raw, true
}

// CreateBlockFromEntries is the extraction creation path. It is identical to Paste
// except the backend skips detection — the frontend explicitly requested this Kind.
func (es *EditorService) CreateBlockFromEntries(uuid, kind string, entries []block.ContentEntry) (id, rawYaml string, err error) {
	processor := block.GetProcessor(kind)
	if processor == nil {
		return "", "", fmt.Errorf("no processor registered for kind %q", kind)
	}

	blockID := block.GenerateBlockIDFor(kind)
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
	sieveBlock := block.SieveBlock{
		ID:    blockID,
		Kind:  kind,
		Attrs: attrs,
	}
	es.UpdateBlock(uuid, sieveBlock)

	processor := block.GetProcessor(kind)
	if processor == nil {
		return
	}

	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return
	}

	// Snapshot the current merged state (user patch + existing attrs) for OnChange.
	snap, ok := shadow.SnapshotBlock(blockID)
	if !ok {
		return
	}
	blkCopy := &block.SieveBlock{ID: snap.ID, Kind: snap.Kind, Attrs: snap.Attrs}
	attrsBefore := make(map[string]interface{}, len(snap.Attrs))
	for k, v := range snap.Attrs {
		attrsBefore[k] = v
	}

	processor.OnChange(blkCopy)

	// Compute which attrs OnChange changed and merge only those back.
	attrsChanged := make(map[string]interface{})
	for k, v := range blkCopy.Attrs {
		if attrsBefore[k] != v {
			attrsChanged[k] = v
		}
	}

	if len(attrsChanged) > 0 {
		shadow.SetBlock(block.SieveBlock{ID: blockID, Kind: kind, Attrs: attrsChanged})
	}

	// Always notify client so it gets the re-computed serialisedForm and UI updates
	if blkFinal, okFinal := shadow.SnapshotBlock(blockID); okFinal {
		es.notifyBlockUpdated(uuid, block.SieveBlock{ID: blockID, Kind: kind, Attrs: blkFinal.Attrs})
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

	// Atomically claim the block (PENDING -> DISPATCHED). If it wasn't PENDING,
	// nothing to do — guarantees the job dispatches exactly once.
	blkCopy, ok := shadow.TryDispatch(blockID)
	if !ok {
		return
	}
	es.notifyBlockUpdated(uuid, blkCopy)

	// Flush state to disk
	_ = es.Flush(uuid)

	go es.RunJob(context.Background(), uuid, blockID)
}

// applyJobUpdate safely applies block updates resulting from a background job.
// ALL mutations flow through the in-memory ShadowDocument — the single update
// path. If the document is closed (no shadow), we open it transiently, apply
// through the same path, then close it (Close flushes to disk with reason "close").
func (es *EditorService) applyJobUpdate(uuid, blockID, kind string, updates map[string]interface{}, deletes []string, flushReason string) {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()

	openedTransiently := false
	if shadow == nil {
		// Document is closed: open it transiently so the update flows through
		// the ShadowDocument. recoverStuck=false — a background open must not spawn
		// recovery jobs that race the Close below. Do NOT hold es.mu across open.
		if err := es.open(uuid, nil, false); err != nil {
			logger.Warn("editor: job update failed to open doc transiently", "uuid", uuid, "err", err)
			return
		}
		openedTransiently = true

		es.mu.RLock()
		shadow = es.shadows[uuid]
		es.mu.RUnlock()
		if shadow == nil {
			logger.Warn("editor: job update shadow missing after transient open", "uuid", uuid)
			return
		}
	}

	if len(updates) > 0 {
		shadow.SetBlock(block.SieveBlock{ID: blockID, Kind: kind, Attrs: updates})
	}
	for _, k := range deletes {
		shadow.DeleteBlockAttr(blockID, k)
	}
	if flushReason != "" {
		_ = es.flushShadow(shadow, flushReason)
	}

	if blk, ok := shadow.SnapshotBlock(blockID); ok {
		es.notifyBlockUpdated(uuid, block.SieveBlock{ID: blockID, Kind: kind, Attrs: blk.Attrs})
	}

	if openedTransiently {
		// Close flushes (reason "close") and removes the shadow from the map.
		es.Close(uuid)
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

	// One lock: a deep copy of the target block (for the processor to mutate) plus
	// an immutable DocView the job uses to resolve any block by id.
	snap, doc, ok := shadow.SnapshotForJob(blockID)
	if !ok {
		return
	}
	kind := snap.Kind
	blkCopy := &block.SieveBlock{ID: snap.ID, Kind: snap.Kind, Attrs: snap.Attrs}
	attrsBefore := make(map[string]interface{}, len(snap.Attrs))
	for k, v := range snap.Attrs {
		attrsBefore[k] = v
	}

	processor := block.GetProcessor(kind)
	if processor == nil {
		return
	}

	label := processor.JobLabel(blkCopy)
	if label != "" && es.jobs != nil {
		es.jobs.Start(JobInfo{
			JobID:   blockID,
			Label:   label,
			DocID:   uuid,
			SpinTab: false,
		})
		defer es.jobs.End(blockID)
	}

	// notify lets the processor push intermediate attr updates mid-job
	// (e.g. push src immediately after saving, before slow AI describe).
	notify := func(bID string, partialAttrs map[string]interface{}) {
		es.applyJobUpdate(uuid, bID, kind, partialAttrs, nil, "job-progress")
	}

	jctx := block.JobContext{
		Ctx:    ctx,
		UUID:   uuid,
		Doc:    doc,
		Block:  blkCopy,
		Notify: notify,
	}
	if err := processor.RunJob(jctx); err != nil {
		es.applyJobUpdate(uuid, blockID, kind, map[string]interface{}{"status": block.BlockStatusError}, nil, "job-complete")
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

	blkCopy, found := shadow.SnapshotBlock(blockID)
	if !found {
		return fmt.Errorf("block not found")
	}
	processor := block.GetProcessor(blkCopy.Kind)
	if processor == nil {
		return fmt.Errorf("processor not found")
	}

	plainContent := processor.MarkdownRepresentation(blkCopy)
	if plainContent == "" {
		return fmt.Errorf("block cannot be promoted")
	}

	// Promote-to-Doc is a Transform-to-Prose: build a prose block carrying the
	// promoted content and the ORIGINAL id via prose's own InitAttrs (the standard
	// block-creation flow — no hand-rolled serialization), then replace the
	// structured block IN PLACE so it keeps its document position. The preserved id
	// is a like-for-like replacement for the retired [!block] anchor (D-r.7 made
	// prose carry its own id), so AI ref chains keep resolving.
	proseProc := block.GetProcessor(block.KindProse)
	if proseProc == nil {
		return fmt.Errorf("prose processor not registered")
	}
	attrs := proseProc.InitAttrs(blockID, map[string]interface{}{"content": plainContent})
	if !shadow.ReplaceBlock(blockID, block.SieveBlock{ID: blockID, Kind: block.KindProse, Attrs: attrs}) {
		return fmt.Errorf("block not found in tree")
	}

	_ = es.Flush(uuid)
	es.notifyBlockPromoted(uuid, blockID, plainContent)
	return nil
}
