package editor

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"time"

	"sieve/ident"
	"sieve/logger"
	"sieve/sieve/ai"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/fencedblock"
	"sieve/sieve/services"
)

// docFiler is the synchronous filing surface EditorService's document-lifecycle
// jobs call. The concrete *ai.AIService satisfies it (SetAI stores one); a test
// injects a fake to observe the engine-bounded fan-out without a real CLI. This
// mirrors the seam the retired AIService.fileOnClose field used to provide —
// relocated onto the type that now owns the job lifecycle.
type docFiler interface {
	EvaluateAndFileDoc(id string, fileAfter, allowDiscard bool) (ai.FilingOutcome, error)
}

// ContainerSavedNotifier hears that a container's content reached disk. It is an
// interface here because the publisher is the workspace broadcast, which lives
// in requesthandlers — far above this package in the DAG — and because a save is
// a fact about a container rather than a message to one client: whoever tells
// the world is the composition root's choice, not this service's.
type ContainerSavedNotifier interface {
	ContainerSaved(uuid string, version int)
}

// FocusListener hears which open document the user is reading. The empty uuid
// means the focused document has gone away and nothing has taken its place.
//
// It is a lifecycle cue for whoever derives something FROM the open document a
// reader is actually looking at — the inspection engine re-checks it — and
// never a request to change the document.
type FocusListener interface {
	OnFocusChanged(uuid string)
}

// EditorService is the Go-side editor model. It holds one ShadowDocument per
// open document and coordinates all save operations. DocumentService owns disk.
type EditorService struct {
	documents  *services.DocumentService
	codec      *block.DocumentCodec
	services   block.BlockServices
	jobs       *services.JobTracker // not a processor concern; EditorService tracks job spinners directly
	engine     *services.JobEngine
	ai         docFiler // synchronous AI brain; document-lifecycle jobs call it inside their Work
	debounce   time.Duration
	mu         sync.RWMutex
	shadows    map[string]*block.ShadowDocument
	listener   block.BlockLifecycleListener
	saved      ContainerSavedNotifier
	inspection *InspectionEngine // observed after every op lands on a shadow; nil is a no-op (most tests never wire inspection)
	// focused is the document the user is reading right now, and focusListener
	// hears it change. Both are volatile run state, guarded by mu like the rest.
	focused       string
	focusListener FocusListener
	clipboard     NativeClipboardPort // reads the OS clipboard the webview cannot (#87)
	pendingDrops  PendingDropSource   // the native drop bucket the webview cannot see (#86)
	// jobsWG tracks every dispatched block-job goroutine (DispatchJobIfNeeded's
	// `go RunJob`). It is the drain a retiring service (CloseAll) and callers that
	// must settle dispatched work (WaitForJobs) wait on — a job's completion writes
	// a flush to disk, so "the goroutine returned" is the only safe "the write
	// finished" signal.
	jobsWG sync.WaitGroup
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

// SetSavedNotifier registers who publishes the container-saved fact. Nil leaves
// saves unannounced, which is what a test that does not care about the fact gets.
func (es *EditorService) SetSavedNotifier(n ContainerSavedNotifier) {
	es.mu.Lock()
	defer es.mu.Unlock()
	es.saved = n
}

// SetInspectionEngine registers the engine observed after every op lands on a
// shadow (notifyBlockCreated/Updated/Replaced) and closed alongside a document
// (Close). Nil leaves those hooks a no-op, which is what a test that never
// wires inspection gets.
func (es *EditorService) SetInspectionEngine(e *InspectionEngine) {
	es.mu.Lock()
	defer es.mu.Unlock()
	es.inspection = e
}

// SetFocusListener registers who hears which document the user is looking at.
func (es *EditorService) SetFocusListener(l FocusListener) {
	es.mu.Lock()
	defer es.mu.Unlock()
	es.focusListener = l
}

// SetFocusedDocument records that the user is now reading uuid, and tells
// whoever is listening. Re-stating the document already focused says nothing.
//
// This is VOLATILE: it is where the eyes are in THIS run, not domain.Session's
// persisted last-active tab, which survives a restart and answers a different
// question ("what should open"). A document whose channel goes away is no longer
// focused — Close clears it — so nothing here outlives the socket it came from.
func (es *EditorService) SetFocusedDocument(uuid string) {
	es.mu.Lock()
	if es.focused == uuid {
		es.mu.Unlock()
		return
	}
	es.focused = uuid
	listener := es.focusListener
	es.mu.Unlock()
	if listener != nil {
		listener.OnFocusChanged(uuid)
	}
}

// clearFocus forgets uuid if it is the focused document, and tells whoever is
// listening that nothing is focused now.
func (es *EditorService) clearFocus(uuid string) {
	es.mu.Lock()
	if es.focused != uuid {
		es.mu.Unlock()
		return
	}
	es.focused = ""
	listener := es.focusListener
	es.mu.Unlock()
	if listener != nil {
		listener.OnFocusChanged("")
	}
}

// FocusedDocument returns the document the user is reading, or empty when the
// last focused one has closed.
func (es *EditorService) FocusedDocument() string {
	es.mu.RLock()
	defer es.mu.RUnlock()
	return es.focused
}

// notifySaved publishes the one fact a successful save produces. It is called
// from flushShadow — the single chokepoint every document write funnels through
// — so explicit flush, debounce autosave, a finished job's write and close-time
// flush all announce the same thing in the same words. version is the one the
// store stamped on THIS write, which is what makes the fact orderable against
// the state a waiting client already knew.
func (es *EditorService) notifySaved(uuid string, version int) {
	es.mu.RLock()
	n := es.saved
	es.mu.RUnlock()
	if n != nil {
		n.ContainerSaved(uuid, version)
	}
}

func (es *EditorService) notifyBlockCreated(uuid string, blk block.SieveBlock, index int) {
	es.mu.RLock()
	l := es.listener
	inspection := es.inspection
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
		l.OnBlockCreated(uuid, blk.Kind, blk.ID, blk.Attrs, markdown, index)
	}
	if inspection != nil {
		inspection.enqueue(uuid, blk.ID)
	}
}

func (es *EditorService) notifyBlockUpdated(uuid string, blk block.SieveBlock) {
	es.mu.RLock()
	l := es.listener
	inspection := es.inspection
	es.mu.RUnlock()
	if l != nil {
		l.OnBlockUpdated(uuid, blk.ID, blk.Attrs)
	}
	if inspection != nil {
		inspection.enqueue(uuid, blk.ID)
	}
}

func (es *EditorService) notifyBlockReplaced(uuid, oldID string, blk block.SieveBlock) {
	es.mu.RLock()
	l := es.listener
	inspection := es.inspection
	es.mu.RUnlock()
	if l != nil {
		markdown := ""
		if processor := block.GetProcessor(blk.Kind); processor != nil {
			markdown, _ = processor.Serialize(blk)
		}
		l.OnBlockReplaced(uuid, oldID, blk.Kind, blk.ID, blk.Attrs, markdown)
	}
	if inspection != nil {
		inspection.enqueue(uuid, blk.ID)
	}
}

func (es *EditorService) notifyBlockRemoved(uuid, blockID string) {
	es.mu.RLock()
	l := es.listener
	es.mu.RUnlock()
	if l != nil {
		l.OnBlockRemoved(uuid, blockID)
	}
}

// notifyOrderChanged announces a reorder. order is read back from the shadow
// AFTER the op applied rather than taken from the op: the op is a request, and
// what the client has to follow is what the document now holds.
func (es *EditorService) notifyOrderChanged(uuid string, order []string) {
	es.mu.RLock()
	l := es.listener
	es.mu.RUnlock()
	if l != nil {
		l.OnOrderChanged(uuid, order)
	}
}

// dispatchedStuckThreshold is how old a DISPATCHED block must be before it is
// assumed stuck (server crash, OOM) and reset to PENDING on reconnect.
const dispatchedStuckThreshold = 10 * time.Minute

// Open ensures a shadow for uuid (idempotent) and recovers stuck DISPATCHED
// blocks — the user-open path. Background callers that must not trigger recovery
// (a transient open to apply a job result) use open() with recoverStuck=false.
func (es *EditorService) Open(uuid string) error {
	return es.open(uuid, true)
}

// open ensures a shadow for uuid. recoverStuck gates stuck-job recovery: a
// transient background open passes false so it does NOT spawn recovery jobs —
// that would both churn (the doc would reopen ~10s later) and RACE the immediate
// Close. Recovery is a user-open concern.
func (es *EditorService) open(uuid string, recoverStuck bool) error {
	// Idempotent: reuse an already-open shadow, so every caller for a uuid shares
	// ONE identity and minted ids stay stable.
	es.mu.Lock()
	if _, ok := es.shadows[uuid]; ok {
		es.mu.Unlock()
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
		_ = es.flushShadow(shadow, "debounce")
	})
	// Handle minting now happens in NewShadow (the constructor invariant: no block
	// without an id) and on every reparse — no separate mint pass needed here.

	es.mu.Lock()
	// Another goroutine may have opened the same uuid between the check above and
	// here; if so, discard ours and reuse theirs.
	if _, ok := es.shadows[uuid]; ok {
		es.mu.Unlock()
		shadow.StopDebounce()
		return nil
	}
	es.shadows[uuid] = shadow
	es.mu.Unlock()

	// A document whose block ids were just upgraded (#75) owes disk a rewrite NOW,
	// not whenever the autosave next fires: until it lands, a reopen would mint
	// different ids, so any address taken from this document — including a block id
	// captured by a dispatched job — would stop resolving.
	if shadow.MigratedOnLoad() {
		if err := es.flushShadow(shadow, "identity-migration"); err != nil {
			logger.Warn("editor: identity migration failed to persist", "uuid", uuid, "err", err)
		}
	}

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

// shadowFor returns uuid's open shadow, or nil. It is the read a same-package
// collaborator (the spell checker) takes instead of touching es.shadows, so the
// map and its lock stay this type's alone.
func (es *EditorService) shadowFor(uuid string) *block.ShadowDocument {
	es.mu.RLock()
	defer es.mu.RUnlock()
	return es.shadows[uuid]
}

// openUUIDs returns the documents currently open, in no order. It is the same
// same-package read as shadowFor, for a collaborator that must act on ALL of
// them — the spell checker answering a workspace-wide change of mind about a
// word. A uuid closed between this read and the act on it is a no-op there.
func (es *EditorService) openUUIDs() []string {
	es.mu.RLock()
	defer es.mu.RUnlock()
	uuids := make([]string, 0, len(es.shadows))
	for uuid := range es.shadows {
		uuids = append(uuids, uuid)
	}
	return uuids
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
	inspection := es.inspection
	es.mu.Unlock()

	// Dropping the inspection queue is unconditional: a seed runs off the WS
	// read loop in its own goroutine and can still be mid-walk when a fast
	// open+close races it — this must not leave a queue behind for a shadow
	// that no longer exists.
	if inspection != nil {
		inspection.closeDocument(uuid)
	}
	// A document nobody can see is not the one being read. Clearing here rather
	// than on a frame is what makes the teardown the single truth: the channel
	// going away IS the focus ending.
	es.clearFocus(uuid)

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
		// The wire states a create's position as an Anchor; this is the boundary that
		// resolves it against the authoritative tree, so everything below works in
		// resolved indices.
		op.Index = es.ResolveAnchor(uuid, op.Anchor)
		// Every kind-bearing create runs the one lifecycle (InitAttrs → positioned
		// insert → job dispatch → render-back insert-block). The client ignores a
		// render-back for a node it already has, so prose needs no special path. A
		// kind-less op can't run the lifecycle (no processor) — it falls through to
		// the plain tree insert below.
		if op.Kind != "" {
			id := op.BlockID
			if id == "" {
				id = ident.New()
			}
			_, _, err := es.createBlock(uuid, op.Kind, id, op.Attrs, op.Aliases, op.Index, true)
			return err
		}
		// A kind-less create falls through to the plain tree insert below, which
		// cannot run the lifecycle. It still carries an id from somewhere, so it
		// gets the same scrutiny every named id gets.
		if err := es.validateClientID(uuid, op.BlockID); err != nil {
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
	if err := shadow.ApplyOp(op); err != nil {
		return err
	}
	// Every mutation echoes, so a client that follows this document rather than
	// leading it can be told (#96). These ops are applied here and nowhere else in
	// Go, so this is their only emission point — a transform keeps the slot and
	// says so with a replace-block instead. A removal needs no accompanying
	// order-changed: losing the id IS the order change, and two events for one
	// mutation is two repaints.
	switch op.Type {
	case "delete-block":
		es.notifyBlockRemoved(uuid, op.BlockID)
	case "set-order", "move", "reorder":
		es.notifyOrderChanged(uuid, shadow.BlockIDs())
	}
	return nil
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

// ReplaceText applies one anchored text edit to a block and returns what
// happened. It is the write half of the text substrate: the client points at a
// run it saw — a spelling mark, later anything else that names text — and asks
// for it to be replaced.
//
// The processor that owns the payload resolves the anchor and rewrites its own
// text; the result then goes through mergeAndReact, the SAME merge every other
// granular mutation takes, so this edit marks the document dirty, runs the
// processor's OnChange and re-queues the block for spelling exactly as a
// client-sent update-block would.
//
// IT RENDERS BACK BY REPLACEMENT, not as an attrs merge. The edit is
// client-INSTIGATED but server-EXECUTED — the species a paste and a transform
// belong to — so the block Go now holds is the authoritative one and the client
// PLACES it. An attrs merge would say the opposite: that the client's copy of
// the text is still the current one and only some attrs moved. The identity is
// unchanged, so both ids on the render-back are this block's.
//
// A stale anchor comes back as block.ErrTextStale, and nothing was changed.
//
// The processor takes a BATCH, and this is the batch of one.
func (es *EditorService) ReplaceText(uuid string, edit domain.TextEdit) error {
	return es.ReplaceTextBatch(uuid, edit.BlockID, []domain.TextEdit{edit})
}

// ReplaceTextBatch applies several anchored edits to ONE block as a single
// write: the processor resolves every anchor against one reading before any of
// them is written, and the result reaches the document as one merge, one echo
// and one undo step.
//
// It is ALL-OR-NOTHING. One anchor that no longer resolves fails the batch and
// leaves the block exactly as it was, because the alternative — writing the
// edits that did resolve — would hand back a block half-way through an act the
// caller asked for whole.
//
// The batch is why a caller replacing many runs must not loop the single-edit
// form: the first write moves the text every later anchor was read against, so
// a loop stales itself after its first success.
//
// It is as marks-blind as its batch-of-one sibling: a domain.TextEdit names a
// run, and nothing here can tell which producer — or whether any producer — put
// a mark on it.
func (es *EditorService) ReplaceTextBatch(uuid, blockID string, edits []domain.TextEdit) error {
	if len(edits) == 0 {
		return nil
	}
	shadow := es.shadowFor(uuid)
	if shadow == nil {
		return fmt.Errorf("text-replace: no open document for uuid %q", uuid)
	}
	blk, found := shadow.SnapshotBlock(blockID)
	if !found {
		return fmt.Errorf("text-replace: no block %q in document %q", blockID, uuid)
	}
	updater, writable := block.TextUpdaterFor(blk.Kind)
	if !writable {
		return fmt.Errorf("text-replace: kind %q does not accept text edits", blk.Kind)
	}
	if err := es.updateText(updater, &blk, edits); err != nil {
		return err
	}
	// blk is a deep snapshot, so the processor wrote into a copy: the merge below
	// is what puts the edit in the document. Passing the whole payload is safe —
	// a merge is additive, and every key not rewritten merges back as itself.
	merged, present, err := es.mergeAndReact(uuid, block.BlockOp{
		Type:    "update-block",
		BlockID: blk.ID,
		Kind:    blk.Kind,
		Attrs:   blk.Attrs,
	})
	if err != nil || !present {
		return err
	}
	es.notifyBlockReplaced(uuid, merged.ID, merged)
	es.DispatchJobIfNeeded(uuid, merged.ID)
	return nil
}

// updateText calls the processor, recovering any panic so a bad processor costs
// the caller an error rather than the process. Same containment as the spell
// checker's read of NormalisedText: this runs on the WS read loop, where an
// unrecovered panic takes down more than the request that caused it.
func (es *EditorService) updateText(updater block.TextUpdater, blk *block.SieveBlock, edits []domain.TextEdit) (err error) {
	defer func() {
		if r := recover(); r != nil {
			logger.Error("editor: UpdateText panicked", "kind", blk.Kind, "block", blk.ID, "err", r)
			err = fmt.Errorf("text-replace: processor %q panicked", blk.Kind)
		}
	}()
	return updater.UpdateText(blk, edits)
}

// readingOf returns blk's kind's own reading of its text, and whether the kind
// bears text at all. A processor that panics costs its caller the reading and
// nothing else: this is called from the WS read loop and from timer goroutines
// alike, where an unrecovered panic takes down more than the read that caused
// it.
func (es *EditorService) readingOf(blk block.SieveBlock) (segments []domain.TextSegment, bearsText bool) {
	bearer, bearsText := block.TextBearerFor(blk.Kind)
	if !bearsText {
		return nil, false
	}
	defer func() {
		if r := recover(); r != nil {
			logger.Error("editor: NormalisedText panicked", "kind", blk.Kind, "block", blk.ID, "err", r)
			segments = nil
		}
	}()
	return bearer.NormalisedText(&blk), true
}

// ExportMarkdown derives CLEAN whole-doc markdown for "Copy as Markdown" from the
// LIVE shadow: every block surviving the CALLER's filter renders via its
// MarkdownRepresentation (NOT the on-disk Serialize). The exclusion policy belongs
// to the call site, which passes a closure (nil exports everything); this service
// only resolves the shadow and delegates. Returns an error when the document is
// not open.
func (es *EditorService) ExportMarkdown(uuid string, filter block.BlockFilter) (string, error) {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return "", fmt.Errorf("export-markdown: no open document for uuid %q", uuid)
	}
	return shadow.ExportMarkdown(filter), nil
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
	prior := len(shadow.BlockIDs())
	n := shadow.EnterWysiwygMode()
	// A tree that held blocks and re-parses into none came from a buffer that no
	// longer states the document. The tree is replaced regardless — the buffer is
	// this mode's truth — and only the flush guard then keeps the emptiness off
	// disk, so nothing else in the log says the document was lost.
	if n == 0 && prior > 0 {
		logger.Warn("editor: enter-wysiwyg re-parsed nothing over a document that held blocks",
			"uuid", uuid, "prior_blocks", prior)
	}
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
		saved, err := es.documents.Save(doc)
		if err != nil {
			logger.Warn("editor: flush save failed", "uuid", shadow.UUID, "source", source, "err", err)
			return err
		}
		logger.Info("editor: saved", "uuid", shadow.UUID, "source", source, "bytes", len(merged), "version", saved.Meta().Version())
		// Publish the fact on EVERY successful save — not just the debounce path.
		// flushShadow is the single chokepoint every saver funnels through (Flush,
		// the debounce closure, FlushAll, applyJobUpdate), so announcing here makes
		// "the world hears about the save" a property of the save itself. Neither
		// early return above reaches this line, so a failed write and a refused
		// (data-loss-guard) one both announce nothing — the document stays dirty.
		es.notifySaved(shadow.UUID, saved.Meta().Version())
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
	inspection := es.inspection
	es.mu.Unlock()
	logger.Info("editor: close-all", "count", len(shadows))
	for _, sh := range shadows {
		// Dropping the inspection queue is unconditional for the same reason
		// Close's is: nil only when the field is unwired (tests).
		if inspection != nil {
			inspection.closeDocument(sh.UUID)
		}
		es.clearFocus(sh.UUID)
		sh.StopDebounce()
		_ = es.flushShadow(sh, "close-all")
	}
	// Drain in-flight job goroutines. Retiring the service (e.g. a library switch)
	// must not leave a completing job writing a flush against the store we are
	// abandoning — that would leak the old handle and race the successor. StopDebounce
	// above already set closed=true on every dropped shadow, so a late job flush cannot
	// re-arm a timer; here we simply wait for the flush itself to finish.
	es.jobsWG.Wait()
}

// SetJobs wires the JobTracker EditorService uses for job-spinner lifecycle.
// Separate from BlockServices (a processor bundle) because no processor needs it.
func (es *EditorService) SetJobs(j *services.JobTracker) {
	es.jobs = j
}

// SetEngine injects the communal job engine. Post-construction (like SetJobs) so
// the root can build it after the JobTracker (which main() wires up) exists, and
// so the ~25 test constructors need no change.
func (es *EditorService) SetEngine(e *services.JobEngine) { es.engine = e }

// SetAI injects the synchronous AI brain. Post-construction (like SetEngine) so
// the root can wire it after Init. The document-lifecycle entries below call its
// sync methods inside a JobDescriptor.Work — the engine (not AIService) owns all
// concurrency now.
func (es *EditorService) SetAI(a *ai.AIService) { es.ai = a }

// ── Document-lifecycle jobs ─────────────────────────────────────────────────
//
// These submit document (not block) filing work to the communal engine's ai
// pool. They are the new home of what AIService.EvaluateOnClose used to do: the
// pool's worker count now bounds close-time filing concurrency (the retired
// local semaphore). Every JobDescriptor sets a non-empty Meta.Label — the status
// bar keys off it. Document jobs go through es.engine.Submit directly (not
// submitBlockJob, which is block-shaped).

// closeFilingAllowed gates automatic close-time filing to the Smart tier,
// exactly as AIService.EvaluateOnClose did (dumb mode = no CLI, so a close must
// not auto-file/discard). State is nil only in tests that bypass wiring; there we
// proceed so the fan-out is exercised.
func (es *EditorService) closeFilingAllowed() bool {
	if es.services.State == nil {
		return true
	}
	return es.services.State.LoadSettings().Tier() == domain.TierSmart
}

// submitDocFiling builds and submits one document filing JobDescriptor. label
// must be non-empty. Filing failure is non-fatal — it is logged, never surfaced.
func (es *EditorService) submitDocFiling(id, jobPrefix, label string, fileAfter, allowDiscard, spinTab bool) {
	es.engine.Submit(services.JobDescriptor{
		Category: block.CategoryAI,
		Meta:     domain.JobInfo{JobID: jobPrefix + id, Label: label, DocID: id, SpinTab: spinTab},
		Work:     func() (any, error) { return es.ai.EvaluateAndFileDoc(id, fileAfter, allowDiscard) },
		OnError: func(err error) {
			logger.Warn("editor: document filing failed", "job", jobPrefix+id, "uuid", id, "err", err)
		},
	})
}

// alreadyFiled reports whether id names a document that has already been promoted
// to the Library (a Note). Close-time smart filing skips these: re-running the AI
// evaluation on an already-filed note wastes a CLI call and never changes its
// filed state. A load error (unknown/deleted uuid, or a test with a synthetic id)
// returns false so a legitimate unfiled buffer is never silently skipped. Only the
// CLOSE paths consult this — explicit user file actions (FileDocument/KeepAndFile/
// UpdateMetadata) deliberately re-evaluate filed notes.
func (es *EditorService) alreadyFiled(id string) bool {
	if es.documents == nil {
		return false
	}
	doc, err := es.documents.LoadByUUID(id)
	if err != nil {
		return false
	}
	return doc.Kind() == domain.KindNote
}

// CloseAllAndFile evaluates + files every closing document on the ai worker pool.
// Replaces AIService.EvaluateOnClose/runCloseFiling for the "Close All Tabs" path:
// the local semaphore folds into the engine's ai pool. Every UNFILED closing doc
// is still evaluated on close (the close-files-nothing regression stays fixed);
// already-filed notes are skipped — re-filing a Note on close is wasted AI work.
func (es *EditorService) CloseAllAndFile(ids []string) {
	if !es.closeFilingAllowed() {
		return
	}
	for _, id := range ids {
		if es.alreadyFiled(id) {
			continue
		}
		es.submitDocFiling(id, "file:", "Filing…", true, true, false)
	}
}

// CloseDocument flushes the open shadow (so the latest content is on disk) then
// submits one close-time filing job. Replaces AIService.EvaluateOnClose(id) for
// the single-tab HTTP close path. Flush no-ops when the doc is not open. An
// already-filed note is flushed but NOT re-filed — smart filing on close is only
// for unfiled buffers.
func (es *EditorService) CloseDocument(id string) {
	if !es.closeFilingAllowed() {
		return
	}
	_ = es.Flush(id)
	if es.alreadyFiled(id) {
		return
	}
	es.submitDocFiling(id, "file:", "Filing…", true, true, false)
}

// FileDocument submits an explicit "file this note" user action (evaluate + file,
// no discard). Unlike CloseDocument this is NOT tier-gated: the user explicitly
// asked for it. Routed through the engine's ai pool like every other filing job.
func (es *EditorService) FileDocument(id string) {
	es.submitDocFiling(id, "file:", "Filing note…", true, false, true)
}

// UpdateMetadata submits an explicit metadata-only evaluation (no file, no
// discard). Not tier-gated — the user asked for it directly.
func (es *EditorService) UpdateMetadata(id string) {
	es.submitDocFiling(id, "meta:", "Updating metadata…", false, false, true)
}

// KeepAndFile files a note the user explicitly kept (evaluate + file, no discard).
// Not tier-gated. The user_intent="keep" write stays in the handler (user-owned).
func (es *EditorService) KeepAndFile(uuid string) {
	es.submitDocFiling(uuid, "file:", "Filing note…", true, false, true)
}

// submitBlockJob turns a block ProcessorJob into a JobDescriptor and submits it
// to the communal engine, guaranteeing Apply-before-finish and finish-once. The
// wrap lives here because Apply and onDone (the attr-diff/shadow merge) operate
// on EditorService-owned data. onDone is the caller's finish closure.
//
// INVARIANT: every submitted job has a non-empty Label — a nil DescribeJob is
// never submitted, and a non-nil ProcessorJob is real async work that MUST label
// itself for the status bar. An empty Label is a processor programming error.
func (es *EditorService) submitBlockJob(job block.ProcessorJob, meta domain.JobInfo, blk *block.SieveBlock, onDone func(err error)) {
	if meta.Label == "" {
		panic(fmt.Sprintf("submitBlockJob: block %q (kind via meta) has an empty Label — a submitted ProcessorJob must declare a non-empty Label", meta.JobID))
	}
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
	return es.createBlockWithID(uuid, kind, ident.New(), overrides, nil, index)
}

// validateClientID is the server's whole job on the identity of a block it did
// not name (issue #96). A UUIDv7 is unique without coordination, so a block born
// in a lens can carry the durable id it will keep — Go stops being the sole MINTER
// and becomes the sole VALIDATOR. There are exactly two ways a given name is not
// acceptable, and both are refusals rather than corrections: a silently-substituted
// id would leave the client addressing a block that no longer answers to it.
//
//	MALFORMED  — anything that is not the canonical UUID form. ident.Valid is the
//	             one predicate, shared with the client, so both ends agree about
//	             what an id even is.
//	TAKEN      — this document already holds it. Adopting it would merge two
//	             blocks the client believes are distinct.
//
// An empty id is not a client id at all (Go is about to mint one) and passes.
func (es *EditorService) validateClientID(uuid, blockID string) error {
	if blockID == "" {
		return nil
	}
	if !ident.Valid(blockID) {
		return fmt.Errorf("create-block: refusing malformed block id %q", blockID)
	}
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return fmt.Errorf("create-block: no open document for uuid %q", uuid)
	}
	if _, taken := shadow.SnapshotBlock(blockID); taken {
		return fmt.Errorf("create-block: block id %q is already in document %q", blockID, uuid)
	}
	return nil
}

// ResolveAnchor turns a wire anchor into the top-level index a new block takes in
// uuid's tree — the one translation between how the wire names a position (by the
// block it follows) and how every creation path here takes one (an int). A
// document nobody has open resolves to block.AppendIndex, as does an anchor
// naming a block the document does not hold; block.Anchor says why.
func (es *EditorService) ResolveAnchor(uuid string, anchor block.Anchor) int {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return block.AppendIndex
	}
	return shadow.ResolveAnchor(anchor)
}

// createBlockWithID creates a block using a caller-supplied ID at a caller-supplied
// document index. Used by HandlePaste so the pre-generated ID (passed to PasteMatch)
// is reused. index is the position among top-level blocks; block.AppendIndex — any
// negative index — appends, and one past the end clamps there. The block is inserted through the SAME
// create-block op as every other create — no separate append path.
func (es *EditorService) createBlockWithID(uuid, kind, blockID string, overrides map[string]interface{}, aliases []string, index int) (id string, rawYaml string, err error) {
	return es.createBlock(uuid, kind, blockID, overrides, aliases, index, true)
}

// createBlock is the one creation primitive. notify controls the WS render-back
// (insert-block): true for all create paths (the frontend inserts the new block
// positionally as a tracked PM transaction, preserving undo). aliases carries the
// block's lineage when a create op brings it (usually nil — lineage normally accrues
// via gc/merge).
func (es *EditorService) createBlock(uuid, kind, blockID string, overrides map[string]interface{}, aliases []string, index int, notify bool) (id string, rawYaml string, err error) {
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
	if err = es.validateClientID(uuid, blockID); err != nil {
		return "", "", err
	}
	processor := block.GetProcessor(kind)
	if processor == nil {
		return "", "", fmt.Errorf("no processor registered for kind %q", kind)
	}
	id = blockID
	attrs := processor.InitAttrs(id, overrides)
	sieveBlock := block.SieveBlock{ID: id, Kind: kind, Attrs: attrs, Aliases: aliases}
	if err = shadow.ApplyOp(block.BlockOp{Type: "create-block", BlockID: id, Kind: kind, Attrs: attrs, Aliases: aliases, Index: index}); err != nil {
		return "", "", err
	}
	rawYaml, err = fencedblock.SerializeYaml[map[string]interface{}](attrs)
	if err != nil {
		return "", "", err
	}

	if notify {
		// The render-back states where the block ACTUALLY landed, which an append does
		// not know going in: the client places the server's node at the index coming
		// back, so it must be a real position and never a sentinel.
		es.notifyBlockCreated(uuid, sieveBlock, shadow.IndexOfBlock(id))
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
		// Only a block outcome has something to render back. An item that claims no
		// kind (or that is nothing but a link, which paste turns into inline content
		// with nowhere to go in a block batch) is skipped, as the no-match case
		// always was.
		res := es.HandlePaste(uuid, entries, index+i)
		if !res.IsBlock() {
			logger.Warn("paste-slice: item produced no block", "uuid", uuid, "outcome", res.Outcome)
			continue
		}
		if blk, found := shadow.SnapshotBlock(res.ID); found {
			created = append(created, block.FrontendBlock{ID: blk.ID, Kind: blk.Kind, Attrs: blk.Attrs, Aliases: blk.Aliases})
		}
	}
	return created, nil
}

// HandlePaste runs paste matchers and delegates to CreateBlock on the first match.
// The created block renders back via insert-block (tracked insert at its index) —
// no separate softReloadContent needed. It is the secondary creation path; prefer
// CreateBlock directly for UI-triggered creation.
//
// The result says what the paste DID, not merely whether a matcher fired: a block
// was created, Go composed content for the caret, or Sieve did nothing and the
// frontend replays the clipboard itself.
func (es *EditorService) HandlePaste(uuid string, entries []block.ContentEntry, index int) block.PasteResult {
	matchKind, processor, fromDetection, ok := block.FirstPasteMatch(entries)
	if !ok {
		// No kind claims it. Views that are nothing but a hyperlink still get the one
		// smart a link keeps — its title — as ordinary content (#67); everything else
		// is not a Sieve concern.
		return block.NewLinkPaste(es.services.LinkPreview).Result(entries)
	}
	blockID := ident.New()
	overrides := processor.Transform(entries, uuid, blockID, block.ActionPaste)
	if fromDetection {
		if overrides == nil {
			overrides = map[string]interface{}{}
		}
		overrides["smartPaste"] = true
	}
	id, raw, err := es.createBlockWithID(uuid, matchKind, blockID, overrides, nil, index)
	if err != nil {
		logger.Warn("paste: create failed", "uuid", uuid, "kind", matchKind, "error", err)
		return block.PasteNothing()
	}
	return block.PasteBlock(matchKind, id, raw)
}

// DetectExtractions composes the offer set for a source in this document. It is the
// document-scoped half of block.DetectExtractions: content a source merely HOLDS
// lives in the document directory, so only a caller that knows the uuid can put it
// in front of the recognisers.
func (es *EditorService) DetectExtractions(uuid, sourceKind string, entries []block.ContentEntry) []block.SupportedActions {
	return block.DetectExtractions(sourceKind, block.MaterialiseEntries(uuid, entries))
}

// CreateBlockFromEntries applies a recognised action. PASTE/EXTRACT create a new block;
// TRANSFORM replaces sourceID in place (preserving its document position). The frontend
// posted the operation — the backend does not re-derive it. For TRANSFORM, sourceID is
// the id of the top-level block being replaced (native nodes are prose blocks with ids).
//
// sourceID is also the POSITION: an additive extract lands directly after the block
// it came from, so the caller states no index. An empty or unknown sourceID appends.
func (es *EditorService) CreateBlockFromEntries(uuid, kind string, entries []block.ContentEntry, action block.Action, sourceID string) (id, rawYaml string, err error) {
	processor := block.GetProcessor(kind)
	if processor == nil {
		return "", "", fmt.Errorf("no processor registered for kind %q", kind)
	}
	// The offer being played back may have stood on content a source is holding, so
	// the playback must see exactly what detection saw.
	entries = block.MaterialiseEntries(uuid, entries)

	if action == block.ActionTransform || action == block.ActionUndoSmartPaste {
		return es.transformInPlace(uuid, kind, processor, entries, sourceID, action)
	}

	blockID := ident.New()
	overrides := processor.Transform(entries, uuid, blockID, action)
	if overrides == nil {
		return "", "", fmt.Errorf("%s: processor %q could not transform entries into a block", action, kind)
	}
	index := es.ResolveAnchor(uuid, block.Anchor{AfterBlockID: sourceID})
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
// (prose/code/diagram/log): merge the patch into the live tree, let the processor
// react, notify the client with the merged result, and dispatch any job the change
// moved to PENDING. The per-kind behaviour lives entirely in the processor
// (OnChange/RunJob) — this orchestration never branches on kind. Reached only
// through HandleBlockOp's update-block case (block-op is the single granular
// mutation path).
//
// It renders back as an ATTRS MERGE, the render-back for a change the client is
// already holding the result of: it sent the op. A mutation Go itself executed
// renders back by replacement instead — see ReplaceText.
func (es *EditorService) applyBlockUpdate(uuid string, op block.BlockOp) error {
	blk, present, err := es.mergeAndReact(uuid, op)
	if err != nil || !present {
		return err
	}
	es.notifyBlockUpdated(uuid, blk)
	es.DispatchJobIfNeeded(uuid, op.BlockID)
	return nil
}

// mergeAndReact is the half of a granular mutation that every caller shares:
// merge the patch into the live tree (attrs additive, aliases replaced when
// present), let the processor react via OnChange, and merge back only what
// OnChange itself changed. It returns the block as it now stands — what a caller
// renders back, on whichever lane it chooses.
//
// present is false when there is nothing to render back at all: no processor is
// registered for the kind, or the block did not survive the merge.
func (es *EditorService) mergeAndReact(uuid string, op block.BlockOp) (blk block.SieveBlock, present bool, err error) {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return block.SieveBlock{}, false, fmt.Errorf("update-block: no open document for uuid %q", uuid)
	}

	// Prose's body is just Attrs["content"], merged like any other key — no
	// kind-special handling.
	shadow.MergeBlock(block.SieveBlock{ID: op.BlockID, Kind: op.Kind, Attrs: op.Attrs, Aliases: op.Aliases})

	processor := block.GetProcessor(op.Kind)
	if processor == nil {
		return block.SieveBlock{}, false, nil
	}

	// Snapshot the merged state (patch + existing attrs) for OnChange, then merge
	// back only what OnChange itself changed.
	snap, ok := shadow.SnapshotBlock(op.BlockID)
	if !ok {
		return block.SieveBlock{}, false, nil
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

	blkFinal, okFinal := shadow.SnapshotBlock(op.BlockID)
	if !okFinal {
		return block.SieveBlock{}, false, nil
	}
	return block.SieveBlock{ID: op.BlockID, Kind: op.Kind, Attrs: blkFinal.Attrs}, true, nil
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

	// Track the goroutine so a retiring service / a WaitForJobs caller can block
	// until the job (and the flush its completion writes) has fully finished.
	es.jobsWG.Add(1)
	go func() {
		defer es.jobsWG.Done()
		es.RunJob(context.Background(), uuid, blockID)
	}()
}

// WaitForJobs blocks until every dispatched block-job goroutine has fully
// returned — INCLUDING the flush a completing job writes to disk. It is the
// settle seam: a caller (or a test before TempDir cleanup) that needs dispatched
// work to be durably on disk waits here. It does NOT stop the autosave debounce
// timer — that is Close/CloseAll's concern.
func (es *EditorService) WaitForJobs() {
	es.jobsWG.Wait()
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
		if err := es.open(uuid, false); err != nil {
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
	// A nil *ProcessorJob means "no async work for this block". Such blocks are
	// created COMPLETE by their processor's InitAttrs (the settle-at-creation rule),
	// so there is nothing to do here — never submit, never settle at runtime.
	if job == nil {
		return
	}

	// finish runs after Work (+Apply on success). It merges the attr delta the
	// job produced into the shadow through the single update path, or on error sets
	// the UNIFORM framework error state ({status, error}) — TIMEOUT vs ERROR — so no
	// processor writes error-rendering code.
	finish := func(err error) {
		if err != nil {
			es.applyJobUpdate(uuid, blockID, kind, map[string]interface{}{
				"status": es.classifyJobError(err),
				"error":  err.Error(),
			}, nil, "job-complete")
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

	meta := domain.JobInfo{JobID: blockID, Label: job.Label, DocID: uuid, SpinTab: false}

	if es.engine != nil {
		es.submitBlockJob(*job, meta, blkCopy, finish)
		return
	}

	// Fallback for tests where no engine is wired: run the job inline, preserving
	// Apply-before-finish and finish-once. A submitted job always has non-nil Work.
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

// classifyJobError maps a job's Work error to the uniform terminal status the
// framework writes for every block kind: BlockStatusTimeout when the failure is a
// deadline/timeout (either a wrapped context.DeadlineExceeded or the CLI's
// "cli timeout after N seconds" string, which does not wrap it), else
// BlockStatusError. Processors never classify errors themselves.
func (es *EditorService) classifyJobError(err error) string {
	if errors.Is(err, context.DeadlineExceeded) || strings.Contains(strings.ToLower(err.Error()), "timeout") {
		return block.BlockStatusTimeout
	}
	return block.BlockStatusError
}
