package ink

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"slices"
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
	addr  string
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
	r := &testRadio{addr: listener.Addr().String(), tcp: radio.NewTCP(listener.Addr().String(), companionID)}
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

// speakAs makes every link from now on the companion's of identity; it must not be called while a
// Dial runs.
func (r *testRadio) speakAs(identity string) { r.tcp = radio.NewTCP(r.addr, identity) }

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

	mu sync.Mutex
	// deleted and sessionChanges are what the rig was told besides InkChanged.
	deleted        []string
	sessionChanges int
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

func (rig *inkRig) ContainerDeleted(uuid string) {
	rig.mu.Lock()
	defer rig.mu.Unlock()
	rig.deleted = append(rig.deleted, uuid)
}

func (rig *inkRig) SessionChanged() {
	rig.mu.Lock()
	defer rig.mu.Unlock()
	rig.sessionChanges++
}

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

// A held note its companion did not list is absent once that companion has listed, and a
// whiteboard is told apart. Delete removes Sieve's copy, which the next listing brings back.
// A notebook is deleted only where it would not come straight back: its tablet not connected, or
// connected and no longer offering it. A note the tablet offers again after its copy was deleted
// is synced from the start into a new container, and the link stays up.
func TestInkService_MarksWhatTheTabletNoLongerOffersAndDeletesSievesCopyOnlyWhereItStays(t *testing.T) {
	records := inkLog()
	rig := newInkRig(t, records)
	board := NewNoteReplicas(rig.containers, companionID)
	opened, err := board.Open(testID(0xb0))
	if err != nil {
		t.Fatal(err)
	}
	for _, rec := range logOf(header("Board"), pageAdd(page(1), 0, nil, link.BoundsUnbounded)) {
		body, err := rec.Body()
		if err != nil {
			t.Fatal(err)
		}
		if err := opened.Append(rec, body); err != nil {
			t.Fatal(err)
		}
	}
	if err := board.End(); err != nil {
		t.Fatal(err)
	}
	byTitle := func(st Status) map[string]SyncedNote {
		notes := map[string]SyncedNote{}
		for _, n := range st.Notes {
			notes[n.Title] = n
		}
		return notes
	}
	if n := byTitle(rig.svc.Status())["Board"]; n.Absent || !n.Whiteboard || n.Deletion != DeleteReturns {
		t.Errorf("before any listing: %+v", n)
	}

	rig.enable(linkKey)
	rig.start()
	notes := byTitle(rig.await("caught up", func(st Status) bool { return connected(st) && st.Session.Records == len(records) }))
	if !notes["Board"].Absent || notes["Ideas"].Absent || notes["Ideas"].Whiteboard {
		t.Errorf("after the listing: %+v", notes)
	}
	if notes["Ideas"].Deletion != DeleteRefused || notes["Board"].Deletion != DeleteLast {
		t.Errorf("deletions while connected: Ideas %v, Board %v", notes["Ideas"].Deletion, notes["Board"].Deletion)
	}
	ideas, boardUUID := notes["Ideas"].UUID, notes["Board"].UUID
	if err := rig.svc.Delete(ideas); !errors.Is(err, ErrStillOffered) {
		t.Errorf("deleting what the tablet offers: %v", err)
	}
	if _, err := reopen(t, rig.st).Load(ideas); err != nil {
		t.Errorf("a refused delete removed the container: %v", err)
	}

	deleted := func(uuid string) {
		t.Helper()
		if err := rig.svc.Delete(uuid); err != nil {
			t.Fatal(err)
		}
		if _, err := reopen(t, rig.st).Load(uuid); err == nil {
			t.Errorf("the deleted container %s is still held", uuid)
		}
		rig.mu.Lock()
		announced := slices.Clone(rig.deleted)
		rig.mu.Unlock()
		if !slices.Contains(announced, uuid) {
			t.Errorf("deletions announced %v, want %s among them", announced, uuid)
		}
		for _, n := range rig.svc.Status().Notes {
			if n.UUID == uuid {
				t.Errorf("listed after its delete: %+v", n)
			}
		}
	}
	deleted(boardUUID)

	rig.companion.Withdraw(noteID, true)
	if err := rig.companion.Relist(); err != nil {
		t.Fatal(err)
	}
	rig.await("Ideas withdrawn", func(st Status) bool {
		n := byTitle(st)["Ideas"]
		return n.Absent && n.Deletion == DeleteLast
	})
	deleted(ideas)
	rig.companion.Withdraw(noteID, false)
	if err := rig.companion.Relist(); err != nil {
		t.Fatal(err)
	}
	again := byTitle(rig.await("offered again", func(st Status) bool {
		n, ok := byTitle(st)["Ideas"]
		return connected(st) && ok && n.Seq == uint32(len(records))
	}))["Ideas"]
	if again.UUID == ideas {
		t.Errorf("synced again into the deleted container %s", ideas)
	}
	if got := rig.opens(); len(got) != 2 || got[1] != 0 {
		t.Errorf("OPENs asked from %v, want the second from 0", got)
	}
	if n := rig.radio.dials.Load(); n != 1 {
		t.Errorf("%d dials: the link did not stay up", n)
	}

	rig.stopPromptly()
	if n := byTitle(rig.svc.Status())["Ideas"]; n.Deletion != DeleteReturns {
		t.Errorf("deletion with the tablet away: %v", n.Deletion)
	}
	deleted(again.UUID)
	rig.start()
	back := byTitle(rig.await("synced at the next session", func(st Status) bool {
		n, ok := byTitle(st)["Ideas"]
		return ok && n.Seq == uint32(len(records))
	}))["Ideas"]
	if back.UUID == again.UUID {
		t.Errorf("synced again into the deleted container %s", again.UUID)
	}
	if err := rig.svc.Delete("not-a-note"); !errors.Is(err, ErrNoSuchPage) {
		t.Errorf("deleting what is no Digital Note: %v", err)
	}
}

// A listing arriving while Status reads what the tablets offer is no concurrent map access.
func TestInkService_AListingDuringStatusIsNoRace(t *testing.T) {
	rig := newInkRig(t, inkLog())
	if err := rig.sync(); err != nil {
		t.Fatal(err)
	}
	stop, listed := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(listed)
		for i := uint32(0); ; i++ {
			select {
			case <-stop:
				return
			default:
				rig.svc.offer(companionID, []link.NoteEntry{{ID: noteID, HeadSeq: i}})
			}
		}
	}()
	for i := 0; i < 50; i++ {
		rig.svc.Status()
	}
	close(stop)
	<-listed
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
		{"from the open replica", &sessionRun{replicas: replicas, link: namedLink{identity: "another-companion"}}, 1, uint32(len(records))},
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
func (l *recordingListener) LogRestarted(container string, note link.ID) {
	l.add("restarted held=%t", container != "" && note == noteID)
}
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
	if live := rig.svc.Live(); live.Note != noteID || live.Page != page(1) || live.Container == "" {
		t.Errorf("live while the companion shows the note: %+v", live)
	}
	if err := rig.svc.Delete(rig.svc.Live().Container); !errors.Is(err, ErrStillOffered) {
		t.Errorf("deleting the live note: %v", err)
	}
	late := &recordingListener{}
	rig.svc.Subscribe(late)
	rig.stopPromptly()
	if live := rig.svc.Live(); live != (LiveNote{}) {
		t.Errorf("live after the session ended: %+v", live)
	}
	lateWant := []string{"live page=true held=true", "live none", "link off"}
	deadline := time.Now().Add(2 * time.Second)
	for len(late.heard()) < len(lateWant) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := late.heard(); strings.Join(got, "\n") != strings.Join(lateWant, "\n") {
		t.Errorf("a listener subscribed while live heard %v, want %v", got, lateWant)
	}

	want := []string{"link looking", "link connected", "live page=true held=true", "ink 1"}
	for _, r := range records[2:] {
		want = append(want, fmt.Sprintf("record %d held=true", r.Seq))
	}
	want = append(want, "live none", "link off")
	deadline = time.Now().Add(2 * time.Second)
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

// A replica the companion disowns is heard as the note's log restarting, before the records of the
// new log.
func TestInkService_ASetAsideReplicaIsHeardAsARestartedLog(t *testing.T) {
	records := inkLog()
	rig := newInkRig(t, records[:2])
	if err := rig.sync(); err != nil {
		t.Fatal(err)
	}
	rig.svc = rig.newService()
	rig.companion.SetRecords(records)
	rig.companion.CorruptHead = true
	heard := &recordingListener{}
	rig.svc.Subscribe(heard)
	rig.enable(linkKey)
	rig.start()
	restarted := func() bool { return slices.Contains(heard.heard(), "restarted held=true") }
	rig.await("set aside and caught up again", func(st Status) bool {
		return connected(st) && restarted() && len(st.Notes) == 1 && st.Notes[0].Seq == uint32(len(records))
	})
	rig.stopPromptly()
	got := heard.heard()
	at := slices.Index(got, "restarted held=true")
	if at < 0 || !slices.Contains(got[at:], "record 1 held=true") || slices.Contains(got[:at], "record 1 held=true") {
		t.Errorf("heard %v, want the restart before the new log's records", got)
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

// logsFunc is a noteLogs that answers with a function.
type logsFunc func(uuid string) ([]byte, error)

func (f logsFunc) noteLog(uuid string) ([]byte, error) { return f(uuid) }

// openNotesOver holds notes open over a log source that answers every container with log.
func openNotesOver(t *testing.T, log []link.Record) *OpenNotes {
	jsonl := jsonlOf(t, log)
	return &OpenNotes{logs: logsFunc(func(string) ([]byte, error) { return jsonl, nil }), notes: map[string]*OpenNote{}}
}

// pageView is a page as a lens holds it: changes heard before the answer are held, then the
// answer's strokes and every change above the answer's seq, changes at or below it dropped.
type pageView struct {
	answered bool
	held     []StrokeChange
	seq      uint32
	strokes  []string
}

func (v *pageView) answer(t *testing.T, export []byte, seq uint32) {
	t.Helper()
	var page protocol.InkPageExport
	if err := json.Unmarshal(export, &page); err != nil {
		t.Fatal(err)
	}
	v.answered, v.seq, v.strokes = true, seq, nil
	for _, s := range page.Strokes {
		v.strokes = append(v.strokes, s.ID)
	}
	held := v.held
	v.held = nil
	for _, c := range held {
		v.take(c)
	}
}

func (v *pageView) take(c StrokeChange) {
	if !v.answered {
		v.held = append(v.held, c)
		return
	}
	if c.Seq <= v.seq {
		return
	}
	if c.Added != nil {
		v.strokes = append(v.strokes, c.Added.Stroke.String())
		return
	}
	v.strokes = slices.DeleteFunc(v.strokes, func(id string) bool { return id == c.Removed.String() })
}

// strokeIDs are the ids of a replay's strokes on its page at index i.
func strokeIDs(n *StrokeBasedNote, i int) []string {
	var ids []string
	for _, s := range n.Strokes(i) {
		ids = append(ids, s.Stroke.String())
	}
	return ids
}

// A page is answered with the strokes the whole log puts on it and the seq that log reaches: the
// asset when no session holds the note, the open replica's asset and queue when one does.
func TestOpenNotes_AnswerAPageAtTheSeqItsLogReaches(t *testing.T) {
	records := inkLog()
	for _, tc := range []struct {
		name string
		// hold opens the rig's note in a session that has written none of records to disk.
		hold bool
	}{{"from the asset", false}, {"from an open replica's unwritten queue", true}} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newInkRig(t, records)
			var uuid string
			if tc.hold {
				replicas := NewNoteReplicas(rig.containers, companionID)
				replicas.flushBytes, replicas.flushAfter = 1<<30, time.Hour
				opened, err := replicas.Open(noteID)
				if err != nil {
					t.Fatal(err)
				}
				for _, rec := range records {
					body, _ := rec.Body()
					if err := opened.Append(rec, body); err != nil {
						t.Fatal(err)
					}
				}
				t.Cleanup(func() { _ = replicas.End() })
				uuid = opened.(*NoteReplica).UUID()
				if _, err := rig.containers.LoadAsset(rig.container(), StrokesKey); err == nil {
					t.Fatal("the queue reached the asset")
				}
				rig.svc.mu.Lock()
				rig.svc.run = &sessionRun{replicas: replicas, link: namedLink{identity: companionID}}
				rig.svc.mu.Unlock()
			} else {
				if err := rig.sync(); err != nil {
					t.Fatal(err)
				}
				uuid = rig.container().UUID()
			}
			notes := NewOpenNotes(rig.svc)
			note, err := notes.Open(uuid, "socket")
			if err != nil {
				t.Fatal(err)
			}
			replay := ReadStrokeBasedNote(uuid, jsonlOf(t, records))
			for i, p := range replay.Pages() {
				var view pageView
				if err := note.AnswerPage(p.ID, func(export []byte, seq uint32) error { view.answer(t, export, seq); return nil }); err != nil {
					t.Fatal(err)
				}
				if view.seq != uint32(len(records)) || fmt.Sprint(view.strokes) != fmt.Sprint(strokeIDs(replay, i)) {
					t.Errorf("page %d answered at seq %d with %v, want seq %d with %v", i, view.seq, view.strokes, len(records), strokeIDs(replay, i))
				}
			}
			if !notes.Holds(uuid) {
				t.Error("the note is not held")
			}
		})
	}
}

func TestOpenNotes_RefuseWhatIsNoDigitalNotePage(t *testing.T) {
	rig := newInkRig(t, inkLog())
	if err := rig.sync(); err != nil {
		t.Fatal(err)
	}
	notes := NewOpenNotes(rig.svc)
	unknown := "0199aaaa-0000-7000-8000-000000000000"
	if _, err := notes.Open(unknown, "socket"); !errors.Is(err, ErrNoSuchPage) || notes.Holds(unknown) {
		t.Errorf("an unknown container: %v, held %t", err, notes.Holds(unknown))
	}
	note, err := notes.Open(rig.container().UUID(), "socket")
	if err != nil {
		t.Fatal(err)
	}
	called := false
	if err := note.AnswerPage(page(9), func([]byte, uint32) error { called = true; return nil }); !errors.Is(err, ErrNoSuchPage) || called {
		t.Errorf("an absent page: %v, answered %t", err, called)
	}
}

// Each committed record hands out the stroke change the replay says it made, once.
func TestOpenNote_CommitHandsOutEachStrokeChangeOnce(t *testing.T) {
	base := logOf(header("n"), pageAdd(page(1), 0, nil, link.BoundsFixed), strokeAdd(page(1), stroke(1)),
		pageAdd(page(2), 1, nil, link.BoundsFixed), pageRemove(page(2)))
	at := func(seq int, r link.Record) link.Record { r.Seq = uint32(seq); return r }
	next := func(r link.Record) link.Record { return at(len(base)+1, r) }
	for _, tc := range []struct {
		name string
		rec  link.Record
		want string
	}{
		{"a new stroke", next(strokeAdd(page(1), stroke(2))), "6 add p1 s2"},
		{"a present stroke added again", next(strokeAdd(page(1), stroke(1))), ""},
		{"a stroke removed", next(strokeRemove(page(1), stroke(1))), "6 remove p1 s1"},
		{"an absent stroke removed", next(strokeRemove(page(1), stroke(9))), ""},
		{"a stroke on a removed page", next(strokeAdd(page(2), stroke(2))), ""},
		{"a page added", next(pageAdd(page(3), 2, nil, link.BoundsFixed)), ""},
		{"a note-header", next(header("again")), ""},
		{"a record already held", at(len(base), strokeAdd(page(1), stroke(2))), ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			note, err := openNotesOver(t, base).Open("c", "socket")
			if err != nil {
				t.Fatal(err)
			}
			var got []string
			record := func(c StrokeChange) {
				if c.Added != nil {
					got = append(got, fmt.Sprintf("%d add p%x s%x", c.Seq, c.Page[15]-0x10, c.Added.Stroke[15]-0x40))
				} else {
					got = append(got, fmt.Sprintf("%d remove p%x s%x", c.Seq, c.Page[15]-0x10, c.Removed[15]-0x40))
				}
			}
			note.Commit(tc.rec, record)
			note.Commit(tc.rec, record)
			if strings.Join(got, ",") != tc.want {
				t.Errorf("changes %q, want %q", got, tc.want)
			}
		})
	}
}

// A record past the next seq replays the log again, so the note stands where the log does.
func TestOpenNote_ARecordPastAGapReplaysTheLog(t *testing.T) {
	records := strokesLog(4)
	served := records[:3]
	notes := &OpenNotes{logs: logsFunc(func(string) ([]byte, error) { return jsonlOf(t, served), nil }), notes: map[string]*OpenNote{}}
	note, err := notes.Open("c", "socket")
	if err != nil {
		t.Fatal(err)
	}
	served = records
	var changes int
	note.Commit(records[5], func(StrokeChange) { changes++ })
	var view pageView
	if err := note.AnswerPage(page(1), func(export []byte, seq uint32) error { view.answer(t, export, seq); return nil }); err != nil {
		t.Fatal(err)
	}
	if changes != 0 || view.seq != 6 || len(view.strokes) != 4 {
		t.Errorf("%d changes; answered at seq %d with %d strokes", changes, view.seq, len(view.strokes))
	}
}

// A consumer holding an answer and taking every change above its seq holds the replay of the
// whole log, whichever side of the answer each record is committed on: before the log is read but
// heard after, while the answer is being sent, or after.
func TestOpenNote_AStrokeCommittedAroundAnAnswerIsNeitherLostNorDoubled(t *testing.T) {
	records := strokesLog(3)
	inLog := records[:4]
	notes := &OpenNotes{logs: logsFunc(func(string) ([]byte, error) { return jsonlOf(t, inLog), nil }), notes: map[string]*OpenNote{}}
	note, err := notes.Open("c", "socket")
	if err != nil {
		t.Fatal(err)
	}
	var view pageView
	var mu sync.Mutex
	take := func(_ []string, c StrokeChange) {
		mu.Lock()
		defer mu.Unlock()
		view.take(c)
	}
	sent := make(chan struct{})
	err = note.AnswerPage(page(1), func(export []byte, seq uint32) error {
		mu.Lock()
		view.answer(t, export, seq)
		mu.Unlock()
		// The record before the answer is heard only now; the next is committed while it is sent.
		go func() {
			notes.Commit("c", records[3], take)
			notes.Commit("c", records[4], take)
			close(sent)
		}()
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-sent:
	case <-time.After(5 * time.Second):
		t.Fatal("the commits never ran")
	}
	notes.Commit("c", records[4], take)
	want := strokeIDs(ReadStrokeBasedNote("c", jsonlOf(t, records)), 0)
	if fmt.Sprint(view.strokes) != fmt.Sprint(want) {
		t.Errorf("the consumer holds %v, want %v", view.strokes, want)
	}
}

// A restarted note replays its log as it now stands, answers from it, and takes the new log's
// records from the seq it reaches; send runs once, and a note not held is not restarted.
func TestOpenNote_ARestartedNoteAnswersFromTheNewLog(t *testing.T) {
	old := strokesLog(4)
	fresh := logOf(header("Again"), pageAdd(page(1), 0, nil, link.BoundsFixed), strokeAdd(page(1), stroke(7)), strokeAdd(page(1), stroke(8)))
	served := old
	notes := &OpenNotes{logs: logsFunc(func(string) ([]byte, error) { return jsonlOf(t, served), nil }), notes: map[string]*OpenNote{}}
	note, err := notes.Open("c", "socket")
	if err != nil {
		t.Fatal(err)
	}
	served = fresh[:3]
	var sent int
	notes.Restart("c", func([]string) { sent++ })
	notes.Restart("other", func([]string) { sent++ })
	var view pageView
	if err := note.AnswerPage(page(1), func(export []byte, seq uint32) error { view.answer(t, export, seq); return nil }); err != nil {
		t.Fatal(err)
	}
	note.Commit(fresh[3], view.take)
	if want := strokeIDs(ReadStrokeBasedNote("c", jsonlOf(t, fresh)), 0); sent != 1 || view.seq != 3 || fmt.Sprint(view.strokes) != fmt.Sprint(want) {
		t.Errorf("sent %d; answered at seq %d holding %v, want seq 3 then %v", sent, view.seq, view.strokes, want)
	}
}

// A note is registered before its log is read, so a record committed during the read reaches it.
func TestOpenNotes_ARecordCommittedWhileTheLogIsReadReachesTheNote(t *testing.T) {
	records := strokesLog(3)
	changes := make(chan StrokeChange, 1)
	var notes *OpenNotes
	notes = &OpenNotes{logs: logsFunc(func(uuid string) ([]byte, error) {
		go notes.Commit(uuid, records[4], func(_ []string, c StrokeChange) { changes <- c })
		return jsonlOf(t, records[:4]), nil
	}), notes: map[string]*OpenNote{}}
	if _, err := notes.Open("c", "socket"); err != nil {
		t.Fatal(err)
	}
	select {
	case c := <-changes:
		if c.Seq != 5 || c.Added == nil {
			t.Errorf("change %+v", c)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the record committed during the read was lost")
	}
}

// Records for a container whose note is not held, or no longer is, reach nothing.
func TestOpenNotes_HoldNothingUnaskedAndReleaseWhatWasAsked(t *testing.T) {
	records := strokesLog(2)
	notes := openNotesOver(t, records[:3])
	var changes int
	count := func([]string, StrokeChange) { changes++ }
	notes.Commit("c", records[3], count)
	if notes.Holds("c") || changes != 0 {
		t.Fatalf("an unasked note: held %t, %d changes", notes.Holds("c"), changes)
	}
	if _, err := notes.Open("c", "socket"); err != nil {
		t.Fatal(err)
	}
	notes.Release("c", "socket")
	notes.Commit("c", records[3], count)
	if notes.Holds("c") || changes != 0 {
		t.Errorf("a released note: held %t, %d changes", notes.Holds("c"), changes)
	}
}

// Each change reaches every holder of the note once, and a holder that is answered after a change
// it heard while waiting takes the page at that change's seq and drops the change, so both hold the
// replay of the whole log. A note stops being held when its last holder releases it.
func TestOpenNotes_EveryHolderTakesEachChangeOnceAtItsOwnSeq(t *testing.T) {
	records := strokesLog(3)
	served := records[:3]
	notes := &OpenNotes{logs: logsFunc(func(string) ([]byte, error) { return jsonlOf(t, served), nil }), notes: map[string]*OpenNote{}}
	views := map[string]*pageView{"note": {}, "live": {}}
	heard := map[string]int{}
	take := func(holders []string, c StrokeChange) {
		for _, h := range holders {
			heard[h]++
			views[h].take(c)
		}
	}
	answer := func(holder string) {
		t.Helper()
		note, err := notes.Open("c", holder)
		if err != nil {
			t.Fatal(err)
		}
		if err := note.AnswerPage(page(1), func(export []byte, seq uint32) error { views[holder].answer(t, export, seq); return nil }); err != nil {
			t.Fatal(err)
		}
	}
	answer("note")
	notes.Commit("c", records[3], take)
	if _, err := notes.Open("c", "live"); err != nil {
		t.Fatal(err)
	}
	notes.Commit("c", records[4], take)
	answer("live")
	if views["note"].seq != 3 || views["live"].seq != 5 || heard["note"] != 2 || heard["live"] != 1 {
		t.Errorf("answered at seqs %d and %d; heard %v", views["note"].seq, views["live"].seq, heard)
	}
	want := fmt.Sprint(strokeIDs(ReadStrokeBasedNote("c", jsonlOf(t, records)), 0))
	for holder, view := range views {
		if fmt.Sprint(view.strokes) != want {
			t.Errorf("%s holds %v, want %v", holder, view.strokes, want)
		}
	}
	var restarted []string
	notes.Restart("c", func(holders []string) { restarted = holders })
	if fmt.Sprint(restarted) != "[note live]" {
		t.Errorf("restart told %v", restarted)
	}
	notes.Release("c", "note")
	if !notes.Holds("c") || notes.HeldBy("c", "note") || !notes.HeldBy("c", "live") {
		t.Errorf("after the note's socket let go: held %t, by note %t, by live %t", notes.Holds("c"), notes.HeldBy("c", "note"), notes.HeldBy("c", "live"))
	}
	notes.ReleaseAll("live")
	if notes.Holds("c") {
		t.Error("a note nobody holds is still held")
	}
}

// graceTimer is the Live view's clock, moved by the test: every grace asked for waits until the
// test lets the time pass, and passing calls even a grace stopped since, as a timer whose stop
// raced its firing does.
type graceTimer struct {
	mu      sync.Mutex
	pending []func()
	stopped int
}

func (g *graceTimer) afterFunc(_ time.Duration, f func()) func() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.pending = append(g.pending, f)
	return func() bool {
		g.mu.Lock()
		defer g.mu.Unlock()
		g.stopped++
		return true
	}
}

// pass lets every grace asked for so far run out.
func (g *graceTimer) pass() {
	g.mu.Lock()
	due := g.pending
	g.pending = nil
	g.mu.Unlock()
	for _, f := range due {
		f()
	}
}

// liveRecorder is the Live view's change listener: it resolves the view at each change and keeps
// what it found as a line.
type liveRecorder struct {
	view *LiveView

	mu    sync.Mutex
	lines []string
}

func (r *liveRecorder) Refresh(uuid string) error {
	node, err := r.view.Resolve(domain.NewContainerAddress(uuid))
	line := "gone"
	if err == nil {
		live := node.Attrs["live"].(map[string]interface{})
		line = fmt.Sprintf("%s page=%s waiting=%t", live["container"], live["page"], live["waiting"])
	} else if !errors.Is(err, domain.ErrNodeNotFound) {
		line = err.Error()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lines = append(r.lines, line)
	return nil
}

func (r *liveRecorder) last() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.lines) == 0 {
		return ""
	}
	return r.lines[len(r.lines)-1]
}

// The Live view resolves from the first live note, mirroring the note, its page and its header as
// the digital-note block holds them; through the grace after the tablet stops it still resolves,
// waiting on the last page written; a note live again within the grace closes nothing, and a grace run out ends the view:
// its tab is closed, its container is told deleted, the session and the views of ink are told, and
// it resolves no more.
func TestInkService_TheLiveViewLastsFromTheFirstLiveNoteToTheGraceAfterTheLast(t *testing.T) {
	records := inkLog()
	rig := newInkRig(t, records)
	timer := &graceTimer{}
	rig.svc.view.afterFunc = timer.afterFunc
	view := rig.svc.LiveView()
	heard := &liveRecorder{view: view}
	rig.svc.SetChangeListener(heard)
	addr := domain.NewContainerAddress(view.UUID())
	if _, err := view.Resolve(addr); !errors.Is(err, domain.ErrNodeNotFound) {
		t.Fatalf("before anything is live: %v", err)
	}
	session := rig.state.LoadSession()
	session.Tabs, session.ActiveIdx = []domain.Tab{{ID: "a-note", Kind: "note"}, {ID: view.UUID(), Kind: KindLive}}, 1
	if err := rig.state.SaveSession(session); err != nil {
		t.Fatal(err)
	}

	rig.companion.Live = true
	rig.enable(linkKey)
	rig.start()
	st := rig.await("live", func(st Status) bool {
		return st.Live.Present && st.Live.Note != "" && len(st.Notes) == 1 && st.Notes[0].Seq == uint32(len(records))
	})
	uuid := rig.container().UUID()
	if want := (LiveStatus{Present: true, UUID: view.UUID(), Device: aDevice.Name, Note: uuid, NoteTitle: "Ideas"}); st.Live != want {
		t.Errorf("status %+v, want %+v", st.Live, want)
	}
	node, err := view.Resolve(addr)
	if err != nil {
		t.Fatal(err)
	}
	note, _ := node.Attrs["note"].(map[string]interface{})
	pages, _ := note["pages"].([]interface{})
	device, _ := node.Attrs["note_device"].(map[string]interface{})
	if node.Kind != KindLive || node.ID != view.UUID() || node.Title != "Live · "+aDevice.Name || node.Attrs["id"] != view.UUID() ||
		len(pages) != 2 || device["name"] != aDevice.Name {
		t.Errorf("node %+v", node)
	}
	if want := uuid + " page=" + page(1).String() + " waiting=false"; heard.last() != want {
		t.Errorf("last change %q, want %q", heard.last(), want)
	}
	for _, other := range []domain.Address{domain.NewContainerAddress(uuid), domain.NewLeafAddress(view.UUID(), "x")} {
		if _, err := view.Resolve(other); !errors.Is(err, domain.ErrNodeNotFound) {
			t.Errorf("%s resolved: %v", other.String(), err)
		}
	}
	if !view.Claims(addr) || view.Claims(domain.NewContainerAddress(uuid)) {
		t.Error("the view claims an address other than its own uuid's, or not its own")
	}

	rig.stopPromptly()
	if want := uuid + " page=" + page(1).String() + " waiting=true"; heard.last() != want || !rig.svc.Status().Live.Waiting {
		t.Errorf("after the tablet stopped: %q, %+v", heard.last(), rig.svc.Status().Live)
	}
	rig.start()
	rig.await("live again", func(st Status) bool { return st.Live.Present && !st.Live.Waiting })
	timer.pass()
	if _, err := view.Resolve(addr); err != nil || timer.stopped == 0 {
		t.Errorf("a note live again within the grace: %v, %d graces stopped", err, timer.stopped)
	}

	rig.stopPromptly()
	timer.pass()
	if _, err := view.Resolve(addr); !errors.Is(err, domain.ErrNodeNotFound) || heard.last() != "gone" || rig.svc.Status().Live.Present || !view.Claims(addr) {
		t.Errorf("after the grace: %v, last change %q, claimed %t", err, heard.last(), view.Claims(addr))
	}
	rig.mu.Lock()
	deleted, sessionChanges := rig.deleted, rig.sessionChanges
	rig.mu.Unlock()
	if fmt.Sprint(deleted) != fmt.Sprint([]string{view.UUID()}) || sessionChanges != 1 {
		t.Errorf("deleted %v, session told %d times", deleted, sessionChanges)
	}
	if tabs := rig.state.LoadSession().Tabs; len(tabs) != 1 || tabs[0].ID != "a-note" {
		t.Errorf("tabs %+v, want the Live tab closed", tabs)
	}
}

// The Live view follows the live note from page to page and from note to note, telling the change
// listener of each move and the views of ink of each note it starts to mirror.
func TestLiveView_FollowsTheLiveNoteFromPageToPageAndNoteToNote(t *testing.T) {
	rig := newInkRig(t, nil)
	view := rig.svc.LiveView()
	heard := &liveRecorder{view: view}
	rig.svc.SetChangeListener(heard)
	other := testID(0xb0)
	x1, x2 := LiveNote{Container: "x", Note: noteID, Page: page(1)}, LiveNote{Container: "x", Note: noteID, Page: page(2)}
	y := LiveNote{Container: "y", Note: other, Page: page(3)}
	for _, live := range []LiveNote{x1, x1, x2, y} {
		view.follow(live)
	}
	want := []string{"x page=" + page(1).String() + " waiting=false", "x page=" + page(2).String() + " waiting=false",
		"y page=" + page(3).String() + " waiting=false"}
	if strings.Join(heard.lines, "\n") != strings.Join(want, "\n") {
		t.Errorf("changes\n%s\nwant\n%s", strings.Join(heard.lines, "\n"), strings.Join(want, "\n"))
	}
	if container, present := view.Mirrors(); container != "y" || !present {
		t.Errorf("mirrors %q, %t", container, present)
	}
	if n := rig.invalidations.Load(); n != 2 {
		t.Errorf("%d invalidations, want one as each note began to be mirrored", n)
	}
}

// OpenOnTablet sends the note's id and the page's to the tablet it came from and words the
// tablet's answer: live on the note, or refused with its reason. With no tablet connected, or another tablet than the
// note's, nothing is sent; a container that is no Digital Note is ErrNoSuchNote.
func TestInkService_OpenOnTabletAnswersWithTheTabletsOutcome(t *testing.T) {
	for _, c := range []struct {
		name    string
		answer  link.OpenNoteAnswer
		connect bool
		as      string
		want    OpenResult
	}{
		{"live", link.OpenNoteAnswer{}, true, "", OpenResult{Outcome: OpenOpened}},
		{"not in front", link.OpenNoteAnswer{Refuse: link.RefuseNotForeground}, true, "", OpenResult{Outcome: OpenRefused, Reason: link.RefuseNotForeground}},
		{"not offered", link.OpenNoteAnswer{Refuse: link.RefuseNotOffered}, true, "", OpenResult{Outcome: OpenRefused, Reason: link.RefuseNotOffered}},
		{"another tablet", link.OpenNoteAnswer{}, true, "another-companion", OpenResult{Outcome: OpenOtherTablet}},
		{"no tablet", link.OpenNoteAnswer{}, false, "", OpenResult{Outcome: OpenNoTablet}},
	} {
		t.Run(c.name, func(t *testing.T) {
			records := inkLog()
			rig := newInkRig(t, records)
			if err := rig.sync(); err != nil {
				t.Fatal(err)
			}
			uuid := rig.container().UUID()
			rig.companion.SetOpenNoteAnswer(c.answer)
			if c.as != "" {
				rig.radio.speakAs(c.as)
			}
			if c.connect {
				rig.enable(linkKey)
				rig.start()
				rig.await("connected", connected)
			}
			got, err := rig.svc.OpenOnTablet(uuid, page(2).String())
			if err != nil || got != c.want {
				t.Fatalf("%+v, %v; want %+v", got, err, c.want)
			}
			sent := 0
			for len(rig.companion.OpenNotes) > 0 {
				if asked := <-rig.companion.OpenNotes; asked != (link.OpenNoteRequest{Note: noteID, Page: page(2)}) {
					t.Errorf("OPEN-NOTE of %+v", asked)
				}
				sent++
			}
			if wantSent := map[bool]int{true: 1, false: 0}[c.want.Outcome == OpenOpened || c.want.Outcome == OpenRefused]; sent != wantSent {
				t.Errorf("%d OPEN-NOTEs sent, want %d", sent, wantSent)
			}
			if c.want.Outcome == OpenOpened {
				rig.await("the note live", func(st Status) bool { return rig.svc.Live().Container == uuid })
			}
		})
	}

	rig := newInkRig(t, nil)
	if _, err := rig.svc.OpenOnTablet("no-such-container", ""); !errors.Is(err, ErrNoSuchNote) {
		t.Errorf("a container that is no Digital Note: %v", err)
	}
}

// OpenOnTablet sends the page asked for when the note has it and the nil page id otherwise, and the
// LIVE that answers completes the request whether or not it moves anything: the note already live
// on the page asked for stays as it is, and the Live view follows a LIVE naming another page.
func TestInkService_OpenOnTabletAsksForThePageWhenTheNoteHasIt(t *testing.T) {
	for _, c := range []struct {
		name        string
		pageID      string
		live        bool
		sent, shown link.ID
	}{
		{"a page of the note", page(2).String(), false, page(2), page(2)},
		{"no page", "", false, link.ID{}, page(1)},
		{"a page id that does not parse", "page-2", false, link.ID{}, page(1)},
		{"a page the note does not have", page(9).String(), false, link.ID{}, page(1)},
		{"the page already live", page(1).String(), true, page(1), page(1)},
		{"another page of the note already live", page(2).String(), true, page(2), page(2)},
	} {
		t.Run(c.name, func(t *testing.T) {
			rig := newInkRig(t, inkLog())
			if err := rig.sync(); err != nil {
				t.Fatal(err)
			}
			uuid := rig.container().UUID()
			heard := &liveRecorder{view: rig.svc.LiveView()}
			rig.svc.SetChangeListener(heard)
			rig.companion.Live = c.live
			rig.enable(linkKey)
			rig.start()
			rig.await("connected", func(st Status) bool {
				return connected(st) && (!c.live || rig.svc.Live() == LiveNote{Container: uuid, Note: noteID, Page: page(1)})
			})
			got, err := rig.svc.OpenOnTablet(uuid, c.pageID)
			if err != nil || got != (OpenResult{Outcome: OpenOpened}) {
				t.Fatalf("%+v, %v", got, err)
			}
			if asked := <-rig.companion.OpenNotes; asked != (link.OpenNoteRequest{Note: noteID, Page: c.sent}) {
				t.Errorf("OPEN-NOTE of %+v, want page %s", asked, c.sent)
			}
			want := uuid + " page=" + c.shown.String() + " waiting=false"
			rig.await("the page shown live", func(Status) bool {
				return rig.svc.Live() == LiveNote{Container: uuid, Note: noteID, Page: c.shown} && heard.last() == want
			})
		})
	}
}

// OpenOnTablet waits for the tablet's answer on its own goroutine, never the session's: while it
// waits the link stays usable and stops promptly, and the wait ends with the session or once the
// injected clock says its few seconds are up.
func TestInkService_OpenOnTabletWaitsABoundedTimeAndHoldsNothingUp(t *testing.T) {
	for _, c := range []struct {
		name string
		end  func(rig *inkRig, fire chan time.Time)
		want OpenOutcome
	}{
		{"the wait runs out", func(_ *inkRig, fire chan time.Time) { fire <- time.Now() }, OpenNoAnswer},
		{"the session ends", func(rig *inkRig, _ chan time.Time) { rig.stopPromptly() }, OpenNoTablet},
	} {
		t.Run(c.name, func(t *testing.T) {
			records := inkLog()
			rig := newInkRig(t, records)
			if err := rig.sync(); err != nil {
				t.Fatal(err)
			}
			uuid := rig.container().UUID()
			rig.companion.SetOpenNoteAnswer(link.OpenNoteAnswer{Silent: true})
			waits, fire := make(chan time.Duration, 1), make(chan time.Time, 1)
			rig.svc.answerWait = func(d time.Duration) <-chan time.Time {
				waits <- d
				return fire
			}
			rig.enable(linkKey)
			rig.start()
			rig.await("connected", connected)
			result := make(chan OpenResult, 1)
			go func() {
				r, err := rig.svc.OpenOnTablet(uuid, "")
				if err != nil {
					t.Error(err)
				}
				result <- r
			}()
			if d := <-waits; d != openAnswerWait {
				t.Errorf("waits %v", d)
			}
			<-rig.companion.OpenNotes
			if st := rig.svc.Status(); !connected(st) || len(st.Notes) != 1 {
				t.Errorf("while waiting: %+v", st.Link)
			}
			c.end(rig, fire)
			select {
			case r := <-result:
				if r.Outcome != c.want {
					t.Errorf("%+v, want %s", r, c.want)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("the wait did not end")
			}
		})
	}
}

// awaitMetas is the METAs the companion has received once it has received n, failing after five
// seconds; a moment's wait shows none arrive beyond them.
func (rig *inkRig) awaitMetas(n int) []link.Meta {
	rig.t.Helper()
	waitFor(rig.t, func() bool { return len(rig.companion.ReceivedMetas()) >= n })
	time.Sleep(50 * time.Millisecond)
	got := rig.companion.ReceivedMetas()
	if len(got) != n {
		rig.t.Fatalf("the companion received %d METAs, want %d: %+v", len(got), n, got)
	}
	return got
}

// A description kept for a note goes to the tablet it came from while that tablet is connected
// and listed the note, as META of the description's fields and seq, and the seq sent is recorded:
// never for another tablet's note or one this tablet did not list, and not again for the same seq.
// A description kept while no tablet is connected goes once the tablet next lists the note.
func TestInkService_ADescriptionGoesToTheTabletItsNoteCameFrom(t *testing.T) {
	records := inkLog()
	rig := newInkRig(t, records)
	rig.enable(linkKey)
	rig.start()
	st := rig.await("caught up", func(st Status) bool {
		return connected(st) && len(st.Notes) == 1 && st.Notes[0].Seq == uint32(len(records))
	})
	uuid := st.Notes[0].UUID
	elsewhere := func(companion string, note link.ID) string {
		t.Helper()
		c, err := rig.svc.containers.Create(KindDigitalNote, map[string]interface{}{
			"title": "Elsewhere", "note_companion": companion, "note_source_id": note.String(), "note_synced_seq": 3})
		if err != nil {
			t.Fatal(err)
		}
		return c.UUID()
	}
	others := []string{elsewhere("another-companion", noteID), elsewhere(companionID, testID(0xb0))}
	for _, other := range others {
		if err := rig.svc.keepDescription(other, 3, kitchen); err != nil {
			t.Fatal(err)
		}
	}
	if err := rig.svc.keepDescription(uuid, uint32(len(records)), kitchen); err != nil {
		t.Fatal(err)
	}
	if err := rig.svc.keepDescription(uuid, uint32(len(records)), kitchen); err != nil {
		t.Fatal(err)
	}
	got := rig.awaitMetas(1)[0]
	want := link.Meta{Note: noteID, Title: kitchen.Title, Keywords: kitchen.Keywords, Categories: kitchen.Categories,
		Summary: kitchen.Summary, AsOfSeq: uint32(len(records))}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("META %+v, want %+v", got, want)
	}
	sent := func(uuid string) string {
		c, err := reopen(t, rig.st).Load(uuid)
		if err != nil {
			t.Fatal(err)
		}
		return c.Storable().Meta()["note_meta_sent_seq"]
	}
	if s := sent(uuid); s != "6" {
		t.Errorf("recorded as sent at %q", s)
	}
	for _, other := range others {
		if s := sent(other); s != "" {
			t.Errorf("a note not this tablet's to hear of is recorded as sent at %q", s)
		}
	}

	rig.stopPromptly()
	next := append(append([]link.Record(nil), records...), strokeAdd(page(1), stroke(9)))
	next[len(next)-1].Seq = uint32(len(next))
	rig.companion.SetRecords(next)
	renamed := domain.NoteMetadata{Title: "Kitchen, second pass", Keywords: []string{"extension"}, Summary: "Revised."}
	if err := rig.svc.keepDescription(uuid, uint32(len(next)), renamed); err != nil {
		t.Fatal(err)
	}
	rig.awaitMetas(1)
	rig.start()
	got = rig.awaitMetas(2)[1]
	if got.Note != noteID || got.Title != renamed.Title || got.AsOfSeq != uint32(len(next)) || len(got.Categories) != 0 {
		t.Errorf("META on the next session %+v", got)
	}
	if s := sent(uuid); s != "7" {
		t.Errorf("recorded as sent at %q after the next session", s)
	}
}

// namedLink is a link that is only ever asked whose it is.
type namedLink struct {
	radio.Link
	identity string
}

func (l namedLink) Identity() string { return l.identity }
