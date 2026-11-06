package ink

import (
	"context"
	"errors"
	"fmt"
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

// The errors NameNow returns for a note it cannot name now; NoteNamer.Refusal says each in words.
var (
	// ErrNamingUnavailable is the AI's tier being dumb.
	ErrNamingUnavailable = errors.New("ink: no AI is configured to name a note")
	// ErrNoInk is a note with no ink on any page.
	ErrNoInk = errors.New("ink: the note has no ink")
)

// NoteNamer gives Digital Notes their names. A note is due when no record has been committed to it
// for the settle time (domain.InkSettings.Settle) and its log has moved past the seq its stored
// description is of, whether or not the tablet shows it live. The settle time counts from the last
// record committed to it while the namer runs; for a note that has had none since the namer first
// started, from when its block was last saved, the modified time of its face, which a replica
// stamps whenever a session brings the note up to its head or ends; and from the namer's first
// start when its face carries none. A due note is described by one job in the AI pool, at most one
// per note at a time: the describer is shown images of its first eight pages and
// InkService.keepDescription keeps what it answers, of the seq the log stood at when the job
// began. A note that receives a record while its job runs is due again once it settles again.
// NameNow describes a note at once, due or not.
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
	held    map[string]*namedNote
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
	// last is when its log last changed, as far as the namer knows.
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
	n.running = true
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
func (n *NoteNamer) LiveChanged(LiveNote)         {}
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
	note := n.note(container, time.Time{})
	note.seq, note.last = max(note.seq, rec.Seq), n.now()
	n.arm()
}

// NameNow submits the job that describes the Digital Note in container uuid, whatever its settle
// time and whether or not its description is of the seq its log stands at now; it does nothing
// while that note's job runs. The note's first page is drawn before the job is submitted, so ctx
// bounds that drawing. A container that is not a Digital Note is ErrNoSuchPage, a note with no
// ink ErrNoInk, a dumb AI ErrNamingUnavailable, and nothing connected that can draw its pages
// ErrNoDrawer; Refusal says each in words.
func (n *NoteNamer) NameNow(ctx context.Context, uuid string) error {
	if n.describer.Tier() == domain.TierDumb {
		return ErrNamingUnavailable
	}
	log, err := n.notes.noteLog(uuid)
	if err != nil {
		return err
	}
	note := NewStrokeBasedNote(uuid)
	cursor, _ := note.Read(log)
	if !note.Inked() {
		return fmt.Errorf("%w: %s", ErrNoInk, uuid)
	}
	n.mu.Lock()
	held := n.note(uuid, time.Time{})
	if held.job {
		n.mu.Unlock()
		return nil
	}
	held.job = true
	n.mu.Unlock()
	if _, err := n.images.Image(ctx, uuid, 0); err != nil {
		n.idle(uuid)
		return err
	}
	logger.Info("ink: naming a note now, as asked", "container", uuid, "seq", cursor.Seq)
	n.submit(uuid, cursor.Seq, min(note.PageCount(), maxNamedPages))
	return nil
}

// Refusal is what a person asking NameNow is told of err, the error it returned.
func (n *NoteNamer) Refusal(err error) string {
	switch {
	case errors.Is(err, ErrNamingUnavailable):
		return "No AI is configured in Settings, so nothing can name this notebook."
	case errors.Is(err, ErrNoInk):
		return "This notebook has no ink to name it from."
	case errors.Is(err, ErrNoDrawer):
		return "Nothing is open that can draw this notebook's pages. Open Sieve's window and try again."
	case errors.Is(err, ErrNoSuchPage):
		return "This is not a notebook Sieve holds."
	case errors.Is(err, context.DeadlineExceeded):
		return "The window did not draw this notebook's pages in time. Try again."
	default:
		return "The notebook could not be named: " + err.Error()
	}
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
		note := n.note(uuid, domain.NewDocumentMeta(face, nil).Modified())
		note.seq = max(note.seq, kind.seq(face, "note_synced_seq"))
		note.described = max(note.described, kind.DescribedSeq(face))
	}
	now, settle := n.now(), n.settle()
	var ready []string
	for uuid, note := range n.held {
		if at, due := n.dueAt(note, settle); due && !now.Before(at) {
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
		n.retry(uuid, "ink: a note is not named while no AI is configured", nil)
		return
	}
	log, err := n.notes.noteLog(uuid)
	if err != nil {
		n.retry(uuid, "ink: a note could not be read to name it", err)
		return
	}
	note := NewStrokeBasedNote(uuid)
	cursor, _ := note.Read(log)
	if !note.Inked() {
		logger.Info("ink: a note with no ink is not named", "container", uuid, "seq", cursor.Seq)
		n.finished(uuid, cursor.Seq)
		return
	}
	n.submit(uuid, cursor.Seq, min(note.PageCount(), maxNamedPages))
}

// submit submits the job that describes the note in uuid, whose job flag is set, from its first
// pages pages, as its log stands at seq.
func (n *NoteNamer) submit(uuid string, seq uint32, pages int) {
	n.engine.Submit(services.JobDescriptor{
		Category: block.CategoryAI,
		Meta:     domain.JobInfo{JobID: "name-note:" + uuid, Label: "Naming " + n.notes.noteName(uuid), DocID: uuid},
		Work:     func() (any, error) { return n.describe(uuid, pages) },
		OnFinished: func(result any) {
			d := result.(domain.NoteMetadata)
			if err := n.notes.keepDescription(uuid, seq, d); err != nil {
				logger.Error("ink: keeping a note's description", "container", uuid, "err", err.Error())
				n.retry(uuid, "", nil)
				return
			}
			logger.Info("ink: named a note", "container", uuid, "seq", seq, "title", d.Title)
			n.finished(uuid, seq)
		},
		OnError: func(err error) {
			var drawing pageError
			if errors.As(err, &drawing) {
				n.retry(uuid, "ink: a note's pages could not be drawn to name it", err)
				return
			}
			logger.Warn("ink: describing a note failed", "container", uuid, "seq", seq, "err", err.Error())
			n.finished(uuid, seq)
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
	note := n.note(uuid, time.Time{})
	note.job, note.described, note.pause, note.retryAt = false, max(note.described, seq), 0, time.Time{}
	n.arm()
}

// idle is the note in uuid with no job, and nothing else known of it changed.
func (n *NoteNamer) idle(uuid string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.note(uuid, time.Time{}).job = false
	n.arm()
}

// retry is the note in uuid not described now, to be tried again after its pause. why, with err
// when it is not nil, is logged when a run of pauses begins, not on each try within it; "" logs
// nothing.
func (n *NoteNamer) retry(uuid, why string, err error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	note := n.note(uuid, time.Time{})
	if why != "" && note.pause == 0 {
		if err != nil {
			logger.Info(why, "container", uuid, "err", err.Error())
		} else {
			logger.Info(why, "container", uuid)
		}
	}
	note.pause = min(max(2*note.pause, retryBase), retryMax)
	note.job, note.retryAt = false, n.now().Add(note.pause)
	n.arm()
}

// dueAt is when note settles, and whether it is due, with no job running. n.mu is held.
func (n *NoteNamer) dueAt(note *namedNote, settle time.Duration) (time.Time, bool) {
	if note.job || note.seq <= note.described {
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
	for _, note := range n.held {
		if at, due := n.dueAt(note, settle); due && (first.IsZero() || at.Before(first)) {
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

// note is what is known of the note in uuid. A note not yet known is new, its log last changed at
// changed or, when that is the zero time, at the namer's first start. n.mu is held.
func (n *NoteNamer) note(uuid string, changed time.Time) *namedNote {
	note, ok := n.held[uuid]
	if !ok {
		if changed.IsZero() {
			changed = n.started
		}
		note = &namedNote{last: changed}
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
