package ink

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"sieve/sieve/domain"
	"sieve/sieve/ink/link"
	"sieve/sieve/ink/radio"
	"sieve/sieve/protocol"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

// testRadio hands out links to a scripted companion listening on a loopback socket, dialled by
// the TCP radio. Loopback sockets have room in them as a real link has, so neither side's write
// waits for the other to read.
type testRadio struct {
	tcp   radio.Radio
	dials atomic.Int32
	// hold makes every Dial wait for its context, as a scan that finds nothing does.
	hold atomic.Bool
	// fail, when set, is every Dial's error.
	fail atomic.Pointer[error]

	mu     sync.Mutex
	served []net.Conn
}

func newTestRadio(t *testing.T, companion *link.ScriptedCompanion) *testRadio {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	r := &testRadio{tcp: radio.NewTCP(listener.Addr().String(), companionID)}
	t.Cleanup(func() {
		listener.Close()
		r.drop()
	})
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			r.mu.Lock()
			r.served = append(r.served, conn)
			r.mu.Unlock()
			go func() {
				_ = companion.Serve(conn)
				conn.Close()
			}()
		}
	}()
	return r
}

func (r *testRadio) Dial(ctx context.Context) (radio.Link, error) {
	r.dials.Add(1)
	if err := r.fail.Load(); err != nil {
		return nil, *err
	}
	if r.hold.Load() {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return r.tcp.Dial(ctx)
}

// drop closes the companion's end of every link, as the companion going out of range does.
func (r *testRadio) drop() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, c := range r.served {
		c.Close()
	}
	r.served = nil
}

// inkRig is a Sieve's store and settings, a companion reached through a testRadio, and the
// service over them. It counts the service's invalidations.
type inkRig struct {
	*replicaRig
	state         *services.StateService
	radio         *testRadio
	invalidations atomic.Int32
	svc           *InkService
}

func newInkRig(t *testing.T, records []link.Record) *inkRig {
	t.Helper()
	rig := &inkRig{replicaRig: newReplicaRig(t, records)}
	state, err := services.NewStateService(rig.st, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	rig.state, rig.radio = state, newTestRadio(t, rig.companion)
	rig.svc = rig.newService()
	return rig
}

func (rig *inkRig) InkChanged() { rig.invalidations.Add(1) }

// newService is a service over the rig, as a Sieve starting again builds it.
func (rig *inkRig) newService() *InkService {
	svc := NewInkService(rig.state, reopen(rig.t, rig.st), rig.radio, rig)
	svc.redial.base = 10 * time.Millisecond
	rig.t.Cleanup(svc.Stop)
	return svc
}

// enable writes Ink as enabled under key, as a person who paired earlier left it.
func (rig *inkRig) enable(key link.Key) {
	rig.t.Helper()
	settings := rig.state.LoadSettings()
	settings.Ink = domain.InkSettings{Enabled: true, Key: key.Text()}
	if err := rig.state.SaveSettings(settings); err != nil {
		rig.t.Fatal(err)
	}
}

func (rig *inkRig) start() {
	rig.t.Helper()
	if err := rig.svc.Start(); err != nil {
		rig.t.Fatal(err)
	}
}

// await is the status once ok holds of it.
func (rig *inkRig) await(what string, ok func(Status) bool) Status {
	rig.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		st := rig.svc.Status()
		if ok(st) {
			return st
		}
		if time.Now().After(deadline) {
			rig.t.Fatalf("never %s: %+v", what, st)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// stopPromptly stops the service and fails if that takes more than a moment.
func (rig *inkRig) stopPromptly() {
	rig.t.Helper()
	stopped := make(chan struct{})
	go func() {
		rig.svc.Stop()
		close(stopped)
	}()
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		rig.t.Fatal("Stop did not return")
	}
	if phase := rig.svc.Status().Link.Phase; phase != LinkOff {
		rig.t.Errorf("stopped in %s", phase)
	}
}

func connected(st Status) bool { return st.Link.Phase == LinkConnected }

// inkLog is a note of two pages and three strokes.
func inkLog() []link.Record {
	return logOf(header("Ideas"), pageAdd(page(1), 0, ruled, link.BoundsFixed), strokeAdd(page(1), stroke(1)),
		pageAdd(page(2), 1, nil, link.BoundsFixed), strokeAdd(page(2), stroke(2), offSheet), strokeAdd(page(1), stroke(3)))
}

func TestInkService_DisabledNeverDials(t *testing.T) {
	rig := newInkRig(t, inkLog())
	rig.start()
	time.Sleep(50 * time.Millisecond)
	if n := rig.radio.dials.Load(); n != 0 {
		t.Errorf("dialled %d times while disabled", n)
	}
	if st := rig.svc.Status(); st.Enabled || st.Key != "" || st.Link.Phase != LinkOff {
		t.Errorf("status %+v", st)
	}
}

func TestInkService_EnablingMintsAKeyOnceAndKeepsIt(t *testing.T) {
	rig := newInkRig(t, nil)
	rig.radio.hold.Store(true)
	if err := rig.svc.SetEnabled(true); err != nil {
		t.Fatal(err)
	}
	st := rig.await("looking", func(st Status) bool { return st.Link.Phase == LinkLooking })
	key, err := link.ParseKey(st.Key)
	if err != nil || !st.Enabled || st.Key != key.Text() || st.SieveID != key.SieveID() {
		t.Fatalf("status %+v: %v", st, err)
	}
	if err := rig.svc.SetEnabled(false); err != nil {
		t.Fatal(err)
	}
	if err := rig.svc.SetEnabled(true); err != nil {
		t.Fatal(err)
	}
	rig.svc.Stop()
	fresh, err := filestore.NewFileStore(rig.st.Root(), "testhost")
	if err != nil {
		t.Fatal(err)
	}
	state, err := services.NewStateService(fresh, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	rig.state = state
	rig.svc = rig.newService()
	rig.start()
	if again := rig.await("looking", func(st Status) bool { return st.Link.Phase == LinkLooking }); again.Key != st.Key {
		t.Errorf("the key changed from %q to %q", st.Key, again.Key)
	}
}

func TestInkService_ASessionLandsNotesAndStatusListsThem(t *testing.T) {
	records := inkLog()
	rig := newInkRig(t, records)
	rig.enable(linkKey)
	rig.start()
	st := rig.await("caught up", func(st Status) bool { return connected(st) && st.Session.Records == len(records) })
	if st.Link.Companion != companionID || st.Session.Companion != companionID || st.Session.Bytes == 0 ||
		st.Session.CatchUp <= 0 || st.Session.KBps() <= 0 {
		t.Errorf("session %+v link %+v", st.Session, st.Link)
	}
	expectListed := func(when string, st Status) {
		t.Helper()
		if len(st.Notes) != 1 || st.Notes[0].Title != "Ideas" || st.Notes[0].Pages != 2 ||
			st.Notes[0].Seq != uint32(len(records)) || st.Notes[0].Companion != companionID {
			t.Fatalf("%s: notes %+v", when, st.Notes)
		}
		if want := []Companion{{Identity: companionID, Device: aDevice.Name, Notes: 1}}; fmt.Sprint(st.Companions) != fmt.Sprint(want) {
			t.Errorf("%s: companions %+v, want %+v", when, st.Companions, want)
		}
	}
	expectListed("following", st)
	if c := rig.expectHeld(records); c.Storable().Meta()["note_title"] != "Ideas" || c.Storable().Meta()["note_pages"] != "2" ||
		c.Storable().Meta()["note_device"] != aDevice.Name {
		t.Errorf("face while following %v", c.Storable().Meta())
	}
	rig.stopPromptly()
	expectListed("stopped", rig.svc.Status())
	if v := rig.expectHeld(records).Versions(); len(v) != 1 {
		t.Errorf("%d versions after a session that only caught up", len(v))
	}
}

// While a session has a note open, Status shows it as its replica stands, ahead of its face;
// otherwise as its face says.
func TestInkService_StatusShowsAnOpenNoteAsItsReplicaStands(t *testing.T) {
	rig := newInkRig(t, nil)
	records := strokesLog(3)
	replicas := NewNoteReplicas(rig.containers, companionID)
	opened, err := replicas.Open(noteID)
	if err != nil {
		t.Fatal(err)
	}
	for _, rec := range records {
		body, err := rec.Body()
		if err != nil {
			t.Fatal(err)
		}
		if err := opened.Append(rec, body); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		name  string
		run   *sessionRun
		pages int
		seq   uint32
	}{
		{"from the face", nil, 0, 0},
		{"from the open replica", &sessionRun{replicas: replicas}, 1, uint32(len(records))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig.svc.mu.Lock()
			rig.svc.run = tc.run
			rig.svc.mu.Unlock()
			st := rig.svc.Status()
			if len(st.Notes) != 1 || st.Notes[0].Title != "Strokes" || st.Notes[0].Pages != tc.pages || st.Notes[0].Seq != tc.seq {
				t.Errorf("notes %+v", st.Notes)
			}
			if want := []Companion{{Identity: companionID, Device: aDevice.Name, Notes: 1}}; fmt.Sprint(st.Companions) != fmt.Sprint(want) {
				t.Errorf("companions %+v, want %+v", st.Companions, want)
			}
		})
	}
	if err := replicas.End(); err != nil {
		t.Fatal(err)
	}
}

func TestInkService_ADroppedLinkIsRedialledAndResumesFromTheCursor(t *testing.T) {
	records := inkLog()
	rig := newInkRig(t, records[:2])
	rig.enable(linkKey)
	rig.start()
	rig.await("caught up to 2", func(st Status) bool { return connected(st) && st.Session.Records == 2 })
	rig.companion.SetRecords(records)
	rig.radio.drop()
	rig.await("caught up the rest", func(st Status) bool { return connected(st) && st.Session.Records == len(records)-2 })
	if got := rig.opens(); len(got) != 2 || got[0] != 0 || got[1] != 2 {
		t.Errorf("OPENs asked from %v, want 0 then 2", got)
	}
	if n := rig.radio.dials.Load(); n != 2 {
		t.Errorf("%d dials", n)
	}
	rig.stopPromptly()
	rig.expectHeld(records)
}

func TestInkService_StopIsPrompt(t *testing.T) {
	for _, tc := range []struct {
		name  string
		hold  bool
		ready func(Status) bool
	}{
		{"while a dial is scanning", true, func(st Status) bool { return st.Link.Phase == LinkLooking }},
		{"while a session follows", false, func(st Status) bool { return connected(st) && st.Session.Records == 6 }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newInkRig(t, inkLog())
			rig.radio.hold.Store(tc.hold)
			rig.enable(linkKey)
			rig.start()
			rig.await("ready", tc.ready)
			rig.stopPromptly()
		})
	}
}

func TestInkService_ARadioThatCannotDialIsQuietOrUnsupported(t *testing.T) {
	for _, tc := range []struct {
		name        string
		err         error
		supported   bool
		dialAgain   bool
		wantProblem string
	}{
		{"no companion in range", errors.New("no companion found"), true, true, ""},
		{"no Bluetooth ink here", fmt.Errorf("bluetooth: %w", radio.ErrBluetoothUnsupported), false, false, ""},
		{"Bluetooth is off", fmt.Errorf("bluetooth: %w", radio.ErrBluetoothOff), true, true, "bluetooth: Bluetooth is off"},
		{"Sieve may not use Bluetooth", fmt.Errorf("bluetooth: %w", radio.ErrBluetoothNotAuthorised), true, true, "bluetooth: Sieve is not authorised to use Bluetooth"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newInkRig(t, nil)
			rig.radio.fail.Store(&tc.err)
			rig.enable(linkKey)
			rig.start()
			time.Sleep(100 * time.Millisecond)
			st := rig.svc.Status()
			if st.Supported != tc.supported || st.Link.Problem != tc.wantProblem {
				t.Errorf("status %+v", st)
			}
			if again := rig.radio.dials.Load() > 1; again != tc.dialAgain {
				t.Errorf("dialled %d times", rig.radio.dials.Load())
			}
			rig.stopPromptly()
		})
	}
}

func TestInkService_AWrongKeyIsRejectedAndTriedAgain(t *testing.T) {
	rig := newInkRig(t, inkLog())
	rig.enable(link.Key{9})
	rig.start()
	st := rig.await("rejected", func(st Status) bool { return st.Link.Problem == ProblemKeyRejected })
	if st.Link.Phase != LinkLooking || len(st.Notes) != 0 {
		t.Errorf("status %+v", st)
	}
	rig.await("tried again", func(Status) bool { return rig.radio.dials.Load() > 2 })
}

func TestInkService_ANewKeyChangesTheSieveIDAndDropsTheLink(t *testing.T) {
	rig := newInkRig(t, inkLog())
	rig.enable(linkKey)
	rig.start()
	before := rig.await("connected", connected)
	if err := rig.svc.NewKey(); err != nil {
		t.Fatal(err)
	}
	after := rig.await("rejected", func(st Status) bool { return st.Link.Problem == ProblemKeyRejected })
	if after.SieveID == before.SieveID || after.Key == before.Key || before.SieveID != linkKey.SieveID() {
		t.Errorf("SieveID %s then %s", before.SieveID, after.SieveID)
	}
	if n := rig.radio.dials.Load(); n < 2 {
		t.Errorf("%d dials", n)
	}
}

// steppedClock is the loop's clock, moved by the test: each pause the loop asks for is handed to
// the test, and the loop waits until the test lets it pass.
type steppedClock struct {
	pauses chan time.Duration
	fire   chan time.Time
}

func newSteppedClock() *steppedClock {
	return &steppedClock{pauses: make(chan time.Duration, 64), fire: make(chan time.Time)}
}

func (c *steppedClock) after(d time.Duration) <-chan time.Time {
	c.pauses <- d
	return c.fire
}

// asked is the next pause the loop asks for; the loop waits in it until pass.
func (c *steppedClock) asked(t *testing.T) time.Duration {
	t.Helper()
	select {
	case d := <-c.pauses:
		return d
	case <-time.After(5 * time.Second):
		t.Fatal("the loop asked for no pause")
		return 0
	}
}

// pass ends the pause the loop is waiting in.
func (c *steppedClock) pass(t *testing.T) {
	t.Helper()
	select {
	case c.fire <- time.Now():
	case <-time.After(5 * time.Second):
		t.Fatal("the loop was not waiting")
	}
}

func TestRedialPause_DoublesOverRejectionsAndStartsAgain(t *testing.T) {
	const reject, accept, reset = "reject", "accept", "reset"
	for _, tc := range []struct {
		name  string
		steps []string
		want  []time.Duration
	}{
		{"a refusing companion", []string{reject, reject, reject, reject, reject, reject, reject},
			[]time.Duration{1, 2, 4, 8, 16, 30, 30}},
		{"a session that is not rejected", []string{reject, reject, accept, reject}, []time.Duration{1, 2, 1, 1}},
		{"no companion in range", []string{accept, accept}, []time.Duration{1, 1}},
		{"a reset", []string{reject, reject, reject, reset, reject, reject}, []time.Duration{1, 2, 4, 1, 2}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := redialPause{base: time.Second, max: 30 * time.Second}
			var got []time.Duration
			for _, step := range tc.steps {
				if step == reset {
					p.reset()
					continue
				}
				got = append(got, p.next(step == reject)/time.Second)
			}
			if fmt.Sprint(got) != fmt.Sprint(tc.want) {
				t.Errorf("pauses %v s, want %v s", got, tc.want)
			}
		})
	}
}

// A companion that keeps refusing the key is dialled ever less often, and nothing is invalidated
// while nothing shown changes; a new key starts the pauses again from the base.
func TestInkService_ARefusingCompanionIsDialledLessOftenAndQuietly(t *testing.T) {
	rig := newInkRig(t, inkLog())
	clock := newSteppedClock()
	rig.svc.after, rig.svc.redial = clock.after, redialPause{base: time.Second, max: 30 * time.Second}
	rig.enable(link.Key{9})
	rig.start()
	var pauses []time.Duration
	var shown int32
	for i := int32(1); i <= 7; i++ {
		pauses = append(pauses, clock.asked(t)/time.Second)
		if n := rig.radio.dials.Load(); n != i {
			t.Fatalf("%d dials before pause %d", n, i)
		}
		if i == 1 {
			shown = rig.invalidations.Load()
		} else if n := rig.invalidations.Load(); n != shown {
			t.Errorf("refusal %d invalidated: %d invalidations, %d after the first", i, n, shown)
		}
		clock.pass(t)
	}
	if want := []time.Duration{1, 2, 4, 8, 16, 30, 30}; fmt.Sprint(pauses) != fmt.Sprint(want) {
		t.Errorf("pauses %v s, want %v s", pauses, want)
	}
	if st := rig.svc.Status(); st.Link.Problem != ProblemKeyRejected {
		t.Errorf("status %+v", st.Link)
	}

	if d := clock.asked(t); d != 30*time.Second {
		t.Fatalf("pause %v before the new key", d)
	}
	if err := rig.svc.NewKey(); err != nil {
		t.Fatal(err)
	}
	pauses = nil
	for i := 0; i < 3; i++ {
		pauses = append(pauses, clock.asked(t)/time.Second)
		clock.pass(t)
	}
	if want := []time.Duration{1, 1, 2}; fmt.Sprint(pauses) != fmt.Sprint(want) {
		t.Errorf("pauses after a new key %v s, want %v s", pauses, want)
	}
	rig.stopPromptly()
}

// recordingListener keeps every event it hears as a line. With a gate, each call waits on it.
type recordingListener struct {
	gate chan struct{}

	mu     sync.Mutex
	events []string
}

func (l *recordingListener) add(format string, args ...interface{}) {
	if l.gate != nil {
		<-l.gate
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.events = append(l.events, fmt.Sprintf(format, args...))
}

func (l *recordingListener) heard() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.events...)
}

func (l *recordingListener) LinkChanged(s LinkState) { l.add("link %s", s.Phase) }
func (l *recordingListener) RecordCommitted(container string, note link.ID, rec link.Record) {
	l.add("record %d held=%t", rec.Seq, container != "" && note == noteID)
}
func (l *recordingListener) LiveInk(records []link.LiveRecord) { l.add("ink %d", len(records)) }
func (l *recordingListener) LiveChanged(live LiveNote) {
	if live == (LiveNote{}) {
		l.add("live none")
		return
	}
	l.add("live page=%t held=%t", live.Note == noteID && live.Page == page(1), live.Container != "")
}

func TestInkService_ListenersHearEventsInOrderAndASlowOneStallsNothing(t *testing.T) {
	records := inkLog()
	rig := newInkRig(t, records[:2])
	if err := rig.sync(); err != nil {
		t.Fatal(err)
	}
	rig.svc = rig.newService()
	rig.companion.SetRecords(records)
	rig.companion.Live = true
	rig.companion.Ink = []byte{byte(link.LiveClock), 1, 0, 0, 0, 0x10, 0x27}
	ours, slow := &recordingListener{}, &recordingListener{gate: make(chan struct{})}
	t.Cleanup(func() { close(slow.gate) })
	rig.svc.Subscribe(ours)
	rig.svc.Subscribe(slow)
	rig.enable(linkKey)
	rig.start()
	rig.await("caught up", func(st Status) bool { return connected(st) && st.Session.Records == len(records)-2 })
	rig.stopPromptly()

	want := []string{"link looking", "link connected", "live page=true held=true", "ink 1"}
	for _, r := range records[2:] {
		want = append(want, fmt.Sprintf("record %d held=true", r.Seq))
	}
	want = append(want, "live none", "link off")
	deadline := time.Now().Add(2 * time.Second)
	for len(ours.heard()) < len(want) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := ours.heard(); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("heard\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	rig.svc.Unsubscribe(ours)
	if err := rig.svc.Start(); err != nil {
		t.Fatal(err)
	}
	rig.await("connected again", connected)
	rig.stopPromptly()
	if got := len(ours.heard()); got != len(want) {
		t.Errorf("an unsubscribed listener heard %d more events", got-len(want))
	}
}

func TestInkService_InvalidatesOnChangesAndThrottlesTheCatchUp(t *testing.T) {
	records := strokesLog(50)
	for _, tc := range []struct {
		name     string
		throttle time.Duration
		// atLeast and atMost bound the invalidations up to the catch-up being over.
		atLeast, atMost int32
	}{
		// Looking, connected and the catch-up over; no record is due within the hour.
		{"throttled", time.Hour, 3, 3},
		{"unthrottled", 0, 3 + int32(len(records)), 1 << 20},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newInkRig(t, records)
			rig.svc.throttle = tc.throttle
			rig.enable(linkKey)
			rig.start()
			rig.await("caught up", func(st Status) bool { return connected(st) && st.Session.Records == len(records) })
			time.Sleep(50 * time.Millisecond)
			if n := rig.invalidations.Load(); n < tc.atLeast || n > tc.atMost {
				t.Errorf("%d invalidations, want %d to %d", n, tc.atLeast, tc.atMost)
			}
			before := rig.invalidations.Load()
			rig.stopPromptly()
			if rig.invalidations.Load() == before {
				t.Error("stopping did not invalidate")
			}
		})
	}
}

func TestInkService_ExportsAHeldPageInTheExportShape(t *testing.T) {
	records := inkLog()
	rig := newInkRig(t, records)
	if err := rig.sync(); err != nil {
		t.Fatal(err)
	}
	rig.svc = rig.newService()
	c := rig.container()
	exported, err := rig.svc.ExportPage(c.UUID(), 1)
	if err != nil {
		t.Fatal(err)
	}
	want, err := ReadStrokeBasedNote(c.UUID(), rig.asset(c, StrokesKey)).ExportPage(1)
	if err != nil || !bytes.Equal(exported, want) {
		t.Errorf("exported %s, want %s (%v)", exported, want, err)
	}
	decoder := json.NewDecoder(bytes.NewReader(exported))
	decoder.DisallowUnknownFields()
	var shape protocol.InkPageExport
	if err := decoder.Decode(&shape); err != nil {
		t.Fatalf("not the published shape: %v", err)
	}
	if shape.Note.ID != noteID.String() || len(shape.Strokes) != 1 || shape.Strokes[0].Points[0].X != offSheet.X {
		t.Errorf("exported %+v", shape)
	}
	for _, tc := range []struct {
		name string
		uuid string
		page int
	}{
		{"an unknown container", "0199aaaa-0000-7000-8000-000000000000", 0},
		{"a page out of range", c.UUID(), 2},
		{"a negative page", c.UUID(), -1},
	} {
		if _, err := rig.svc.ExportPage(tc.uuid, tc.page); !errors.Is(err, ErrNoSuchPage) {
			t.Errorf("%s: %v", tc.name, err)
		}
	}
}
