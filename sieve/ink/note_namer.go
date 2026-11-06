package ink

import (
	"context"
	"errors"
	"sync"
	"time"

	"sieve/logger"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/ink/link"
	"sieve/sieve/services"
)

// NoteDescriber describes a handwritten note from images of its pages. ai.AIService implements it.
type NoteDescriber interface {
	// Tier is the AI's tier now; nothing is described while it is domain.TierDumb.
	Tier() domain.Tier
	// DescribeNote describes the note in container uuid from pages, the absolute addresses of
	// images of its pages in page order, all assets of that container.
	DescribeNote(uuid string, pages []domain.Address) (domain.NoteMetadata, error)
}

// PageImager is the images of notes' pages. PageImages implements it.
type PageImager interface {
	Image(ctx context.Context, uuid string, page int) (PageImage, error)
}

var _ PageImager = (*PageImages)(nil)

// maxNamedPages is how many of a note's pages, from the first, the describer is shown.
const maxNamedPages = 8

// The pause before a note is tried again when its pages could not be drawn or the AI's tier is
// dumb: retryBase, doubled each time in a row, up to retryMax.
const (
	retryBase = 30 * time.Second
	retryMax  = 10 * time.Minute
)

// NoteNamer gives Digital Notes their names. A note is settled when it is not the live note and
// no record has been committed to it for the settle time (domain.InkSettings.Settle); for a note
// that has had no record since the namer first started, the time counts from then. A settled note
// whose log has moved past the seq its stored description is of is due, and is described by one
// job in the AI pool, at most one per note at a time: the describer is shown images of its first
// eight pages and InkService.keepDescription keeps what it answers, of the seq the log stood at
// when the job began. A note that receives a record while its job runs is due again once it
// settles again.
//
// Which notes are due is read from the faces of the notes held, without reading their logs, when
// the namer starts and whenever its one timer fires; the timer is set for the earliest moment a
// due note can settle. Nothing is described while the AI's tier is dumb, a note with no ink is
// never described, and a note whose pages cannot be drawn is tried again after a bounded pause. A
// describer that fails leaves the note undescribed until its log moves again or the namer starts
// again. It is safe for concurrent use.
type NoteNamer struct {
	notes     *InkService
	images    PageImager
	describer NoteDescriber
	engine    *services.JobEngine
	now       func() time.Time
	// afterFunc calls f once d has passed, unless the stop it returns is called first.
	afterFunc func(d time.Duration, f func()) (stop func() bool)

	mu      sync.Mutex
	running bool
	started time.Time
	// live is the container of the live note, "" when none is live.
	live string
	held map[string]*namedNote
	// stopTimer stops the pending wake, due at wakeAt; nil when none is pending. wakes numbers the
	// timers, so one that fires after another replaced it does nothing.
	stopTimer func() bool
	wakeAt    time.Time
	wakes     uint64
}

// namedNote is what the namer knows of one note.
type namedNote struct {
	// seq is the newest seq of the note's log known; described is the seq its stored description
	// is of, or the seq it was last found to need none at.
	seq, described uint32
	// last is when a record was last committed to it, or when the namer started.
	last time.Time
	job  bool
	// retryAt is when it may be tried again, after a pause of pause.
	retryAt time.Time
	pause   time.Duration
}

var _ Listener = (*NoteNamer)(nil)

// NewNoteNamer is the namer of notes's Digital Notes, which draws their pages through images,
// describes them through describer and runs its jobs on engine. It listens to notes from now on,
// and runs while notes runs.
func NewNoteNamer(notes *InkService, images PageImager, describer NoteDescriber, engine *services.JobEngine) *NoteNamer {
	n := &NoteNamer{
		notes: notes, images: images, describer: describer, engine: engine, now: time.Now, held: map[string]*namedNote{},
		afterFunc: func(d time.Duration, f func()) func() bool { return time.AfterFunc(d, f).Stop },
	}
	notes.attachNamer(n)
	return n
}

// start begins naming: the notes held are found from their faces at once. It does nothing while
// the namer runs.
func (n *NoteNamer) start() {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.running {
		return
	}
	n.running, n.live = true, ""
	if n.started.IsZero() {
		n.started = n.now()
	}
	n.setTimer(n.now())
}

// stop ends naming; a job already running finishes and its description is kept.
func (n *NoteNamer) stop() {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.running = false
	if n.stopTimer != nil {
		n.stopTimer()
		n.stopTimer = nil
	}
	n.wakes++
}

func (n *NoteNamer) LinkChanged(LinkState)        {}
func (n *NoteNamer) LiveInk([]link.LiveRecord)    {}
func (n *NoteNamer) LogRestarted(string, link.ID) {}

// RecordCommitted is a record committed to the note in container: it is not settled until the
// settle time has passed from now.
func (n *NoteNamer) RecordCommitted(container string, _ link.ID, rec link.Record) {
	if container == "" {
		return
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if !n.running {
		return
	}
	note := n.note(container)
	note.seq, note.last = max(note.seq, rec.Seq), n.now()
	n.arm()
}

// LiveChanged is the note in live.Container live, and no other.
func (n *NoteNamer) LiveChanged(live LiveNote) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if !n.running {
		return
	}
	n.live = live.Container
	n.arm()
}

// wake is the timer numbered wake firing: the notes held are read from their faces, a note no
// longer held is forgotten, and every due note that has settled is named.
func (n *NoteNamer) wake(wake uint64) {
	faces, err := n.notes.containers.Find(KindDigitalNote, nil)
	if err != nil {
		logger.Error("ink: finding notes to name", "err", err.Error())
	}
	kind := NewDigitalNoteKind()
	n.mu.Lock()
	if !n.running || wake != n.wakes {
		n.mu.Unlock()
		return
	}
	n.stopTimer = nil
	if err == nil {
		for uuid, note := range n.held {
			if _, held := faces[uuid]; !held && !note.job {
				delete(n.held, uuid)
			}
		}
	}
	for uuid, face := range faces {
		note := n.note(uuid)
		note.seq = max(note.seq, kind.seq(face, "note_synced_seq"))
		note.described = max(note.described, kind.DescribedSeq(face))
	}
	now, settle := n.now(), n.settle()
	var ready []string
	for uuid, note := range n.held {
		if at, due := n.dueAt(uuid, note, settle); due && !now.Before(at) {
			note.job = true
			ready = append(ready, uuid)
		}
	}
	n.arm()
	n.mu.Unlock()
	for _, uuid := range ready {
		n.name(uuid)
	}
}

// name submits the job that describes the note in uuid, whose job flag is set, or clears the flag
// when none is to run.
func (n *NoteNamer) name(uuid string) {
	if n.describer.Tier() == domain.TierDumb {
		n.retry(uuid)
		return
	}
	log, err := n.notes.noteLog(uuid)
	if err != nil {
		logger.Warn("ink: reading a note to name it", "container", uuid, "err", err.Error())
		n.retry(uuid)
		return
	}
	note := NewStrokeBasedNote(uuid)
	cursor, _ := note.Read(log)
	if !note.Inked() {
		n.finished(uuid, cursor.Seq)
		return
	}
	pages := min(note.PageCount(), maxNamedPages)
	n.engine.Submit(services.JobDescriptor{
		Category: block.CategoryAI,
		Meta:     domain.JobInfo{JobID: "name-note:" + uuid, Label: "Naming " + n.notes.noteName(uuid), DocID: uuid},
		Work:     func() (any, error) { return n.describe(uuid, pages) },
		OnFinished: func(result any) {
			if err := n.notes.keepDescription(uuid, cursor.Seq, result.(domain.NoteMetadata)); err != nil {
				logger.Error("ink: keeping a note's description", "container", uuid, "err", err.Error())
				n.retry(uuid)
				return
			}
			n.finished(uuid, cursor.Seq)
		},
		OnError: func(err error) {
			var drawing pageError
			if errors.As(err, &drawing) {
				logger.Info("ink: a note's pages could not be drawn to name it", "container", uuid, "err", err.Error())
				n.retry(uuid)
				return
			}
			logger.Warn("ink: describing a note failed", "container", uuid, "err", err.Error())
			n.finished(uuid, cursor.Seq)
		},
	})
}

// describe is the description of the note in uuid from the images of its first pages pages.
func (n *NoteNamer) describe(uuid string, pages int) (domain.NoteMetadata, error) {
	addresses := make([]domain.Address, 0, pages)
	for i := 0; i < pages; i++ {
		img, err := n.images.Image(context.Background(), uuid, i)
		if err != nil {
			return domain.NoteMetadata{}, pageError{err}
		}
		addresses = append(addresses, img.Address)
	}
	return n.describer.DescribeNote(uuid, addresses)
}

// finished is the job of the note in uuid over with the note described, or found to need no
// description, as of seq.
func (n *NoteNamer) finished(uuid string, seq uint32) {
	n.mu.Lock()
	defer n.mu.Unlock()
	note := n.note(uuid)
	note.job, note.described, note.pause, note.retryAt = false, max(note.described, seq), 0, time.Time{}
	n.arm()
}

// retry is the note in uuid not described now, to be tried again after its pause.
func (n *NoteNamer) retry(uuid string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	note := n.note(uuid)
	note.pause = min(max(2*note.pause, retryBase), retryMax)
	note.job, note.retryAt = false, n.now().Add(note.pause)
	n.arm()
}

// dueAt is when note, of container uuid, settles, and whether it is due and not live, with no job
// running. n.mu is held.
func (n *NoteNamer) dueAt(uuid string, note *namedNote, settle time.Duration) (time.Time, bool) {
	if note.job || note.seq <= note.described || uuid == n.live {
		return time.Time{}, false
	}
	at := note.last.Add(settle)
	if note.retryAt.After(at) {
		at = note.retryAt
	}
	return at, true
}

// arm sets the timer for when the first due note settles, unless one is set for sooner or the namer
// is not running. n.mu is held.
func (n *NoteNamer) arm() {
	if !n.running {
		return
	}
	var first time.Time
	settle := n.settle()
	for uuid, note := range n.held {
		if at, due := n.dueAt(uuid, note, settle); due && (first.IsZero() || at.Before(first)) {
			first = at
		}
	}
	if first.IsZero() || (n.stopTimer != nil && !n.wakeAt.After(first)) {
		return
	}
	n.setTimer(first)
}

// setTimer replaces the pending wake with one at at. n.mu is held.
func (n *NoteNamer) setTimer(at time.Time) {
	if n.stopTimer != nil {
		n.stopTimer()
	}
	n.wakes++
	wake := n.wakes
	n.wakeAt = at
	n.stopTimer = n.afterFunc(max(at.Sub(n.now()), 0), func() { n.wake(wake) })
}

// note is what is known of the note in uuid, new as of the namer's start when nothing is. n.mu is
// held.
func (n *NoteNamer) note(uuid string) *namedNote {
	note, ok := n.held[uuid]
	if !ok {
		note = &namedNote{last: n.started}
		n.held[uuid] = note
	}
	return note
}

// settle is how long a note must go without a record to settle.
func (n *NoteNamer) settle() time.Duration { return n.notes.settings.LoadSettings().Ink.Settle() }

// pageError is a page that could not be drawn for a description.
type pageError struct{ err error }

func (e pageError) Error() string { return e.err.Error() }
func (e pageError) Unwrap() error { return e.err }
