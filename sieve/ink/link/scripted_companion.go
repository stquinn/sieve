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
	// others are the logs of the notes served beside Note's, by note.
	others map[ID][]Record

	// CorruptHead sends one HEAD whose hash does not hold.
	CorruptHead bool
	// RefuseAhead answers one OPEN with REFUSE ahead.
	RefuseAhead bool
	// StaleBeforeHead sends, before answering each OPEN, an OP and a DONE the session must ignore.
	StaleBeforeHead bool
	// Live sends LIVE of Note and Page after each NOTES.
	Live bool
	// LiveOf, when set, is the note a LIVE names in place of Note.
	LiveOf ID
	// Ink, when set, is sent as one INK frame after each LIVE.
	Ink []byte
	// GapAt skips the record of this seq.
	GapAt uint32
	// openNote is how each OPEN-NOTE is answered; see SetOpenNoteAnswer.
	openNote OpenNoteAnswer

	// Metas receives each META, Opens each OPEN's haveSeq, OpenNotes each OPEN-NOTE's note, and
	// Acks each ACK's seq.
	Metas     chan Meta
	Opens     chan uint32
	OpenNotes chan ID
	Acks      chan uint32
}

// OpenNoteAnswer is how a ScriptedCompanion answers OPEN-NOTE: with LIVE of the note and Page
// when Refuse is "", otherwise with REFUSE of the note for Refuse; not at all when Silent.
type OpenNoteAnswer struct {
	Refuse string
	Silent bool
}

// NewScriptedCompanion serves records as the log of note, under key.
func NewScriptedCompanion(key Key, note, page ID, records []Record) *ScriptedCompanion {
	return &ScriptedCompanion{
		Key: key, Note: note, Page: page, records: records,
		Metas: make(chan Meta, 8), Opens: make(chan uint32, 64), OpenNotes: make(chan ID, 64), Acks: make(chan uint32, 4096),
	}
}

// SetRecords replaces the log served from the next OPEN on.
func (c *ScriptedCompanion) SetRecords(records []Record) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.records = records
}

// SetNote serves records as the log of note, beside Note's, from the next LIST on.
func (c *ScriptedCompanion) SetNote(note ID, records []Record) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.others == nil {
		c.others = map[ID][]Record{}
	}
	c.others[note] = records
}

// SetOpenNoteAnswer sets how each OPEN-NOTE from now on is answered; it may be called while serving.
func (c *ScriptedCompanion) SetOpenNoteAnswer(a OpenNoteAnswer) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.openNote = a
}

// log is the records served as note's log. c.mu is held.
func (c *ScriptedCompanion) log(note ID) []Record {
	if other, ok := c.others[note]; ok && note != c.Note {
		return other
	}
	return c.records
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
			note := in.id()
			err = c.sendFrom(stream, note, in.u32())
		case frameAck:
			in.id()
			c.Acks <- in.u32()
		case frameMeta:
			c.Metas <- Meta{in.id(), in.string(), in.strings(), in.strings(), in.string(), in.u32()}
		case frameOpenNote:
			err = c.answerOpenNote(stream, in.id())
		}
		if err != nil {
			return err
		}
	}
}

func (c *ScriptedCompanion) sendNotes(stream *frameStream) error {
	c.mu.Lock()
	notes := newFrame(frameNotes).u32(uint32(1 + len(c.others))).id(c.Note).string("").u32(1).u32(uint32(len(c.records)))
	for note, records := range c.others {
		notes = notes.id(note).string("").u32(1).u32(uint32(len(records)))
	}
	live, ink, liveNote := c.Live, c.Ink, c.Note
	if c.LiveOf != (ID{}) {
		liveNote = c.LiveOf
	}
	c.mu.Unlock()
	if err := stream.write(notes.b); err != nil {
		return err
	}
	if !live {
		return nil
	}
	if err := stream.write(newFrame(frameLive).id(liveNote).id(c.Page).b); err != nil {
		return err
	}
	if len(ink) > 0 {
		return stream.write(newFrame(frameInk).raw(ink).b)
	}
	return nil
}

func (c *ScriptedCompanion) answerOpenNote(stream *frameStream, note ID) error {
	c.OpenNotes <- note
	c.mu.Lock()
	answer := c.openNote
	c.mu.Unlock()
	switch {
	case answer.Silent:
		return nil
	case answer.Refuse != "":
		return stream.write(newFrame(frameRefuse).id(note).string(answer.Refuse).b)
	default:
		return stream.write(newFrame(frameLive).id(note).id(c.Page).b)
	}
}

func (c *ScriptedCompanion) sendFrom(stream *frameStream, note ID, have uint32) error {
	c.Opens <- have
	c.mu.Lock()
	records, corrupt, ahead, stale, gapAt := c.log(note), c.CorruptHead, c.RefuseAhead, c.StaleBeforeHead, c.GapAt
	c.CorruptHead, c.RefuseAhead = false, false
	c.mu.Unlock()
	if stale {
		body, _ := Record{Seq: 99, Op: OpPageRemove, Page: c.Page}.Body()
		if err := stream.write(newFrame(frameOp).id(note).raw(NewLogFrame(body)).b); err != nil {
			return err
		}
		if err := stream.write(newFrame(frameDone).id(note).b); err != nil {
			return err
		}
	}
	if ahead {
		return stream.write(newFrame(frameRefuse).id(note).string(RefuseAhead).b)
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
	if err := stream.write(newFrame(frameHead).id(note).u32(cursor.Seq).raw(cursor.Hash[:]).b); err != nil {
		return err
	}
	for i := int(have); i < len(bodies); i++ {
		if uint32(i+1) == gapAt {
			continue
		}
		if err := stream.write(newFrame(frameOp).id(note).raw(NewLogFrame(bodies[i])).b); err != nil {
			return err
		}
	}
	return stream.write(newFrame(frameDone).id(note).b)
}
