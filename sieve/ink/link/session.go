package link

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"slices"
	"sort"
	"sync"
	"time"
)

// A Sieve acks every so many records or so often, whichever comes first.
const (
	ackEveryRecords = 64
	ackEvery        = 500 * time.Millisecond
)

var (
	// ErrRefused is the companion refusing the handshake: it does not hold this Sieve's key.
	ErrRefused = errors.New("the companion refused the handshake")
	// ErrBadCompanion is a companion whose proof does not hold: it does not hold this Sieve's key.
	ErrBadCompanion = errors.New("the companion's proof does not hold")
	// ErrNotRunning is a request to a session whose handshake has not held, or whose Run has returned.
	ErrNotRunning = errors.New("the session is not running")
)

// RefusedError is the companion's REFUSE of a request, with its reason.
type RefusedError struct{ Reason string }

func (e *RefusedError) Error() string { return "the companion refused: " + e.Reason }

// Observer is told what a session sees, on the session's goroutine. A method must not block for
// long: the link waits while it runs.
type Observer interface {
	// Notes is a NOTES frame: the notes the companion offers this Sieve.
	Notes(notes []NoteEntry)
	// Opened is a HEAD: the companion holds note to headSeq, and its replica to have.
	Opened(note ID, headSeq, have uint32)
	// Committed is a record appended to the note's replica.
	Committed(note ID, r Record)
	// Done is a DONE: the companion has sent the note to its head, which the replica holds to seq,
	// after records records in this session.
	Done(note ID, seq uint32, records int)
	// Live is a LIVE: the note and page being written, both zero when none is.
	Live(note, page ID)
	// Ink is the live records of one INK frame.
	Ink(records []LiveRecord)
	// Refused is a REFUSE of an OPEN of note, with its reason. A REFUSE of an OPEN-NOTE is answered
	// to the caller of OpenNote instead.
	Refused(note ID, reason string)
	// SetAside is the note's replica set aside: its log starts again from seq 1, and the records
	// Committed reports for it from now on are the new log's.
	SetAside(note ID)
}

// Plan is what one session is to do after the handshake.
type Plan struct {
	// List sends LIST and reports NOTES.
	List bool
	// CatchUp opens, in id order and one at a time, every listed note whose headSeq is past what
	// Replicas.Have reports for it; a note it does not pass is not opened.
	CatchUp bool
	// Only, when set, narrows CatchUp to one note.
	Only *ID
	// Follow keeps the session open: a note the companion shows live is opened and its records
	// and ink followed.
	Follow bool
	// Meta is sent once NOTES has come, followed by another LIST.
	Meta *Meta
}

// Session is this Sieve's end of one connection to a companion. A Session is used once.
type Session struct {
	key      Key
	replicas Replicas
	stream   *frameStream
	obs      Observer
	plan     Plan

	queue    []ID
	current  *ID
	open     map[ID]Replica
	heads    map[ID]headCheck
	received map[ID]int
	// requests are the OPENs and OPEN-NOTEs not yet answered. OP and DONE of a note with an OPEN
	// among them are ignored, since the HEAD starts it again from haveSeq.
	requests  requests
	following ID
	metaSent  bool
	ink       LiveDecoder

	ackMu    sync.Mutex
	unacked  map[ID]uint32
	ackCount int
}

// headCheck is a HEAD to compare a replica's chain with when its cursor reaches seq.
type headCheck struct {
	seq  uint32
	hash [32]byte
}

// NewSession is a session over link that proves itself with key, keeps notes in replicas, and
// reports to obs.
func NewSession(link io.ReadWriter, key Key, replicas Replicas, obs Observer, p Plan) *Session {
	return &Session{
		key: key, replicas: replicas, stream: newFrameStream(link), obs: obs, plan: p,
		open: map[ID]Replica{}, heads: map[ID]headCheck{}, received: map[ID]int{},
		unacked: map[ID]uint32{}, requests: requests{byNote: map[ID][]chan error{}},
	}
}

// Run does the handshake and the plan. It returns nil when a plan that does not follow has
// finished. Any error means the link must be dropped; a later session resumes from each
// replica's cursor. To end a following session, close the link.
func (s *Session) Run() error {
	if err := s.handshake(); err != nil {
		return err
	}
	s.requests.start()
	defer s.requests.stop()
	stop := make(chan struct{})
	defer close(stop)
	go s.ackLoop(stop)
	if s.plan.List || s.plan.CatchUp || s.plan.Meta != nil {
		if err := s.stream.write(listFrame{}.encode()); err != nil {
			return err
		}
	}
	for {
		frame, err := s.stream.read(limitFromCompanion)
		if err != nil {
			return err
		}
		finished, err := s.handle(frame)
		if err != nil {
			return err
		}
		if finished {
			return s.flushAcks()
		}
	}
}

// handshake proves this Sieve to the companion and the companion to this Sieve, then seals the stream.
func (s *Session) handshake() error {
	frame, err := s.stream.read(limitBeforeProof)
	if err != nil {
		return fmt.Errorf("reading CHALLENGE: %w", err)
	}
	in := &frameReader{b: frame}
	if in.u8() != frameChallenge {
		return errors.New("the companion did not begin with CHALLENGE")
	}
	if v := in.u8(); v != protocolVersion {
		return fmt.Errorf("the companion speaks protocol %d", v)
	}
	cNonce := append([]byte{}, in.take(nonceBytes)...)
	if err := in.finish(); err != nil {
		return err
	}
	sNonce := make([]byte, nonceBytes)
	if _, err := rand.Read(sNonce); err != nil {
		return err
	}
	if err := s.stream.write(helloFrame{s.key.SieveID(), sNonce, s.key.SieveProof(cNonce)}.encode()); err != nil {
		return err
	}
	frame, err = s.stream.read(limitBeforeProof)
	if err != nil {
		return fmt.Errorf("reading OK: %w", err)
	}
	in = &frameReader{b: frame}
	switch in.u8() {
	case frameOK:
	case frameRefuse:
		return ErrRefused
	default:
		return errors.New("the companion answered HELLO with neither OK nor REFUSE")
	}
	proof := in.take(proofBytes)
	if err := in.finish(); err != nil {
		return err
	}
	if !hmac.Equal(proof, s.key.CompanionProof(sNonce)) {
		return ErrBadCompanion
	}
	sessionKey, err := s.key.SessionKey(cNonce, sNonce)
	if err != nil {
		return err
	}
	return s.stream.upgrade(sessionKey, SieveToCompanion, CompanionToSieve)
}

// handle takes one frame and says whether the plan is finished.
func (s *Session) handle(frame []byte) (bool, error) {
	if len(frame) == 0 {
		return false, errors.New("an empty frame")
	}
	in := &frameReader{b: frame[1:]}
	switch frame[0] {
	case frameNotes:
		notes := in.notes()
		if err := in.finish(); err != nil {
			return false, err
		}
		return s.onNotes(notes)
	case frameHead:
		note, head := in.head()
		if err := in.finish(); err != nil {
			return false, err
		}
		return false, s.onHead(note, head)
	case frameOp:
		note, logFrame := in.id(), LogFrame(in.rest())
		if err := in.finish(); err != nil {
			return false, err
		}
		return false, s.onOp(note, logFrame)
	case frameDone:
		note := in.id()
		if err := in.finish(); err != nil {
			return false, err
		}
		return s.onDone(note)
	case frameLive:
		note, page := in.id(), in.id()
		if err := in.finish(); err != nil {
			return false, err
		}
		return false, s.onLive(note, page)
	case frameInk:
		records, err := s.ink.Feed(in.rest())
		if err != nil {
			return false, err
		}
		s.obs.Ink(records)
		return false, nil
	case frameRefuse:
		note, reason := in.id(), in.string()
		if err := in.finish(); err != nil {
			return false, err
		}
		return s.onRefuse(note, reason)
	}
	return false, fmt.Errorf("the companion may not send frame type %d", frame[0])
}

func (s *Session) onNotes(notes []NoteEntry) (bool, error) {
	s.obs.Notes(notes)
	if s.plan.Meta != nil && !s.metaSent {
		s.metaSent = true
		meta, err := s.plan.Meta.encode()
		if err != nil {
			return false, err
		}
		if err := s.stream.write(meta); err != nil {
			return false, err
		}
		return false, s.stream.write(listFrame{}.encode())
	}
	if s.plan.CatchUp {
		sort.Slice(notes, func(i, j int) bool { return bytes.Compare(notes[i].ID[:], notes[j].ID[:]) < 0 })
		for _, n := range notes {
			if s.plan.Only != nil && *s.plan.Only != n.ID {
				continue
			}
			have, err := s.have(n.ID)
			if err != nil {
				return false, err
			}
			if n.HeadSeq > have {
				s.queue = append(s.queue, n.ID)
			}
		}
		return s.openNext()
	}
	return !s.plan.Follow, nil
}

// openNext opens the next queued note; the plan is finished when none is left and it does not follow.
func (s *Session) openNext() (bool, error) {
	if s.current != nil {
		return false, nil
	}
	if len(s.queue) == 0 {
		return !s.plan.Follow, nil
	}
	note := s.queue[0]
	s.queue = s.queue[1:]
	s.current = &note
	return false, s.sendOpen(note)
}

func (s *Session) sendOpen(note ID) error {
	r, err := s.replica(note)
	if err != nil {
		return err
	}
	return s.stream.writeIf(func() bool { return s.requests.add(note, nil) }, openFrame{note, r.Cursor().Seq}.encode())
}

func (s *Session) onHead(note ID, head headCheck) error {
	s.requests.answerOpen(note)
	s.heads[note] = head
	r, err := s.replica(note)
	if err != nil {
		return err
	}
	s.obs.Opened(note, head.seq, r.Cursor().Seq)
	return s.checkHead(note, r)
}

func (s *Session) onOp(note ID, frame LogFrame) error {
	if s.requests.awaitingHead(note) {
		return nil
	}
	body, err := frame.Body()
	if err != nil {
		return fmt.Errorf("note %s: %w", note, err)
	}
	rec, err := ParseBody(body)
	if err != nil {
		return fmt.Errorf("note %s: %w", note, err)
	}
	r, err := s.replica(note)
	if err != nil {
		return err
	}
	if err := r.Append(rec, body); err != nil {
		return fmt.Errorf("note %s: %w", note, err)
	}
	s.received[note]++
	s.obs.Committed(note, rec)
	s.noteAck(note, rec.Seq)
	return s.checkHead(note, r)
}

// checkHead compares the replica's chain with the note's HEAD once its cursor stands at the HEAD's
// seq. A mismatch means the replica is wrong in a way contiguity could not see: it is set aside
// and the note opened again from nothing.
func (s *Session) checkHead(note ID, r Replica) error {
	head, ok := s.heads[note]
	cursor := r.Cursor()
	if !ok || cursor.Seq != head.seq {
		return nil
	}
	delete(s.heads, note)
	if cursor.Hash == head.hash {
		return nil
	}
	if err := r.SetAside(); err != nil {
		return err
	}
	s.obs.SetAside(note)
	return s.sendOpen(note)
}

func (s *Session) onDone(note ID) (bool, error) {
	if s.requests.awaitingHead(note) {
		return false, nil
	}
	r, err := s.replica(note)
	if err != nil {
		return false, err
	}
	s.obs.Done(note, r.Cursor().Seq, s.received[note])
	if s.current != nil && *s.current == note {
		s.current = nil
	}
	return s.openNext()
}

func (s *Session) onLive(note, page ID) error {
	if note != (ID{}) {
		s.requests.live(note)
	}
	previous := s.following
	s.following = note
	s.obs.Live(note, page)
	if s.plan.Follow && note != (ID{}) && note != previous {
		return s.sendOpen(note)
	}
	return nil
}

func (s *Session) onRefuse(note ID, reason string) (bool, error) {
	if s.requests.refuse(note, reason) {
		return false, nil
	}
	s.obs.Refused(note, reason)
	if s.following == note {
		s.following = ID{}
	}
	if reason == RefuseAhead {
		r, err := s.replica(note)
		if err != nil {
			return false, err
		}
		if err := r.SetAside(); err != nil {
			return false, err
		}
		s.obs.SetAside(note)
		return false, s.sendOpen(note)
	}
	if s.current != nil && *s.current == note {
		s.current = nil
		return s.openNext()
	}
	return false, nil
}

// OpenNote sends OPEN-NOTE, asking the companion to show note. Its answer arrives on the channel,
// once: nil when a LIVE names note, a *RefusedError when the companion refuses it, ErrNotRunning
// when the session ends first. It may be called from any goroutine, the Observer's included, and
// is ErrNotRunning, with no channel, while the session is not running.
func (s *Session) OpenNote(note ID) (<-chan error, error) {
	answer := make(chan error, 1)
	running := false
	err := s.stream.writeIf(func() bool {
		running = s.requests.add(note, answer)
		return running
	}, openNoteFrame{note}.encode())
	switch {
	case !running:
		return nil, ErrNotRunning
	case err != nil:
		s.requests.forget(note, answer)
		return nil, err
	}
	return answer, nil
}

func (s *Session) replica(note ID) (Replica, error) {
	if r, ok := s.open[note]; ok {
		return r, nil
	}
	r, err := s.replicas.Open(note)
	if err != nil {
		return nil, err
	}
	s.open[note] = r
	return r, nil
}

// have is the seq the note's replica holds at least: its cursor when this session has it open,
// otherwise what Replicas.Have reports without opening it.
func (s *Session) have(note ID) (uint32, error) {
	if r, ok := s.open[note]; ok {
		return r.Cursor().Seq, nil
	}
	return s.replicas.Have(note)
}

func (s *Session) noteAck(note ID, seq uint32) {
	s.ackMu.Lock()
	s.unacked[note] = seq
	s.ackCount++
	flush := s.ackCount >= ackEveryRecords
	s.ackMu.Unlock()
	if flush {
		_ = s.flushAcks()
	}
}

func (s *Session) flushAcks() error {
	s.ackMu.Lock()
	pending := s.unacked
	s.unacked = map[ID]uint32{}
	s.ackCount = 0
	s.ackMu.Unlock()
	for note, seq := range pending {
		if err := s.stream.write(ackFrame{note, seq}.encode()); err != nil {
			return err
		}
	}
	return nil
}

func (s *Session) ackLoop(stop <-chan struct{}) {
	tick := time.NewTicker(ackEvery)
	defer tick.Stop()
	for {
		select {
		case <-stop:
			return
		case <-tick.C:
			if s.flushAcks() != nil {
				return
			}
		}
	}
}

// requests are the OPENs and OPEN-NOTEs a running session has written and the companion has not
// answered, each note's in the order they were written: an OPEN as nil, an OPEN-NOTE as the
// channel its answer goes to. The companion answers a note's requests in the order it reads them:
// an OPEN with HEAD, an OPEN-NOTE with LIVE, either with REFUSE. It is safe for concurrent use.
type requests struct {
	mu      sync.Mutex
	running bool
	byNote  map[ID][]chan error
}

// start takes requests from now on.
func (r *requests) start() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.running = true
}

// stop takes no more requests, and answers every OPEN-NOTE still awaited with ErrNotRunning.
func (r *requests) stop() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.running = false
	for note, waiting := range r.byNote {
		for _, answer := range waiting {
			if answer != nil {
				answer <- ErrNotRunning
			}
		}
		delete(r.byNote, note)
	}
}

// add records a request of note about to be written, an OPEN when answer is nil, and reports
// whether it may be: false once stopped.
func (r *requests) add(note ID, answer chan error) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.running {
		r.byNote[note] = append(r.byNote[note], answer)
	}
	return r.running
}

// forget drops the OPEN-NOTE answer, which was never written.
func (r *requests) forget(note ID, answer chan error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.drop(note, slices.Index(r.byNote[note], answer))
}

// awaitingHead is whether an OPEN of note is unanswered.
func (r *requests) awaitingHead(note ID) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Contains(r.byNote[note], nil)
}

// answerOpen drops the oldest OPEN of note, which a HEAD answers.
func (r *requests) answerOpen(note ID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.drop(note, slices.Index(r.byNote[note], nil))
}

// live answers every OPEN-NOTE of note with nil: a LIVE names it.
func (r *requests) live(note ID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	opens := 0
	for _, a := range r.byNote[note] {
		if a == nil {
			opens++
		} else {
			a <- nil
		}
	}
	if opens == 0 {
		delete(r.byNote, note)
		return
	}
	r.byNote[note] = make([]chan error, opens)
}

// refuse drops the request a REFUSE of note for reason answers and reports whether it was an
// OPEN-NOTE, which is answered with the refusal. Only an OPEN is refused as ahead, and an OPEN-NOTE
// is the one refused as not-foreground; any other refusal answers the note's oldest request.
func (r *requests) refuse(note ID, reason string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	waiting := r.byNote[note]
	i := 0
	switch reason {
	case RefuseAhead:
		i = slices.Index(waiting, nil)
	case RefuseNotForeground:
		if j := slices.IndexFunc(waiting, func(a chan error) bool { return a != nil }); j >= 0 {
			i = j
		}
	}
	if i < 0 || i >= len(waiting) {
		return false
	}
	answer := waiting[i]
	r.drop(note, i)
	if answer == nil {
		return false
	}
	answer <- &RefusedError{reason}
	return true
}

// drop removes the request at i of note, none when i is out of range, and forgets a note left
// with none. r.mu is held.
func (r *requests) drop(note ID, i int) {
	waiting := r.byNote[note]
	if i >= 0 && i < len(waiting) {
		waiting = slices.Delete(waiting, i, i+1)
	}
	if len(waiting) == 0 {
		delete(r.byNote, note)
		return
	}
	r.byNote[note] = waiting
}
