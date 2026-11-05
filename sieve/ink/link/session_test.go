package link

import (
	"bytes"
	"crypto/rand"
	"errors"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

var testKey = Key{'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'}

// fakeCompanion is the companion's end of the protocol, enough to drive a session: it proves
// itself with its key and serves its log of vectorNote.
type fakeCompanion struct {
	key Key

	mu      sync.Mutex
	records []Record
	// corruptHead sends one HEAD whose hash does not hold.
	corruptHead bool
	// refuseAhead answers one OPEN with REFUSE ahead.
	refuseAhead bool
	// staleBeforeHead sends, before answering each OPEN, an OP and a DONE the session must ignore.
	staleBeforeHead bool
	// live sends LIVE of vectorNote after each NOTES.
	live bool
	// gapAt skips the record of this seq.
	gapAt uint32

	metas chan Meta
	opens chan uint32
	acks  chan uint32
}

func newFakeCompanion(records []Record) *fakeCompanion {
	return &fakeCompanion{key: testKey, records: records, metas: make(chan Meta, 8), opens: make(chan uint32, 8), acks: make(chan uint32, 512)}
}

func (c *fakeCompanion) setRecords(records []Record) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.records = records
}

// serve runs the protocol until the link closes or the session misbehaves.
func (c *fakeCompanion) serve(link io.ReadWriter) error {
	stream := newFrameStream(link)
	cNonce := make([]byte, nonceBytes)
	_, _ = rand.Read(cNonce)
	if err := stream.write(newFrame(frameChallenge).u8(protocolVersion).raw(cNonce).b); err != nil {
		return err
	}
	frame, err := stream.read(limitBeforeProof)
	if err != nil {
		return err
	}
	in := &frameReader{b: frame[1:]}
	name, sNonce, proof := in.string(), append([]byte{}, in.take(nonceBytes)...), in.take(proofBytes)
	if name != c.key.SieveID() || !bytes.Equal(proof, c.key.SieveProof(cNonce)) {
		return stream.write(newFrame(frameRefuse).id(ID{}).string(RefuseRefused).b)
	}
	if err := stream.write(newFrame(frameOK).raw(c.key.CompanionProof(sNonce)).b); err != nil {
		return err
	}
	sessionKey, err := c.key.SessionKey(cNonce, sNonce)
	if err != nil {
		return err
	}
	if err := stream.upgrade(sessionKey, CompanionToSieve, SieveToCompanion); err != nil {
		return err
	}
	for {
		frame, err := stream.read(limitFromSieve)
		if err != nil {
			return err
		}
		in := &frameReader{b: frame[1:]}
		switch frame[0] {
		case frameList:
			err = c.sendNotes(stream)
		case frameOpen:
			in.id()
			err = c.sendFrom(stream, in.u32())
		case frameAck:
			in.id()
			c.acks <- in.u32()
		case frameMeta:
			c.metas <- Meta{in.id(), in.string(), in.strings(), in.strings(), in.string(), in.u32()}
		}
		if err != nil {
			return err
		}
	}
}

func (c *fakeCompanion) sendNotes(stream *frameStream) error {
	c.mu.Lock()
	head, live := uint32(len(c.records)), c.live
	c.mu.Unlock()
	if err := stream.write(newFrame(frameNotes).u32(1).id(vectorNote).string("").u32(1).u32(head).b); err != nil {
		return err
	}
	if live {
		return stream.write(newFrame(frameLive).id(vectorNote).id(vectorPage).b)
	}
	return nil
}

func (c *fakeCompanion) sendFrom(stream *frameStream, have uint32) error {
	c.opens <- have
	c.mu.Lock()
	records, corrupt, ahead, stale, gapAt := c.records, c.corruptHead, c.refuseAhead, c.staleBeforeHead, c.gapAt
	c.corruptHead, c.refuseAhead = false, false
	c.mu.Unlock()
	if stale {
		body, _ := Record{Seq: 99, Op: OpPageRemove, Page: vectorPage}.Body()
		if err := stream.write(newFrame(frameOp).id(vectorNote).raw(NewLogFrame(body)).b); err != nil {
			return err
		}
		if err := stream.write(newFrame(frameDone).id(vectorNote).b); err != nil {
			return err
		}
	}
	if ahead {
		return stream.write(newFrame(frameRefuse).id(vectorNote).string(RefuseAhead).b)
	}
	var cursor Cursor
	bodies := make([][]byte, len(records))
	for i, r := range records {
		bodies[i], _ = r.Body()
		_ = cursor.Accept(r, bodies[i])
	}
	if corrupt {
		cursor.Hash[0] ^= 1
	}
	if err := stream.write(newFrame(frameHead).id(vectorNote).u32(cursor.Seq).raw(cursor.Hash[:]).b); err != nil {
		return err
	}
	for i := int(have); i < len(bodies); i++ {
		if uint32(i+1) == gapAt {
			continue
		}
		if err := stream.write(newFrame(frameOp).id(vectorNote).raw(NewLogFrame(bodies[i])).b); err != nil {
			return err
		}
	}
	return stream.write(newFrame(frameDone).id(vectorNote).b)
}

// recorder is an Observer that keeps what it is told.
type recorder struct {
	mu        sync.Mutex
	committed []uint32
	live      []ID
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
func (r *recorder) Live(note, _ ID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.live = append(r.live, note)
}

// harness runs sessions against one companion over loopback sockets, which have a little room in
// them as a real link has, so neither side's write waits for the other to read.
type harness struct {
	t         *testing.T
	companion *fakeCompanion
	replicas  *MemoryReplicas
}

func newHarness(t *testing.T, records []Record) *harness {
	return &harness{t: t, companion: newFakeCompanion(records), replicas: NewMemoryReplicas()}
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
		_ = h.companion.serve(theirs)
		theirs.Close()
	}()
	defer ours.Close()
	done := make(chan error, 1)
	go func() { done <- NewSession(ours, key, h.replicas, newRecorder(), p).Run() }()
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
		case out[i] = <-h.companion.opens:
		case <-time.After(time.Second):
			h.t.Fatalf("OPEN %d did not come", i+1)
		}
	}
	select {
	case extra := <-h.companion.opens:
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
	h.companion.setRecords(vectorRecords)
	if err := h.run(testKey, Plan{CatchUp: true}); err != nil {
		t.Fatalf("second session: %v", err)
	}
	if have := h.opens(2); have[0] != 0 || have[1] != 2 {
		t.Errorf("OPENs asked from %v, want 0 then 2", have)
	}
	if got := h.held().Cursor().Seq; got != uint32(len(vectorRecords)) {
		t.Errorf("held %d", got)
	}
	if err := h.run(testKey, Plan{CatchUp: true}); err != nil {
		t.Fatalf("third session: %v", err)
	}
	h.opens(0)
}

func TestAcksAreSentForWhatIsHeld(t *testing.T) {
	h := newHarness(t, vectorRecords)
	if err := h.run(testKey, Plan{CatchUp: true}); err != nil {
		t.Fatal(err)
	}
	select {
	case seq := <-h.companion.acks:
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
		setup func(*fakeCompanion)
		aside int
	}{
		{"a HEAD whose hash differs", func(c *fakeCompanion) { c.corruptHead = true }, len(vectorRecords)},
		{"REFUSE ahead", func(c *fakeCompanion) { c.refuseAhead = true }, 2},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t, vectorRecords[:2])
			if err := h.run(testKey, Plan{CatchUp: true}); err != nil {
				t.Fatal(err)
			}
			h.opens(1)
			h.companion.setRecords(vectorRecords)
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
			if got := h.held().Cursor().Seq; got != uint32(len(vectorRecords)) {
				t.Errorf("held %d", got)
			}
		})
	}
}

func TestOpAndDoneBeforeTheHeadAreIgnored(t *testing.T) {
	h := newHarness(t, vectorRecords)
	h.companion.staleBeforeHead = true
	if err := h.run(testKey, Plan{CatchUp: true}); err != nil {
		t.Fatal(err)
	}
	if got := h.held().Cursor().Seq; got != uint32(len(vectorRecords)) {
		t.Errorf("held %d", got)
	}
}

func TestAGapDropsTheLinkAndKeepsTheContiguousRecords(t *testing.T) {
	h := newHarness(t, vectorRecords)
	h.companion.gapAt = 3
	if err := h.run(testKey, Plan{CatchUp: true}); err == nil {
		t.Fatal("a gap was accepted")
	}
	if got := h.held().Cursor().Seq; got != 2 {
		t.Errorf("held %d", got)
	}
}

func TestFollowOpensTheLiveNote(t *testing.T) {
	h := newHarness(t, vectorRecords)
	h.companion.live = true
	ours, theirs := h.pair()
	go func() { _ = h.companion.serve(theirs) }()
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
	if got := <-h.companion.metas; got.Title != "A title" || got.Categories[0] != "Work" || got.AsOfSeq != 6 {
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
