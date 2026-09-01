package editor

import (
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/services"
)

// Real uuids: NewShadow upgrades any non-uuid handle it parses, so a test that
// names its blocks must seed ids the loader will leave alone.
const (
	proseA = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01"
	proseB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b02"
	probeC = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b03"
)

// recordedMarks is one SpellMarks call. The notifier records rather than
// asserts, so a test can check both what was pushed and what was NOT.
type recordedMarks struct {
	uuid    string
	blockID string
	marks   []domain.TextMark
}

type recordingNotifier struct {
	mu  sync.Mutex
	got []recordedMarks

	// gate, when set, PARKS every push of a non-empty set after the first until
	// the channel is closed — the seam a test uses to hold a drain inside its
	// push and stage what a concurrent producer does around it. arrivals counts
	// calls as they ENTER, before the park, so a test can wait for a push to
	// arrive without waiting for it to complete.
	gate     chan struct{}
	arrivals int
}

func (n *recordingNotifier) SpellMarks(uuid, blockID string, marks []domain.TextMark) {
	n.mu.Lock()
	n.arrivals++
	gate := n.gate
	park := gate != nil && len(marks) > 0 && n.arrivals > 1
	n.mu.Unlock()
	if park {
		<-gate
	}

	n.mu.Lock()
	defer n.mu.Unlock()
	n.got = append(n.got, recordedMarks{uuid: uuid, blockID: blockID, marks: marks})
}

// arrived is how many pushes have STARTED, parked ones included.
func (n *recordingNotifier) arrived() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.arrivals
}

func (n *recordingNotifier) forBlock(blockID string) ([]domain.TextMark, bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, r := range n.got {
		if r.blockID == blockID {
			return r.marks, true
		}
	}
	return nil, false
}

// forBlockAll returns every push recorded for blockID, in call order — used
// where a test cares that a SECOND push (a correction's clear) followed a
// first, not just that some push happened.
func (n *recordingNotifier) forBlockAll(blockID string) [][]domain.TextMark {
	n.mu.Lock()
	defer n.mu.Unlock()
	var out [][]domain.TextMark
	for _, r := range n.got {
		if r.blockID == blockID {
			out = append(out, r.marks)
		}
	}
	return out
}

// forDocument returns every push recorded for one document, in call order. A
// workspace-wide change is only proven by which DOCUMENT heard what.
func (n *recordingNotifier) forDocument(uuid string) []recordedMarks {
	n.mu.Lock()
	defer n.mu.Unlock()
	var out []recordedMarks
	for _, r := range n.got {
		if r.uuid == uuid {
			out = append(out, r)
		}
	}
	return out
}

// One shared dictionary for the file — the parse walks 80,000 lines and nothing
// here mutates it.
var testSpell = services.NewSpellService(nil)

// openSpellDoc seeds a document, opens it, and returns a checker bound to it
// and wired back onto es (SetSpellChecker) — the same wiring service_provider.go
// does — so a live op enqueues through the checker exactly as it would in
// production. body is raw markdown, so a test writes the block tree it wants.
func openSpellDoc(t *testing.T, body string) (*SpellChecker, *EditorService, string) {
	t.Helper()
	return openSpellDocWithDebounce(t, body, 0)
}

// openSpellDocWithDebounce is openSpellDoc with the autosave delay chosen by
// the caller (0 = the production default, far longer than any test's patience).
// A test that must observe the BACKGROUND save an edit arms needs the timer to
// fire inside its own.
func openSpellDocWithDebounce(t *testing.T, body string, debounce time.Duration) (*SpellChecker, *EditorService, string) {
	t.Helper()
	sc, es, uuids := openSpellDocs(t, testSpell, debounce, body)
	return sc, es, uuids[0]
}

// openSpellDocs is the whole-workspace form: one document per body, all open on
// ONE EditorService, with a checker wired to it. A test about a change of mind
// that reaches every open document — a word accepted, the toggle flipped —
// needs more than one, and a test about its own dictionary passes its own
// spell service rather than teaching the shared one.
func openSpellDocs(t *testing.T, spell *services.SpellService, debounce time.Duration, bodies ...string) (*SpellChecker, *EditorService, []string) {
	t.Helper()
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), debounce)
	t.Cleanup(es.CloseAll)

	uuids := make([]string, 0, len(bodies))
	for _, body := range bodies {
		doc, err := ds.New()
		if err != nil {
			t.Fatalf("New doc: %v", err)
		}
		doc.SetBody([]byte(body))
		doc, err = ds.Save(doc)
		if err != nil {
			t.Fatalf("Save doc: %v", err)
		}
		if err := es.Open(doc.UUID()); err != nil {
			t.Fatalf("Open: %v", err)
		}
		uuids = append(uuids, doc.UUID())
	}
	sc := NewSpellChecker(es, spell)
	es.SetSpellChecker(sc)
	return sc, es, uuids
}

// fakeSpellTimer is one scheduled-but-not-yet-run drain, as fakeSpellClock
// hands it out. stopped mirrors time.Timer.Stop's contract: set means fire
// must skip it.
type fakeSpellTimer struct {
	fn      func()
	stopped bool
}

// fakeSpellClock stands in for afterFunc in tests: a schedule is CAPTURED
// rather than run against real time, so a test controls exactly when — and
// whether — a debounce elapses. Assign its after method to a SpellChecker's
// after field (same-package white-box access) before exercising it.
type fakeSpellClock struct {
	mu     sync.Mutex
	timers []*fakeSpellTimer
}

func (c *fakeSpellClock) after(_ time.Duration, f func()) stopFunc {
	c.mu.Lock()
	t := &fakeSpellTimer{fn: f}
	c.timers = append(c.timers, t)
	c.mu.Unlock()
	return func() {
		c.mu.Lock()
		t.stopped = true
		c.mu.Unlock()
	}
}

// fire simulates every currently-armed timer's debounce elapsing at once: it
// runs each scheduled, not-yet-stopped callback exactly once, in scheduling
// order, and forgets the whole batch. Its return is how many callbacks
// actually ran — a burst of enqueues for one document arms many timers but
// cancels all but the last, so fire after a burst returns 1.
func (c *fakeSpellClock) fire() int {
	c.mu.Lock()
	timers := c.timers
	c.timers = nil
	c.mu.Unlock()

	ran := 0
	for _, t := range timers {
		c.mu.Lock()
		stopped := t.stopped
		c.mu.Unlock()
		if stopped {
			continue
		}
		t.fn()
		ran++
	}
	return ran
}

func proseRegion(id, content string) string {
	return "<!--s:" + id + "-->\n" + content + "\n<!--/s:" + id + "-->"
}

// A mark's anchor is quote plus occurrence, and its offsets cut the quote back
// out of the segment. Occurrence restarts per segment and counts only identical
// quotes, so two DIFFERENT misspellings both start at 0 — and it is minted over
// EVERY word run, so a run that went unflagged still takes its number.
//
// Every case asserts the ROUND TRIP: domain.TextSegment.Locate — the resolver
// the squiggle and the write both go through — finds the mark back at the run
// it was minted from. A mint counted over the misspellings alone passes the
// first case and lands the second on the filename.
func TestSpellChecker_ComposesMarksAnchoredByQuoteAndOccurrence(t *testing.T) {
	type anchor struct {
		quote      string
		occurrence int
	}
	cases := []struct {
		name    string
		content string
		want    []anchor
	}{
		{
			name:    "identical quotes number in reading order; different ones each start at 0",
			content: "teh cat sat on teh mat with a helllo",
			want:    []anchor{{"teh", 0}, {"teh", 1}, {"helllo", 0}},
		},
		{
			name:    "a run inside an address is never flagged, but it is still counted",
			content: "see recieve.go then recieve here",
			want:    []anchor{{"recieve", 1}},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resetRegistry()
			sc, _, uuid := openSpellDoc(t, proseRegion(proseA, tc.content))

			marks := sc.CheckDocument(sc.documents.shadowFor(uuid))
			if len(marks) != len(tc.want) {
				t.Fatalf("want %d marks, got %d: %+v", len(tc.want), len(marks), marks)
			}
			segment := domain.TextSegment{Text: tc.content}
			for i, w := range tc.want {
				m := marks[i]
				if m.Quote != w.quote || m.Occurrence != w.occurrence {
					t.Errorf("mark %d = (%q,%d), want (%q,%d)", i, m.Quote, m.Occurrence, w.quote, w.occurrence)
				}
				if m.BlockID != proseA {
					t.Errorf("mark %d block = %q, want %q", i, m.BlockID, proseA)
				}
				if m.Class != domain.TextClassProse {
					t.Errorf("mark %d class = %q, want prose", i, m.Class)
				}
				if m.Locator == "" {
					t.Errorf("mark %d carries no locator", i)
				}
				if m.Start < 0 || m.End > len(tc.content) || tc.content[m.Start:m.End] != m.Quote {
					t.Fatalf("mark %d offsets [%d:%d] do not cut %q out of %q", i, m.Start, m.End, m.Quote, tc.content)
				}
				if m.Suggestions == nil {
					t.Errorf("mark %d suggestions is nil; the wire needs an empty list, not null", i)
				}
				run, found := segment.Locate(m.Quote, m.Occurrence)
				if !found || run.Start != m.Start || run.End != m.End {
					t.Errorf("mark %d resolves to %+v (found=%v), want the run it was minted from, [%d:%d]", i, run, found, m.Start, m.End)
				}
			}
		})
	}
}

// The seed queues every block and drains once, but pushes ONLY blocks that
// need correcting: a
// misspelled block gets its marks, a kind that bears no text is skipped (never
// participates), and — the binding suppression rule — a block that is clean
// on this, its FIRST check, gets no frame at all. There is no prior state to
// clear, so silence is correct; only a block that WAS flagged and is now clean
// earns the empty push that clears it (proven separately, by
// TestSpellChecker_ObservedOpsRecomputeAndClearOnCorrection).
func TestSpellChecker_SeedPushesOnlyFlaggedBlocks(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(&testRunJobProcessor{FencedDeserializer: block.FencedDeserializer{Kind: "probe"}})
	body := proseRegion(proseA, "a helllo here") + "\n\n" +
		proseRegion(proseB, "this sentence is entirely correct") + "\n\n" +
		"```probe\nid: " + probeC + "\nsource: helllo helllo\nstatus: COMPLETE\n```"
	sc, _, uuid := openSpellDoc(t, body)

	clock := &fakeSpellClock{}
	sc.after = clock.after
	notifier := &recordingNotifier{}
	sc.SetNotifier(notifier)

	sc.CheckAndPush(uuid)
	if ran := clock.fire(); ran != 1 {
		t.Fatalf("fire ran %d drains, want exactly 1 — the whole-document seed is one enqueue burst", ran)
	}

	if pushes := notifier.forDocument(uuid); len(pushes) == 0 {
		t.Errorf("nothing was pushed for uuid %q", uuid)
	}
	flagged, pushed := notifier.forBlock(proseA)
	if !pushed || len(flagged) != 1 || flagged[0].Quote != "helllo" {
		t.Errorf("misspelled block pushed %+v (pushed=%v), want one helllo mark", flagged, pushed)
	}
	if _, pushed := notifier.forBlock(proseB); pushed {
		t.Error("a block clean on its first check was pushed; the seed must suppress it")
	}
	if _, pushed := notifier.forBlock(probeC); pushed {
		t.Error("a kind that is not a TextBearer was pushed; only participating kinds may be")
	}
}

// panickyTextBearerProcessor is a TextBearer whose NormalisedText always
// panics — a stand-in for a buggy processor, used to prove CheckAndPush
// cannot be brought down by one.
type panickyTextBearerProcessor struct {
	testRunJobProcessor
}

func (p *panickyTextBearerProcessor) NormalisedText(_ *block.SieveBlock) []domain.TextSegment {
	panic("boom")
}

// CheckAndPush runs off the read loop in its own goroutine (ws_handler.go), so
// a panic here must never reach the caller: it costs the panicking block its
// marks, and every other block in the same pass is still checked and pushed.
// CheckDocument (a pure computation, unaffected by the queue) is the direct
// proof: it is called first, before the queue enters the picture at all.
func TestSpellChecker_APanickingProcessorFailsOnlyItsOwnBlock(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(&panickyTextBearerProcessor{
		testRunJobProcessor{FencedDeserializer: block.FencedDeserializer{Kind: "panicky"}},
	})
	body := proseRegion(proseA, "a helllo here") + "\n\n" +
		"```panicky\nid: " + probeC + "\nsource: boom\nstatus: COMPLETE\n```"
	sc, es, uuid := openSpellDoc(t, body)

	marks := sc.CheckDocument(es.shadowFor(uuid))
	if len(marks) != 1 || marks[0].BlockID != proseA || marks[0].Quote != "helllo" {
		t.Fatalf("marks = %+v, want exactly one helllo mark on %s — the panic must cost only its own block", marks, proseA)
	}

	clock := &fakeSpellClock{}
	sc.after = clock.after
	notifier := &recordingNotifier{}
	sc.SetNotifier(notifier)

	sc.CheckAndPush(uuid) // must not panic
	if ran := clock.fire(); ran != 1 {
		t.Fatalf("fire ran %d drains, want exactly 1", ran)
	}

	flagged, pushed := notifier.forBlock(proseA)
	if !pushed || len(flagged) != 1 || flagged[0].Quote != "helllo" {
		t.Errorf("unaffected block pushed %+v (pushed=%v), want one helllo mark", flagged, pushed)
	}
	// A panicking NormalisedText recovers to zero segments — the SAME shape as
	// a genuinely clean block — so on this first check it is suppressed exactly
	// like TestSpellChecker_SeedPushesOnlyFlaggedBlocks's clean block: no frame.
	if _, pushed := notifier.forBlock(probeC); pushed {
		t.Error("a recovered-panic block was pushed on its first check; it must be suppressed like any other first-check-clean block")
	}
}

// Nothing to push to and nothing to push about are both no-ops, not panics:
// CheckAndPush runs off the read loop, so it routinely arrives after the
// document it was launched for has closed.
func TestSpellChecker_PushIsANoOpWithoutANotifierOrAnOpenDocument(t *testing.T) {
	resetRegistry()
	sc, es, uuid := openSpellDoc(t, proseRegion(proseA, "a helllo here"))

	sc.CheckAndPush(uuid) // no notifier registered; seeds and arms a real timer

	notifier := &recordingNotifier{}
	sc.SetNotifier(notifier)
	es.Close(uuid) // cancels that timer via SetSpellChecker's wiring (openSpellDoc)
	sc.CheckAndPush(uuid)
	if len(notifier.got) != 0 {
		t.Errorf("pushed %d mark sets for a closed document, want none", len(notifier.got))
	}
	if marks := sc.CheckDocument(nil); marks != nil {
		t.Errorf("CheckDocument(nil) = %+v, want nil", marks)
	}
}

// A burst of enqueues against one document — several ops landing in quick
// succession, same or different blocks — collapses into ONE drain: each
// enqueue cancels the previous timer and arms a new one, so only the last
// survives to fire. Every block touched anywhere in the burst is still
// recomputed in that one drain.
func TestSpellChecker_EnqueueCollapsesABurstIntoOneDrain(t *testing.T) {
	resetRegistry()
	sc, _, uuid := openSpellDoc(t, proseRegion(proseA, "a helllo here")+"\n\n"+proseRegion(proseB, "this is fine"))
	clock := &fakeSpellClock{}
	sc.after = clock.after
	notifier := &recordingNotifier{}
	sc.SetNotifier(notifier)

	sc.enqueue(uuid, proseA)
	sc.enqueue(uuid, proseB)
	sc.enqueue(uuid, proseA) // repeat: still one entry in the pending set

	if ran := clock.fire(); ran != 1 {
		t.Fatalf("fire ran %d drains for a %d-call burst, want exactly 1", ran, 3)
	}
	flagged, pushed := notifier.forBlock(proseA)
	if !pushed || len(flagged) != 1 || flagged[0].Quote != "helllo" {
		t.Errorf("proseA pushed %+v (pushed=%v), want one helllo mark", flagged, pushed)
	}
	if _, pushed := notifier.forBlock(proseB); pushed {
		t.Error("proseB is clean on its first check and must be suppressed")
	}
}

// The op-observer hook (EditorService's notifyBlockUpdated, wired through
// SetSpellChecker) is the queue's ONLY intake besides the seed — this test
// never calls sc.enqueue directly. A block flagged by an earlier drain that is
// then corrected by a live op is recomputed and pushed EMPTY exactly once,
// clearing the client's squiggle; a document opened clean and left alone stays
// silent, proving the hook does not enqueue on its own.
func TestSpellChecker_ObservedOpsRecomputeAndClearOnCorrection(t *testing.T) {
	resetRegistry()
	sc, es, uuid := openSpellDoc(t, proseRegion(proseA, "a helllo here"))
	clock := &fakeSpellClock{}
	sc.after = clock.after
	notifier := &recordingNotifier{}
	sc.SetNotifier(notifier)

	sc.CheckAndPush(uuid)
	if ran := clock.fire(); ran != 1 {
		t.Fatalf("seed: fire ran %d drains, want 1", ran)
	}
	if flagged, pushed := notifier.forBlock(proseA); !pushed || len(flagged) != 1 {
		t.Fatalf("seed did not flag the misspelling: pushed=%v marks=%+v", pushed, flagged)
	}

	// A live op — NOT a direct sc.enqueue call — fixes the typo. The post-apply
	// hook in notifyBlockUpdated is what must enqueue this.
	if err := es.HandleBlockOp(uuid, block.BlockOp{
		Type: "update-block", Kind: "prose", BlockID: proseA,
		Attrs: map[string]interface{}{"content": "a hello here"},
	}); err != nil {
		t.Fatalf("update-block: %v", err)
	}
	if ran := clock.fire(); ran != 1 {
		t.Fatalf("correction: fire ran %d drains, want 1 — the op-observer hook must have armed one", ran)
	}

	pushes := notifier.forBlockAll(proseA)
	if len(pushes) != 2 {
		t.Fatalf("proseA pushed %d times, want 2 (flag, then clear)", len(pushes))
	}
	if len(pushes[1]) != 0 {
		t.Errorf("correction push = %+v, want an EMPTY set clearing the squiggle", pushes[1])
	}
}

// Deleting the document's shadow (Close) must drop its queue outright: a timer
// already armed by an enqueue is canceled rather than left to fire against a
// shadow and a client that no longer exist.
func TestSpellChecker_CloseCancelsAnArmedDrain(t *testing.T) {
	resetRegistry()
	sc, es, uuid := openSpellDoc(t, proseRegion(proseA, "a helllo here"))
	clock := &fakeSpellClock{}
	sc.after = clock.after
	notifier := &recordingNotifier{}
	sc.SetNotifier(notifier)

	sc.enqueue(uuid, proseA)
	es.Close(uuid)

	if ran := clock.fire(); ran != 0 {
		t.Errorf("fire ran %d drains after close, want 0 — Close must cancel the armed timer", ran)
	}
	if len(notifier.got) != 0 {
		t.Errorf("pushed %d mark sets for a closed document, want none", len(notifier.got))
	}
}

// CloseAll (bulk retirement / library switch) must drop every closed
// document's spell queue exactly as Close drops one — bulk close is still
// close. Table-driven against Close so both paths are pinned by the same
// assertions.
func TestSpellChecker_CloseVariantsCancelArmedDrains(t *testing.T) {
	tests := []struct {
		name  string
		close func(es *EditorService, uuids []string)
	}{
		{
			name: "Close",
			close: func(es *EditorService, uuids []string) {
				for _, uuid := range uuids {
					es.Close(uuid)
				}
			},
		},
		{
			name: "CloseAll",
			close: func(es *EditorService, uuids []string) {
				es.CloseAll()
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resetRegistry()
			sc, es, uuids := openSpellDocs(t, testSpell, 0,
				proseRegion(proseA, "a helllo here"),
				proseRegion(proseB, "a wolrd here"))
			clock := &fakeSpellClock{}
			sc.after = clock.after
			notifier := &recordingNotifier{}
			sc.SetNotifier(notifier)

			sc.enqueue(uuids[0], proseA)
			sc.enqueue(uuids[1], proseB)

			tt.close(es, uuids)

			if ran := clock.fire(); ran != 0 {
				t.Errorf("%s: fire ran %d drains after close, want 0 — close must cancel every armed timer", tt.name, ran)
			}
			if len(notifier.got) != 0 {
				t.Errorf("%s: pushed %d mark sets for closed documents, want none", tt.name, len(notifier.got))
			}
			sc.queueMu.Lock()
			remaining := len(sc.queues)
			sc.queueMu.Unlock()
			if remaining != 0 {
				t.Errorf("%s: left %d queue entries behind, want 0", tt.name, remaining)
			}
		})
	}
}

// THE DISABLE RACE. A drain that has computed marks and a SetEnabled(false)
// that clears them are two writers to one client's squiggles, and the order
// they land in is the whole difference between a clean disable and squiggles
// nothing will ever remove: the clear states everything the client is to
// forget, so marks arriving after it are unrecoverable — nothing recomputes
// while checking is off.
//
// Staged, not raced: the notifier parks the second drain inside its push, the
// disable is started while it is parked, and only then is the push released.
// Whatever order the two producers were started in, the LAST thing the client
// hears must be the empty clear.
func TestSpellChecker_ADisableDuringADrainStillEndsCleared(t *testing.T) {
	resetRegistry()
	sc, _, uuid := openSpellDoc(t, proseRegion(proseA, "a helllo here"))
	clock := &fakeSpellClock{}
	sc.after = clock.after
	notifier := &recordingNotifier{gate: make(chan struct{})}
	sc.SetNotifier(notifier)

	sc.CheckAndPush(uuid)
	if ran := clock.fire(); ran != 1 {
		t.Fatalf("seed: fire ran %d drains, want 1", ran)
	}

	// A second drain over the still-misspelled block. Its push is the one the
	// gate parks — the seed's was arrival 1.
	sc.enqueue(uuid, proseA)
	drained := make(chan struct{})
	go func() { defer close(drained); clock.fire() }()

	deadline := time.Now().Add(2 * time.Second)
	for notifier.arrived() < 2 {
		if time.Now().After(deadline) {
			t.Fatal("the second drain never reached its push")
		}
		time.Sleep(time.Millisecond)
	}

	disabled := make(chan struct{})
	go func() { defer close(disabled); sc.SetEnabled(false) }()
	time.Sleep(50 * time.Millisecond) // ample for an unserialised clearAll to run to completion
	close(notifier.gate)

	<-drained
	select {
	case <-disabled:
	case <-time.After(2 * time.Second):
		t.Fatal("SetEnabled(false) never returned")
	}

	pushes := notifier.forBlockAll(proseA)
	if len(pushes) == 0 || len(pushes[len(pushes)-1]) != 0 {
		t.Fatalf("proseA heard %+v; a disabled client's LAST frame must be the empty clear", pushes)
	}
}

// The queue is touched from two independent goroutine shapes in production: an
// op-apply path enqueuing (many callers, potentially concurrent) and a timer
// goroutine draining. This drives both at once — run with -race — to prove the
// mutex actually serializes access rather than just look like it does.
func TestSpellChecker_ConcurrentEnqueueAndDrainDoesNotRace(t *testing.T) {
	resetRegistry()
	sc, _, uuid := openSpellDoc(t, proseRegion(proseA, "a helllo here")+"\n\n"+proseRegion(proseB, "this is fine"))
	clock := &fakeSpellClock{}
	sc.after = clock.after
	sc.SetNotifier(&recordingNotifier{})

	const bursts = 50
	var wg sync.WaitGroup
	wg.Add(bursts)
	for i := 0; i < bursts; i++ {
		go func() {
			defer wg.Done()
			sc.enqueue(uuid, proseA)
			sc.enqueue(uuid, proseB)
		}()
	}

	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-done:
				return
			default:
				clock.fire()
			}
		}
	}()

	wg.Wait()
	close(done)
	clock.fire() // whatever the last enqueue armed
}

// renderBackRecorder captures the attrs of every render-back a mutation fires,
// whichever lane it takes — an attrs merge or a replace-by-id — so a test can
// assert WHAT the client was told rather than only what the shadow now holds.
// It also counts the replacements separately, because which lane a mutation
// renders back on is itself the contract for a Go-side text rewrite.
type renderBackRecorder struct {
	mu       sync.Mutex
	got      []map[string]interface{}
	replaced []string
}

func (r *renderBackRecorder) listener() *mockLifecycleListener {
	return &mockLifecycleListener{
		onUpdated: func(_, _ string, attrs map[string]interface{}) {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.got = append(r.got, attrs)
		},
		onReplaced: func(_, oldID, _, newID string, attrs map[string]interface{}, _ string) {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.got = append(r.got, attrs)
			r.replaced = append(r.replaced, oldID+"→"+newID)
		},
	}
}

func (r *renderBackRecorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.got)
}

func (r *renderBackRecorder) replacements() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.replaced...)
}

func (r *renderBackRecorder) last() map[string]interface{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.got) == 0 {
		return nil
	}
	return r.got[len(r.got)-1]
}

// THE WRITE LANE END TO END, driven by nothing but a mark the read lane
// produced: the mark's own anchor is handed straight back as the edit, the
// block is rewritten, the client is told with the authoritative block, and the
// squiggle clears.
//
// The render-back is a REPLACE-BY-ID, keeping the block's identity. A text
// rewrite is client-instigated but SERVER-EXECUTED, the same species as a
// paste or a transform: the client places the block Go now holds. The attrs
// lane cannot carry it — a client merges attrs onto text it believes it still
// owns, and drops the merge for prose.
//
// The clear is the point that must not be special-cased: nothing here re-checks
// the block. The edit went through the ordinary update path, whose post-apply
// hook queues the block like any other op, and the next drain finds it
// corrected.
func TestSpellChecker_ReplacingAMarkedWordRewritesTheBlockAndClearsTheMark(t *testing.T) {
	resetRegistry()
	sc, es, uuid := openSpellDoc(t, proseRegion(proseA, "a helllo here"))
	clock := &fakeSpellClock{}
	sc.after = clock.after
	notifier := &recordingNotifier{}
	sc.SetNotifier(notifier)
	updates := &renderBackRecorder{}
	es.SetLifecycleListener(updates.listener())

	sc.CheckAndPush(uuid)
	if ran := clock.fire(); ran != 1 {
		t.Fatalf("seed: fire ran %d drains, want 1", ran)
	}
	marks, pushed := notifier.forBlock(proseA)
	if !pushed || len(marks) != 1 {
		t.Fatalf("seed pushed %+v (pushed=%v), want one mark", marks, pushed)
	}
	mark := marks[0]
	if len(mark.Suggestions) == 0 || mark.Suggestions[0] != "hello" {
		t.Fatalf("mark suggestions = %v, want hello offered first", mark.Suggestions)
	}

	// The edit IS the mark: quote, occurrence and locator travel back unread.
	if err := es.ReplaceText(uuid, domain.TextEdit{
		BlockID:     mark.BlockID,
		Locator:     mark.Locator,
		Quote:       mark.Quote,
		Occurrence:  mark.Occurrence,
		Start:       mark.Start,
		End:         mark.End,
		Replacement: mark.Suggestions[0],
	}); err != nil {
		t.Fatalf("ReplaceText: %v", err)
	}

	blk, found := es.shadowFor(uuid).SnapshotBlock(proseA)
	if !found || blk.Content() != "a hello here" {
		t.Errorf("content = %q (found=%v), want %q", blk.Content(), found, "a hello here")
	}
	if updates.count() != 1 {
		t.Fatalf("%d render-backs fired, want exactly 1 — the edited block is echoed like any other Go-side mutation", updates.count())
	}
	if content, _ := updates.last()["content"].(string); content != "a hello here" {
		t.Errorf("render-back carried content %q, want the authoritative %q", content, "a hello here")
	}
	if want := []string{proseA + "→" + proseA}; !reflect.DeepEqual(updates.replacements(), want) {
		t.Errorf("replacements = %v, want %v — a text rewrite is placed by id, never merged as attrs", updates.replacements(), want)
	}

	if ran := clock.fire(); ran != 1 {
		t.Fatalf("after the replace, fire ran %d drains, want 1 — the op-observer must have queued the block", ran)
	}
	pushes := notifier.forBlockAll(proseA)
	if len(pushes) != 2 {
		t.Fatalf("proseA pushed %d times, want 2 (flag, then clear)", len(pushes))
	}
	if len(pushes[1]) != 0 {
		t.Errorf("post-replace push = %+v, want an EMPTY set clearing the squiggle", pushes[1])
	}
}

// What a replace refuses, and what it leaves behind when it does. Every case
// asserts the block is UNCHANGED and no render-back fired: a write that cannot
// be placed must not half-happen, and must not tell the client anything moved.
func TestSpellChecker_ReplaceTextRefusals(t *testing.T) {
	const content = "a helllo here"
	cases := []struct {
		name      string
		edit      func(uuid string) domain.TextEdit
		wantStale bool
	}{
		{
			name: "the quote was typed over between the mark and the edit",
			edit: func(string) domain.TextEdit {
				return domain.TextEdit{BlockID: proseA, Locator: "content", Quote: "wolrd", Occurrence: 0, Start: 2, End: 7, Replacement: "world"}
			},
			wantStale: true,
		},
		{
			name: "the occurrence is past what the text holds",
			edit: func(string) domain.TextEdit {
				return domain.TextEdit{BlockID: proseA, Locator: "content", Quote: "helllo", Occurrence: 1, Start: 2, End: 8, Replacement: "hello"}
			},
			wantStale: true,
		},
		{
			name: "no such block",
			edit: func(string) domain.TextEdit {
				return domain.TextEdit{BlockID: probeC, Locator: "content", Quote: "helllo", Occurrence: 0, Replacement: "hello"}
			},
		},
		{
			name: "a locator the processor did not mint",
			edit: func(string) domain.TextEdit {
				return domain.TextEdit{BlockID: proseA, Locator: "source", Quote: "helllo", Occurrence: 0, Replacement: "hello"}
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resetRegistry()
			_, es, uuid := openSpellDoc(t, proseRegion(proseA, content))
			updates := &renderBackRecorder{}
			es.SetLifecycleListener(updates.listener())

			err := es.ReplaceText(uuid, tc.edit(uuid))
			if err == nil {
				t.Fatal("the replace was accepted")
			}
			if errors.Is(err, block.ErrTextStale) != tc.wantStale {
				t.Errorf("err = %v, stale=%v; want stale=%v", err, errors.Is(err, block.ErrTextStale), tc.wantStale)
			}
			if blk, found := es.shadowFor(uuid).SnapshotBlock(proseA); !found || blk.Content() != content {
				t.Errorf("content = %q (found=%v), want it untouched: %q", blk.Content(), found, content)
			}
			if updates.count() != 0 {
				t.Errorf("%d render-backs fired for a refused replace, want none", updates.count())
			}
		})
	}
}

// A closed document has nothing to write to. ReplaceText runs off the WS read
// loop, so it can arrive after the channel that sent it went away.
func TestSpellChecker_ReplaceTextRefusesAClosedDocument(t *testing.T) {
	resetRegistry()
	_, es, uuid := openSpellDoc(t, proseRegion(proseA, "a helllo here"))
	es.Close(uuid)

	err := es.ReplaceText(uuid, domain.TextEdit{BlockID: proseA, Locator: "content", Quote: "helllo", Replacement: "hello"})
	if err == nil {
		t.Fatal("a replace against a closed document was accepted")
	}
	if errors.Is(err, block.ErrTextStale) {
		t.Error("a closed document reported as stale; staleness is about text that moved on")
	}
}

// savedRecorder hears the one fact a successful write to disk produces.
type savedRecorder struct{ saved chan string }

func (r *savedRecorder) ContainerSaved(uuid string, _ int) {
	select {
	case r.saved <- uuid:
	default:
	}
}

// A replace is a document mutation like any other, so the autosave it arms is
// the ordinary one: nothing asks for a flush, and the corrected text reaches
// disk on the debounce the merge reset.
func TestSpellChecker_AReplacementIsAutosavedLikeAnyOtherEdit(t *testing.T) {
	resetRegistry()
	_, es, uuid := openSpellDocWithDebounce(t, proseRegion(proseA, "a helllo here"), 20*time.Millisecond)
	recorder := &savedRecorder{saved: make(chan string, 4)}
	es.SetSavedNotifier(recorder)

	if err := es.ReplaceText(uuid, domain.TextEdit{
		BlockID: proseA, Locator: "content", Quote: "helllo", Occurrence: 0, Start: 2, End: 8, Replacement: "hello",
	}); err != nil {
		t.Fatalf("ReplaceText: %v", err)
	}

	select {
	case <-recorder.saved:
	case <-time.After(2 * time.Second):
		t.Fatal("the replace never autosaved; it must mark the document dirty like any other mutation")
	}
	doc, err := es.documents.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("LoadByUUID: %v", err)
	}
	if !strings.Contains(string(doc.Body()), "a hello here") {
		t.Errorf("on-disk body = %q, want the corrected text", string(doc.Body()))
	}
}

// sourceTextBearerProcessor is a TextBearer whose segments are NOT prose — a
// stand-in for the source-bearing kinds (code, diagram) that hand out their
// text for a reader to index without being written prose.
type sourceTextBearerProcessor struct {
	testRunJobProcessor
}

func (p *sourceTextBearerProcessor) NormalisedText(blk *block.SieveBlock) []domain.TextSegment {
	source, _ := blk.Attrs["source"].(string)
	return []domain.TextSegment{
		{Locator: "source", Text: source, Class: domain.TextClassCode},
		{Locator: "title", Text: "teh helllo title", Class: domain.TextClassLabel},
	}
}

// PARTICIPATING IS NOT BEING CHECKED. A kind may bear text — and code and
// diagram now do — without a word of it ever squiggling: the class decides, so
// a diagram's script and a code block's identifiers are walked and skipped
// rather than excluded by naming their kinds.
func TestSpellChecker_ChecksProseSegmentsOnly(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(&sourceTextBearerProcessor{
		testRunJobProcessor{FencedDeserializer: block.FencedDeserializer{Kind: "sourcey"}},
	})
	body := proseRegion(proseA, "a helllo here") + "\n\n" +
		"```sourcey\nid: " + probeC + "\nsource: teh recieve wolrd\nstatus: COMPLETE\n```"
	sc, es, uuid := openSpellDoc(t, body)

	if _, bears := block.TextBearerFor("sourcey"); !bears {
		t.Fatal("the stand-in kind does not bear text; the test proves nothing")
	}
	for _, m := range sc.CheckDocument(es.shadowFor(uuid)) {
		if m.BlockID != proseA {
			t.Errorf("a %s-class segment produced a mark (%q on %s); only prose is checked", m.Class, m.Quote, m.BlockID)
		}
	}
}

// Accepting a word is a workspace-wide change of mind, so it clears that word
// in EVERY open document rather than in the one it was accepted from. Both
// routes are the same act with different durability, so both are driven here.
func TestSpellChecker_AcceptingAWordClearsItInEveryOpenDocument(t *testing.T) {
	cases := []struct {
		name   string
		accept func(sc *SpellChecker, word string)
	}{
		{name: "Ignore", accept: func(sc *SpellChecker, word string) { sc.Ignore(word) }},
		{name: "Learn", accept: func(sc *SpellChecker, word string) { sc.Learn(word) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resetRegistry()
			// Its own dictionary: Learn teaches the service it is given, and the
			// file-wide one is shared by every other test here.
			sc, _, uuids := openSpellDocs(t, services.NewSpellService(nil), 0,
				proseRegion(proseA, "a zzblorp here"),
				proseRegion(proseB, "another zzblorp there"))
			clock := &fakeSpellClock{}
			sc.after = clock.after
			notifier := &recordingNotifier{}
			sc.SetNotifier(notifier)

			for _, uuid := range uuids {
				sc.CheckAndPush(uuid)
			}
			if ran := clock.fire(); ran != len(uuids) {
				t.Fatalf("seed: fire ran %d drains, want one per document (%d)", ran, len(uuids))
			}
			for i, uuid := range uuids {
				pushes := notifier.forDocument(uuid)
				if len(pushes) != 1 || len(pushes[0].marks) != 1 || pushes[0].marks[0].Quote != "zzblorp" {
					t.Fatalf("document %d was pushed %+v, want one zzblorp mark", i, pushes)
				}
			}

			tc.accept(sc, "zzblorp")
			if ran := clock.fire(); ran != len(uuids) {
				t.Fatalf("accept: fire ran %d drains, want one per open document (%d)", ran, len(uuids))
			}
			for i, uuid := range uuids {
				pushes := notifier.forDocument(uuid)
				if len(pushes) != 2 {
					t.Fatalf("document %d heard %d pushes, want 2 (flag, then clear)", i, len(pushes))
				}
				if len(pushes[1].marks) != 0 {
					t.Errorf("document %d clear push = %+v, want an EMPTY set", i, pushes[1].marks)
				}
			}
		})
	}
}

// The toggle, both ways. OFF clears every block that carries marks and stops
// the queue taking work at all; ON re-checks every open document through the
// ordinary seed. A flip to the state already held does nothing — no clears, no
// re-seed — so a client re-stating its position is free.
func TestSpellChecker_TogglingClearsEverythingAndThenRestoresIt(t *testing.T) {
	resetRegistry()
	sc, es, uuid := openSpellDoc(t, proseRegion(proseA, "a helllo here")+"\n\n"+proseRegion(proseB, "this is fine"))
	clock := &fakeSpellClock{}
	sc.after = clock.after
	notifier := &recordingNotifier{}
	sc.SetNotifier(notifier)

	sc.CheckAndPush(uuid)
	if ran := clock.fire(); ran != 1 {
		t.Fatalf("seed: fire ran %d drains, want 1", ran)
	}

	sc.SetEnabled(false)
	pushes := notifier.forBlockAll(proseA)
	if len(pushes) != 2 || len(pushes[1]) != 0 {
		t.Fatalf("proseA heard %+v, want the flag then an EMPTY clear", pushes)
	}
	if got := notifier.forBlockAll(proseB); len(got) != 0 {
		t.Errorf("a block that was never flagged heard %+v; there is nothing to clear", got)
	}

	// With checking off the queue takes nothing, so a live op arms no drain.
	if err := es.HandleBlockOp(uuid, block.BlockOp{
		Type: "update-block", Kind: "prose", BlockID: proseB,
		Attrs: map[string]interface{}{"content": "now a wolrd typo"},
	}); err != nil {
		t.Fatalf("update-block: %v", err)
	}
	if ran := clock.fire(); ran != 0 {
		t.Errorf("fire ran %d drains while disabled, want 0", ran)
	}

	sc.SetEnabled(false) // already off: no clears, nothing armed
	if ran := clock.fire(); ran != 0 || len(notifier.forBlockAll(proseA)) != 2 {
		t.Errorf("a repeated flip to off did something: %d drains, %d pushes", ran, len(notifier.forBlockAll(proseA)))
	}

	sc.SetEnabled(true)
	if ran := clock.fire(); ran != 1 {
		t.Fatalf("re-enabling ran %d drains, want the one seed", ran)
	}
	if got := notifier.forBlockAll(proseA); len(got) != 3 || len(got[2]) != 1 {
		t.Errorf("proseA heard %+v, want the mark back on re-enabling", got)
	}
	if got := notifier.forBlockAll(proseB); len(got) != 1 || len(got[0]) != 1 {
		t.Errorf("proseB heard %+v, want the typo it grew while disabled", got)
	}
}
