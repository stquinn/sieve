package link

import (
	"bytes"
	"crypto/rand"
	"io"
	"sync"
)

// ScriptedCompanion is the companion's end of the protocol, enough to drive a Session in a
// test: it proves itself with its key and serves one note's log, misbehaving as its fields say.
// Set the fields before Serve and between sessions, never while one is serving.
type ScriptedCompanion struct {
	Key  Key
	Note ID
	// Page is the page a LIVE names, and a stale record removes.
	Page ID

	mu      sync.Mutex
	records []Record

	// CorruptHead sends one HEAD whose hash does not hold.
	CorruptHead bool
	// RefuseAhead answers one OPEN with REFUSE ahead.
	RefuseAhead bool
	// StaleBeforeHead sends, before answering each OPEN, an OP and a DONE the session must ignore.
	StaleBeforeHead bool
	// Live sends LIVE of Note and Page after each NOTES.
	Live bool
	// Ink, when set, is sent as one INK frame after each LIVE.
	Ink []byte
	// GapAt skips the record of this seq.
	GapAt uint32

	// Metas receives each META, Opens each OPEN's haveSeq, and Acks each ACK's seq.
	Metas chan Meta
	Opens chan uint32
	Acks  chan uint32
}

// NewScriptedCompanion serves records as the log of note, under key.
func NewScriptedCompanion(key Key, note, page ID, records []Record) *ScriptedCompanion {
	return &ScriptedCompanion{
		Key: key, Note: note, Page: page, records: records,
		Metas: make(chan Meta, 8), Opens: make(chan uint32, 64), Acks: make(chan uint32, 4096),
	}
}

// SetRecords replaces the log served from the next OPEN on.
func (c *ScriptedCompanion) SetRecords(records []Record) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.records = records
}

// Serve runs the protocol until the link closes or the session misbehaves.
func (c *ScriptedCompanion) Serve(link io.ReadWriter) error {
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
	if name != c.Key.SieveID() || !bytes.Equal(proof, c.Key.SieveProof(cNonce)) {
		return stream.write(newFrame(frameRefuse).id(ID{}).string(RefuseRefused).b)
	}
	if err := stream.write(newFrame(frameOK).raw(c.Key.CompanionProof(sNonce)).b); err != nil {
		return err
	}
	sessionKey, err := c.Key.SessionKey(cNonce, sNonce)
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
			c.Acks <- in.u32()
		case frameMeta:
			c.Metas <- Meta{in.id(), in.string(), in.strings(), in.strings(), in.string(), in.u32()}
		}
		if err != nil {
			return err
		}
	}
}

func (c *ScriptedCompanion) sendNotes(stream *frameStream) error {
	c.mu.Lock()
	head, live, ink := uint32(len(c.records)), c.Live, c.Ink
	c.mu.Unlock()
	if err := stream.write(newFrame(frameNotes).u32(1).id(c.Note).string("").u32(1).u32(head).b); err != nil {
		return err
	}
	if !live {
		return nil
	}
	if err := stream.write(newFrame(frameLive).id(c.Note).id(c.Page).b); err != nil {
		return err
	}
	if len(ink) > 0 {
		return stream.write(newFrame(frameInk).raw(ink).b)
	}
	return nil
}

func (c *ScriptedCompanion) sendFrom(stream *frameStream, have uint32) error {
	c.Opens <- have
	c.mu.Lock()
	records, corrupt, ahead, stale, gapAt := c.records, c.CorruptHead, c.RefuseAhead, c.StaleBeforeHead, c.GapAt
	c.CorruptHead, c.RefuseAhead = false, false
	c.mu.Unlock()
	if stale {
		body, _ := Record{Seq: 99, Op: OpPageRemove, Page: c.Page}.Body()
		if err := stream.write(newFrame(frameOp).id(c.Note).raw(NewLogFrame(body)).b); err != nil {
			return err
		}
		if err := stream.write(newFrame(frameDone).id(c.Note).b); err != nil {
			return err
		}
	}
	if ahead {
		return stream.write(newFrame(frameRefuse).id(c.Note).string(RefuseAhead).b)
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
	if err := stream.write(newFrame(frameHead).id(c.Note).u32(cursor.Seq).raw(cursor.Hash[:]).b); err != nil {
		return err
	}
	for i := int(have); i < len(bodies); i++ {
		if uint32(i+1) == gapAt {
			continue
		}
		if err := stream.write(newFrame(frameOp).id(c.Note).raw(NewLogFrame(bodies[i])).b); err != nil {
			return err
		}
	}
	return stream.write(newFrame(frameDone).id(c.Note).b)
}
