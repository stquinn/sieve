package link

import (
	"bytes"
	"errors"
	"io"
	"net"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

var testKey = Key{'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'}

// recorder is an Observer that keeps what it is told, and calls opened, when set, at each HEAD.
type recorder struct {
	mu        sync.Mutex
	committed []uint32
	live      []ID
	aside     []ID
	refused   []string
	done      chan uint32
	notes     chan struct{}
	opened    func(note ID)
}

func newRecorder() *recorder {
	return &recorder{done: make(chan uint32, 8), notes: make(chan struct{}, 8)}
}

func (r *recorder) Notes([]NoteEntry) {
	select {
	case r.notes <- struct{}{}:
	default:
	}
}
func (r *recorder) Opened(note ID, _, _ uint32) {
	if r.opened != nil {
		r.opened(note)
	}
}
func (r *recorder) Ink([]LiveRecord) {}
func (r *recorder) Refused(_ ID, reason string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.refused = append(r.refused, reason)
}
func (r *recorder) Done(_ ID, seq uint32, _ int) {
	r.done <- seq
}
func (r *recorder) Committed(_ ID, rec Record) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.committed = append(r.committed, rec.Seq)
}
func (r *recorder) SetAside(note ID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.aside = append(r.aside, note)
}
func (r *recorder) Live(note, _ ID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.live = append(r.live, note)
}

// harness runs sessions against one companion over loopback sockets, which have a little room in
// them as a real link has, so neither side's write waits for the other to read.
type harness struct {
	t         *testing.T
	companion *ScriptedCompanion
	replicas  *countingReplicas
	// obs is the observer of the last run.
	obs *recorder
}

// countingReplicas counts the replicas a session opens.
type countingReplicas struct {
	*MemoryReplicas
	mu     sync.Mutex
	opened int
}

func (c *countingReplicas) Open(note ID) (Replica, error) {
	c.mu.Lock()
	c.opened++
	c.mu.Unlock()
	return c.MemoryReplicas.Open(note)
}

// takeOpened is how many replicas were opened since it was last asked.
func (c *countingReplicas) takeOpened() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := c.opened
	c.opened = 0
	return n
}

func newHarness(t *testing.T, records []Record) *harness {
	return &harness{t: t, companion: NewScriptedCompanion(testKey, vectorNote, vectorPage, records),
		replicas: &countingReplicas{MemoryReplicas: NewMemoryReplicas()}}
}

func (h *harness) pair() (ours, theirs net.Conn) {
	h.t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		h.t.Fatal(err)
	}
	defer listener.Close()
	ours, err = net.Dial("tcp", listener.Addr().String())
	if err != nil {
		h.t.Fatal(err)
	}
	theirs, err = listener.Accept()
	if err != nil {
		h.t.Fatal(err)
	}
	return ours, theirs
}

// run runs one session with key and p to its end and returns its error.
func (h *harness) run(key Key, p Plan) error {
	h.t.Helper()
	h.obs = newRecorder()
	_, ended, link := h.start(key, p, h.obs)
	defer link.Close()
	return h.end(ended)
}

// start runs a session with key and p, heard by obs, until it ends on the error sent on ended or
// link is closed.
func (h *harness) start(key Key, p Plan, obs *recorder) (s *Session, ended <-chan error, link net.Conn) {
	ours, theirs := h.pair()
	go func() {
		_ = h.companion.Serve(theirs)
		theirs.Close()
	}()
	done := make(chan error, 1)
	s = NewSession(ours, key, h.replicas, obs, p)
	go func() { done <- s.Run() }()
	return s, done, ours
}

// end is the error the session ended on.
func (h *harness) end(ended <-chan error) error {
	h.t.Helper()
	select {
	case err := <-ended:
		return err
	case <-time.After(5 * time.Second):
		h.t.Fatal("the session did not finish")
		return nil
	}
}

// answer is the answer that came on answer.
func (h *harness) answer(answer <-chan error) error {
	h.t.Helper()
	select {
	case err := <-answer:
		return err
	case <-time.After(5 * time.Second):
		h.t.Fatal("no answer came")
		return nil
	}
}

func (h *harness) held() *MemoryReplica { return h.replicas.Replica(vectorNote) }

func (h *harness) opens(n int) []uint32 {
	h.t.Helper()
	out := make([]uint32, n)
	for i := range out {
		select {
		case out[i] = <-h.companion.Opens:
		case <-time.After(time.Second):
			h.t.Fatalf("OPEN %d did not come", i+1)
		}
	}
	select {
	case extra := <-h.companion.Opens:
		h.t.Errorf("an OPEN beyond %v, from %d", out, extra)
	default:
	}
	return out
}

func TestCatchUpResumesFromTheCursor(t *testing.T) {
	h := newHarness(t, vectorRecords[:2])
	if err := h.run(testKey, Plan{CatchUp: true}); err != nil {
		t.Fatalf("first session: %v", err)
	}
	h.companion.SetRecords(vectorRecords)
	if err := h.run(testKey, Plan{CatchUp: true}); err != nil {
		t.Fatalf("second session: %v", err)
	}
	if have := h.opens(2); have[0] != 0 || have[1] != 2 {
		t.Errorf("OPENs asked from %v, want 0 then 2", have)
	}
	if got := h.held().Cursor().Seq; got != uint32(len(vectorRecords)) {
		t.Errorf("held %d", got)
	}
	h.replicas.takeOpened()
	if err := h.run(testKey, Plan{CatchUp: true}); err != nil {
		t.Fatalf("third session: %v", err)
	}
	h.opens(0)
	if n := h.replicas.takeOpened(); n != 0 {
		t.Errorf("a note known to be held to its head opened %d replicas", n)
	}
}

func TestAcksAreSentForWhatIsHeld(t *testing.T) {
	h := newHarness(t, vectorRecords)
	if err := h.run(testKey, Plan{CatchUp: true}); err != nil {
		t.Fatal(err)
	}
	select {
	case seq := <-h.companion.Acks:
		if seq != uint32(len(vectorRecords)) {
			t.Errorf("acked %d", seq)
		}
	case <-time.After(time.Second):
		t.Error("no ACK")
	}
}

func TestAReplicaTheCompanionDisownsIsSetAsideAndAskedForAgain(t *testing.T) {
	for _, c := range []struct {
		name  string
		setup func(*ScriptedCompanion)
		aside int
	}{
		{"a HEAD whose hash differs", func(c *ScriptedCompanion) { c.CorruptHead = true }, len(vectorRecords)},
		{"REFUSE ahead", func(c *ScriptedCompanion) { c.RefuseAhead = true }, 2},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t, vectorRecords[:2])
			if err := h.run(testKey, Plan{CatchUp: true}); err != nil {
				t.Fatal(err)
			}
			h.opens(1)
			h.companion.SetRecords(vectorRecords)
			c.setup(h.companion)
			if err := h.run(testKey, Plan{CatchUp: true}); err != nil {
				t.Fatal(err)
			}
			if have := h.opens(2); have[0] != 2 || have[1] != 0 {
				t.Errorf("OPENs asked from %v, want 2 then 0", have)
			}
			if aside := h.held().Aside(); len(aside) != 1 || len(aside[0]) != c.aside {
				t.Errorf("set aside %v", aside)
			}
			if heard := h.obs.aside; len(heard) != 1 || heard[0] != vectorNote {
				t.Errorf("the observer heard %v set aside, want the note once", heard)
			}
			if got := h.held().Cursor().Seq; got != uint32(len(vectorRecords)) {
				t.Errorf("held %d", got)
			}
		})
	}
}

func TestOpAndDoneBeforeTheHeadAreIgnored(t *testing.T) {
	h := newHarness(t, vectorRecords)
	h.companion.StaleBeforeHead = true
	if err := h.run(testKey, Plan{CatchUp: true}); err != nil {
		t.Fatal(err)
	}
	if got := h.held().Cursor().Seq; got != uint32(len(vectorRecords)) {
		t.Errorf("held %d", got)
	}
}

func TestAGapDropsTheLinkAndKeepsTheContiguousRecords(t *testing.T) {
	h := newHarness(t, vectorRecords)
	h.companion.GapAt = 3
	if err := h.run(testKey, Plan{CatchUp: true}); err == nil {
		t.Fatal("a gap was accepted")
	}
	if got := h.held().Cursor().Seq; got != 2 {
		t.Errorf("held %d", got)
	}
}

func TestFollowOpensTheLiveNote(t *testing.T) {
	h := newHarness(t, vectorRecords)
	h.companion.Live = true
	ours, theirs := h.pair()
	go func() { _ = h.companion.Serve(theirs) }()
	obs := newRecorder()
	ended := make(chan error, 1)
	go func() { ended <- NewSession(ours, testKey, h.replicas, obs, Plan{List: true, Follow: true}).Run() }()
	select {
	case seq := <-obs.done:
		if seq != uint32(len(vectorRecords)) {
			t.Errorf("done at %d", seq)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the live note was not caught up")
	}
	ours.Close()
	theirs.Close()
	if err := <-ended; err == nil {
		t.Error("a following session ended without its link closing")
	}
	obs.mu.Lock()
	defer obs.mu.Unlock()
	if len(obs.live) != 1 || obs.live[0] != vectorNote || len(obs.committed) != len(vectorRecords) {
		t.Errorf("live %v, committed %v", obs.live, obs.committed)
	}
}

// META sent while the session runs reaches the companion, cut to its limits; before the handshake
// and after Run has returned it is ErrNotRunning and nothing is written.
func TestSendMetaReachesTheCompanionOnlyWhileTheSessionRuns(t *testing.T) {
	h := newHarness(t, vectorRecords)
	meta := Meta{vectorNote, strings.Repeat("t", 600), []string{"k", "budget, rough"}, []string{"Work"}, "A line.", 6}
	unstarted := NewSession(&bytes.Buffer{}, testKey, NewMemoryReplicas(), newRecorder(), Plan{})
	if err := unstarted.SendMeta(meta); !errors.Is(err, ErrNotRunning) {
		t.Errorf("before the handshake: %v", err)
	}

	obs := newRecorder()
	s, ended, link := h.start(testKey, Plan{List: true, Follow: true}, obs)
	<-obs.notes
	if err := s.SendMeta(meta); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-h.companion.Metas:
		want := meta.Truncated()
		if got.Note != vectorNote || got.Title != want.Title || len(got.Title) != 512 || !slices.Equal(got.Keywords, meta.Keywords) ||
			!slices.Equal(got.Categories, meta.Categories) || got.Summary != meta.Summary || got.AsOfSeq != 6 {
			t.Errorf("the companion received %+v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no META reached the companion")
	}
	link.Close()
	_ = h.end(ended)
	if err := s.SendMeta(meta); !errors.Is(err, ErrNotRunning) {
		t.Errorf("after Run returned: %v", err)
	}
	if got := h.companion.ReceivedMetas(); len(got) != 1 {
		t.Errorf("the companion received %d METAs, want 1", len(got))
	}
}

// Truncated cuts each field to the companion's limit on a rune boundary and leaves what fits as it
// was.
func TestMetaTruncatedFitsTheCompanionsLimits(t *testing.T) {
	terms := func(n int, term string) []string { return slices.Repeat([]string{term}, n) }
	for _, tc := range []struct {
		name string
		in   Meta
		want Meta
	}{
		{"what fits", Meta{Title: "Kitchen", Keywords: []string{"a, b"}, Categories: []string{}, Summary: "One line."},
			Meta{Title: "Kitchen", Keywords: []string{"a, b"}, Categories: []string{}, Summary: "One line."}},
		{"a title at the limit", Meta{Title: strings.Repeat("t", 512)}, Meta{Title: strings.Repeat("t", 512)}},
		{"a long title", Meta{Title: strings.Repeat("t", 513)}, Meta{Title: strings.Repeat("t", 512)}},
		{"a title cut inside a rune", Meta{Title: strings.Repeat("t", 511) + "é"}, Meta{Title: strings.Repeat("t", 511)}},
		{"a long summary", Meta{Summary: strings.Repeat("s", 5000)}, Meta{Summary: strings.Repeat("s", 4096)}},
		{"a summary cut inside a rune", Meta{Summary: strings.Repeat("s", 4094) + "€"}, Meta{Summary: strings.Repeat("s", 4094)}},
		{"too many terms", Meta{Keywords: terms(70, "k"), Categories: terms(65, "c")}, Meta{Keywords: terms(64, "k"), Categories: terms(64, "c")}},
		{"a long term", Meta{Keywords: []string{strings.Repeat("k", 127) + "é", "short"}},
			Meta{Keywords: []string{strings.Repeat("k", 127), "short"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.in.Truncated()
			if got.Title != tc.want.Title || got.Summary != tc.want.Summary || !slices.Equal(got.Keywords, tc.want.Keywords) ||
				!slices.Equal(got.Categories, tc.want.Categories) {
				t.Errorf("Truncated = %+v", got)
			}
			if _, err := got.encode(); err != nil {
				t.Errorf("the truncated META does not encode: %v", err)
			}
		})
	}
}

// An OPEN-NOTE sent while the session runs is answered by the LIVE it brings, which a following
// session then catches up, or by the companion's refusal with its reason, which the observer never
// hears as a refused OPEN.
func TestOpenNoteMidSessionIsAnsweredByLiveOrARefusal(t *testing.T) {
	for _, c := range []struct {
		name   string
		answer OpenNoteAnswer
		want   string
	}{
		{"live", OpenNoteAnswer{}, ""},
		{"not in front", OpenNoteAnswer{Refuse: RefuseNotForeground}, RefuseNotForeground},
		{"not offered", OpenNoteAnswer{Refuse: RefuseNotOffered}, RefuseNotOffered},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t, vectorRecords)
			h.companion.SetOpenNoteAnswer(c.answer)
			obs := newRecorder()
			s, ended, link := h.start(testKey, Plan{List: true, Follow: true}, obs)
			<-obs.notes
			answer, err := s.OpenNote(vectorNote)
			if err != nil {
				t.Fatal(err)
			}
			got := h.answer(answer)
			var refused *RefusedError
			switch {
			case c.want == "" && got != nil:
				t.Errorf("answered %v, want the note live", got)
			case c.want != "" && (!errors.As(got, &refused) || refused.Reason != c.want):
				t.Errorf("answered %v, want refused %s", got, c.want)
			}
			if c.want == "" {
				if seq := <-obs.done; seq != uint32(len(vectorRecords)) {
					t.Errorf("the note opened was caught up to %d", seq)
				}
			}
			if note := <-h.companion.OpenNotes; note != vectorNote {
				t.Errorf("OPEN-NOTE named %s", note)
			}
			link.Close()
			_ = h.end(ended)
			obs.mu.Lock()
			defer obs.mu.Unlock()
			if len(obs.refused) != 0 {
				t.Errorf("the observer heard %v refused", obs.refused)
			}
		})
	}
}

// A refused OPEN-NOTE of a note the catch-up is bringing to its head, or of one still queued for
// it, leaves the catch-up as it was: both notes reach their heads and no OPEN is refused.
func TestARefusedOpenNoteDoesNotDisturbTheCatchUp(t *testing.T) {
	other := ID{0xff, 15: 1}
	for _, c := range []struct {
		name   string
		target ID
	}{
		{"the note being caught up", vectorNote},
		{"a note queued for the catch-up", other},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t, vectorRecords)
			h.companion.SetNote(other, vectorRecords[:3])
			h.companion.SetOpenNoteAnswer(OpenNoteAnswer{Refuse: RefuseNotOffered})
			obs := newRecorder()
			answers := make(chan (<-chan error), 1)
			sessions := make(chan *Session, 1)
			obs.opened = func(note ID) {
				if note != vectorNote {
					return
				}
				answer, err := (<-sessions).OpenNote(c.target)
				if err != nil {
					t.Error(err)
				}
				answers <- answer
			}
			s, ended, link := h.start(testKey, Plan{CatchUp: true}, obs)
			sessions <- s
			defer link.Close()
			if err := h.end(ended); err != nil {
				t.Fatal(err)
			}
			var refused *RefusedError
			if got := h.answer(<-answers); !errors.As(got, &refused) || refused.Reason != RefuseNotOffered {
				t.Errorf("answered %v", got)
			}
			if a, b := h.replicas.Replica(vectorNote).Cursor().Seq, h.replicas.Replica(other).Cursor().Seq; a != uint32(len(vectorRecords)) || b != 3 {
				t.Errorf("caught up to %d and %d", a, b)
			}
			if len(obs.refused) != 0 {
				t.Errorf("the observer heard %v refused", obs.refused)
			}
		})
	}
}

// OPEN-NOTE is refused with ErrNotRunning before the handshake and after Run has returned, and an
// OPEN-NOTE still awaited when the session ends is answered ErrNotRunning.
func TestOpenNoteOutsideARunningSessionIsErrNotRunning(t *testing.T) {
	h := newHarness(t, vectorRecords)
	unstarted := NewSession(&bytes.Buffer{}, testKey, NewMemoryReplicas(), newRecorder(), Plan{})
	if _, err := unstarted.OpenNote(vectorNote); !errors.Is(err, ErrNotRunning) {
		t.Errorf("before the handshake: %v", err)
	}

	obs := newRecorder()
	s, ended, link := h.start(testKey, Plan{List: true}, obs)
	if err := h.end(ended); err != nil {
		t.Fatal(err)
	}
	link.Close()
	if _, err := s.OpenNote(vectorNote); !errors.Is(err, ErrNotRunning) {
		t.Errorf("after Run returned: %v", err)
	}

	h.companion.SetOpenNoteAnswer(OpenNoteAnswer{Silent: true})
	obs = newRecorder()
	s, ended, link = h.start(testKey, Plan{List: true, Follow: true}, obs)
	<-obs.notes
	answer, err := s.OpenNote(vectorNote)
	if err != nil {
		t.Fatal(err)
	}
	link.Close()
	_ = h.end(ended)
	if got := h.answer(answer); !errors.Is(got, ErrNotRunning) {
		t.Errorf("awaited as the session ended: %v", got)
	}
}

func TestHandshakeFailsClosed(t *testing.T) {
	wrong := Key{}
	if err := newHarness(t, nil).run(wrong, Plan{List: true}); !errors.Is(err, ErrRefused) {
		t.Errorf("a wrong key: %v", err)
	}

	ours, theirs := net.Pipe()
	defer ours.Close()
	defer theirs.Close()
	go func() {
		rogue := newFrameStream(theirs)
		_ = rogue.write(newFrame(frameChallenge).u8(protocolVersion).raw(make([]byte, nonceBytes)).b)
		_, _ = rogue.read(limitBeforeProof)
		_ = rogue.write(newFrame(frameOK).raw(make([]byte, proofBytes)).b)
	}()
	if err := NewSession(ours, testKey, NewMemoryReplicas(), newRecorder(), Plan{List: true}).Run(); !errors.Is(err, ErrBadCompanion) {
		t.Errorf("a rogue companion: %v", err)
	}
}

// TestSealedStreamFailsClosed runs a real handshake, then hands the session sealed frames damaged per case.
func TestSealedStreamFailsClosed(t *testing.T) {
	for _, c := range []struct {
		name   string
		damage func(frames [][]byte) []byte
	}{
		{"tampered", func(f [][]byte) []byte { w := bytes.Join(f, nil); w[len(w)-1] ^= 1; return w }},
		{"replayed", func(f [][]byte) []byte { return bytes.Join([][]byte{f[0], f[0]}, nil) }},
		{"truncated", func(f [][]byte) []byte { w := bytes.Join(f, nil); return w[:len(w)-3] }},
		{"reordered", func(f [][]byte) []byte { return bytes.Join([][]byte{f[1], f[0]}, nil) }},
	} {
		t.Run(c.name, func(t *testing.T) {
			ours, theirs := net.Pipe()
			defer ours.Close()
			go func() {
				defer theirs.Close()
				stream := newFrameStream(theirs)
				cNonce := make([]byte, nonceBytes)
				_ = stream.write(newFrame(frameChallenge).u8(protocolVersion).raw(cNonce).b)
				frame, _ := stream.read(limitBeforeProof)
				in := &frameReader{b: frame[1:]}
				in.string()
				sNonce := append([]byte{}, in.take(nonceBytes)...)
				_ = stream.write(newFrame(frameOK).raw(testKey.CompanionProof(sNonce)).b)
				sessionKey, _ := testKey.SessionKey(cNonce, sNonce)
				var wire bytes.Buffer
				sealed := &frameStream{w: &wire}
				_ = sealed.upgrade(sessionKey, CompanionToSieve, SieveToCompanion)
				var frames [][]byte
				for _, plain := range [][]byte{newFrame(frameNotes).u32(0).b, newFrame(frameInk).b} {
					wire.Reset()
					_ = sealed.write(plain)
					frames = append(frames, append([]byte{}, wire.Bytes()...))
				}
				go func() { _, _ = io.Copy(io.Discard, theirs) }()
				_, _ = theirs.Write(c.damage(frames))
			}()
			if err := NewSession(ours, testKey, NewMemoryReplicas(), newRecorder(), Plan{List: true, Follow: true}).Run(); err == nil {
				t.Fatal("damage went unnoticed")
			}
		})
	}
}

func TestACompanionFrameOutsideTheProtocolIsAnError(t *testing.T) {
	s := NewSession(&bytes.Buffer{}, testKey, NewMemoryReplicas(), newRecorder(), Plan{})
	for _, frameType := range []byte{frameHello, frameList, frameOpen, frameAck, frameMeta, frameOpenNote, 99} {
		if _, err := s.handle([]byte{frameType}); err == nil {
			t.Errorf("frame type %d was taken", frameType)
		}
	}
}
