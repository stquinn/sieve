package editor

import (
	"errors"
	"fmt"
	"reflect"
	"sort"
	"sync"
	"time"

	"sieve/logger"
	"sieve/sieve/block"
	"sieve/sieve/domain"
)

// inspectionDebounce is how long a document's pending-check queue waits after
// its most recent enqueue before draining. A burst of edits — several ops
// against the same or different blocks in quick succession — collapses into
// one recompute pass per touched block instead of one per op.
const inspectionDebounce = 600 * time.Millisecond

// stopFunc cancels a scheduled drain if it has not already run. Calling it
// after the drain ran, or calling a nil stopFunc, is a no-op — the same
// contract as time.Timer.Stop.
type stopFunc func()

// afterFunc schedules f to run once, after d elapses, and returns a stopFunc
// that cancels it. Constructor-injected so a test can replace real time with a
// controllable fake clock instead of sleeping.
type afterFunc func(d time.Duration, f func()) stopFunc

// realAfter is the production afterFunc: an uncontrollable real timer.
func realAfter(d time.Duration, f func()) stopFunc {
	t := time.AfterFunc(d, f)
	return func() { t.Stop() }
}

// Inspector is the whole producer contract: a word naming the feature, and a
// reading of one block's text.
//
// Inspect is handed every segment a block's kind hands out and returns the marks
// it has something to say about — reading only the classes it applies to, and
// leaving the rest walked and skipped. The marks it returns carry NO block id:
// the engine stamps that, because a producer is shown text and not a document.
// Each mark copies its segment's Locator VERBATIM — a locator is the minting
// kind's own opaque payload, and a producer that spelled one would be inventing
// an anchor into bytes it has never seen.
//
// parameters is whatever the feature was enabled with, interpreted by the
// inspector alone. The engine carries it and reads none of it.
type Inspector interface {
	Feature() string
	Inspect(segments []domain.TextSegment, parameters map[string]any) []domain.TextMark
}

// FeatureController is the optional second half of a producer: an inspector
// that acts on its parameters WHEN THEY ARRIVE, rather than only when a drain
// asks what it can see. Registration is unchanged — a producer that implements
// this is a producer with an imperative in its vocabulary, not a second kind of
// registration.
//
// Control is called on the goroutine the control frame arrived on, before the
// enablement is recorded, and it returns the parameters the engine is to
// REMEMBER. That return is how an imperative parameter is CONSUMED: a feature
// acts on it and hands back the state it wants to be left in, so the same frame
// arriving twice acts twice instead of being deduplicated as a repeat of what is
// already true.
//
// The engine reads none of it. What Control does with a parameter, and which
// parameters survive it, is the feature's business alone.
type FeatureController interface {
	Control(uuid string, enabled bool, parameters map[string]any) map[string]any
}

// FeatureScope says where a feature's enablement lives, and so which channel
// controls it: a workspace-scoped feature is one answer for the whole app
// (spelling, bound to a persisted setting), while a document-scoped feature is
// per open document and dies with its channel.
type FeatureScope string

const (
	ScopeWorkspace FeatureScope = "workspace"
	ScopeDocument  FeatureScope = "document"
)

// ErrUnknownFeature refuses a control frame naming a feature nothing registered:
// enabling it would be enabling nothing, silently, forever.
var ErrUnknownFeature = errors.New("no inspector is registered for that feature")

// ErrFeatureScope refuses a control frame that arrived on the wrong channel for
// the feature it names. The channel IS the scope, so a global feature toggled
// from one document would be one document deciding for every other.
var ErrFeatureScope = errors.New("that feature is not controlled from this channel")

// TextMarksNotifier hears one feature's complete mark set for one block. It is
// an interface here for the reason ContainerSavedNotifier is: the thing that
// pushes lives in requesthandlers, far above this package in the DAG, so this
// package may only name the port.
//
// Each call REPLACES what the listener holds for that (feature, block) pair — an
// empty marks slice is the clear, and is how a corrected block loses its
// squiggles without any feature disturbing another's.
type TextMarksNotifier interface {
	TextMarks(uuid, feature, blockID string, marks []domain.TextMark)
}

// markKey names one feature's findings about one block — the grain suppression
// is decided at. Two features flagging the same block are two independent
// answers, and one of them going quiet must not silence the other.
type markKey struct{ feature, blockID string }

// featureKey names one enablement. A workspace-scoped feature is enabled once,
// under the empty uuid; a document-scoped one is enabled per open document.
type featureKey struct{ uuid, feature string }

// inspectionQueue is one open document's liveness state. pending is the set of
// block ids due a recompute at the next drain. hadMarks is the set of
// (feature, block) pairs the LAST drain pushed a NON-EMPTY mark set for — it is
// what lets a later drain tell "clean, and already known clean" (nothing to
// push) apart from "clean, but was flagged" (an empty push is the only thing
// that clears the client's marks). stop cancels the timer currently armed to
// drain this queue.
type inspectionQueue struct {
	pending  map[string]struct{}
	hadMarks map[markKey]struct{}
	stop     stopFunc
}

// activeFeature is one enabled inspector as a drain runs it: the producer and
// the parameters its enablement carried.
type activeFeature struct {
	inspector  Inspector
	parameters map[string]any
}

// registration is one registered producer and where its enablement lives.
type registration struct {
	inspector Inspector
	scope     FeatureScope
}

// InspectionEngine turns an open document's text into marks, for every feature
// that is switched on. It sits beside EditorService rather than inside it
// because inspection is a READER of the block-text substrate and not part of the
// document model: it only ever reads a shadow, and mutates nothing there — the
// registry, the enablement and the liveness queues below are the only state it
// owns.
//
// Registration is participation: a feature exists because an inspector
// registered it, so a control frame naming anything else is refused rather than
// remembered. One shadow walk per drain feeds every enabled inspector, which is
// why a second feature costs a document nothing but its own inspect.
type InspectionEngine struct {
	documents *EditorService

	// mu guards the wiring — the notifier and the registry — both written at
	// composition and read on every drain. It is a LEAF: it is never held while
	// another lock is taken, so it may be taken while holding queueMu.
	mu         sync.RWMutex
	notifier   TextMarksNotifier
	inspectors map[string]registration

	after    afterFunc
	debounce time.Duration

	queueMu sync.Mutex
	queues  map[string]*inspectionQueue // uuid -> that document's pending-check state
	enabled map[featureKey]map[string]any

	// sendMu serialises WHOLE pushes — the enabled re-check, the hadMarks
	// update and the notifier call as one indivisible act. Both producers take
	// it, and they must: a drain that decided to push while a disable was between
	// emptying hadMarks and sending its clears would land its marks after the
	// clear, on a client that is no longer being checked and so will never hear
	// the frame that removes them again.
	//
	// It is a SECOND lock rather than a longer hold of queueMu because a
	// notifier call reaches the WS layer, and an enqueue off the op-apply path
	// must never wait on the network.
	//
	// Lock order is sendMu THEN queueMu, never the reverse.
	sendMu sync.Mutex
}

// NewInspectionEngine binds an engine to the service that owns the open
// documents. Every feature starts OFF: enablement arrives only through
// SetWorkspaceFeature/SetDocumentFeature, so the composition root's persisted
// settings and a live control frame take the same path.
func NewInspectionEngine(documents *EditorService) *InspectionEngine {
	return &InspectionEngine{
		documents:  documents,
		inspectors: make(map[string]registration),
		after:      realAfter,
		debounce:   inspectionDebounce,
		queues:     make(map[string]*inspectionQueue),
		enabled:    make(map[featureKey]map[string]any),
	}
}

// Register admits a producer under the feature word it answers to, scoped to the
// channel that controls it. Registering the same word twice replaces the
// registration, which is what a library switch rebuilding the world wants.
func (e *InspectionEngine) Register(inspector Inspector, scope FeatureScope) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.inspectors[inspector.Feature()] = registration{inspector: inspector, scope: scope}
}

// Features returns the word of every registered producer, sorted. Registration
// is participation, so this IS the set of features that exist: a word the wire
// vocabulary publishes and this does not answer for is a switch nothing serves.
func (e *InspectionEngine) Features() []string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	words := make([]string, 0, len(e.inspectors))
	for feature := range e.inspectors {
		words = append(words, feature)
	}
	sort.Strings(words)
	return words
}

// SetNotifier registers who receives pushed mark sets. Nil leaves the drains
// with nowhere to send.
func (e *InspectionEngine) SetNotifier(n TextMarksNotifier) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.notifier = n
}

// SetWorkspaceFeature turns a workspace-scoped feature on or off for the whole
// app and makes every open document agree at once. Turning one OFF pushes the
// empty set for every block that currently carries its marks — the ordinary
// clear, so what was drawn vanishes everywhere without the client learning a
// second way to forget it. Turning one ON re-seeds each open document through
// the same path an open takes. Re-stating what is already true, parameters
// included, does nothing.
func (e *InspectionEngine) SetWorkspaceFeature(feature string, enabled bool, parameters map[string]any) error {
	return e.setFeature(featureKey{feature: feature}, ScopeWorkspace, enabled, parameters)
}

// SetDocumentFeature turns a document-scoped feature on or off for ONE open
// document. The state is per open channel — a closing document disables its
// features implicitly, and a reconnecting client re-arms by asking again.
func (e *InspectionEngine) SetDocumentFeature(uuid, feature string, enabled bool, parameters map[string]any) error {
	if uuid == "" {
		return fmt.Errorf("feature %q: %w", feature, ErrFeatureScope)
	}
	return e.setFeature(featureKey{uuid: uuid, feature: feature}, ScopeDocument, enabled, parameters)
}

// setFeature is the one enablement path both scopes take: refuse what nothing
// serves, record the new state, then either seed or clear.
func (e *InspectionEngine) setFeature(key featureKey, scope FeatureScope, enabled bool, parameters map[string]any) error {
	reg, known := e.registrationFor(key.feature)
	if !known {
		return fmt.Errorf("feature %q: %w", key.feature, ErrUnknownFeature)
	}
	if reg.scope != scope {
		return fmt.Errorf("feature %q is %s-scoped: %w", key.feature, reg.scope, ErrFeatureScope)
	}
	parameters = e.control(key.uuid, reg.inspector, enabled, parameters)

	e.queueMu.Lock()
	held, was := e.enabled[key]
	if was == enabled && (!enabled || reflect.DeepEqual(held, parameters)) {
		e.queueMu.Unlock()
		return nil
	}
	if enabled {
		e.enabled[key] = parameters
	} else {
		delete(e.enabled, key)
	}
	e.queueMu.Unlock()

	// A feature switching on seeds what it now applies to: one document when the
	// enablement names one, every open document when it speaks for the workspace.
	if enabled {
		if key.uuid != "" {
			e.CheckAndPush(key.uuid)
		} else {
			e.RecheckAll()
		}
		return nil
	}
	e.clear(key.uuid, key.feature)
	return nil
}

// control offers an enablement to a producer that acts on its parameters, and
// returns what the engine is to remember: whatever the producer handed back, or
// the parameters unchanged when it takes no part in this.
//
// A panic leaves the parameters as they arrived and the enablement otherwise
// unaffected — a producer that fails to interpret its own imperative must not
// take the switch that turns it on down with it.
func (e *InspectionEngine) control(uuid string, inspector Inspector, enabled bool, parameters map[string]any) (kept map[string]any) {
	controller, acts := inspector.(FeatureController)
	if !acts {
		return parameters
	}
	defer func() {
		if r := recover(); r != nil {
			logger.Error("inspection: Control panicked", "feature", inspector.Feature(), "uuid", uuid, "err", r)
			kept = parameters
		}
	}()
	return controller.Control(uuid, enabled, parameters)
}

// registrationFor returns what is registered under feature, if anything.
func (e *InspectionEngine) registrationFor(feature string) (registration, bool) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	reg, known := e.inspectors[feature]
	return reg, known
}

// CheckAndPush seeds uuid's pending-check queue with every block currently in
// the open document — the open-time trigger — through the same enqueue path a
// live op takes. It does not push synchronously: the debounced drain that
// follows is the sole place a marks frame is sent, so an open and a burst of
// typing produce marks the same way, and a document that opens clean produces no
// traffic at all. A uuid with no open shadow is a no-op: this runs off the WS
// read loop in its own goroutine, so it routinely arrives after the document
// closed.
func (e *InspectionEngine) CheckAndPush(uuid string) {
	shadow := e.documents.shadowFor(uuid)
	if shadow == nil {
		return
	}
	for _, blk := range shadow.SnapshotBlocks() {
		e.enqueue(uuid, blk.ID)
	}
}

// RecheckAll queues every block of every open document, exactly as an open does.
// It is what a feature-owned verb calls when the answer it changed is not local
// to one document — a word accepted, which must stop being flagged everywhere at
// once.
func (e *InspectionEngine) RecheckAll() {
	for _, uuid := range e.documents.openUUIDs() {
		e.CheckAndPush(uuid)
	}
}

// OnFocusChanged implements FocusListener: the document the user is now looking
// at is re-checked, so a feature switched on while it sat in the background
// catches up the moment it is read again. An empty uuid — focus left the last
// document — asks for nothing.
func (e *InspectionEngine) OnFocusChanged(uuid string) {
	if uuid == "" {
		return
	}
	e.CheckAndPush(uuid)
}

// enqueue marks blockID as due a recompute for uuid and (re)arms the document's
// debounce timer. It is the sole intake to the pending-check queue:
// CheckAndPush's seed and EditorService's post-apply notify hooks both call it,
// and nothing else does. Repeat calls collapse — the queue is a set, and each
// call cancels and reschedules the one pending timer — so a typing burst against
// the same or different blocks drains once, one debounce after the last enqueue.
// It is also THE GATE: a document with no feature enabled queues nothing, so a
// switched-off workspace does no work rather than doing it and discarding it.
// The cancel-then-rearm runs under one lock hold: two enqueues racing from
// different goroutines (a live op arriving while a seed is still running, say)
// must not each arm their own timer — an afterFunc MUST NOT invoke its callback
// synchronously, or this self-deadlocks against drain's own lock.
func (e *InspectionEngine) enqueue(uuid, blockID string) {
	e.queueMu.Lock()
	defer e.queueMu.Unlock()
	if len(e.activeLocked(uuid)) == 0 {
		return
	}
	q, ok := e.queues[uuid]
	if !ok {
		q = &inspectionQueue{pending: map[string]struct{}{}, hadMarks: map[markKey]struct{}{}}
		e.queues[uuid] = q
	}
	q.pending[blockID] = struct{}{}
	if q.stop != nil {
		q.stop()
	}
	q.stop = e.after(e.debounce, func() { e.drain(uuid) })
}

// activeLocked returns the inspectors enabled for uuid — the workspace ones plus
// this document's own — with the parameters each was enabled with. Callers hold
// queueMu.
func (e *InspectionEngine) activeLocked(uuid string) []activeFeature {
	e.mu.RLock()
	defer e.mu.RUnlock()
	var active []activeFeature
	for feature, reg := range e.inspectors {
		key := featureKey{feature: feature}
		if reg.scope == ScopeDocument {
			key.uuid = uuid
		}
		if parameters, on := e.enabled[key]; on {
			active = append(active, activeFeature{inspector: reg.inspector, parameters: parameters})
		}
	}
	return active
}

// closeDocument drops uuid's queue, cancels its timer and forgets every
// document-scoped feature it had switched on. Called from EditorService.Close: a
// document that closes mid-debounce must not drain after — there is no shadow
// left to read and no client left to push to — and a channel close is the
// implicit disable for everything scoped to that channel.
func (e *InspectionEngine) closeDocument(uuid string) {
	e.queueMu.Lock()
	defer e.queueMu.Unlock()
	for key := range e.enabled {
		if key.uuid == uuid {
			delete(e.enabled, key)
		}
	}
	q, ok := e.queues[uuid]
	if !ok {
		return
	}
	if q.stop != nil {
		q.stop()
	}
	delete(e.queues, uuid)
}

// clear tells the documents holding feature's marks to forget them and drops the
// pending work. An empty uuid clears every open document, which is what a
// workspace feature switching off means. It walks hadMarks rather than the whole
// document: a block that was never flagged has nothing to clear, so a workspace
// with one misspelling in it costs one frame to disable.
func (e *InspectionEngine) clear(uuid, feature string) {
	e.mu.RLock()
	notifier := e.notifier
	e.mu.RUnlock()

	e.sendMu.Lock()
	defer e.sendMu.Unlock()

	e.queueMu.Lock()
	type cleared struct{ uuid, blockID string }
	var clears []cleared
	for queued, q := range e.queues {
		if uuid != "" && queued != uuid {
			continue
		}
		// The pending work is dropped only when NOTHING is left watching this
		// document: another feature still switched on has recomputes owed to it,
		// and this disable is not its business.
		if len(e.activeLocked(queued)) == 0 {
			if q.stop != nil {
				q.stop()
				q.stop = nil
			}
			q.pending = map[string]struct{}{}
		}
		for key := range q.hadMarks {
			if key.feature != feature {
				continue
			}
			clears = append(clears, cleared{uuid: queued, blockID: key.blockID})
			delete(q.hadMarks, key)
		}
	}
	e.queueMu.Unlock()

	if notifier == nil {
		return
	}
	for _, c := range clears {
		notifier.TextMarks(c.uuid, feature, c.blockID, []domain.TextMark{})
	}
}

// drain is the pending-check queue's one consumer: for every block id queued for
// uuid, recompute what each enabled feature says about it and decide whether to
// push. A block absent from the shadow (deleted before the timer fired, or the
// document closed) is skipped silently — closeDocument already dropped the queue
// in the close case, so this is really only the delete-before-drain case. A
// block that bears no text is skipped too: it was queued because SOME op touched
// it, not because it participates.
//
// ONE READING FEEDS EVERY FEATURE. The block's segments are minted once and
// handed to each enabled inspector, so a second producer costs the walk nothing.
//
// Among participating blocks: a push fires only when the recomputed set is
// non-empty, or that feature had marks on the block — a correction, pushed once
// as the EMPTY set that clears them. A block that was clean and stays clean
// produces no frame at all, which is what keeps a quiet open, or a quiet block
// within a busy document, silent.
func (e *InspectionEngine) drain(uuid string) {
	e.queueMu.Lock()
	q, ok := e.queues[uuid]
	if !ok {
		e.queueMu.Unlock()
		return
	}
	pending := q.pending
	q.pending = map[string]struct{}{}
	q.stop = nil
	active := e.activeLocked(uuid)
	e.queueMu.Unlock()

	if len(pending) == 0 || len(active) == 0 {
		return
	}
	shadow := e.documents.shadowFor(uuid)
	if shadow == nil {
		return
	}
	e.mu.RLock()
	notifier := e.notifier
	e.mu.RUnlock()

	// A feature switched off mid-drain has already had its clears sent, so the
	// rest of this batch's marks for it would arrive after the clear that was
	// meant to be the client's last word. Every OTHER feature carries on.
	abandoned := map[string]bool{}
	for blockID := range pending {
		blk, found := shadow.SnapshotBlock(blockID)
		if !found {
			e.forget(q, blockID)
			continue
		}
		segments, bearsText := e.documents.readingOf(blk)
		if !bearsText {
			continue
		}
		for _, feature := range active {
			word := feature.inspector.Feature()
			if abandoned[word] {
				continue
			}
			if !e.push(uuid, word, blockID, q, e.inspect(feature, segments, blk), notifier) {
				abandoned[word] = true
			}
		}
	}
}

// forget drops every feature's memory of a block that is no longer in the
// document. Nothing is pushed: the block itself is gone, and what was drawn on
// it went with it.
func (e *InspectionEngine) forget(q *inspectionQueue, blockID string) {
	e.queueMu.Lock()
	defer e.queueMu.Unlock()
	for key := range q.hadMarks {
		if key.blockID == blockID {
			delete(q.hadMarks, key)
		}
	}
}

// push settles one feature's recomputed marks for one block: whether the frame
// is warranted, what hadMarks now says, and the send itself — all under sendMu,
// so no clear can interleave between the decision and the frame it produces. It
// reports whether that feature is still on; false means the marks it was called
// with are obsolete, since a disable has already emptied hadMarks and sent the
// clears they would undo.
func (e *InspectionEngine) push(uuid, feature, blockID string, q *inspectionQueue, marks []domain.TextMark, notifier TextMarksNotifier) bool {
	e.sendMu.Lock()
	defer e.sendMu.Unlock()

	key := markKey{feature: feature, blockID: blockID}
	e.queueMu.Lock()
	if !e.enabledLocked(uuid, feature) {
		e.queueMu.Unlock()
		return false
	}
	_, wasFlagged := q.hadMarks[key]
	if len(marks) == 0 {
		delete(q.hadMarks, key)
	} else {
		q.hadMarks[key] = struct{}{}
	}
	e.queueMu.Unlock()

	if len(marks) == 0 && !wasFlagged {
		return true
	}
	if notifier != nil {
		notifier.TextMarks(uuid, feature, blockID, marks)
	}
	return true
}

// enabledLocked reports whether feature is on for uuid, under either scope.
// Callers hold queueMu.
func (e *InspectionEngine) enabledLocked(uuid, feature string) bool {
	if _, on := e.enabled[featureKey{feature: feature}]; on {
		return true
	}
	_, on := e.enabled[featureKey{uuid: uuid, feature: feature}]
	return on
}

// inspect runs one producer over a block's reading and stamps the block id onto
// what it found — the one thing a producer cannot say for itself, since it is
// shown text rather than a document.
//
// A panic is recovered so a bad producer costs that block its marks and nothing
// else: this runs unsupervised in a timer goroutine, where an unwind would take
// the process rather than the request.
func (e *InspectionEngine) inspect(feature activeFeature, segments []domain.TextSegment, blk block.SieveBlock) (marks []domain.TextMark) {
	defer func() {
		if r := recover(); r != nil {
			logger.Error("inspection: Inspect panicked", "feature", feature.inspector.Feature(), "block", blk.ID, "err", r)
			marks = []domain.TextMark{}
		}
	}()
	found := feature.inspector.Inspect(segments, feature.parameters)
	marks = make([]domain.TextMark, 0, len(found))
	for _, m := range found {
		m.BlockID = blk.ID
		marks = append(marks, m)
	}
	return marks
}
