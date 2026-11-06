package ink

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"sieve/sieve/domain"
	"sieve/sieve/ink/link"
	"sieve/sieve/services"
)

// fakeClock is the namer's clock, moved by the test: a timer fires when advance passes its time. It
// starts an hour ahead of the wall clock, so every save the store stamps during a test reads as
// long past.
type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
}

type fakeTimer struct {
	at      time.Time
	f       func()
	stopped bool
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Now().Add(time.Hour).Truncate(time.Second)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) AfterFunc(d time.Duration, f func()) func() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	timer := &fakeTimer{at: c.now.Add(d), f: f}
	c.timers = append(c.timers, timer)
	return func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		was := !timer.stopped
		timer.stopped = true
		return was
	}
}

// advance moves the clock on by d and fires, in time order, every timer due by then, those the
// fired ones set included.
func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
	for {
		c.mu.Lock()
		var due *fakeTimer
		for _, timer := range c.timers {
			if !timer.stopped && !timer.at.After(c.now) && (due == nil || timer.at.Before(due.at)) {
				due = timer
			}
		}
		if due != nil {
			due.stopped = true
		}
		c.mu.Unlock()
		if due == nil {
			return
		}
		due.f()
	}
}

// fakeDescriber answers every description with answer, or err, at tier, and keeps the pages it
// was shown. While hold is set each description waits for it to close.
type fakeDescriber struct {
	mu     sync.Mutex
	tier   domain.Tier
	answer domain.NoteMetadata
	err    error
	hold   chan struct{}
	shown  [][]domain.Address
}

func (d *fakeDescriber) Tier() domain.Tier {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.tier
}

func (d *fakeDescriber) DescribeNote(_ string, pages []domain.Address) (domain.NoteMetadata, error) {
	d.mu.Lock()
	d.shown = append(d.shown, pages)
	hold, answer, err := d.hold, d.answer, d.err
	d.mu.Unlock()
	if hold != nil {
		<-hold
	}
	return answer, err
}

func (d *fakeDescriber) calls() [][]domain.Address {
	d.mu.Lock()
	defer d.mu.Unlock()
	return slices.Clone(d.shown)
}

func (d *fakeDescriber) set(change func(*fakeDescriber)) {
	d.mu.Lock()
	defer d.mu.Unlock()
	change(d)
}

// kitchen is what the fake describer says of a note.
var kitchen = domain.NoteMetadata{Title: "Kitchen extension planning", Keywords: []string{"extension", "budget, rough"},
	Categories: []string{"Home"}, Summary: "Plans for the kitchen. A rough budget."}

// namerRig is an imagesRig whose note is named by a namer on a fake clock, with a settle time of
// ten seconds, a fake describer and the real job engine. The note's log last changed at the
// clock's start.
type namerRig struct {
	*imagesRig
	state     *services.StateService
	clock     *fakeClock
	describer *fakeDescriber
	tracker   *services.JobTracker
	engine    *services.JobEngine
	namer     *NoteNamer
}

const testSettle = 10 * time.Second

func newNamerRig(t *testing.T, records ...link.Record) *namerRig {
	t.Helper()
	rig := &namerRig{imagesRig: newImagesRig(t, records...), clock: newFakeClock(),
		describer: &fakeDescriber{tier: domain.TierSmart, answer: kitchen}, tracker: services.NewJobTracker()}
	state, err := services.NewStateService(rig.st, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	settings := state.LoadSettings()
	settings.Ink.SettleSeconds = int(testSettle / time.Second)
	if err := state.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	rig.state, rig.svc.settings = state, state
	rig.engine = services.NewJobEngine(nil, 2, rig.tracker)
	rig.changedAt(rig.clock.Now())
	rig.namer = rig.newNamer()
	return rig
}

// changedAt makes the note's face say its block was last saved at at.
func (rig *namerRig) changedAt(at time.Time) {
	rig.t.Helper()
	if _, err := rig.containers.SaveMeta(rig.uuid(), func(m domain.DocumentMeta) {
		m.All()["modified"] = at.Local().Format("2006-01-02T15:04:05")
	}); err != nil {
		rig.t.Fatal(err)
	}
}

// nameNow asks the namer to name the note now and waits until no naming job is queued or running.
func (rig *namerRig) nameNow() error {
	rig.t.Helper()
	err := rig.namer.NameNow(context.Background(), rig.uuid())
	rig.settled(0)
	return err
}

// newNamer is a namer over the rig, started, as a Sieve starting again builds it.
func (rig *namerRig) newNamer() *NoteNamer {
	n := NewNoteNamer(rig.svc, rig.images, rig.describer, rig.engine)
	n.now, n.afterFunc = rig.clock.Now, rig.clock.AfterFunc
	n.start()
	rig.t.Cleanup(n.stop)
	return n
}

// commit appends records to the replica and tells the namer of each, as a session does.
func (rig *namerRig) commit(records ...link.Record) {
	rig.t.Helper()
	for _, r := range records {
		rig.append(r)
		rig.namer.RecordCommitted(rig.uuid(), noteID, rig.appended[len(rig.appended)-1])
	}
}

// settled advances the clock by d and waits until no naming job is queued or running.
func (rig *namerRig) settled(d time.Duration) {
	rig.t.Helper()
	rig.clock.advance(d)
	waitFor(rig.t, func() bool {
		rig.namer.mu.Lock()
		defer rig.namer.mu.Unlock()
		for _, note := range rig.namer.held {
			if note.job {
				return false
			}
		}
		return len(rig.tracker.Active())+len(rig.tracker.Queued()) == 0
	})
}

// meta is the note's .meta as a fresh store reads it.
func (rig *namerRig) meta() map[string]string {
	rig.t.Helper()
	c, err := reopen(rig.t, rig.st).Load(rig.uuid())
	if err != nil {
		rig.t.Fatal(err)
	}
	return c.Storable().Meta()
}

// A note is named once it has gone the settle time without a record, counted from its face's last
// save for one found there: one job, shown its pages in order, whose description is kept in
// .meta, keywords whole and tags unbroken by a comma, the tablet's title left in the block, the
// version unmoved, and every tab of the note renamed. A named, unchanged note is not named again,
// by this namer or the next.
func TestNoteNamer_NamesANoteOnceItHasSettled(t *testing.T) {
	rig := newNamerRig(t, inkLog()...)
	session := rig.state.LoadSession()
	session.Tabs = []domain.Tab{{ID: rig.uuid(), Kind: KindDigitalNote, DisplayName: "Ideas"}, {ID: "other", DisplayName: "Other"}}
	if err := rig.state.SaveSession(session); err != nil {
		t.Fatal(err)
	}
	version := rig.container().Version()

	rig.settled(0)
	rig.settled(9 * time.Second)
	rig.commit(strokeAdd(page(2), stroke(7)))
	rig.settled(5 * time.Second)
	if calls := rig.describer.calls(); len(calls) != 0 {
		t.Fatalf("described %d times before the note settled", len(calls))
	}
	rig.settled(5 * time.Second)
	calls := rig.describer.calls()
	if len(calls) != 1 {
		t.Fatalf("described %d times once the note settled, want 1", len(calls))
	}
	want := []domain.Address{rig.image(0).Address, rig.image(1).Address}
	if !slices.EqualFunc(calls[0], want, domain.Address.Equal) {
		t.Errorf("shown %v, want the page images in page order %v", calls[0], want)
	}

	meta := rig.meta()
	for key, want := range map[string]string{
		"display_name": kitchen.Title, "summary": kitchen.Summary, "tags": "[extension, budget; rough]",
		"note_keywords": `["extension","budget, rough"]`, "note_categories": `["Home"]`, "note_meta_seq": "7",
		"note_title": "Ideas", "note_synced_seq": "6",
	} {
		if meta[key] != want {
			t.Errorf(".meta %s = %q, want %q", key, meta[key], want)
		}
	}
	if got := domain.NewDocumentMeta(meta, nil).Tags(); !slices.Equal(got, []string{"extension", "budget; rough"}) {
		t.Errorf("tags read back as %q", got)
	}
	if c := rig.container(); c.Block().StringAttr("title") != "Ideas" || c.Version() != version {
		t.Errorf("the block's title is %q at version %d, want the tablet's at %d", c.Block().StringAttr("title"), c.Version(), version)
	}
	tabs := rig.state.LoadSession().Tabs
	if tabs[0].DisplayName != kitchen.Title || tabs[1].DisplayName != "Other" {
		t.Errorf("tabs are named %q and %q", tabs[0].DisplayName, tabs[1].DisplayName)
	}
	if notes := rig.svc.Status().Notes; len(notes) != 1 || notes[0].Name != kitchen.Title || notes[0].Title != "Ideas" {
		t.Errorf("Status lists %+v", notes)
	}

	rig.settled(time.Minute)
	rig.namer.stop()
	rig.namer = rig.newNamer()
	rig.settled(0)
	rig.settled(time.Minute)
	if calls := rig.describer.calls(); len(calls) != 1 {
		t.Errorf("a named, unchanged note was described %d times", len(calls))
	}
}

// A note is named whether or not the tablet shows it live.
func TestNoteNamer_TheLiveNoteIsNamedToo(t *testing.T) {
	rig := newNamerRig(t, inkLog()...)
	rig.namer.LiveChanged(LiveNote{Container: rig.uuid(), Note: noteID, Page: page(1)})
	rig.settled(0)
	rig.settled(testSettle)
	if calls := rig.describer.calls(); len(calls) != 1 {
		t.Errorf("the live note, settled, was described %d times", len(calls))
	}
}

// A note found on its face when the namer starts settles the settle time after its block was last
// saved, so one quiet for longer is named at once and one saved just before waits only the rest.
func TestNoteNamer_SettlesFromTheFacesLastSaveAcrossARestart(t *testing.T) {
	for _, tc := range []struct {
		name  string
		saved time.Duration
		// wait is how long after the new namer starts the note is named.
		wait time.Duration
	}{
		{"quiet for an hour", -time.Hour, 0},
		{"saved four seconds before", -4 * time.Second, testSettle - 4*time.Second},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newNamerRig(t, inkLog()...)
			rig.namer.stop()
			rig.changedAt(rig.clock.Now().Add(tc.saved))
			rig.namer = rig.newNamer()
			if tc.wait > 0 {
				rig.settled(tc.wait - time.Second)
				if calls := rig.describer.calls(); len(calls) != 0 {
					t.Fatalf("described %d times before the note settled", len(calls))
				}
				rig.settled(time.Second)
			} else {
				rig.settled(0)
			}
			if calls := rig.describer.calls(); len(calls) != 1 {
				t.Errorf("described %d times once settled, want 1", len(calls))
			}
		})
	}
}

// NameNow names a note at once, unsettled and already described alike, and does nothing while its
// job runs, nor does the note settling meanwhile.
func TestNoteNamer_NameNowNamesANoteAtOnce(t *testing.T) {
	rig := newNamerRig(t, inkLog()...)
	if err := rig.nameNow(); err != nil {
		t.Fatal(err)
	}
	if calls := rig.describer.calls(); len(calls) != 1 || rig.meta()["note_meta_seq"] != "6" {
		t.Fatalf("an unsettled note asked for: %d descriptions, of seq %s", len(calls), rig.meta()["note_meta_seq"])
	}
	if err := rig.nameNow(); err != nil {
		t.Fatal(err)
	}
	if calls := rig.describer.calls(); len(calls) != 2 {
		t.Fatalf("a described note asked for again: %d descriptions, want 2", len(calls))
	}

	rig.commit(strokeAdd(page(1), stroke(9)))
	hold := make(chan struct{})
	rig.describer.set(func(d *fakeDescriber) { d.hold = hold })
	if err := rig.namer.NameNow(context.Background(), rig.uuid()); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(rig.describer.calls()) == 3 })
	if err := rig.namer.NameNow(context.Background(), rig.uuid()); err != nil {
		t.Fatal(err)
	}
	rig.clock.advance(testSettle)
	for deadline := time.Now().Add(100 * time.Millisecond); time.Now().Before(deadline); time.Sleep(time.Millisecond) {
		if calls := rig.describer.calls(); len(calls) != 3 {
			t.Fatalf("asked again while its job ran: %d descriptions, want 3", len(calls))
		}
	}
	close(hold)
	rig.settled(0)
	if calls := rig.describer.calls(); len(calls) != 3 || rig.meta()["note_meta_seq"] != "7" {
		t.Errorf("%d descriptions, of seq %s, want 3 of the record committed before the job", len(calls), rig.meta()["note_meta_seq"])
	}
}

// NameNow refuses a note it cannot name now, submitting nothing, and Refusal says why in words.
func TestNoteNamer_NameNowRefusesWhatItCannotName(t *testing.T) {
	for _, tc := range []struct {
		name  string
		log   []link.Record
		block func(*namerRig)
		uuid  func(*namerRig) string
		want  error
		says  string
	}{
		{"a dumb tier", inkLog(), func(rig *namerRig) { rig.describer.set(func(d *fakeDescriber) { d.tier = domain.TierDumb }) },
			nil, ErrNamingUnavailable, "No AI is configured"},
		{"no ink", logOf(header("Blank"), pageAdd(page(1), 0, nil, link.BoundsFixed)), func(*namerRig) {},
			nil, ErrNoInk, "no ink"},
		{"no drawer", inkLog(), func(rig *namerRig) { rig.drawer.err = fmt.Errorf("%w: no window", ErrNoDrawer) },
			nil, ErrNoDrawer, "Open Sieve's window"},
		{"not a note", inkLog(), func(*namerRig) {}, func(*namerRig) string { return "no-such-container" },
			ErrNoSuchPage, "not a notebook"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newNamerRig(t, tc.log...)
			tc.block(rig)
			uuid := rig.uuid()
			if tc.uuid != nil {
				uuid = tc.uuid(rig)
			}
			err := rig.namer.NameNow(context.Background(), uuid)
			if !errors.Is(err, tc.want) {
				t.Fatalf("NameNow = %v, want %v", err, tc.want)
			}
			if says := rig.namer.Refusal(err); !strings.Contains(says, tc.says) {
				t.Errorf("Refusal = %q, want it to say %q", says, tc.says)
			}
			rig.settled(0)
			if calls := rig.describer.calls(); len(calls) != 0 {
				t.Errorf("described %d times", len(calls))
			}
		})
	}
}

// A note has one job at a time. A record committed while it runs leaves the job to keep what it
// found, of the seq it began at, and the note due for the newer seq: it is named again once it
// settles again.
func TestNoteNamer_ARecordDuringTheJobLeavesTheNoteDue(t *testing.T) {
	rig := newNamerRig(t, inkLog()...)
	hold := make(chan struct{})
	rig.describer.set(func(d *fakeDescriber) { d.hold = hold })
	rig.settled(0)
	rig.clock.advance(testSettle)
	waitFor(t, func() bool { return len(rig.describer.calls()) == 1 })
	rig.commit(strokeAdd(page(1), stroke(8)))
	rig.clock.advance(time.Minute)
	if calls := rig.describer.calls(); len(calls) != 1 {
		t.Fatalf("a second job began while the first ran: %d", len(calls))
	}
	rig.describer.set(func(d *fakeDescriber) { d.hold = nil })
	close(hold)
	rig.settled(0)
	rig.settled(0)
	calls := rig.describer.calls()
	if len(calls) != 2 {
		t.Fatalf("described %d times, want again for the newer seq", len(calls))
	}
	if got := rig.meta()["note_meta_seq"]; got != "7" {
		t.Errorf("the last description is of seq %s, want 7", got)
	}
}

// At most the first eight pages are shown, in page order.
func TestNoteNamer_ShowsAtMostTheFirstEightPages(t *testing.T) {
	ops := []link.Record{header("Long")}
	for i := byte(0); i < 10; i++ {
		ops = append(ops, pageAdd(page(i), uint32(i), nil, link.BoundsFixed), strokeAdd(page(i), stroke(i)))
	}
	rig := newNamerRig(t, ops...)
	rig.settled(0)
	rig.settled(testSettle)
	calls := rig.describer.calls()
	if len(calls) != 1 || len(calls[0]) != maxNamedPages {
		t.Fatalf("shown %v", calls)
	}
	for i, addr := range calls[0] {
		if want := rig.image(i).Address; !addr.Equal(want) {
			t.Errorf("image %d is %v, want %v", i, addr, want)
		}
	}
}

// A note is not described while its pages cannot be drawn or the AI's tier is dumb, nor ever while
// it holds no ink: it stays due, and is tried again after a pause that doubles, until it can be.
func TestNoteNamer_ANoteThatCannotBeDescribedNowStaysDue(t *testing.T) {
	for _, tc := range []struct {
		name string
		log  []link.Record
		// block makes describing fail now, and unblock lets it succeed.
		block, unblock func(*namerRig)
		// attempts counts the tries made so far.
		attempts func(*namerRig) int
	}{
		{"no drawer", inkLog(),
			func(rig *namerRig) { rig.drawer.err = fmt.Errorf("%w: no window", ErrNoDrawer) },
			func(rig *namerRig) { rig.drawer.mu.Lock(); rig.drawer.err = nil; rig.drawer.mu.Unlock() },
			func(rig *namerRig) int { return len(rig.drawer.drawings()) }},
		{"a dumb tier", inkLog(),
			func(rig *namerRig) { rig.describer.set(func(d *fakeDescriber) { d.tier = domain.TierDumb }) },
			func(rig *namerRig) { rig.describer.set(func(d *fakeDescriber) { d.tier = domain.TierSmart }) },
			nil},
		{"no ink", logOf(header("Blank"), pageAdd(page(1), 0, nil, link.BoundsFixed)),
			func(*namerRig) {},
			func(rig *namerRig) { rig.commit(strokeAdd(page(1), stroke(1))); rig.clock.advance(testSettle) },
			nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newNamerRig(t, tc.log...)
			tc.block(rig)
			rig.settled(0)
			rig.settled(testSettle)
			if tc.attempts != nil && tc.attempts(rig) == 0 {
				t.Fatal("no attempt was made once the note settled")
			}
			tried := 0
			if tc.attempts != nil {
				tried = tc.attempts(rig)
				rig.settled(retryBase - time.Second)
				if got := tc.attempts(rig); got != tried {
					t.Errorf("tried again within the pause: %d → %d", tried, got)
				}
				rig.settled(time.Second)
				if got := tc.attempts(rig); got <= tried {
					t.Errorf("not tried again after the pause")
				}
			}
			if calls := rig.describer.calls(); len(calls) != 0 || len(rig.drawer.drawings()) > 0 && tc.attempts == nil {
				t.Fatalf("described %d times, drew %d pages", len(calls), len(rig.drawer.drawings()))
			}
			tc.unblock(rig)
			rig.settled(retryMax)
			if calls := rig.describer.calls(); len(calls) != 1 {
				t.Errorf("described %d times once it could be, want 1", len(calls))
			}
		})
	}
}

// A describer that fails leaves the note undescribed and is not asked again until the note's log
// moves.
func TestNoteNamer_AFailedDescriptionWaitsForTheNoteToChange(t *testing.T) {
	rig := newNamerRig(t, inkLog()...)
	rig.describer.set(func(d *fakeDescriber) { d.err = errors.New("the model said nothing") })
	rig.settled(0)
	rig.settled(testSettle)
	rig.settled(time.Hour)
	if calls := rig.describer.calls(); len(calls) != 1 {
		t.Fatalf("a failed description was asked for %d times", len(calls))
	}
	if _, ok := rig.meta()["note_meta_seq"]; ok {
		t.Error("a failed description was kept")
	}
	rig.describer.set(func(d *fakeDescriber) { d.err = nil })
	rig.commit(strokeAdd(page(1), stroke(9)))
	rig.settled(testSettle)
	if calls := rig.describer.calls(); len(calls) != 2 || rig.meta()["note_meta_seq"] != "7" {
		t.Errorf("after the note changed: %d descriptions, of seq %s", len(calls), rig.meta()["note_meta_seq"])
	}
}

// The job is named for the note and shown where jobs are while it runs.
func TestNoteNamer_TheJobIsLabelledWithTheNote(t *testing.T) {
	rig := newNamerRig(t, inkLog()...)
	hold := make(chan struct{})
	rig.describer.set(func(d *fakeDescriber) { d.hold = hold })
	rig.settled(0)
	rig.clock.advance(testSettle)
	waitFor(t, func() bool { return len(rig.tracker.Active()) == 1 })
	job := rig.tracker.Active()[0]
	if job.JobID != "name-note:"+rig.uuid() || job.Label != "Naming Ideas" || job.DocID != rig.uuid() || job.Category != "ai" {
		t.Errorf("the job is %+v", job)
	}
	close(hold)
	rig.settled(0)
}
