package link

import (
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"unicode/utf8"
)

// Frame types; in the clear before the handshake ends, sealed after.
const (
	frameChallenge = 32
	frameHello     = 33
	frameOK        = 34
	frameRefuse    = 35
	frameList      = 36
	frameNotes     = 37
	frameOpen      = 38
	frameHead      = 39
	frameOp        = 40
	frameAck       = 41
	frameDone      = 42
	frameMeta      = 43
	frameOpenNote  = 44
	frameLive      = 45
	frameInk       = 46

	protocolVersion = 1
	nonceBytes      = 16
	proofBytes      = 32
)

// Reasons a REFUSE gives.
const (
	RefuseRefused       = "refused"
	RefuseNotOffered    = "not-offered"
	RefuseAhead         = "ahead"
	RefuseNotForeground = "not-foreground"
)

// ID is a UUID as its 16 RFC 9562 bytes. The zero ID is the nil UUID, which frames use for "none".
type ID [16]byte

// String is the canonical lowercase hyphenated form.
func (u ID) String() string {
	return fmt.Sprintf("%x-%x-%x-%x-%x", u[:4], u[4:6], u[6:8], u[8:10], u[10:])
}

// ParseID reads the 36-character hyphenated form; hex digits may be either case.
func ParseID(text string) (ID, error) {
	var u ID
	if len(text) != 36 || text[8] != '-' || text[13] != '-' || text[18] != '-' || text[23] != '-' {
		return u, fmt.Errorf("not a uuid: %q", text)
	}
	raw, err := hex.DecodeString(text[:8] + text[9:13] + text[14:18] + text[19:23] + text[24:])
	if err != nil {
		return u, fmt.Errorf("not a uuid: %q", text)
	}
	copy(u[:], raw)
	return u, nil
}

// frameWriter builds a frame or a log body, little-endian. A string or list too long for its
// length prefix sticks as an error, which finish reports.
type frameWriter struct {
	b   []byte
	err error
}

func newFrame(t byte) *frameWriter { return &frameWriter{b: []byte{t}} }

func (w *frameWriter) raw(v []byte) *frameWriter { w.b = append(w.b, v...); return w }
func (w *frameWriter) id(v ID) *frameWriter      { return w.raw(v[:]) }
func (w *frameWriter) u8(v byte) *frameWriter    { w.b = append(w.b, v); return w }
func (w *frameWriter) u32(v uint32) *frameWriter {
	w.b = binary.LittleEndian.AppendUint32(w.b, v)
	return w
}
func (w *frameWriter) u64(v uint64) *frameWriter {
	w.b = binary.LittleEndian.AppendUint64(w.b, v)
	return w
}
func (w *frameWriter) f32(v float32) *frameWriter { return w.u32(math.Float32bits(v)) }

func (w *frameWriter) string(v string) *frameWriter {
	if len(v) > math.MaxUint16 {
		w.fail(fmt.Errorf("a string of %d bytes is over the limit of %d", len(v), math.MaxUint16))
	}
	w.b = binary.LittleEndian.AppendUint16(w.b, uint16(len(v)))
	return w.raw([]byte(v))
}

func (w *frameWriter) strings(v []string) *frameWriter {
	if len(v) > math.MaxUint8 {
		w.fail(fmt.Errorf("a list of %d strings is over the limit of %d", len(v), math.MaxUint8))
	}
	w.u8(byte(len(v)))
	for _, s := range v {
		w.string(s)
	}
	return w
}

func (w *frameWriter) fail(err error) {
	if w.err == nil {
		w.err = err
	}
}

func (w *frameWriter) finish() ([]byte, error) { return w.b, w.err }

// frameReader reads a frame or a log body; the first short or invalid read sticks, and finish
// reports it.
type frameReader struct {
	b   []byte
	bad bool
}

func (r *frameReader) take(n int) []byte {
	if r.bad || n > len(r.b) {
		r.bad = true
		return make([]byte, n)
	}
	v := r.b[:n]
	r.b = r.b[n:]
	return v
}

func (r *frameReader) u8() byte     { return r.take(1)[0] }
func (r *frameReader) u32() uint32  { return binary.LittleEndian.Uint32(r.take(4)) }
func (r *frameReader) u64() uint64  { return binary.LittleEndian.Uint64(r.take(8)) }
func (r *frameReader) f32() float32 { return math.Float32frombits(r.u32()) }
func (r *frameReader) id() (v ID)   { copy(v[:], r.take(16)); return v }
func (r *frameReader) rest() []byte { return r.take(len(r.b)) }
func (r *frameReader) string() string {
	return string(r.take(int(binary.LittleEndian.Uint16(r.take(2)))))
}

// text is a string that must be valid UTF-8.
func (r *frameReader) text() string {
	s := r.string()
	if !utf8.ValidString(s) {
		r.bad = true
	}
	return s
}

// flag is a u8 that must be 0 or 1.
func (r *frameReader) flag() byte {
	v := r.u8()
	if v > 1 {
		r.bad = true
	}
	return v
}

func (r *frameReader) strings() []string {
	out := make([]string, r.u8())
	for i := range out {
		out[i] = r.string()
	}
	return out
}

func (r *frameReader) finish() error {
	if r.bad {
		return errors.New("a frame cut short or holding an invalid value")
	}
	if len(r.b) != 0 {
		return fmt.Errorf("%d bytes after a frame", len(r.b))
	}
	return nil
}

// notes reads NOTES after its type byte.
func (r *frameReader) notes() []NoteEntry {
	out := make([]NoteEntry, 0)
	for n := r.u32(); n > 0 && !r.bad; n-- {
		out = append(out, NoteEntry{ID: r.id(), Title: r.string(), Pages: r.u32(), HeadSeq: r.u32()})
	}
	return out
}

// head reads HEAD after its type byte.
func (r *frameReader) head() (ID, headCheck) {
	note, seq := r.id(), r.u32()
	var hash [32]byte
	copy(hash[:], r.take(32))
	return note, headCheck{seq, hash}
}

// NoteEntry is one line of NOTES: a note the companion offers this Sieve.
type NoteEntry struct {
	ID      ID
	Title   string
	Pages   uint32
	HeadSeq uint32
}

// The limits a companion holds META to: it drops a META over any of them.
const (
	metaTitleBytes   = 512
	metaSummaryBytes = 4096
	metaTerms        = 64
	metaTermBytes    = 128
)

// Meta is META: this Sieve's description of a note the companion offered. The companion drops
// it unless the note was offered on this connection, AsOfSeq is not past the note's head, and
// Title is at most 512 bytes, Summary 4 KiB, and Keywords and Categories at most 64 terms of
// 128 bytes.
type Meta struct {
	Note       ID
	Title      string
	Keywords   []string
	Categories []string
	Summary    string
	AsOfSeq    uint32
}

// Truncated is m cut to fit the companion's limits: Title to 512 bytes and Summary to 4 KiB,
// Keywords and Categories to their first 64 terms and each term to 128 bytes, every cut on a rune
// boundary. What fits is unchanged.
func (m Meta) Truncated() Meta {
	m.Title, m.Summary = m.cut(m.Title, metaTitleBytes), m.cut(m.Summary, metaSummaryBytes)
	m.Keywords, m.Categories = m.terms(m.Keywords), m.terms(m.Categories)
	return m
}

// terms is list cut to at most 64 terms of at most 128 bytes each, in a new slice.
func (m Meta) terms(list []string) []string {
	if list == nil {
		return nil
	}
	out := make([]string, 0, min(len(list), metaTerms))
	for _, t := range list[:min(len(list), metaTerms)] {
		out = append(out, m.cut(t, metaTermBytes))
	}
	return out
}

// cut is s cut to at most n bytes, ending on a rune boundary.
func (m Meta) cut(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

func (m Meta) encode() ([]byte, error) {
	return newFrame(frameMeta).id(m.Note).string(m.Title).strings(m.Keywords).strings(m.Categories).string(m.Summary).u32(m.AsOfSeq).finish()
}

// helloFrame is HELLO: this Sieve's name, its nonce and its proof.
type helloFrame struct {
	sieveID       string
	sNonce, proof []byte
}

func (h helloFrame) encode() []byte {
	return newFrame(frameHello).string(h.sieveID).raw(h.sNonce).raw(h.proof).b
}

// openFrame is OPEN: catch a note up from what this Sieve holds.
type openFrame struct {
	note ID
	have uint32
}

func (o openFrame) encode() []byte { return newFrame(frameOpen).id(o.note).u32(o.have).b }

// ackFrame is ACK: this Sieve holds a note to seq.
type ackFrame struct {
	note ID
	seq  uint32
}

func (a ackFrame) encode() []byte { return newFrame(frameAck).id(a.note).u32(a.seq).b }

// openNoteFrame is OPEN-NOTE: show a note on the companion at page, or at the page of the
// companion's own choosing when page is the zero ID.
type openNoteFrame struct{ note, page ID }

func (o openNoteFrame) encode() []byte { return newFrame(frameOpenNote).id(o.note).id(o.page).b }

// listFrame is LIST: ask for NOTES.
type listFrame struct{}

func (listFrame) encode() []byte { return newFrame(frameList).b }
