package ink

import (
	"context"
	"errors"
	"fmt"
	"io"
	"slices"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"sieve/logger"
	"sieve/sieve/domain"
	"sieve/sieve/ink/link"
	"sieve/sieve/ink/radio"
	"sieve/sieve/services"
)

// Invalidator is told what changed that the views of ink show.
type Invalidator interface {
	// InkChanged is what Settings → Ink or the sidebar's Ink section shows having changed: the
	// link, the last session's numbers, the synced notes or the Live view.
	InkChanged()
	// ContainerDeleted is container uuid no longer existing: the Live view, ended.
	ContainerDeleted(uuid string)
	// SessionChanged is the session's tabs having changed.
	SessionChanged()
}

// LinkPhase is where the link to a companion stands.
type LinkPhase string

const (
	LinkOff       LinkPhase = "off"
	LinkLooking   LinkPhase = "looking"
	LinkConnected LinkPhase = "connected"
)

// The problems a session can end on that the user must act on.
const (
	ProblemKeyRejected  = "key rejected — re-enter the key on the Boox"
	ProblemCompanionKey = "the companion could not prove the key"
)

// ErrNoSuchPage is an export of a container that is not a held Digital Note, or of a page it
// does not have.
var ErrNoSuchPage = errors.New("ink: no such note page")

// ErrNoSuchNote is a request about a container that is not a held Digital Note from a companion.
var ErrNoSuchNote = errors.New("ink: no such note")

// openAnswerWait is how long OpenOnTablet waits for the tablet's answer.
const openAnswerWait = 5 * time.Second

// OpenOutcome is what came of asking the tablet to open a note.
type OpenOutcome string

const (
	// OpenOpened is the tablet showing the note, live.
	OpenOpened OpenOutcome = "opened"
	// OpenNoTablet is no tablet connected.
	OpenNoTablet OpenOutcome = "no-tablet"
	// OpenOtherTablet is a tablet connected that is not the one the note came from.
	OpenOtherTablet OpenOutcome = "other-tablet"
	// OpenRefused is the tablet refusing, for OpenResult.Reason.
	OpenRefused OpenOutcome = "refused"
	// OpenNoAnswer is the tablet not answering in time.
	OpenNoAnswer OpenOutcome = "no-answer"
)

// OpenResult is what came of asking the tablet to open a note: the outcome and, when the tablet
// refused, its REFUSE reason (link.RefuseNotForeground, link.RefuseNotOffered or another).
type OpenResult struct {
	Outcome OpenOutcome
	Reason  string
}

// LinkState is the link as the user sees it.
type LinkState struct {
	Phase LinkPhase
	// Companion is the identity of the companion connected to, "" unless Phase is LinkConnected.
	Companion string
	// Problem is the failure the last session ended on, kept until a session next connects; ""
	// when there is none.
	Problem string
}

// LiveNote is the note and page a companion shows as being written. The zero LiveNote is none.
type LiveNote struct {
	// Container is the uuid of the container holding the note, "" when none holds it yet.
	Container string
	Note      link.ID
	Page      link.ID
}

// Listener hears what the service sees. Each listener is called on a goroutine of its own, one
// call at a time, in the order the events happened; the service never waits for a listener and
// holds none of its locks during a call. A slow listener therefore only falls behind, and its
// backlog is held in memory until it catches up, so a listener must return promptly. A listener
// may call any method of the service. Records and slices it is given are shared: it must not
// modify them.
type Listener interface {
	// LinkChanged is the link entering state.
	LinkChanged(state LinkState)
	// RecordCommitted is rec appended to the replica of the companion's note, held in container.
	RecordCommitted(container string, note link.ID, rec link.Record)
	// LiveInk is the live records of one INK frame.
	LiveInk(records []link.LiveRecord)
	// LiveChanged is the companion showing another note or page as live, or none.
	LiveChanged(live LiveNote)
	// LogRestarted is the replica of note, held in container, set aside: the container's log
	// starts again from seq 1, and every record RecordCommitted reports for it from now on is the
	// new log's.
	LogRestarted(container string, note link.ID)
}

// SessionNumbers are one session's measurements. The catch-up runs from the first note the
// session opens to bring it up to its head to the last such note done.
type SessionNumbers struct {
	// Companion is the companion's identity.
	Companion string
	// Connect is the time from the companion being seen to the stream being open.
	Connect time.Duration
	// Records is how many records the catch-up committed.
	Records int
	// Bytes is how many bytes the link received during the catch-up.
	Bytes int64
	// CatchUp is how long the catch-up took; zero when there was nothing to catch up.
	CatchUp time.Duration
}

// KBps is the catch-up's throughput in kilobytes a second, 0 when there was no catch-up.
func (n SessionNumbers) KBps() float64 {
	if n.CatchUp <= 0 {
		return 0
	}
	return float64(n.Bytes) / 1000 / n.CatchUp.Seconds()
}

// Companion is a companion this Sieve holds notes from.
type Companion struct {
	Identity string
	// Device is the name of the device its newest note was written on.
	Device string
	Notes  int
}

// SyncedNote is a Digital Note this Sieve holds: read from its replica while a session has it
// open, otherwise from its container's face.
type SyncedNote struct {
	UUID string
	// Name is what the note is called (DigitalNoteKind.Name); Title is the title the tablet wrote.
	Name      string
	Title     string
	Pages     int
	Seq       uint32
	Companion string
	// Device is the name of the device the note was written on.
	Device string
}

// Status is everything Settings → Ink and the sidebar's Ink section show.
type Status struct {
	Enabled bool
	// Key is this Sieve's pairing key in groups of four, "" before Ink is first enabled.
	Key string
	// SieveID is the name the key gives this Sieve on the link.
	SieveID string
	// Supported is false once the radio has said this platform has no Bluetooth ink.
	Supported bool
	Link      LinkState
	// Session is the current session's numbers, otherwise the last one's; HasSession is false
	// before any session connected.
	Session    SessionNumbers
	HasSession bool
	Companions []Companion
	Notes      []SyncedNote
	Live       LiveStatus
}

// InkService makes this Sieve the central for SieveInk companions. While Ink is enabled it dials
// a companion, replicates every note past this Sieve's cursor into a digital-note container,
// follows the note shown live, and dials again whenever the link ends. While it is disabled the
// radio is never dialled. It is safe for concurrent use.
type InkService struct {
	settings    *services.StateService
	containers  *services.BlockContainerService
	radio       radio.Radio
	invalidator Invalidator
	throttle    time.Duration
	// after is the clock the loop waits on between sessions.
	after func(time.Duration) <-chan time.Time
	// answerWait is the clock OpenOnTablet waits on for the tablet's answer.
	answerWait func(time.Duration) <-chan time.Time
	// wake cuts the loop's wait short, to wait the base pause instead.
	wake chan struct{}

	mu          sync.Mutex
	cancel      context.CancelFunc
	done        chan struct{}
	key         link.Key
	run         *sessionRun
	state       LinkState
	unsupported bool
	// radioProblem is the problem the radio itself last reported: Bluetooth off, or Sieve not
	// allowed to use it. It is shown until a Dial fails for another reason or succeeds.
	radioProblem string
	numbers      SessionNumbers
	hasNumbers   bool
	invalidated  time.Time
	// live is the note a session's companion shows as being written now; the zero LiveNote when none.
	live LiveNote
	// view is the Live view, which follows live.
	view   *LiveView
	feeds  []*listenerFeed
	redial redialPause
	// lastFailure is the error the last session ended on before connecting, "" after one connects.
	lastFailure string
	// namer names the notes while the service runs; nil when nothing names them.
	namer *NoteNamer
	// sending is held while a note's description is sent to the tablet and recorded as sent.
	sending sync.Mutex
}

// NewInkService is the service over this machine's settings and session, the container store and
// r. inv, which may be nil, hears every change the views of ink show. It does nothing until Start.
func NewInkService(settings *services.StateService, containers *services.BlockContainerService, r radio.Radio, inv Invalidator) *InkService {
	s := &InkService{
		settings: settings, containers: containers, radio: r, invalidator: inv,
		throttle: time.Second, after: time.After, answerWait: time.After, wake: make(chan struct{}, 1), state: LinkState{Phase: LinkOff},
		redial: redialPause{base: time.Second, max: 30 * time.Second},
	}
	s.view = newLiveView(s)
	return s
}

// LiveView is the service's Live view.
func (s *InkService) LiveView() *LiveView { return s.view }

// attachNamer makes namer the namer that runs while the service runs, and hears its events.
func (s *InkService) attachNamer(namer *NoteNamer) {
	s.Subscribe(namer)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.namer = namer
	if s.cancel != nil {
		namer.start()
	}
}

// SetChangeListener registers who is told that the Live view's node changed.
func (s *InkService) SetChangeListener(l services.ContainerChangeListener) { s.view.setListener(l) }

// Start begins looking for a companion when Ink is enabled, minting the key if there is none; it
// does nothing when Ink is disabled or the service is already running.
func (s *InkService) Start() error {
	settings := s.settings.LoadSettings()
	if !settings.Ink.Enabled {
		return nil
	}
	key, err := s.ensureKey(settings)
	if err != nil {
		return err
	}
	s.mu.Lock()
	if s.cancel != nil {
		s.mu.Unlock()
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.key, s.cancel, s.done = key, cancel, make(chan struct{})
	s.redial.reset()
	if s.namer != nil {
		s.namer.start()
	}
	go s.loop(ctx, s.done)
	s.mu.Unlock()
	return nil
}

// Stop ends the link and the loop, and returns once the open session's replicas are written. A
// naming job already running finishes and keeps what it finds.
func (s *InkService) Stop() {
	s.mu.Lock()
	cancel, done, namer := s.cancel, s.done, s.namer
	s.cancel, s.done = nil, nil
	s.mu.Unlock()
	if cancel == nil {
		return
	}
	if namer != nil {
		namer.stop()
	}
	cancel()
	<-done
	s.setState(LinkState{Phase: LinkOff})
}

// SetEnabled persists the setting and starts or stops the service to match. Enabling mints the
// key the first time.
func (s *InkService) SetEnabled(on bool) error {
	settings := s.settings.LoadSettings()
	settings.Ink.Enabled = on
	if err := s.settings.SaveSettings(settings); err != nil {
		return err
	}
	if !on {
		s.Stop()
		return nil
	}
	return s.Start()
}

// NewKey replaces this Sieve's key, so every paired companion must be paired again, drops the
// open link so the next one proves the new key, and dials again after the base pause.
func (s *InkService) NewKey() error {
	key, err := link.NewKey()
	if err != nil {
		return err
	}
	settings := s.settings.LoadSettings()
	settings.Ink.Key = key.Text()
	if err := s.settings.SaveSettings(settings); err != nil {
		return err
	}
	s.mu.Lock()
	s.key = key
	s.redial.reset()
	run := s.run
	if run != nil {
		run.dropped.Store(true)
	}
	s.mu.Unlock()
	if run != nil {
		run.link.Close()
	}
	select {
	case s.wake <- struct{}{}:
	default:
	}
	s.invalidate()
	return nil
}

// Subscribe adds l, which must be comparable, to the listeners; it hears events from now on, first
// of them LiveChanged for the note live now when one is.
func (s *InkService) Subscribe(l Listener) {
	s.mu.Lock()
	defer s.mu.Unlock()
	feed := &listenerFeed{listener: l}
	s.feeds = append(s.feeds, feed)
	if live := s.live; live != (LiveNote{}) {
		feed.push(func(l Listener) { l.LiveChanged(live) })
	}
}

// Unsubscribe removes l. A call already running finishes; nothing queued for l is delivered.
func (s *InkService) Unsubscribe(l Listener) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, f := range s.feeds {
		if f.listener == l {
			f.close()
			s.feeds = slices.Delete(s.feeds, i, i+1)
			return
		}
	}
}

// Status is the service's state as Settings → Ink shows it.
func (s *InkService) Status() Status {
	settings := s.settings.LoadSettings()
	st := Status{Enabled: settings.Ink.Enabled}
	if key, err := link.ParseKey(settings.Ink.Key); err == nil {
		st.Key, st.SieveID = key.Text(), key.SieveID()
	}
	s.mu.Lock()
	st.Supported, st.Link = !s.unsupported, s.state
	st.Session, st.HasSession = s.numbers, s.hasNumbers
	run := s.run
	s.mu.Unlock()
	var open []SyncedNote
	if run != nil {
		open = run.replicas.Notes()
	}
	st.Notes, st.Companions = s.synced(open)
	st.Live = s.view.Status()
	return st
}

// Notebook is the Digital Note in container uuid as the Meta panel shows it: the note as Status
// lists it and its stored description, with the seq that description is of (0 before it is
// named). A container that is not a Digital Note is ErrNoSuchPage.
func (s *InkService) Notebook(uuid string) (SyncedNote, domain.NoteMetadata, uint32, error) {
	c, err := s.digitalNote(uuid)
	if err != nil {
		return SyncedNote{}, domain.NoteMetadata{}, 0, err
	}
	meta := c.Storable().Meta()
	face := NewDigitalNoteKind().Face(c.Block())
	pages, _ := strconv.Atoi(face["note_pages"])
	seq, _ := strconv.ParseUint(face["note_synced_seq"], 10, 32)
	note := SyncedNote{UUID: uuid, Title: face["note_title"], Pages: pages, Seq: uint32(seq),
		Companion: face["note_companion"], Device: face["note_device"]}
	s.mu.Lock()
	run := s.run
	s.mu.Unlock()
	if run != nil {
		for _, open := range run.replicas.Notes() {
			if open.UUID == uuid {
				note = open
			}
		}
	}
	kind := NewDigitalNoteKind()
	note.Name = kind.Name(meta, note.Title)
	d, described, _ := kind.Description(meta)
	return note, d, described, nil
}

// Live is the note and page a companion shows as being written now; the zero LiveNote when none
// is. Listeners hear each change as LiveChanged after it has happened.
func (s *InkService) Live() LiveNote {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.live
}

// ExportPage is the page at index page of the Digital Note in container uuid, in the §4.2 export
// shape. A container that is not a Digital Note, or a page it does not have, is ErrNoSuchPage.
func (s *InkService) ExportPage(uuid string, page int) ([]byte, error) {
	c, err := s.digitalNote(uuid)
	if err != nil {
		return nil, err
	}
	var log []byte
	if asset, err := s.containers.LoadAsset(c, StrokesKey); err == nil {
		log = asset.Body()
	}
	note := ReadStrokeBasedNote(uuid, log)
	if page < 0 || page >= note.PageCount() {
		return nil, fmt.Errorf("%w: %s has %d pages, not page %d", ErrNoSuchPage, uuid, note.PageCount(), page)
	}
	return note.ExportPage(page)
}

// OpenOnTablet asks the tablet the Digital Note in container uuid came from to open it at the page
// pageID names, sending it the note's id and that page's, and waits a few seconds at most for its
// answer. pageID is a page id as the note's pages list it; "", or one that does not parse or is
// not one of the note's pages, is sent as the nil page id, leaving the page to the tablet. The
// tablet must be connected now: nothing is queued for a later session. A container that is not a
// Digital Note from a companion is ErrNoSuchNote. It may be called from any goroutine and never
// holds up the session.
func (s *InkService) OpenOnTablet(uuid, pageID string) (OpenResult, error) {
	attrs := s.noteAttrs(uuid)
	if attrs == nil {
		return OpenResult{}, fmt.Errorf("%w: %s", ErrNoSuchNote, uuid)
	}
	companion, _ := attrs["note_companion"].(string)
	source, _ := attrs["note_source_id"].(string)
	note, err := link.ParseID(source)
	if err != nil || companion == "" {
		return OpenResult{}, fmt.Errorf("%w: %s came from no companion", ErrNoSuchNote, uuid)
	}
	s.mu.Lock()
	run, wait := s.run, s.answerWait
	s.mu.Unlock()
	if run == nil || run.session == nil {
		return OpenResult{Outcome: OpenNoTablet}, nil
	}
	if run.link.Identity() != companion {
		return OpenResult{Outcome: OpenOtherTablet}, nil
	}
	answer, err := run.session.OpenNote(note, s.pageOf(uuid, pageID))
	if err != nil {
		return OpenResult{Outcome: OpenNoTablet}, nil
	}
	select {
	case err := <-answer:
		var refused *link.RefusedError
		switch {
		case err == nil:
			return OpenResult{Outcome: OpenOpened}, nil
		case errors.As(err, &refused):
			return OpenResult{Outcome: OpenRefused, Reason: refused.Reason}, nil
		default:
			return OpenResult{Outcome: OpenNoTablet}, nil
		}
	case <-wait(openAnswerWait):
		return OpenResult{Outcome: OpenNoAnswer}, nil
	}
}

// pageOf is the page of the Digital Note in container uuid that pageID names, the zero ID when
// pageID does not parse or the note has no such page now.
func (s *InkService) pageOf(uuid, pageID string) link.ID {
	page, err := link.ParseID(pageID)
	if err != nil {
		return link.ID{}
	}
	log, err := s.noteLog(uuid)
	if err != nil {
		return link.ID{}
	}
	note := NewHeaderFold(uuid)
	note.Read(log)
	if note.present(page) < 0 {
		return link.ID{}
	}
	return page
}

// noteLog is the whole log of the Digital Note in container uuid as it stands now: the open
// session's replica of it, queue included, otherwise its asset. A container that is not a
// Digital Note is ErrNoSuchPage.
func (s *InkService) noteLog(uuid string) ([]byte, error) {
	c, err := s.digitalNote(uuid)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	run := s.run
	s.mu.Unlock()
	if run != nil {
		if log, ok := run.replicas.log(uuid); ok {
			return log, nil
		}
	}
	if asset, err := s.containers.LoadAsset(c, StrokesKey); err == nil {
		return asset.Body(), nil
	}
	return nil, nil
}

// noteAttrs are the attrs of the Digital Note in container uuid as they stand now: its open
// replica's, otherwise its block's; nil when no Digital Note is held there.
func (s *InkService) noteAttrs(uuid string) map[string]interface{} {
	if uuid == "" {
		return nil
	}
	s.mu.Lock()
	run := s.run
	s.mu.Unlock()
	if run != nil {
		if attrs, ok := run.replicas.attrsOf(uuid); ok {
			return attrs
		}
	}
	c, err := s.digitalNote(uuid)
	if err != nil {
		return nil
	}
	return c.Block().Attrs
}

// noteName is what the Digital Note in container uuid is called (DigitalNoteKind.Name), its
// tablet's title read as noteAttrs reads it; "" when no Digital Note is held there.
func (s *InkService) noteName(uuid string) string {
	attrs := s.noteAttrs(uuid)
	if attrs == nil {
		return ""
	}
	title, _ := attrs["title"].(string)
	var meta map[string]string
	if c, err := s.containers.Load(uuid); err == nil {
		meta = c.Storable().Meta()
	}
	return NewDigitalNoteKind().Name(meta, title)
}

// keepDescription keeps d as the description of the Digital Note in container uuid as its log
// stood at seq, in its .meta, and then shows it: the ink views are invalidated, every session tab
// of the note takes its name, the Live view is told when it mirrors the note, and the description
// is sent to the tablet as sendDescription sends it. The block, and the title the tablet wrote in
// it, are not touched.
func (s *InkService) keepDescription(uuid string, seq uint32, d domain.NoteMetadata) error {
	if err := s.writeNoteMeta(uuid, func(m domain.DocumentMeta) { NewDigitalNoteKind().Describe(m, d, seq) }); err != nil {
		return err
	}
	s.invalidate()
	renamed, err := s.settings.RenameTabs(uuid, s.noteName(uuid))
	if err != nil {
		logger.Error("ink: renaming a named note's tabs", "container", uuid, "err", err.Error())
	}
	if renamed && s.invalidator != nil {
		s.invalidator.SessionChanged()
	}
	s.view.noteChanged(uuid)
	s.sendDescription(uuid)
	return nil
}

// writeNoteMeta applies edit to the .meta of container uuid: under the open replica holding it,
// whose handle then holds what was written, when a session has one, otherwise directly.
func (s *InkService) writeNoteMeta(uuid string, edit func(domain.DocumentMeta)) error {
	s.mu.Lock()
	run := s.run
	s.mu.Unlock()
	if run != nil {
		if held, err := run.replicas.writeMeta(uuid, edit); held {
			return err
		}
	}
	_, err := s.containers.SaveMeta(uuid, edit)
	return err
}

// sendDescription sends META of the Digital Note in container uuid, and records the seq sent, when
// the session running now is with the tablet the note came from, that tablet listed the note on
// this connection, and the note's stored description is of a later seq than the one last sent,
// and not past the head the tablet listed. META carries the description's fields and seq, and
// nothing else.
func (s *InkService) sendDescription(uuid string) {
	s.sending.Lock()
	defer s.sending.Unlock()
	c, err := s.digitalNote(uuid)
	if err != nil {
		return
	}
	kind, meta := NewDigitalNoteKind(), c.Storable().Meta()
	d, seq, ok := kind.Description(meta)
	if !ok || seq <= kind.SentSeq(meta) {
		return
	}
	note, err := link.ParseID(meta["note_source_id"])
	if err != nil {
		return
	}
	s.mu.Lock()
	run := s.run
	s.mu.Unlock()
	if run == nil || run.session == nil || run.link.Identity() != meta["note_companion"] {
		return
	}
	if head, listed := run.listedHead(note); !listed || seq > head {
		return
	}
	m := link.Meta{Note: note, Title: d.Title, Keywords: d.Keywords, Categories: d.Categories, Summary: d.Summary, AsOfSeq: seq}
	if err := run.session.SendMeta(m); err != nil {
		logger.Info("ink: a note's description was not sent", "container", uuid, "err", err.Error())
		return
	}
	if err := s.writeNoteMeta(uuid, func(m domain.DocumentMeta) { kind.MarkSent(m, seq) }); err != nil {
		logger.Error("ink: recording a sent description", "container", uuid, "err", err.Error())
	}
}

// sendDescriptions sends, as sendDescription does, the description of every note of run's tablet
// whose stored description is of a later seq than the one last sent.
func (s *InkService) sendDescriptions(run *sessionRun) {
	found, err := s.containers.Find(KindDigitalNote, map[string]string{"note_companion": run.link.Identity()})
	if err != nil {
		logger.Error("ink: finding descriptions to send", "err", err.Error())
		return
	}
	kind := NewDigitalNoteKind()
	for uuid, meta := range found {
		if kind.DescribedSeq(meta) > kind.SentSeq(meta) {
			s.sendDescription(uuid)
		}
	}
}

// liveEnded closes every session tab of the Live view uuid, which has ended.
func (s *InkService) liveEnded(uuid string) {
	if _, err := s.settings.CloseTabs(func(t domain.Tab) bool { return t.ID == uuid }); err != nil {
		logger.Error("ink: closing the Live view's tabs", "err", err.Error())
	}
}

// digitalNote is the container uuid, which must be a Digital Note; otherwise ErrNoSuchPage.
func (s *InkService) digitalNote(uuid string) (*domain.BlockContainer, error) {
	c, err := s.containers.Load(uuid)
	if err != nil {
		return nil, fmt.Errorf("%w: %s: %v", ErrNoSuchPage, uuid, err)
	}
	if c.Kind() != KindDigitalNote {
		return nil, fmt.Errorf("%w: %s is a %s", ErrNoSuchPage, uuid, c.Kind())
	}
	return c, nil
}

// ensureKey is the key in settings, minted and saved when there is none.
func (s *InkService) ensureKey(settings domain.Settings) (link.Key, error) {
	if key, err := link.ParseKey(settings.Ink.Key); err == nil {
		return key, nil
	}
	key, err := link.NewKey()
	if err != nil {
		return key, err
	}
	settings.Ink.Key = key.Text()
	return key, s.settings.SaveSettings(settings)
}

// loop runs sessions until ctx ends, pausing between them as redial says; a radio this platform
// does not support is not dialled again.
func (s *InkService) loop(ctx context.Context, done chan struct{}) {
	defer close(done)
	for {
		rejected := s.session(ctx)
		s.mu.Lock()
		unsupported := s.unsupported
		pause := s.redial.next(rejected)
		s.mu.Unlock()
		if unsupported {
			<-ctx.Done()
			return
		}
		if !s.wait(ctx, pause) {
			return
		}
	}
}

// wait pauses for d, or for the base pause from a wake on, and reports whether ctx is still live.
func (s *InkService) wait(ctx context.Context, d time.Duration) bool {
	for {
		select {
		case <-ctx.Done():
			return false
		case <-s.wake:
			s.mu.Lock()
			d = s.redial.base
			s.mu.Unlock()
		case <-s.after(d):
			return true
		}
	}
}

// session dials once and, when a companion answers, runs one session over it to its end. It
// reports whether the companion refused this Sieve's key or could not prove it.
func (s *InkService) session(ctx context.Context) bool {
	s.mu.Lock()
	problem := s.state.Problem
	s.mu.Unlock()
	s.setState(LinkState{Phase: LinkLooking, Problem: problem})
	l, err := s.radio.Dial(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return false
		}
		if errors.Is(err, radio.ErrBluetoothUnsupported) {
			s.mu.Lock()
			s.unsupported = true
			s.mu.Unlock()
			s.invalidate()
			return false
		}
		if errors.Is(err, radio.ErrBluetoothOff) || errors.Is(err, radio.ErrBluetoothNotAuthorised) {
			s.setRadioProblem(err.Error())
			return false
		}
		s.setRadioProblem("")
		logger.Debug("ink: no companion", "err", err.Error())
		return false
	}
	s.setRadioProblem("")
	run := &sessionRun{svc: s, link: l, received: &countedReader{r: l},
		replicas: NewNoteReplicas(s.containers, l.Identity())}
	s.mu.Lock()
	run.session = link.NewSession(run, s.key, run.replicas, run, link.Plan{CatchUp: true, Follow: true})
	s.run = run
	s.mu.Unlock()
	stop := context.AfterFunc(ctx, func() { l.Close() })
	err = run.session.Run()
	stop()
	l.Close()
	if endErr := run.replicas.End(); endErr != nil {
		logger.Error("ink: ending a session's replicas", "err", endErr.Error())
	}
	s.mu.Lock()
	s.run = nil
	s.mu.Unlock()
	return run.end(ctx, err)
}

// connected starts a session's numbers and enters the connected state.
func (s *InkService) connected(companion string, connect time.Duration) {
	s.mu.Lock()
	s.numbers, s.hasNumbers = SessionNumbers{Companion: companion, Connect: connect}, true
	s.redial.reset()
	s.lastFailure = ""
	s.mu.Unlock()
	s.setState(LinkState{Phase: LinkConnected, Companion: companion})
}

// setState enters state and reports whether it changed; a change is published and invalidated.
func (s *InkService) setState(state LinkState) bool {
	s.mu.Lock()
	changed := s.state != state
	s.state = state
	s.mu.Unlock()
	if changed {
		s.publish(func(l Listener) { l.LinkChanged(state) })
		s.invalidate()
	}
	return changed
}

// setRadioProblem shows problem as the link's problem, and with "" withdraws the one it showed
// last, leaving a problem a session ended on in place.
func (s *InkService) setRadioProblem(problem string) {
	s.mu.Lock()
	state, shown := s.state, s.radioProblem
	s.radioProblem = problem
	s.mu.Unlock()
	if problem == shown {
		return
	}
	if problem != "" || state.Problem == shown {
		state.Problem = problem
		s.setState(state)
	}
}

// publish queues event for every listener.
func (s *InkService) publish(event func(Listener)) {
	s.mu.Lock()
	feeds := append([]*listenerFeed(nil), s.feeds...)
	s.mu.Unlock()
	for _, f := range feeds {
		f.push(event)
	}
}

// invalidate tells the invalidator now.
func (s *InkService) invalidate() {
	s.mu.Lock()
	s.invalidated = time.Now()
	s.mu.Unlock()
	if s.invalidator != nil {
		s.invalidator.InkChanged()
	}
}

// invalidateSoon tells the invalidator unless it was told within the throttle.
func (s *InkService) invalidateSoon() {
	s.mu.Lock()
	due := time.Since(s.invalidated) >= s.throttle
	s.mu.Unlock()
	if due {
		s.invalidate()
	}
}

// synced lists the held Digital Notes by name and the companions they came from: each note in
// open as it stands there, every other from its face.
func (s *InkService) synced(open []SyncedNote) ([]SyncedNote, []Companion) {
	found, err := s.containers.Find(KindDigitalNote, nil)
	if err != nil {
		logger.Error("ink: listing synced notes", "err", err.Error())
		return nil, nil
	}
	byUUID := map[string]SyncedNote{}
	for uuid, face := range found {
		pages, _ := strconv.Atoi(face["note_pages"])
		seq, _ := strconv.ParseUint(face["note_synced_seq"], 10, 32)
		byUUID[uuid] = SyncedNote{UUID: uuid, Title: face["note_title"], Pages: pages, Seq: uint32(seq),
			Companion: face["note_companion"], Device: face["note_device"]}
	}
	for _, n := range open {
		byUUID[n.UUID] = n
	}
	kind := NewDigitalNoteKind()
	notes := make([]SyncedNote, 0, len(byUUID))
	for uuid, n := range byUUID {
		n.Name = kind.Name(found[uuid], n.Title)
		notes = append(notes, n)
	}
	sort.Slice(notes, func(i, j int) bool { return notes[i].UUID < notes[j].UUID })
	byIdentity := map[string]int{}
	var companions []Companion
	for _, n := range notes {
		if n.Companion == "" {
			continue
		}
		i, ok := byIdentity[n.Companion]
		if !ok {
			i = len(companions)
			companions = append(companions, Companion{Identity: n.Companion})
			byIdentity[n.Companion] = i
		}
		companions[i].Notes++
		if n.Device != "" {
			companions[i].Device = n.Device
		}
	}
	sort.SliceStable(notes, func(i, j int) bool { return notes[i].Name < notes[j].Name })
	sort.Slice(companions, func(i, j int) bool { return companions[i].Identity < companions[j].Identity })
	return notes, companions
}

// sessionRun is one session: the link it runs over, counted as it is read, and its replicas. It
// is the session's Observer and is called on the session's goroutine only.
type sessionRun struct {
	svc      *InkService
	session  *link.Session
	link     radio.Link
	received *countedReader
	replicas *NoteReplicas
	// dropped marks a link the service closed on purpose, whose error is no failure.
	dropped atomic.Bool

	// listed is the head of each note the companion listed on this connection, by note.
	listedMu sync.Mutex
	listed   map[link.ID]uint32

	connected bool
	// pending are the notes the catch-up has still to bring to their heads.
	pending  map[link.ID]bool
	started  time.Time
	from     int64
	caughtUp int
	live     bool
}

var (
	_ link.Observer = (*sessionRun)(nil)
	_ io.ReadWriter = (*sessionRun)(nil)
)

func (r *sessionRun) Read(p []byte) (int, error)  { return r.received.Read(p) }
func (r *sessionRun) Write(p []byte) (int, error) { return r.link.Write(p) }

// Notes is a NOTES frame: of the notes it lists, every description newer than the one last sent is
// sent. The first is the sign the handshake held: the session is connected, and the notes past what
// this Sieve holds are the catch-up.
func (r *sessionRun) Notes(notes []link.NoteEntry) {
	r.listedMu.Lock()
	r.listed = make(map[link.ID]uint32, len(notes))
	for _, n := range notes {
		r.listed[n.ID] = n.HeadSeq
	}
	r.listedMu.Unlock()
	go r.svc.sendDescriptions(r)
	if r.connected {
		return
	}
	r.connected = true
	r.pending = map[link.ID]bool{}
	for _, n := range notes {
		if have, err := r.replicas.Have(n.ID); err == nil && n.HeadSeq > have {
			r.pending[n.ID] = true
		}
	}
	r.svc.connected(r.link.Identity(), r.link.Elapsed())
}

// listedHead is the head the companion listed note at on this connection; false when it did not
// list the note. It may be called from any goroutine.
func (r *sessionRun) listedHead(note link.ID) (uint32, bool) {
	r.listedMu.Lock()
	defer r.listedMu.Unlock()
	head, ok := r.listed[note]
	return head, ok
}

func (r *sessionRun) Opened(note link.ID, _, _ uint32) {
	if r.pending[note] && r.started.IsZero() {
		r.started, r.from = time.Now(), r.received.n.Load()
	}
}

func (r *sessionRun) Committed(note link.ID, rec link.Record) {
	uuid, err := r.replicas.UUID(note)
	if err != nil {
		logger.Warn("ink: finding a committed note's container", "note", note.String(), "err", err.Error())
	}
	r.svc.publish(func(l Listener) { l.RecordCommitted(uuid, note, rec) })
	r.svc.mu.Lock()
	live := r.svc.live
	r.svc.mu.Unlock()
	if live.Note == note && live.Container == "" && uuid != "" {
		r.Live(note, live.Page)
	}
	structural := rec.Op != link.OpStrokeAdd && rec.Op != link.OpStrokeRemove
	if structural {
		r.svc.view.noteChanged(uuid)
	}
	if len(r.pending) > 0 || structural {
		r.svc.invalidateSoon()
	}
}

// Done is the note at its head: its replica saves what it holds, and the catch-up's numbers move.
func (r *sessionRun) Done(note link.ID, _ uint32, records int) {
	if err := r.replicas.CaughtUp(note); err != nil {
		logger.Error("ink: saving a caught-up note", "note", note.String(), "err", err.Error())
	}
	if !r.pending[note] {
		return
	}
	delete(r.pending, note)
	r.caughtUp += records
	r.measure()
}

func (r *sessionRun) Live(note, page link.ID) {
	live := LiveNote{Note: note, Page: page}
	if note != (link.ID{}) {
		uuid, err := r.replicas.UUID(note)
		if err != nil {
			logger.Warn("ink: finding the live note's container", "note", note.String(), "err", err.Error())
		}
		live.Container = uuid
	}
	r.live = note != (link.ID{})
	r.svc.mu.Lock()
	r.svc.live = live
	r.svc.mu.Unlock()
	r.svc.view.follow(live)
	r.svc.publish(func(l Listener) { l.LiveChanged(live) })
}

func (r *sessionRun) SetAside(note link.ID) {
	uuid, err := r.replicas.UUID(note)
	if err != nil {
		logger.Warn("ink: finding a set-aside note's container", "note", note.String(), "err", err.Error())
	}
	if uuid != "" {
		r.svc.publish(func(l Listener) { l.LogRestarted(uuid, note) })
	}
}

func (r *sessionRun) Ink(records []link.LiveRecord) {
	r.svc.publish(func(l Listener) { l.LiveInk(records) })
}

func (r *sessionRun) Refused(note link.ID, reason string) {
	logger.Warn("ink: the companion refused a note", "note", note.String(), "reason", reason)
	if reason != link.RefuseAhead && r.pending[note] {
		delete(r.pending, note)
		r.measure()
	}
}

// measure writes the catch-up's numbers so far, and tells the invalidator when it is over.
func (r *sessionRun) measure() {
	var elapsed time.Duration
	var bytes int64
	if !r.started.IsZero() {
		elapsed, bytes = time.Since(r.started), r.received.n.Load()-r.from
	}
	s := r.svc
	s.mu.Lock()
	s.numbers.Records, s.numbers.Bytes, s.numbers.CatchUp = r.caughtUp, bytes, elapsed
	s.mu.Unlock()
	if len(r.pending) == 0 {
		s.invalidate()
	}
}

// end is the session over on err: nothing is live any more, and a failure the user must see is
// kept as the state's problem. A session ended by Stop or by a new key is no failure. It reports
// whether the companion refused this Sieve's key or could not prove it. A session that ends
// before connecting on the error the one before it ended on is logged at Debug.
func (r *sessionRun) end(ctx context.Context, err error) bool {
	if r.live {
		r.svc.mu.Lock()
		r.svc.live = LiveNote{}
		r.svc.mu.Unlock()
		r.svc.view.follow(LiveNote{})
		r.svc.publish(func(l Listener) { l.LiveChanged(LiveNote{}) })
	}
	text := fmt.Sprint(err)
	s := r.svc
	s.mu.Lock()
	repeat := !r.connected && err != nil && text == s.lastFailure
	if !r.connected && err != nil {
		s.lastFailure = text
	} else {
		s.lastFailure = ""
	}
	s.mu.Unlock()
	if repeat {
		logger.Debug("ink: session ended", "companion", r.link.Identity(), "err", text)
	} else {
		logger.Info("ink: session ended", "companion", r.link.Identity(), "err", text)
	}
	if ctx.Err() != nil {
		s.invalidate()
		return false
	}
	state := LinkState{Phase: LinkLooking}
	rejected := false
	switch {
	case r.dropped.Load() || err == nil:
	case errors.Is(err, link.ErrRefused):
		state.Problem, rejected = ProblemKeyRejected, true
	case errors.Is(err, link.ErrBadCompanion):
		state.Problem, rejected = ProblemCompanionKey, true
	default:
		state.Problem = "the link ended: " + err.Error()
	}
	s.setState(state)
	return rejected
}

// redialPause is the pause before the next dial: the base pause, doubled after each session in a
// row that the companion refused or could not prove the key on, up to max. Its zero value is not
// usable; base and max must be set.
type redialPause struct {
	base, max time.Duration
	// last is the pause after the last rejected session in the current run of them, 0 when the
	// last session was not rejected.
	last time.Duration
}

// next is the pause after a session that was rejected or not.
func (p *redialPause) next(rejected bool) time.Duration {
	if !rejected {
		p.last = 0
		return p.base
	}
	if p.last == 0 {
		p.last = p.base
	} else {
		p.last = min(2*p.last, p.max)
	}
	return p.last
}

// reset starts the doubling again from the base pause.
func (p *redialPause) reset() { p.last = 0 }

// countedReader is a reader that counts the bytes read through it.
type countedReader struct {
	r io.Reader
	n atomic.Int64
}

func (c *countedReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n.Add(int64(n))
	return n, err
}

// listenerFeed delivers events to one listener in order, on at most one goroutine at a time,
// which runs only while events are queued.
type listenerFeed struct {
	listener Listener

	mu      sync.Mutex
	queue   []func(Listener)
	running bool
	closed  bool
}

func (f *listenerFeed) push(event func(Listener)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return
	}
	f.queue = append(f.queue, event)
	if !f.running {
		f.running = true
		go f.drain()
	}
}

func (f *listenerFeed) drain() {
	for {
		f.mu.Lock()
		if len(f.queue) == 0 || f.closed {
			f.queue, f.running = nil, false
			f.mu.Unlock()
			return
		}
		event := f.queue[0]
		f.queue = f.queue[1:]
		f.mu.Unlock()
		event(f.listener)
	}
}

func (f *listenerFeed) close() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed, f.queue = true, nil
}
