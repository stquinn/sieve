package editor

import (
	"sync"
	"time"

	"sieve/logger"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/services"
)

// spellDrainDebounce is how long a document's pending-check queue waits after
// its most recent enqueue before draining. A burst of edits — several ops
// against the same or different blocks in quick succession — collapses into
// one recompute pass per touched block instead of one per op.
const spellDrainDebounce = 600 * time.Millisecond

// spellSuggestionCount is how many replacements a mark offers. The menu shows
// the first few inline and hangs the rest in a flyout, so the number is what a
// reader might still scan once they have looked past the obvious answer — not
// everything within two edits.
const spellSuggestionCount = 8

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

// spellQueue is one open document's liveness state. pending is the set of
// block ids due a recompute at the next drain. hadMarks is the set the LAST
// drain pushed a NON-EMPTY mark set for — it is what lets a later drain tell
// "clean, and already known clean" (nothing to push) apart from "clean, but
// was flagged" (an empty push is the only thing that clears the client's
// squiggle). stop cancels the timer currently armed to drain this queue.
type spellQueue struct {
	pending  map[string]struct{}
	hadMarks map[string]struct{}
	stop     stopFunc
}

// SpellMarksNotifier hears one block's complete mark set. It is an interface
// here for the reason ContainerSavedNotifier is: the thing that pushes lives in
// requesthandlers, far above this package in the DAG, so this package may only
// name the port.
//
// Each call REPLACES what the listener holds for that block — an empty marks
// slice is the clear, and is how a corrected block loses its squiggles.
type SpellMarksNotifier interface {
	SpellMarks(uuid, blockID string, marks []domain.TextMark)
}

// SpellChecker turns an open document's text into spelling marks. It sits
// beside EditorService rather than inside it because spelling is one reader of
// the block-text substrate and not part of the document model: it only ever
// READS a shadow, and mutates nothing there — its own liveness queue (below)
// is the only state it owns.
type SpellChecker struct {
	documents *EditorService
	spell     *services.SpellService
	mu        sync.RWMutex
	notifier  SpellMarksNotifier

	after    afterFunc
	debounce time.Duration

	queueMu sync.Mutex
	queues  map[string]*spellQueue // uuid -> that document's pending-check state
	enabled bool                   // guarded by queueMu, beside the queues the gate empties

	// sendMu serialises WHOLE pushes — the enabled re-check, the hadMarks
	// update and the notifier call as one indivisible act. Both producers take
	// it, and they must: a drain that decided to push while clearAll was between
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

// NewSpellChecker binds a checker to the service that owns the open documents.
// It starts ENABLED; a run whose settings say otherwise is turned off by the
// composition root, which is also what a later flip goes through.
func NewSpellChecker(documents *EditorService, spell *services.SpellService) *SpellChecker {
	return &SpellChecker{
		documents: documents,
		spell:     spell,
		after:     realAfter,
		debounce:  spellDrainDebounce,
		queues:    make(map[string]*spellQueue),
		enabled:   true,
	}
}

// SetEnabled turns checking on or off for the whole workspace and makes every
// open document agree with the new answer at once. Flipping OFF pushes the
// empty set for every block that currently carries marks — the ordinary clear,
// so squiggles vanish everywhere without the client learning a second way to
// forget them. Flipping ON re-seeds each open document through the same path an
// open takes. A flip to what is already true does nothing.
func (sc *SpellChecker) SetEnabled(on bool) {
	sc.queueMu.Lock()
	if sc.enabled == on {
		sc.queueMu.Unlock()
		return
	}
	sc.enabled = on
	sc.queueMu.Unlock()

	if on {
		sc.reseedAll()
		return
	}
	sc.clearAll()
}

// Ignore stops flagging word for the rest of this run; Learn adds it to the
// user's durable dictionary. Both re-seed every open document, because the
// answer they change is not local to the block the word was ignored in: the
// same word squiggling in three documents must stop squiggling in all three.
func (sc *SpellChecker) Ignore(word string) {
	sc.spell.Ignore(word)
	sc.reseedAll()
}

// Learn adds word to the user's durable dictionary and re-seeds. A dictionary
// that could not be written is logged and the word still holds for this run:
// the user asked for the word to be accepted, and failing to persist that is
// not a reason to keep flagging it in front of them.
func (sc *SpellChecker) Learn(word string) {
	if err := sc.spell.Learn(word); err != nil {
		logger.Error("spell: could not persist the user dictionary", "err", err)
	}
	sc.reseedAll()
}

// reseedAll queues every block of every open document, exactly as an open does.
// The suppression rule in drain is what makes this cheap: a block that was
// clean and stays clean sends nothing, and a block whose only mark was the word
// just accepted sends the one empty frame that clears it.
func (sc *SpellChecker) reseedAll() {
	for _, uuid := range sc.documents.openUUIDs() {
		sc.CheckAndPush(uuid)
	}
}

// clearAll tells every open document to forget the marks it holds and drops the
// pending work. It walks hadMarks rather than the whole document: a block that
// was never flagged has nothing to clear, so a workspace with one misspelling
// in it costs one frame to disable.
func (sc *SpellChecker) clearAll() {
	sc.mu.RLock()
	notifier := sc.notifier
	sc.mu.RUnlock()

	sc.sendMu.Lock()
	defer sc.sendMu.Unlock()

	sc.queueMu.Lock()
	type clear struct{ uuid, blockID string }
	var clears []clear
	for uuid, q := range sc.queues {
		if q.stop != nil {
			q.stop()
			q.stop = nil
		}
		q.pending = map[string]struct{}{}
		for blockID := range q.hadMarks {
			clears = append(clears, clear{uuid: uuid, blockID: blockID})
		}
		q.hadMarks = map[string]struct{}{}
	}
	sc.queueMu.Unlock()

	if notifier == nil {
		return
	}
	for _, c := range clears {
		notifier.SpellMarks(c.uuid, c.blockID, []domain.TextMark{})
	}
}

// SetNotifier registers who receives pushed mark sets. Nil leaves CheckAndPush
// with nowhere to send, which is what a caller that only wants CheckDocument gets.
func (sc *SpellChecker) SetNotifier(n SpellMarksNotifier) {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	sc.notifier = n
}

// CheckAndPush seeds uuid's pending-check queue with every block currently in
// the open document — the open-time trigger — through the same enqueue path a
// live op takes. It does not push synchronously:
// the debounced drain that follows is the sole place a spell-marks frame is
// sent, so an open and a burst of typing produce marks the same way, and a
// document that opens clean produces no traffic at all. A uuid with no open
// shadow is a no-op: CheckAndPush runs off the WS read loop in its own
// goroutine, so it routinely arrives after the document closed.
func (sc *SpellChecker) CheckAndPush(uuid string) {
	shadow := sc.documents.shadowFor(uuid)
	if shadow == nil {
		return
	}
	for _, blk := range shadow.SnapshotBlocks() {
		sc.enqueue(uuid, blk.ID)
	}
}

// enqueue marks blockID as due a recompute for uuid and (re)arms the
// document's debounce timer. It is the sole intake to the pending-check queue:
// CheckAndPush's seed and EditorService's post-apply notify hooks both call
// it, and nothing else does. Repeat calls collapse — the queue is a set, and
// each call cancels and reschedules the one pending timer — so a typing burst
// against the same or different blocks drains once, spellDrainDebounce after
// the last enqueue. It is also THE GATE: with checking off nothing is queued,
// so a disabled workspace does no work rather than doing it and discarding it. The cancel-then-rearm runs under one lock hold: two
// enqueues racing from different goroutines (a live op arriving while
// CheckAndPush's seed is still running, say) must not each arm their own
// timer — an afterFunc MUST NOT invoke its callback synchronously, or this
// self-deadlocks against drain's own lock.
func (sc *SpellChecker) enqueue(uuid, blockID string) {
	sc.queueMu.Lock()
	defer sc.queueMu.Unlock()
	if !sc.enabled {
		return
	}
	q, ok := sc.queues[uuid]
	if !ok {
		q = &spellQueue{pending: map[string]struct{}{}, hadMarks: map[string]struct{}{}}
		sc.queues[uuid] = q
	}
	q.pending[blockID] = struct{}{}
	if q.stop != nil {
		q.stop()
	}
	q.stop = sc.after(sc.debounce, func() { sc.drain(uuid) })
}

// closeDocument drops uuid's queue and cancels its timer, if any. Called from
// EditorService.Close: a document that closes mid-debounce must not drain
// after — there is no shadow left to read and no client left to push to.
func (sc *SpellChecker) closeDocument(uuid string) {
	sc.queueMu.Lock()
	defer sc.queueMu.Unlock()
	q, ok := sc.queues[uuid]
	if !ok {
		return
	}
	if q.stop != nil {
		q.stop()
	}
	delete(sc.queues, uuid)
}

// drain is the pending-check queue's one consumer: for every block id queued
// for uuid, recompute its marks and decide whether to push. A block absent
// from the shadow (deleted before the timer fired, or the document closed) is
// skipped silently — closeDocument already dropped the queue in the close
// case, so this is really only the delete-before-drain case. A block that
// bears no text is skipped too: it was queued because SOME op touched it, not
// because it participates.
//
// Among participating blocks: a push fires only when the recomputed set is
// non-empty, or the block was in hadMarks — a correction, pushed once as the
// EMPTY set that clears the client's squiggle. A block that was clean and
// stays clean produces no frame at all, which is what keeps a quiet open, or a
// quiet block within a busy document, silent.
func (sc *SpellChecker) drain(uuid string) {
	sc.queueMu.Lock()
	q, ok := sc.queues[uuid]
	if !ok {
		sc.queueMu.Unlock()
		return
	}
	pending := q.pending
	q.pending = map[string]struct{}{}
	q.stop = nil
	sc.queueMu.Unlock()

	if len(pending) == 0 {
		return
	}
	shadow := sc.documents.shadowFor(uuid)
	if shadow == nil {
		return
	}
	sc.mu.RLock()
	notifier := sc.notifier
	sc.mu.RUnlock()

	for blockID := range pending {
		blk, found := shadow.SnapshotBlock(blockID)
		if !found {
			sc.queueMu.Lock()
			delete(q.hadMarks, blockID)
			sc.queueMu.Unlock()
			continue
		}
		marks, bearsText := sc.checkBlock(blk)
		if !bearsText {
			continue
		}
		if !sc.push(uuid, blockID, q, marks, notifier) {
			return
		}
	}
}

// push settles one block's recomputed marks: whether the frame is warranted,
// what hadMarks now says, and the send itself — all under sendMu, so no clear
// can interleave between the decision and the frame it produces. It reports
// whether checking is still on; false means the drain it was called from is
// obsolete and must abandon the rest of its batch, since clearAll has already
// emptied hadMarks and sent the clears these marks would undo.
func (sc *SpellChecker) push(uuid, blockID string, q *spellQueue, marks []domain.TextMark, notifier SpellMarksNotifier) bool {
	sc.sendMu.Lock()
	defer sc.sendMu.Unlock()

	sc.queueMu.Lock()
	if !sc.enabled {
		sc.queueMu.Unlock()
		return false
	}
	_, wasFlagged := q.hadMarks[blockID]
	if len(marks) == 0 {
		delete(q.hadMarks, blockID)
	} else {
		q.hadMarks[blockID] = struct{}{}
	}
	sc.queueMu.Unlock()

	if len(marks) == 0 && !wasFlagged {
		return true
	}
	if notifier != nil {
		notifier.SpellMarks(uuid, blockID, marks)
	}
	return true
}

// CheckDocument returns the marks for every block of shadow, in document order.
// It is the whole-document read behind CheckAndPush, and the seam a caller that
// wants the marks rather than the push (a test, a future export) uses.
func (sc *SpellChecker) CheckDocument(shadow *block.ShadowDocument) []domain.TextMark {
	if shadow == nil {
		return nil
	}
	var out []domain.TextMark
	for _, blk := range shadow.SnapshotBlocks() {
		marks, _ := sc.checkBlock(blk)
		out = append(out, marks...)
	}
	return out
}

// checkBlock returns blk's marks and whether blk takes part at all. The two
// answers are separate because they mean different things to a pusher: a
// non-participating kind must be left alone, while a participating kind with
// nothing wrong must be told so.
//
// Only prose-class segments are checked — a dictionary lookup over code or a key
// is noise — but every class is walked, so a kind that grows a prose segment
// joins in without a change here.
func (sc *SpellChecker) checkBlock(blk block.SieveBlock) ([]domain.TextMark, bool) {
	bearer, bearsText := block.TextBearerFor(blk.Kind)
	if !bearsText {
		return nil, false
	}
	marks := []domain.TextMark{}
	for _, segment := range sc.normalisedText(bearer, blk) {
		if segment.Class != domain.TextClassProse {
			continue
		}
		// Occurrence is minted over ALL of the segment's word runs, never over
		// the misspelled ones alone: it is resolved by counting every run, so a
		// tally that skipped the words nothing flagged would anchor each mark on
		// an earlier run of the same word.
		occurrence := segment.Occurrences()
		for _, miss := range sc.spell.Check(segment.Text) {
			// A word nothing is close to still travels as an empty list: the
			// frame promises an array, and null is not one.
			suggestions := sc.spell.Suggest(miss.Word, spellSuggestionCount)
			if suggestions == nil {
				suggestions = []string{}
			}
			marks = append(marks, domain.TextMark{
				BlockID:     blk.ID,
				Locator:     segment.Locator,
				Quote:       miss.Word,
				Occurrence:  occurrence[miss.Start],
				Start:       miss.Start,
				End:         miss.End,
				Class:       segment.Class,
				Suggestions: suggestions,
			})
		}
	}
	return marks, true
}

// normalisedText calls bearer.NormalisedText for blk, recovering any panic so a
// bad processor fails only blk's marks — never the caller's whole spell pass,
// and never the process. Same shape as JobEngine.safeWork: a panic crossing
// into third-party processor code is converted to a logged failure instead of
// an unwind, which is what makes CheckAndPush safe to run unsupervised in the
// goroutine ws_handler.go spawns it in.
func (sc *SpellChecker) normalisedText(bearer block.TextBearer, blk block.SieveBlock) (segments []domain.TextSegment) {
	defer func() {
		if r := recover(); r != nil {
			logger.Error("spell: NormalisedText panicked", "kind", blk.Kind, "block", blk.ID, "err", r)
		}
	}()
	return bearer.NormalisedText(&blk)
}
