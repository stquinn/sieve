package editor

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
	"sieve/sieve/services"
)

// EditorService is the Go-side editor model. It holds one ShadowDocument per
// open document and coordinates all save operations. DocumentService owns disk.
type EditorService struct {
	documents *services.DocumentService
	codec     *block.DocumentCodec
	services  block.BlockServices
	jobs      *services.JobTracker // not a processor concern; EditorService tracks job spinners directly
	engine    *services.JobEngine
	debounce  time.Duration
	mu        sync.RWMutex
	shadows   map[string]*block.ShadowDocument
	listener  block.BlockLifecycleListener
}

// NewEditorService creates an EditorService backed by the given DocumentService.
// codec owns document serialization/deserialization; debounce controls the
// autosave delay (pass 0 to use the default 30s).
func NewEditorService(documents *services.DocumentService, codec *block.DocumentCodec, debounce time.Duration) *EditorService {
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

func (es *EditorService) notifyBlockCreated(uuid string, blk block.SieveBlock, index int, token string) {
	es.mu.RLock()
	l := es.listener
	es.mu.RUnlock()
	if l != nil {
		// markdown is the block's serialized fence — used ONLY by the breakglass
		// markdown-mode editor (a verbatim buffer); the WYSIWYG client renders from
		// attrs. Empty for a kind with no processor. index is the block's document
		// position so the render-back lands in the right place (a slice creates many).
		markdown := ""
		if processor := block.GetProcessor(blk.Kind); processor != nil {
			markdown, _ = processor.Serialize(blk)
		}
		l.OnBlockCreated(uuid, blk.Kind, blk.ID, blk.Attrs, markdown, index, token)
	}
}

func (es *EditorService) notifyBlockUpdated(uuid string, blk block.SieveBlock) {
	es.mu.RLock()
	l := es.listener
	es.mu.RUnlock()
	if l != nil {
		l.OnBlockUpdated(uuid, blk.ID, blk.Attrs)
	}
}

func (es *EditorService) notifyBlockReplaced(uuid, oldID string, blk block.SieveBlock) {
	es.mu.RLock()
	l := es.listener
	es.mu.RUnlock()
	if l != nil {
		markdown := ""
		if processor := block.GetProcessor(blk.Kind); processor != nil {
			markdown, _ = processor.Serialize(blk)
		}
		l.OnBlockReplaced(uuid, oldID, blk.Kind, blk.ID, blk.Attrs, markdown)
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
// open document's authoritative block tree. It is THE single mutation path —
// create/update/delete are not separate messages. Create is uniform for EVERY
// kind (prose included): the one create lifecycle (InitAttrs → positioned insert →
// job dispatch → render-back). The backend does NOT branch on kind — "the editor
// already holds this node" is the client's concern (it suppresses the redundant
// insert: insert-if-absent), not the backend's. delete/move/update are pure tree
// mutations.
func (es *EditorService) HandleBlockOp(uuid string, op block.BlockOp) error {
	switch op.Type {
	case "create-block":
		// Every kind-bearing create runs the one lifecycle (InitAttrs → positioned
		// insert → job dispatch → render-back insert-block). The client ignores a
		// render-back for a node it already has, so prose needs no special path. A
		// kind-less op can't run the lifecycle (no processor) — it falls through to
		// the plain tree insert below.
		if op.Kind != "" {
			id := op.BlockID
			if id == "" {
				id = block.GenerateBlockIDFor(op.Kind)
			}
			_, _, err := es.createBlock(uuid, op.Kind, id, op.Attrs, op.Aliases, op.Index, true, op.Token)
			return err
		}
	case "update-block":
		// Update is uniform for EVERY kind (prose included): merge the patch, run the
		// processor's OnChange, notify, dispatch any job. The per-kind behaviour lives
		// in the processor — this path does not branch on kind.
		return es.applyBlockUpdate(uuid, op)
	}

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
	shadow.MergeBlock(blk)
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
	// Serialize whole-document writes per shadow: concurrent flushes (a background
	// job / the debounce timer / Close) otherwise race the store's shared buffer.
	// The slow disk I/O runs under flushMu only — the brief tree snapshot
	// (ContentForSave) takes the shadow's mu, so editing is not blocked by saves.
	return shadow.WithFlushLock(func() error {
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
		// the debounce closure, FlushAll, applyJobUpdate), so notifying
		// here makes "the frontend hears about the save" a property of the save itself.
		// The data-loss-guard early-return above does NOT reach here, so a refused
		// (non-)save correctly posts nothing.
		if ns := shadow.GetNotifySaved(); ns != nil {
			ns()
		}
		return nil
	})
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
func (es *EditorService) SetJobs(j *services.JobTracker) {
	es.jobs = j
}

// SetEngine injects the communal job engine. Post-construction (like SetJobs) so
// the root can build it after the hub-wired JobTracker exists, and so the ~25
// test constructors need no change.
func (es *EditorService) SetEngine(e *services.JobEngine) { es.engine = e }

// submitBlockJob turns a block ProcessorJob into a JobDescriptor and submits it
// to the communal engine, guaranteeing Apply-before-finish and finish-once. The
// wrap lives here because Apply and onDone (the attr-diff/shadow merge) operate
// on EditorService-owned data. onDone is the caller's finish closure.
func (es *EditorService) submitBlockJob(job block.ProcessorJob, meta services.JobInfo, blk *block.SieveBlock, onDone func(err error)) {
	es.engine.Submit(services.JobDescriptor{
		Category: job.Category,
		Meta:     meta,
		Work:     job.Work,
		OnFinished: func(result any) {
			if job.Apply != nil {
				job.Apply(result, blk)
			}
			onDone(nil)
		},
		OnError: func(err error) { onDone(err) },
	})
}

func (es *EditorService) SetServices(svc block.BlockServices) {
	es.services = svc
}

// CreateBlock is the canonical block creation path for UI-triggered creation
// (keyboard shortcut, toolbar button). Generates a fresh block ID.
func (es *EditorService) CreateBlock(uuid, kind string, overrides map[string]interface{}, index int) (id string, rawYaml string, err error) {
	return es.createBlockWithID(uuid, kind, block.GenerateBlockIDFor(kind), overrides, nil, index)
}

// createBlockWithID creates a block using a caller-supplied ID at a caller-supplied
// document index. Used by HandlePaste so the pre-generated ID (passed to PasteMatch)
// is reused. index is the position among top-level blocks; a negative index appends
// (out-of-range indices clamp to the end). The block is inserted through the SAME
// create-block op as every other create — no separate append path.
func (es *EditorService) createBlockWithID(uuid, kind, blockID string, overrides map[string]interface{}, aliases []string, index int) (id string, rawYaml string, err error) {
	return es.createBlock(uuid, kind, blockID, overrides, aliases, index, true, "")
}

// createBlock is the one creation primitive. notify controls the WS render-back
// (insert-block): true for all create paths (the frontend inserts the new block
// positionally as a tracked PM transaction, preserving undo). aliases carries the
// block's lineage when a create op brings it (usually nil — lineage normally accrues
// via gc/merge).
func (es *EditorService) createBlock(uuid, kind, blockID string, overrides map[string]interface{}, aliases []string, index int, notify bool, token string) (id string, rawYaml string, err error) {
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
	sieveBlock := block.SieveBlock{ID: id, Kind: kind, Attrs: attrs, Aliases: aliases}
	if index < 0 {
		index = 1 << 30 // append: insertBlockAt clamps an out-of-range index to the end
	}
	if err = shadow.ApplyOp(block.BlockOp{Type: "create-block", BlockID: id, Kind: kind, Attrs: attrs, Aliases: aliases, Index: index}); err != nil {
		return "", "", err
	}
	rawYaml, err = fencedblock.SerializeYaml[map[string]interface{}](attrs)
	if err != nil {
		return "", "", err
	}

	if notify {
		es.notifyBlockCreated(uuid, sieveBlock, index, token)
	}

	return id, rawYaml, nil
}

// HandlePasteSlice reconstructs a copied multi-block selection server-side. The
// slice is an ordered list of per-block ContentEntry sets (a sequence of "normal
// pastes"). Each item is paste-matched (prose claims its sieve/prose terminally),
// Transformed, and created at cursorIndex+i with a fresh backend id — so the whole
// selection round-trips into Go's tree, positioned, ids and all. Returns the created
// blocks in order for the frontend to render in one batch (no per-block WS push).
func (es *EditorService) HandlePasteSlice(uuid string, slice [][]block.ContentEntry, index int) ([]block.FrontendBlock, error) {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return nil, fmt.Errorf("paste-slice: no open document for uuid %q", uuid)
	}
	if index < 0 {
		index = len(shadow.SnapshotBlocks())
	}
	var created []block.FrontendBlock
	for i, entries := range slice {
		// Each created block renders back via insert-block (tracked insert at its index),
		// so the frontend renders the whole batch positionally without a full reload.
		kind, id, _, ok := es.HandlePaste(uuid, entries, index+i)
		if !ok {
			logger.Warn("paste-slice: create failed", "uuid", uuid, "kind", kind)
			continue
		}
		if blk, found := shadow.SnapshotBlock(id); found {
			created = append(created, block.FrontendBlock{ID: blk.ID, Kind: blk.Kind, Attrs: blk.Attrs, Aliases: blk.Aliases})
		}
	}
	return created, nil
}

// HandlePaste runs paste matchers and delegates to CreateBlock on the first match.
// The created block renders back via insert-block (tracked insert at its index) —
// no separate softReloadContent needed. It is the secondary creation path; prefer
// CreateBlock directly for UI-triggered creation.
func (es *EditorService) HandlePaste(uuid string, entries []block.ContentEntry, index int) (kind, id, rawYaml string, matched bool) {
	matchKind, processor, fromDetection, ok := block.FirstPasteMatch(entries)
	if !ok {
		return "", "", "", false
	}
	blockID := block.GenerateBlockIDFor(matchKind)
	overrides := processor.Transform(entries, uuid, blockID, block.ActionPaste)
	if fromDetection {
		if overrides == nil {
			overrides = map[string]interface{}{}
		}
		overrides["smartPaste"] = true
	}
	id, raw, err := es.createBlockWithID(uuid, matchKind, blockID, overrides, nil, index)
	if err != nil {
		return "", "", "", false
	}
	return matchKind, id, raw, true
}

// CreateBlockFromEntries applies a recognised action. PASTE/EXTRACT create a new block;
// TRANSFORM replaces sourceID in place (preserving its document position). The frontend
// posted the operation — the backend does not re-derive it. For TRANSFORM, sourceID is
// the id of the top-level block being replaced (native nodes are prose blocks with ids).
func (es *EditorService) CreateBlockFromEntries(uuid, kind string, entries []block.ContentEntry, index int, action block.Action, sourceID string) (id, rawYaml string, err error) {
	processor := block.GetProcessor(kind)
	if processor == nil {
		return "", "", fmt.Errorf("no processor registered for kind %q", kind)
	}

	if action == block.ActionTransform || action == block.ActionUndoSmartPaste {
		return es.transformInPlace(uuid, kind, processor, entries, sourceID, action)
	}

	blockID := block.GenerateBlockIDFor(kind)
	overrides := processor.Transform(entries, uuid, blockID, action)
	if overrides == nil {
		return "", "", fmt.Errorf("%s: processor %q could not transform entries into a block", action, kind)
	}
	return es.createBlockWithID(uuid, kind, blockID, overrides, nil, index)
}

// transformInPlace replaces sourceID with a new block of kind, preserving the source's
// id and document position (the OpTransform definition).
func (es *EditorService) transformInPlace(uuid, kind string, processor block.BlockProcessor, entries []block.ContentEntry, sourceID string, action block.Action) (id, rawYaml string, err error) {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return "", "", fmt.Errorf("transform: no open document for uuid %q", uuid)
	}
	if sourceID == "" {
		return "", "", fmt.Errorf("transform: no source block id")
	}
	overrides := processor.Transform(entries, uuid, sourceID, action)
	if overrides == nil {
		return "", "", fmt.Errorf("transform: processor %q could not transform entries", kind)
	}
	attrs := processor.InitAttrs(sourceID, overrides)
	newBlock := block.SieveBlock{ID: sourceID, Kind: kind, Attrs: attrs}
	if !shadow.ReplaceBlock(sourceID, newBlock) {
		return "", "", fmt.Errorf("transform: source block %q not found", sourceID)
	}
	rawYaml, err = fencedblock.SerializeYaml[map[string]interface{}](attrs)
	if err != nil {
		return "", "", err
	}
	es.notifyBlockReplaced(uuid, sourceID, newBlock)
	es.DispatchJobIfNeeded(uuid, sourceID)
	return sourceID, rawYaml, nil
}

// applyBlockUpdate is THE uniform update path, run identically for every kind
// (prose/code/diagram/log): merge the patch into the live tree (attrs additive,
// aliases replaced when present), let the processor react via OnChange, notify the
// client with the merged result, and dispatch any job the change moved to PENDING.
// The per-kind behaviour lives entirely in the processor (OnChange/RunJob) — this
// orchestration never branches on kind. Reached only through HandleBlockOp's
// update-block case (block-op is the single granular mutation path).
func (es *EditorService) applyBlockUpdate(uuid string, op block.BlockOp) error {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return fmt.Errorf("update-block: no open document for uuid %q", uuid)
	}

	// Merge the patch (attrs + aliases) into the live tree. Prose's body is just
	// Attrs["content"], merged like any other key — no kind-special handling.
	shadow.MergeBlock(block.SieveBlock{ID: op.BlockID, Kind: op.Kind, Attrs: op.Attrs, Aliases: op.Aliases})

	processor := block.GetProcessor(op.Kind)
	if processor == nil {
		return nil
	}

	// Snapshot the merged state (patch + existing attrs) for OnChange, then merge
	// back only what OnChange itself changed.
	snap, ok := shadow.SnapshotBlock(op.BlockID)
	if !ok {
		return nil
	}
	blkCopy := &block.SieveBlock{ID: snap.ID, Kind: snap.Kind, Attrs: snap.Attrs}
	attrsBefore := make(map[string]interface{}, len(snap.Attrs))
	for k, v := range snap.Attrs {
		attrsBefore[k] = v
	}

	processor.OnChange(blkCopy)

	attrsChanged := make(map[string]interface{})
	for k, v := range blkCopy.Attrs {
		if attrsBefore[k] != v {
			attrsChanged[k] = v
		}
	}
	if len(attrsChanged) > 0 {
		shadow.MergeBlock(block.SieveBlock{ID: op.BlockID, Kind: op.Kind, Attrs: attrsChanged})
	}

	// Always notify so the client gets the merged + OnChanged attrs.
	if blkFinal, okFinal := shadow.SnapshotBlock(op.BlockID); okFinal {
		es.notifyBlockUpdated(uuid, block.SieveBlock{ID: op.BlockID, Kind: op.Kind, Attrs: blkFinal.Attrs})
	}

	es.DispatchJobIfNeeded(uuid, op.BlockID)
	return nil
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
		shadow.MergeBlock(block.SieveBlock{ID: blockID, Kind: kind, Attrs: updates})
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

// RunJob asks the block's processor to DESCRIBE its job (DescribeJob), then routes
// it through the communal engine via submitBlockJob. The framework owns the
// lifecycle: the engine runs Work on a per-Category worker pool and drives the job
// tracker via meta; on success it runs the processor's Apply against blkCopy, then
// the finish closure diffs blkCopy vs the pre-job snapshot and merges the delta into
// the shadow (applyJobUpdate). On error the finish closure sets status=ERROR — the
// framework's uniform error handling, so no processor writes tracking/finish code.
func (es *EditorService) RunJob(ctx context.Context, uuid, blockID string) {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return
	}

	// One lock: a deep copy of the target block (for Apply to mutate) plus an
	// immutable DocView the job uses to resolve any block by id.
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

	// notify lets the processor push intermediate attr updates mid-job
	// (e.g. push src immediately after saving, before slow AI describe).
	notify := func(bID string, partialAttrs map[string]interface{}) {
		es.applyJobUpdate(uuid, bID, kind, partialAttrs, nil, "job-progress")
	}

	job := processor.DescribeJob(block.JobContext{
		Ctx:    ctx,
		UUID:   uuid,
		Doc:    doc,
		Block:  blkCopy,
		Notify: notify,
	})
	// A zero ProcessorJob means "no job for this block".
	if job.Category == "" && job.Work == nil && job.Apply == nil {
		return
	}

	// finish runs after Work (+Apply on success). It merges the attr delta the
	// job produced (or sets status=ERROR) into the shadow through the single
	// update path.
	finish := func(err error) {
		if err != nil {
			es.applyJobUpdate(uuid, blockID, kind, map[string]interface{}{"status": block.BlockStatusError}, nil, "job-complete")
			return
		}
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

	meta := services.JobInfo{JobID: blockID, Label: job.Label, DocID: uuid, SpinTab: false}

	if es.engine != nil {
		es.submitBlockJob(job, meta, blkCopy, finish)
		return
	}

	// Fallback for tests where no engine is wired: run the job inline, preserving
	// Apply-before-finish and finish-once.
	if job.Work != nil {
		r, e := job.Work()
		if e != nil {
			finish(e)
			return
		}
		if job.Apply != nil {
			job.Apply(r, blkCopy)
		}
	} else if job.Apply != nil {
		job.Apply(nil, blkCopy)
	}
	finish(nil)
}

