package editor

import (
	"errors"
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

// recordedMarks is one TextMarks call. The notifier records rather than
// asserts, so a test can check both what was pushed and what was NOT.
type recordedMarks struct {
	uuid    string
	feature string
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

func (n *recordingNotifier) TextMarks(uuid, feature, blockID string, marks []domain.TextMark) {
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
	n.got = append(n.got, recordedMarks{uuid: uuid, feature: feature, blockID: blockID, marks: marks})
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

// forFeature returns every push one feature made, in call order. Two features
// reading the same document are only told apart by which word their marks
// arrived under.
func (n *recordingNotifier) forFeature(feature string) []recordedMarks {
	n.mu.Lock()
	defer n.mu.Unlock()
	var out []recordedMarks
	for _, r := range n.got {
		if r.feature == feature {
			out = append(out, r)
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

// One shared dictionary for the package's tests — the parse walks 80,000 lines
// and nothing here mutates it.
var testSpell = services.NewSpellService(nil)

// openInspectedDoc seeds a document, opens it, and returns an engine bound to it
// with spelling registered and switched on — the same wiring
// service_provider.go does — so a live op enqueues through the engine exactly as
// it would in production. body is raw markdown, so a test writes the block tree
// it wants.
func openInspectedDoc(t *testing.T, body string) (*InspectionEngine, *EditorService, string) {
	t.Helper()
	engine, _, es, uuids := openInspectedDocs(t, testSpell, 0, body)
	return engine, es, uuids[0]
}

// openInspectedDocs is the whole-workspace form: one document per body, all open
// on ONE EditorService, with an engine wired to it. A test about a change of mind
// that reaches every open document — a word accepted, a feature switched off —
// needs more than one; a test about its own dictionary passes its own spell
// service rather than teaching the shared one; and debounce is the autosave delay
// (0 = the production default, far longer than any test's patience), which a test
// that must observe the BACKGROUND save an edit arms shortens.
func openInspectedDocs(t *testing.T, spell *services.SpellService, debounce time.Duration, bodies ...string) (*InspectionEngine, *SpellInspector, *EditorService, []string) {
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
	engine := NewInspectionEngine(es)
	inspector := NewSpellInspector(spell, engine)
	engine.Register(inspector, ScopeWorkspace)
	if err := engine.SetWorkspaceFeature(domain.FeatureSpellCheck, true, nil); err != nil {
		t.Fatalf("enable spelling: %v", err)
	}
	es.SetInspectionEngine(engine)
	es.SetFocusListener(engine)
	return engine, inspector, es, uuids
}

// fakeTimer is one scheduled-but-not-yet-run drain, as fakeClock hands it out.
// stopped mirrors time.Timer.Stop's contract: set means fire must skip it.
type fakeTimer struct {
	fn      func()
	stopped bool
}

// fakeClock stands in for afterFunc in tests: a schedule is CAPTURED rather than
// run against real time, so a test controls exactly when — and whether — a
// debounce elapses. Assign its after method to an engine's after field
// (same-package white-box access) before exercising it.
type fakeClock struct {
	mu     sync.Mutex
	timers []*fakeTimer
}

func (c *fakeClock) after(_ time.Duration, f func()) stopFunc {
	c.mu.Lock()
	t := &fakeTimer{fn: f}
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
func (c *fakeClock) fire() int {
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

// staged returns an engine on a fake clock with a recording notifier attached —
// the three lines every liveness test starts with.
func staged(engine *InspectionEngine) (*fakeClock, *recordingNotifier) {
	clock := &fakeClock{}
	engine.after = clock.after
	notifier := &recordingNotifier{}
	engine.SetNotifier(notifier)
	return clock, notifier
}

// The seed queues every block and drains once, but pushes ONLY blocks a feature
// has something to say about: a misspelled block gets its marks, a kind that
// bears no text is skipped (never participates), and — the binding suppression
// rule — a block that is clean on this, its FIRST check, gets no frame at all.
// There is no prior state to clear, so silence is correct; only a block that WAS
// flagged and is now clean earns the empty push that clears it (proven
// separately, by TestInspectionEngine_ObservedOpsRecomputeAndClearOnCorrection).
func TestInspectionEngine_SeedPushesOnlyFlaggedBlocks(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(&testRunJobProcessor{FencedDeserializer: block.FencedDeserializer{Kind: "probe"}})
	body := proseRegion(proseA, "a helllo here") + "\n\n" +
		proseRegion(proseB, "this sentence is entirely correct") + "\n\n" +
		"```probe\nid: " + probeC + "\nsource: helllo helllo\nstatus: COMPLETE\n```"
	engine, _, uuid := openInspectedDoc(t, body)
	clock, notifier := staged(engine)

	engine.CheckAndPush(uuid)
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
	if marks := notifier.forFeature(domain.FeatureSpellCheck); len(marks) == 0 {
		t.Error("nothing arrived under the spell-check feature; a push says who found it")
	}
	if _, pushed := notifier.forBlock(proseB); pushed {
		t.Error("a block clean on its first check was pushed; the seed must suppress it")
	}
	if _, pushed := notifier.forBlock(probeC); pushed {
		t.Error("a kind that is not a TextBearer was pushed; only participating kinds may be")
	}
}

// panickyTextBearerProcessor is a TextBearer whose NormalisedText always
// panics — a stand-in for a buggy processor.
type panickyTextBearerProcessor struct {
	testRunJobProcessor
}

func (p *panickyTextBearerProcessor) NormalisedText(_ *block.SieveBlock) []domain.TextSegment {
	panic("boom")
}

// panickyInspector is a registered producer that always panics — the other half
// of the same containment, since a producer is third-party code to the engine
// exactly as a processor is.
type panickyInspector struct{ feature string }

func (p panickyInspector) Feature() string { return p.feature }

func (p panickyInspector) Inspect([]domain.TextSegment, map[string]any) []domain.TextMark {
	panic("boom")
}

// A drain runs unsupervised in a timer goroutine, so a panic from either side of
// the read — the kind handing out its text, or the producer reading it — must
// cost that block its marks and nothing else. Every other block in the same pass
// is still inspected and pushed.
//
// A recovered panic yields zero marks, which is the SAME shape as a genuinely
// clean block, so on a first check it is suppressed like any other: no frame.
func TestInspectionEngine_APanicFailsOnlyItsOwnBlock(t *testing.T) {
	cases := []struct {
		name              string
		block             string                  // an extra block, when the panic is a processor's
		registerProcessor func()                  // before the document is parsed
		registerInspector func(*InspectionEngine) // once the engine exists
	}{
		{
			name:  "the kind's own reading panics",
			block: "```panicky\nid: " + probeC + "\nsource: boom\nstatus: COMPLETE\n```",
			registerProcessor: func() {
				block.RegisterProcessor(&panickyTextBearerProcessor{
					testRunJobProcessor{FencedDeserializer: block.FencedDeserializer{Kind: "panicky"}},
				})
			},
		},
		{
			name: "a registered producer panics",
			registerInspector: func(engine *InspectionEngine) {
				engine.Register(panickyInspector{feature: "panicky-feature"}, ScopeWorkspace)
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resetRegistry()
			body := proseRegion(proseA, "a helllo here")
			if tc.registerProcessor != nil {
				tc.registerProcessor()
				body += "\n\n" + tc.block
			}
			engine, _, uuid := openInspectedDoc(t, body)
			if tc.registerInspector != nil {
				tc.registerInspector(engine)
				if err := engine.SetWorkspaceFeature("panicky-feature", true, nil); err != nil {
					t.Fatalf("enable the panicking feature: %v", err)
				}
			}
			clock, notifier := staged(engine)

			engine.CheckAndPush(uuid) // must not panic
			if ran := clock.fire(); ran != 1 {
				t.Fatalf("fire ran %d drains, want exactly 1", ran)
			}

			flagged, pushed := notifier.forBlock(proseA)
			if !pushed || len(flagged) != 1 || flagged[0].Quote != "helllo" {
				t.Errorf("unaffected work pushed %+v (pushed=%v), want one helllo mark", flagged, pushed)
			}
			if got := notifier.forFeature("panicky-feature"); len(got) != 0 {
				t.Errorf("a panicking producer pushed %+v; a recovered panic is a clean answer and suppressed", got)
			}
			if _, pushed := notifier.forBlock(probeC); pushed {
				t.Error("a recovered-panic block was pushed on its first check; it must be suppressed like any other first-check-clean block")
			}
		})
	}
}

// Nothing to push to and nothing to push about are both no-ops, not panics: a
// seed runs off the read loop, so it routinely arrives after the document it was
// launched for has closed.
func TestInspectionEngine_PushIsANoOpWithoutANotifierOrAnOpenDocument(t *testing.T) {
	resetRegistry()
	engine, es, uuid := openInspectedDoc(t, proseRegion(proseA, "a helllo here"))

	engine.CheckAndPush(uuid) // no notifier registered; seeds and arms a real timer

	notifier := &recordingNotifier{}
	engine.SetNotifier(notifier)
	es.Close(uuid) // cancels that timer via SetInspectionEngine's wiring
	engine.CheckAndPush(uuid)
	if len(notifier.got) != 0 {
		t.Errorf("pushed %d mark sets for a closed document, want none", len(notifier.got))
	}
}

// A burst of enqueues against one document — several ops landing in quick
// succession, same or different blocks — collapses into ONE drain: each
// enqueue cancels the previous timer and arms a new one, so only the last
// survives to fire. Every block touched anywhere in the burst is still
// recomputed in that one drain.
func TestInspectionEngine_EnqueueCollapsesABurstIntoOneDrain(t *testing.T) {
	resetRegistry()
	engine, _, uuid := openInspectedDoc(t, proseRegion(proseA, "a helllo here")+"\n\n"+proseRegion(proseB, "this is fine"))
	clock, notifier := staged(engine)

	engine.enqueue(uuid, proseA)
	engine.enqueue(uuid, proseB)
	engine.enqueue(uuid, proseA) // repeat: still one entry in the pending set

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
// SetInspectionEngine) is the queue's ONLY intake besides the seed — this test
// never calls engine.enqueue directly. A block flagged by an earlier drain that
// is then corrected by a live op is recomputed and pushed EMPTY exactly once,
// clearing the client's mark; a document opened clean and left alone stays
// silent, proving the hook does not enqueue on its own.
func TestInspectionEngine_ObservedOpsRecomputeAndClearOnCorrection(t *testing.T) {
	resetRegistry()
	engine, es, uuid := openInspectedDoc(t, proseRegion(proseA, "a helllo here"))
	clock, notifier := staged(engine)

	engine.CheckAndPush(uuid)
	if ran := clock.fire(); ran != 1 {
		t.Fatalf("seed: fire ran %d drains, want 1", ran)
	}
	if flagged, pushed := notifier.forBlock(proseA); !pushed || len(flagged) != 1 {
		t.Fatalf("seed did not flag the misspelling: pushed=%v marks=%+v", pushed, flagged)
	}

	// A live op — NOT a direct enqueue call — fixes the typo. The post-apply
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
		t.Errorf("correction push = %+v, want an EMPTY set clearing the mark", pushes[1])
	}
}

// Closing the document must drop its queue outright: a timer already armed by an
// enqueue is canceled rather than left to fire against a shadow and a client
// that no longer exist. CloseAll (bulk retirement / library switch) is still
// close, so both paths are pinned by the same assertions.
func TestInspectionEngine_CloseVariantsCancelArmedDrains(t *testing.T) {
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
			engine, _, es, uuids := openInspectedDocs(t, testSpell, 0,
				proseRegion(proseA, "a helllo here"),
				proseRegion(proseB, "a wolrd here"))
			clock, notifier := staged(engine)

			engine.enqueue(uuids[0], proseA)
			engine.enqueue(uuids[1], proseB)

			tt.close(es, uuids)

			if ran := clock.fire(); ran != 0 {
				t.Errorf("%s: fire ran %d drains after close, want 0 — close must cancel every armed timer", tt.name, ran)
			}
			if len(notifier.got) != 0 {
				t.Errorf("%s: pushed %d mark sets for closed documents, want none", tt.name, len(notifier.got))
			}
			engine.queueMu.Lock()
			remaining := len(engine.queues)
			engine.queueMu.Unlock()
			if remaining != 0 {
				t.Errorf("%s: left %d queue entries behind, want 0", tt.name, remaining)
			}
		})
	}
}

// THE DISABLE RACE. A drain that has computed marks and a feature being switched
// off are two writers to one client's drawing, and the order they land in is the
// whole difference between a clean disable and marks nothing will ever remove:
// the clear states everything the client is to forget, so marks arriving after it
// are unrecoverable — nothing recomputes while the feature is off.
//
// Staged, not raced: the notifier parks the second drain inside its push, the
// disable is started while it is parked, and only then is the push released.
// Whatever order the two producers were started in, the LAST thing the client
// hears must be the empty clear.
func TestInspectionEngine_ADisableDuringADrainStillEndsCleared(t *testing.T) {
	resetRegistry()
	engine, _, uuid := openInspectedDoc(t, proseRegion(proseA, "a helllo here"))
	clock := &fakeClock{}
	engine.after = clock.after
	notifier := &recordingNotifier{gate: make(chan struct{})}
	engine.SetNotifier(notifier)

	engine.CheckAndPush(uuid)
	if ran := clock.fire(); ran != 1 {
		t.Fatalf("seed: fire ran %d drains, want 1", ran)
	}

	// A second drain over the still-misspelled block. Its push is the one the
	// gate parks — the seed's was arrival 1.
	engine.enqueue(uuid, proseA)
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
	go func() {
		defer close(disabled)
		if err := engine.SetWorkspaceFeature(domain.FeatureSpellCheck, false, nil); err != nil {
			t.Errorf("disable: %v", err)
		}
	}()
	time.Sleep(50 * time.Millisecond) // ample for an unserialised clear to run to completion
	close(notifier.gate)

	<-drained
	select {
	case <-disabled:
	case <-time.After(2 * time.Second):
		t.Fatal("switching the feature off never returned")
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
func TestInspectionEngine_ConcurrentEnqueueAndDrainDoesNotRace(t *testing.T) {
	resetRegistry()
	engine, _, uuid := openInspectedDoc(t, proseRegion(proseA, "a helllo here")+"\n\n"+proseRegion(proseB, "this is fine"))
	clock := &fakeClock{}
	engine.after = clock.after
	engine.SetNotifier(&recordingNotifier{})

	const bursts = 50
	var wg sync.WaitGroup
	wg.Add(bursts)
	for i := 0; i < bursts; i++ {
		go func() {
			defer wg.Done()
			engine.enqueue(uuid, proseA)
			engine.enqueue(uuid, proseB)
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

// The toggle, both ways. OFF clears every block that carries the feature's marks
// and stops the queue taking work at all; ON re-checks every open document
// through the ordinary seed. A flip to the state already held does nothing — no
// clears, no re-seed — so a client re-stating its position is free.
func TestInspectionEngine_TogglingClearsEverythingAndThenRestoresIt(t *testing.T) {
	resetRegistry()
	engine, es, uuid := openInspectedDoc(t, proseRegion(proseA, "a helllo here")+"\n\n"+proseRegion(proseB, "this is fine"))
	clock, notifier := staged(engine)

	engine.CheckAndPush(uuid)
	if ran := clock.fire(); ran != 1 {
		t.Fatalf("seed: fire ran %d drains, want 1", ran)
	}

	spell := func(on bool) {
		t.Helper()
		if err := engine.SetWorkspaceFeature(domain.FeatureSpellCheck, on, nil); err != nil {
			t.Fatalf("SetWorkspaceFeature(%v): %v", on, err)
		}
	}

	spell(false)
	pushes := notifier.forBlockAll(proseA)
	if len(pushes) != 2 || len(pushes[1]) != 0 {
		t.Fatalf("proseA heard %+v, want the flag then an EMPTY clear", pushes)
	}
	if got := notifier.forBlockAll(proseB); len(got) != 0 {
		t.Errorf("a block that was never flagged heard %+v; there is nothing to clear", got)
	}

	// With the only feature off the queue takes nothing, so a live op arms no drain.
	if err := es.HandleBlockOp(uuid, block.BlockOp{
		Type: "update-block", Kind: "prose", BlockID: proseB,
		Attrs: map[string]interface{}{"content": "now a wolrd typo"},
	}); err != nil {
		t.Fatalf("update-block: %v", err)
	}
	if ran := clock.fire(); ran != 0 {
		t.Errorf("fire ran %d drains while disabled, want 0", ran)
	}

	spell(false) // already off: no clears, nothing armed
	if ran := clock.fire(); ran != 0 || len(notifier.forBlockAll(proseA)) != 2 {
		t.Errorf("a repeated flip to off did something: %d drains, %d pushes", ran, len(notifier.forBlockAll(proseA)))
	}

	spell(true)
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

// quoteInspector is a stand-in producer: it flags one word it is TOLD to look
// for, so a test can register a second feature and see whose marks are whose. It
// reads every class, which is also how it differs from spelling.
type quoteInspector struct{ feature string }

func (q quoteInspector) Feature() string { return q.feature }

func (q quoteInspector) Inspect(segments []domain.TextSegment, parameters map[string]any) []domain.TextMark {
	term, _ := parameters["term"].(string)
	if term == "" {
		return nil
	}
	var marks []domain.TextMark
	for _, segment := range segments {
		for at := strings.Index(segment.Text, term); at >= 0; at = -1 {
			marks = append(marks, domain.TextMark{
				Locator: segment.Locator, Quote: term, Grain: domain.GrainLiteral,
				Start: at, End: at + len(term), Class: segment.Class, Suggestions: []string{},
			})
		}
	}
	return marks
}

// TWO FEATURES, ONE WALK. A second registered producer reads the same block in
// the same drain — that is the whole reason the reading is minted once — and
// each one's findings arrive under its own word. Switching one off clears only
// its own marks: the other's are neither cleared nor re-pushed, because the
// disable was never about them.
func TestInspectionEngine_TwoFeaturesDrainTogetherAndClearApart(t *testing.T) {
	resetRegistry()
	engine, _, uuid := openInspectedDoc(t, proseRegion(proseA, "a helllo here"))
	engine.Register(quoteInspector{feature: "quotes"}, ScopeDocument)
	clock, notifier := staged(engine)

	if err := engine.SetDocumentFeature(uuid, "quotes", true, map[string]any{"term": "here"}); err != nil {
		t.Fatalf("enable quotes: %v", err)
	}
	if ran := clock.fire(); ran != 1 {
		t.Fatalf("enabling a feature ran %d drains, want the one seed", ran)
	}

	spelt := notifier.forFeature(domain.FeatureSpellCheck)
	found := notifier.forFeature("quotes")
	if len(spelt) != 1 || len(spelt[0].marks) != 1 || spelt[0].marks[0].Quote != "helllo" {
		t.Errorf("spell-check pushed %+v, want the one misspelling", spelt)
	}
	if len(found) != 1 || len(found[0].marks) != 1 || found[0].marks[0].Quote != "here" {
		t.Errorf("quotes pushed %+v, want the one match", found)
	}
	if found[0].marks[0].BlockID != proseA {
		t.Errorf("the quotes mark names block %q, want %q — the engine stamps what a producer cannot know", found[0].marks[0].BlockID, proseA)
	}

	if err := engine.SetDocumentFeature(uuid, "quotes", false, nil); err != nil {
		t.Fatalf("disable quotes: %v", err)
	}
	if cleared := notifier.forFeature("quotes"); len(cleared) != 2 || len(cleared[1].marks) != 0 {
		t.Errorf("quotes heard %+v, want its own EMPTY clear", cleared)
	}
	if after := notifier.forFeature(domain.FeatureSpellCheck); len(after) != 1 {
		t.Errorf("spell-check heard %d pushes, want the 1 it started with — another feature's disable is not its business", len(after))
	}
}

// PARAMETERS REACH THE PRODUCER AND NOTHING ELSE READS THEM. Re-stating an
// enablement with different parameters re-runs the feature (a new search term is
// a new answer); re-stating it with the same ones does nothing at all.
func TestInspectionEngine_ParametersReachInspectAndReExecuteOnChange(t *testing.T) {
	resetRegistry()
	engine, _, uuid := openInspectedDoc(t, proseRegion(proseA, "the cat sat here"))
	engine.Register(quoteInspector{feature: "quotes"}, ScopeDocument)
	clock, notifier := staged(engine)

	if err := engine.SetDocumentFeature(uuid, "quotes", true, map[string]any{"term": "cat"}); err != nil {
		t.Fatalf("enable quotes: %v", err)
	}
	clock.fire()
	if err := engine.SetDocumentFeature(uuid, "quotes", true, map[string]any{"term": "cat"}); err != nil {
		t.Fatalf("restate quotes: %v", err)
	}
	if ran := clock.fire(); ran != 0 {
		t.Errorf("re-stating the same parameters ran %d drains, want 0", ran)
	}
	if err := engine.SetDocumentFeature(uuid, "quotes", true, map[string]any{"term": "here"}); err != nil {
		t.Fatalf("re-arm quotes: %v", err)
	}
	clock.fire()

	pushes := notifier.forFeature("quotes")
	if len(pushes) != 2 {
		t.Fatalf("quotes pushed %+v, want one set per distinct term", pushes)
	}
	if pushes[0].marks[0].Quote != "cat" || pushes[1].marks[0].Quote != "here" {
		t.Errorf("quotes pushed %q then %q, want cat then here", pushes[0].marks[0].Quote, pushes[1].marks[0].Quote)
	}
}

// A feature nothing registered is refused rather than remembered — enabling it
// would be enabling nothing, silently, forever — and a feature is controlled from
// the channel its scope names, so a workspace-wide answer cannot be given by one
// document, nor a per-document one by the workspace.
func TestInspectionEngine_RefusesWhatItCannotServe(t *testing.T) {
	resetRegistry()
	engine, _, uuid := openInspectedDoc(t, proseRegion(proseA, "a helllo here"))
	engine.Register(quoteInspector{feature: "quotes"}, ScopeDocument)

	cases := []struct {
		name string
		call func() error
		want error
	}{
		{
			name: "a feature nothing registered, from the workspace",
			call: func() error { return engine.SetWorkspaceFeature("nonesuch", true, nil) },
			want: ErrUnknownFeature,
		},
		{
			name: "a feature nothing registered, from a document",
			call: func() error { return engine.SetDocumentFeature(uuid, "nonesuch", true, nil) },
			want: ErrUnknownFeature,
		},
		{
			name: "a workspace feature switched from a document channel",
			call: func() error { return engine.SetDocumentFeature(uuid, domain.FeatureSpellCheck, false, nil) },
			want: ErrFeatureScope,
		},
		{
			name: "a document feature switched from the workspace wire",
			call: func() error { return engine.SetWorkspaceFeature("quotes", true, nil) },
			want: ErrFeatureScope,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.call(); !errors.Is(err, tc.want) {
				t.Errorf("err = %v, want %v", err, tc.want)
			}
		})
	}

	// The refusals changed nothing: spelling is still on, and find is still off.
	clock, notifier := staged(engine)
	engine.CheckAndPush(uuid)
	clock.fire()
	if len(notifier.forFeature(domain.FeatureSpellCheck)) != 1 {
		t.Error("spelling stopped answering after a refused control frame")
	}
	if got := notifier.forFeature("quotes"); len(got) != 0 {
		t.Errorf("find pushed %+v after a refused enable", got)
	}
}

// A CHANNEL CLOSE IS THE IMPLICIT DISABLE. Document-scoped state is per open
// channel, so a document that closes takes its features with it: re-opening the
// same uuid starts with nothing switched on, and a client that wants its find
// back re-arms by asking again.
func TestInspectionEngine_DocumentFeaturesDieWithTheirChannel(t *testing.T) {
	resetRegistry()
	engine, es, uuid := openInspectedDoc(t, proseRegion(proseA, "the cat sat helllo here"))
	engine.Register(quoteInspector{feature: "quotes"}, ScopeDocument)
	clock, notifier := staged(engine)

	if err := engine.SetDocumentFeature(uuid, "quotes", true, map[string]any{"term": "cat"}); err != nil {
		t.Fatalf("enable quotes: %v", err)
	}
	clock.fire()

	es.Close(uuid)
	if err := es.Open(uuid); err != nil {
		t.Fatalf("re-open: %v", err)
	}
	engine.CheckAndPush(uuid)
	clock.fire()

	if got := notifier.forFeature("quotes"); len(got) != 1 {
		t.Errorf("find pushed %d times, want only the 1 from before the close — a closed channel disables what it switched on", len(got))
	}
	if got := notifier.forFeature(domain.FeatureSpellCheck); len(got) == 0 {
		t.Error("spelling stopped after a close; a workspace feature outlives any one channel")
	}
}

// FOCUS IS A LIFECYCLE TRIGGER. The document the reader turns to is re-checked,
// so what was switched on while it sat in the background catches up when it is
// read again. It is ADDITIVE: the open-time seed and the op observer are
// untouched, and a focus that names nothing asks for nothing.
func TestInspectionEngine_AFocusChangeRechecksTheFocusedDocument(t *testing.T) {
	resetRegistry()
	engine, _, es, uuids := openInspectedDocs(t, testSpell, 0,
		proseRegion(proseA, "a helllo here"),
		proseRegion(proseB, "a wolrd here"))
	clock, notifier := staged(engine)

	es.SetFocusedDocument(uuids[1])
	if ran := clock.fire(); ran != 1 {
		t.Fatalf("a focus change ran %d drains, want the one re-check", ran)
	}
	if got := notifier.forDocument(uuids[1]); len(got) != 1 || got[0].blockID != proseB {
		t.Errorf("the focused document heard %+v, want its own marks", got)
	}
	if got := notifier.forDocument(uuids[0]); len(got) != 0 {
		t.Errorf("a document nobody focused heard %+v", got)
	}
	if focused := es.FocusedDocument(); focused != uuids[1] {
		t.Errorf("FocusedDocument = %q, want %q", focused, uuids[1])
	}

	es.SetFocusedDocument(uuids[1]) // already focused: nothing to say
	if ran := clock.fire(); ran != 0 {
		t.Errorf("re-stating the focused document ran %d drains, want 0", ran)
	}

	// The channel going away is what ends the focus — there is no un-focus frame.
	es.Close(uuids[1])
	if focused := es.FocusedDocument(); focused != "" {
		t.Errorf("FocusedDocument = %q after close, want empty", focused)
	}
	if ran := clock.fire(); ran != 0 {
		t.Errorf("losing focus ran %d drains, want 0 — there is nothing to re-check", ran)
	}
}

// contentOf is what a block's payload now holds — how a test reads back what a
// write left behind.
func contentOf(t *testing.T, es *EditorService, uuid, blockID string) string {
	t.Helper()
	shadow := es.shadowFor(uuid)
	if shadow == nil {
		t.Fatalf("no open document for %q", uuid)
	}
	blk, found := shadow.SnapshotBlock(blockID)
	if !found {
		t.Fatalf("no block %q in %q", blockID, uuid)
	}
	return blk.Content()
}

// sourceOf is the same read for a kind that keeps its text in a payload attr
// rather than as content — the shape a read-only bearer takes.
func sourceOf(t *testing.T, es *EditorService, uuid, blockID string) string {
	t.Helper()
	shadow := es.shadowFor(uuid)
	if shadow == nil {
		t.Fatalf("no open document for %q", uuid)
	}
	blk, found := shadow.SnapshotBlock(blockID)
	if !found {
		t.Fatalf("no block %q in %q", blockID, uuid)
	}
	source, _ := blk.Attrs["source"].(string)
	return source
}

// replaceAllDoc opens a document holding two prose blocks and one read-only
// text bearer, with the REAL find producer registered document-scoped and
// already switched on for term. What comes back is the wiring a replace-all
// arrives into, plus every block replacement the editor echoed.
func replaceAllDoc(t *testing.T, term string) (*InspectionEngine, *EditorService, string, *[]string) {
	t.Helper()
	resetRegistry()
	block.RegisterProcessor(&sourceTextBearerProcessor{
		testRunJobProcessor{FencedDeserializer: block.FencedDeserializer{Kind: "sourcey"}},
	})
	body := proseRegion(proseA, "the cat sat on the mat") + "\n\n" +
		proseRegion(proseB, "the end") + "\n\n" +
		"```sourcey\nid: " + probeC + "\nsource: the log\nstatus: COMPLETE\n```"
	engine, _, es, uuids := openInspectedDocs(t, testSpell, 0, body)
	engine.Register(NewFindInspector(es), ScopeDocument)
	staged(engine)

	echoed := &[]string{}
	es.SetLifecycleListener(&mockLifecycleListener{
		onReplaced: func(_, _, _, newID string, _ map[string]interface{}, _ string) {
			*echoed = append(*echoed, newID)
		},
	})
	if err := engine.SetDocumentFeature(uuids[0], domain.FeatureFind, true, map[string]any{"term": term}); err != nil {
		t.Fatalf("enable quotes: %v", err)
	}
	return engine, es, uuids[0], echoed
}

// replaceAll is an imperative PARAMETER on the ordinary control frame, and the
// find feature obeys it ON THE REQUEST PATH: every assertion below reads the
// document the instant SetDocumentFeature returns, with no timer fired and no
// drain run, so a producer that did this work in the background fails here.
//
// It replaces every CURRENT match in every block that ACCEPTS text edits. A kind
// that bears text but takes no writes is searched and highlighted like any other
// and skipped here without an error — write participation is the processor's
// answer, never the feature's.
//
// ONE BATCH PER BLOCK is what the echo count proves: two rewritten blocks, two
// replacements, however many matches each of them held.
func TestInspectionEngine_ReplaceAllRewritesEveryCurrentMatchOnTheRequestPath(t *testing.T) {
	engine, es, uuid, echoed := replaceAllDoc(t, "the")

	if err := engine.SetDocumentFeature(uuid, domain.FeatureFind, true, map[string]any{
		"term": "the", "replacement": "a", "replaceAll": true,
	}); err != nil {
		t.Fatalf("replace all: %v", err)
	}

	if got := contentOf(t, es, uuid, proseA); got != "a cat sat on a mat" {
		t.Errorf("proseA = %q, want both matches replaced", got)
	}
	if got := contentOf(t, es, uuid, proseB); got != "a end" {
		t.Errorf("proseB = %q, want its match replaced — replace-all crosses blocks", got)
	}
	if got := sourceOf(t, es, uuid, probeC); got != "the log" {
		t.Errorf("the read-only bearer reads %q, want its text untouched", got)
	}
	if len(*echoed) != 2 {
		t.Errorf("the editor echoed %d block replacements, want one per rewritten block", len(*echoed))
	}
}

// The imperative is CONSUMED on receipt: what the engine remembers is the search
// alone. A repeat of the same frame therefore acts a second time rather than
// being read as a restatement of what is already true — and finds nothing left,
// which is what makes replace-all idempotent.
func TestInspectionEngine_ReplaceAllIsConsumedOnReceiptAndIdempotent(t *testing.T) {
	engine, es, uuid, echoed := replaceAllDoc(t, "the")
	frame := map[string]any{"term": "the", "replacement": "a", "replaceAll": true}

	if err := engine.SetDocumentFeature(uuid, domain.FeatureFind, true, frame); err != nil {
		t.Fatalf("replace all: %v", err)
	}
	held := engine.enabled[featureKey{uuid: uuid, feature: domain.FeatureFind}]
	if _, kept := held["replaceAll"]; kept {
		t.Errorf("the engine remembers %+v, want the imperative consumed", held)
	}
	if _, kept := held["replacement"]; kept {
		t.Errorf("the engine remembers %+v, want the imperative consumed", held)
	}
	if held["term"] != "the" {
		t.Errorf("the engine remembers %+v, want the search kept", held)
	}

	before := contentOf(t, es, uuid, proseA)
	if err := engine.SetDocumentFeature(uuid, domain.FeatureFind, true, frame); err != nil {
		t.Fatalf("replace all again: %v", err)
	}
	if after := contentOf(t, es, uuid, proseA); after != before {
		t.Errorf("a repeat rewrote %q into %q, want nothing left to find", before, after)
	}
	if len(*echoed) != 2 {
		t.Errorf("the editor echoed %d replacements, want the 2 the first pass made", len(*echoed))
	}
}

// Every match is minted from ONE reading and written in one batch, so a
// replacement that contains the term is not searched again: "the" → "there"
// replaces each match once instead of growing without end.
func TestInspectionEngine_ReplaceAllDoesNotCascadeIntoItsOwnReplacement(t *testing.T) {
	engine, es, uuid, _ := replaceAllDoc(t, "the")

	if err := engine.SetDocumentFeature(uuid, domain.FeatureFind, true, map[string]any{
		"term": "the", "replacement": "there", "replaceAll": true,
	}); err != nil {
		t.Fatalf("replace all: %v", err)
	}
	if got := contentOf(t, es, uuid, proseA); got != "there cat sat on there mat" {
		t.Errorf("proseA = %q, want each match replaced exactly once", got)
	}
}

// What is NOT an act to obey. A frame switching find OFF carries no imperative
// however its parameters read — a disable is a disable — and an empty term
// matches nothing, so there is nothing to replace.
func TestInspectionEngine_ReplaceAllActsOnlyOnAnEnabledSearch(t *testing.T) {
	cases := []struct {
		name       string
		enabled    bool
		parameters map[string]any
		// forgets names the parameters the engine must NOT be left holding.
		forgets []string
	}{
		{
			name:       "a disable never acts, whatever it carries",
			enabled:    false,
			parameters: map[string]any{"term": "the", "replacement": "a", "replaceAll": true},
		},
		{
			name:       "an empty term matches nothing, so it replaces nothing",
			enabled:    true,
			parameters: map[string]any{"term": "", "replacement": "a", "replaceAll": true},
		},
		{
			name:       "a search without the imperative only searches",
			enabled:    true,
			parameters: map[string]any{"term": "the", "replacement": "a"},
			// A replacement is what to write WHEN TOLD TO WRITE. Remembering one
			// would leave the feature holding an instruction nobody has given.
			forgets: []string{"replacement", "replaceAll"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			engine, es, uuid, _ := replaceAllDoc(t, "the")
			if err := engine.SetDocumentFeature(uuid, domain.FeatureFind, tc.enabled, tc.parameters); err != nil {
				t.Fatalf("control: %v", err)
			}
			if got := contentOf(t, es, uuid, proseA); got != "the cat sat on the mat" {
				t.Errorf("proseA = %q, want it untouched", got)
			}
			held := engine.enabled[featureKey{uuid: uuid, feature: domain.FeatureFind}]
			for _, forgotten := range tc.forgets {
				if _, kept := held[forgotten]; kept {
					t.Errorf("the engine remembers %+v, want %q consumed", held, forgotten)
				}
			}
		})
	}
}
