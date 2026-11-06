package link

import (
	"bytes"
	"errors"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

var testKey = Key{'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'}

// recorder is an Observer that keeps what it is told.
type recorder struct {
	mu        sync.Mutex
	committed []uint32
	live      []ID
	aside     []ID
	done      chan uint32
}

func newRecorder() *recorder { return &recorder{done: make(chan uint32, 8)} }

func (r *recorder) Notes([]NoteEntry)         {}
func (r *recorder) Opened(ID, uint32, uint32) {}
func (r *recorder) Ink([]LiveRecord)          {}
func (r *recorder) Refused(ID, string)        {}
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
	ours, theirs := h.pair()
	go func() {
		_ = h.companion.Serve(theirs)
		theirs.Close()
	}()
	defer ours.Close()
	done := make(chan error, 1)
	h.obs = newRecorder()
	go func() { done <- NewSession(ours, key, h.replicas, h.obs, p).Run() }()
	select {
	case err := <-done:
		return err
	case <-time.After(5 * time.Second):
		h.t.Fatal("the session did not finish")
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

func TestMetaReachesTheCompanionBeforeThePlanEnds(t *testing.T) {
	h := newHarness(t, vectorRecords)
	meta := Meta{vectorNote, "A title", []string{"k"}, []string{"Work"}, "A line.", 6}
	if err := h.run(testKey, Plan{Meta: &meta}); err != nil {
		t.Fatal(err)
	}
	if got := <-h.companion.Metas; got.Title != "A title" || got.Categories[0] != "Work" || got.AsOfSeq != 6 {
		t.Errorf("%+v", got)
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
