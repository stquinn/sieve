package ink

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash"
	"slices"
	"strconv"
	"strings"
	"sync"

	"sieve/logger"
	"sieve/sieve/ink/link"
)

// noteLogs reads the whole log of the Digital Note in a container as it stands now.
type noteLogs interface {
	noteLog(uuid string) ([]byte, error)
}

// StrokeChange is what one committed record did to the strokes of a page present: one stroke
// added or one removed.
type StrokeChange struct {
	Page link.ID
	// Seq is the seq of the record that made the change.
	Seq uint32
	// Added is the stroke-add record of the stroke now present; nil for a removal.
	Added *link.Record
	// Removed is the id of the stroke now gone; zero for an addition.
	Removed link.ID
}

// ExportStroke is the added stroke in the §4.2 export shape; an error for a removal.
func (c StrokeChange) ExportStroke() ([]byte, error) {
	if c.Added == nil {
		return nil, fmt.Errorf("ink: seq %d removed a stroke", c.Seq)
	}
	return json.Marshal(newExportStroke(*c.Added))
}

// PageAnswer is one page of an open note as it stands at Seq. Key names the log the answer
// reflects: every byte of it up to the record at Seq, so two answers share a key exactly when
// nothing in the note changed between them. Exactly one of Export and Drawing is set: Export is the
// page in the §4.2 export shape; Drawing is the page's kept drawing, made at Key.
type PageAnswer struct {
	Seq     uint32
	Key     string
	Export  []byte
	Drawing []byte
}

// logKey names a log: the SHA-256 of its bytes, their length, and the seq of its last record. It
// is written "{hex sum}-{length}-{seq}".
type logKey struct {
	sum    [sha256.Size]byte
	length int
	seq    uint32
}

// parseLogKey reads a key as String writes it.
func parseLogKey(key string) (logKey, bool) {
	parts := strings.Split(key, "-")
	if len(parts) != 3 {
		return logKey{}, false
	}
	sum, err := hex.DecodeString(parts[0])
	length, lerr := strconv.Atoi(parts[1])
	seq, serr := strconv.ParseUint(parts[2], 10, 32)
	if err != nil || len(sum) != sha256.Size || lerr != nil || serr != nil || length < 0 {
		return logKey{}, false
	}
	k := logKey{length: length, seq: uint32(seq)}
	copy(k.sum[:], sum)
	return k, true
}

func (k logKey) String() string {
	return hex.EncodeToString(k.sum[:]) + "-" + strconv.Itoa(k.length) + "-" + strconv.FormatUint(uint64(k.seq), 10)
}

// names reports whether k is the key of log, whole.
func (k logKey) names(log []byte) bool {
	return len(log) == k.length && sha256.Sum256(log) == k.sum
}

// OpenNote is one Digital Note held while a view of it is open, the seq it stands at, and the
// destinations holding it. Page answers and stroke changes are handed out under one lock, each
// naming the seq it reflects, so a consumer holding a page answered at seq S takes every change
// above S and drops every one at or below it.
//
// The note's log is replayed only when something needs the replay. A page answered with its kept
// drawing needs none: the note then stands at the drawing's key with no replay, and is replayed up
// to exactly that key when a record is committed or a page must be exported. It is safe for
// concurrent use.
type OpenNote struct {
	uuid string
	logs noteLogs

	mu sync.Mutex
	// note is the replay; nil until one is needed.
	note *StrokeBasedNote
	// at names the log the note stands at; the zero key before any page is answered.
	at logKey
	// sum is the running SHA-256 of the log up to at; nil while there is no replay.
	sum hash.Hash
	// holders are the destinations holding the note, in the order they first held it.
	holders []string
}

// load replays the note's log: up to the key the note stands at when it stands at one and the log
// still starts with what that key names, otherwise whole as it stands now. o.mu is held.
func (o *OpenNote) load() error {
	log, err := o.logs.noteLog(o.uuid)
	if err != nil {
		return err
	}
	if o.at.length > 0 && o.at.length <= len(log) && o.at.names(log[:o.at.length]) {
		log = log[:o.at.length]
	}
	note := NewStrokeBasedNote(o.uuid)
	cursor, read := note.Read(log)
	o.note, o.sum = note, sha256.New()
	o.sum.Write(log[:read])
	o.at = logKey{length: read, seq: cursor.Seq}
	o.sum.Sum(o.at.sum[:0])
	return nil
}

// AnswerPage calls send with page as the note stands, and returns what send returns. kept, which
// may be nil, is asked for the page's kept drawing and the key it says it was made at: when the
// note stands at that key the drawing is the answer's Drawing, and otherwise the answer is the
// page's Export. A note not yet replayed whose log is the one a kept drawing's key names is
// answered with the drawing and stays unreplayed. An absent page is ErrNoSuchPage and send is not
// called. kept and send run while the note is held, so no change is handed out between the answer
// being built and send returning; neither may call back into the note.
func (o *OpenNote) AnswerPage(page link.ID, kept func() (drawing []byte, key string), send func(PageAnswer) error) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	var drawing []byte
	var madeAt string
	if kept != nil {
		drawing, madeAt = kept()
	}
	if o.note == nil && drawing != nil {
		if key, ok := parseLogKey(madeAt); ok && (o.at == key || o.at == logKey{}) {
			log, err := o.logs.noteLog(o.uuid)
			if err != nil {
				return err
			}
			if key.names(log) {
				o.at = key
				return send(PageAnswer{Seq: key.seq, Key: madeAt, Drawing: drawing})
			}
		}
	}
	if o.note == nil {
		if err := o.load(); err != nil {
			return err
		}
	}
	i := o.note.present(page)
	if i < 0 {
		return fmt.Errorf("%w: %s has no page %s", ErrNoSuchPage, o.uuid, page)
	}
	answer := PageAnswer{Seq: o.at.seq, Key: o.at.String()}
	if drawing != nil && madeAt == answer.Key {
		answer.Drawing = drawing
		return send(answer)
	}
	export, err := o.note.ExportPage(i)
	if err != nil {
		return err
	}
	answer.Export = export
	return send(answer)
}

// WhileAt calls keep while the note is held, and only when the note is replayed, still stands at
// key and has page; it reports whether it called it. keep must not call back into the note.
func (o *OpenNote) WhileAt(key string, page link.ID, keep func()) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.note == nil || o.at.String() != key || o.note.present(page) < 0 {
		return false
	}
	keep()
	return true
}

// Commit applies rec, the record committed after the last one the note holds, and calls send with
// the stroke change it made, if any, replaying the note first when it has not been. A record at or
// below the note's seq is already held and changes nothing. A record past the next seq means
// records were missed: the note replays its log again and hands out nothing for the records in
// between. send runs while the note is held, as AnswerPage's does.
func (o *OpenNote) Commit(rec link.Record, send func(StrokeChange)) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.note != nil && rec.Seq <= o.at.seq {
		return
	}
	if o.note == nil {
		if err := o.load(); err != nil {
			logger.Error("ink: replaying an open note", "container", o.uuid, "err", err.Error())
			return
		}
		if rec.Seq <= o.at.seq {
			return
		}
	}
	line, err := rec.JSONLine()
	if err != nil || rec.Seq != o.at.seq+1 {
		logger.Warn("ink: an open note missed records, replaying its log", "container", o.uuid, "seq", o.at.seq, "got", rec.Seq)
		o.at = logKey{}
		if err := o.load(); err != nil {
			logger.Error("ink: replaying an open note", "container", o.uuid, "err", err.Error())
		}
		return
	}
	o.sum.Write(line)
	o.at = logKey{length: o.at.length + len(line), seq: rec.Seq}
	o.sum.Sum(o.at.sum[:0])
	switch o.note.Apply(rec) {
	case StrokeAdded:
		send(StrokeChange{Page: rec.Page, Seq: rec.Seq, Added: &rec})
	case StrokeRemoved:
		send(StrokeChange{Page: rec.Page, Seq: rec.Seq, Removed: rec.Stroke})
	}
}

// Restart forgets where the note stood, replays its log again as it now stands when it had been
// replayed, which starts from seq 1 once its replica has been set aside, and then calls send while
// the note is held, so every change handed out after send is the new log's.
func (o *OpenNote) Restart(send func()) {
	o.mu.Lock()
	defer o.mu.Unlock()
	replayed := o.note != nil
	o.note, o.sum, o.at = nil, nil, logKey{}
	if replayed {
		if err := o.load(); err != nil {
			logger.Error("ink: replaying a restarted note", "container", o.uuid, "err", err.Error())
		}
	}
	send()
}

// hold adds holder to the note's holders. o.mu is held.
func (o *OpenNote) hold(holder string) {
	if !slices.Contains(o.holders, holder) {
		o.holders = append(o.holders, holder)
	}
}

// release takes holder from the note's holders and reports whether none is left.
func (o *OpenNote) release(holder string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.holders = slices.DeleteFunc(o.holders, func(h string) bool { return h == holder })
	return len(o.holders) == 0
}

// OpenNotes are the Digital Notes held open for views, by container uuid, each by the destinations
// that hold it: a destination is a name its caller chooses, such as the socket a view is on, and
// every stroke change and restart of a note is handed out once for all of its holders. A note is
// held from the first Open of its container by any destination until the last of them releases
// it; a container not held costs nothing. It is safe for concurrent use.
type OpenNotes struct {
	logs noteLogs

	mu    sync.Mutex
	notes map[string]*OpenNote
}

// NewOpenNotes holds notes open over the logs svc reads.
func NewOpenNotes(svc *InkService) *OpenNotes {
	return &OpenNotes{logs: svc, notes: map[string]*OpenNote{}}
}

// Open is the note of container uuid, held by holder from now until it releases it. Opening
// replays nothing: the log is only read, to find that the container holds a note. The note is
// registered before that read, so a record committed during it reaches the note through Commit; a
// failed read leaves nothing registered. A container that is not a Digital Note is ErrNoSuchPage.
func (ns *OpenNotes) Open(uuid, holder string) (*OpenNote, error) {
	ns.mu.Lock()
	if o, ok := ns.notes[uuid]; ok {
		ns.mu.Unlock()
		o.mu.Lock()
		defer o.mu.Unlock()
		o.hold(holder)
		return o, nil
	}
	o := &OpenNote{uuid: uuid, logs: ns.logs, holders: []string{holder}}
	o.mu.Lock()
	defer o.mu.Unlock()
	ns.notes[uuid] = o
	ns.mu.Unlock()
	if _, err := ns.logs.noteLog(uuid); err != nil {
		ns.mu.Lock()
		if ns.notes[uuid] == o {
			delete(ns.notes, uuid)
		}
		ns.mu.Unlock()
		return nil, err
	}
	return o, nil
}

// Commit hands rec, committed to the note in container uuid, to that note if it is held, and calls
// send with each stroke change it makes and the note's holders as they stand when it is made.
func (ns *OpenNotes) Commit(uuid string, rec link.Record, send func(holders []string, c StrokeChange)) {
	if o := ns.held(uuid); o != nil {
		o.Commit(rec, func(c StrokeChange) { send(slices.Clone(o.holders), c) })
	}
}

// Restart restarts the note of container uuid from its log, if it is held, and calls send with its
// holders as OpenNote.Restart calls its send.
func (ns *OpenNotes) Restart(uuid string, send func(holders []string)) {
	if o := ns.held(uuid); o != nil {
		o.Restart(func() { send(slices.Clone(o.holders)) })
	}
}

// WhileAt calls keep while the note of container uuid is held open and stands at key with page, as
// OpenNote.WhileAt does, and reports whether it called it.
func (ns *OpenNotes) WhileAt(uuid, key string, page link.ID, keep func()) bool {
	o := ns.held(uuid)
	return o != nil && o.WhileAt(key, page, keep)
}

// Holds reports whether any destination holds the note of container uuid open.
func (ns *OpenNotes) Holds(uuid string) bool { return ns.held(uuid) != nil }

// HeldBy reports whether holder holds the note of container uuid open.
func (ns *OpenNotes) HeldBy(uuid, holder string) bool {
	o := ns.held(uuid)
	if o == nil {
		return false
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	return slices.Contains(o.holders, holder)
}

// Release is holder no longer holding the note of container uuid; the note stops being held when
// no destination does.
func (ns *OpenNotes) Release(uuid, holder string) {
	ns.mu.Lock()
	defer ns.mu.Unlock()
	if o, ok := ns.notes[uuid]; ok && o.release(holder) {
		delete(ns.notes, uuid)
	}
}

// ReleaseAll is holder no longer holding any note.
func (ns *OpenNotes) ReleaseAll(holder string) {
	ns.mu.Lock()
	defer ns.mu.Unlock()
	for uuid, o := range ns.notes {
		if o.release(holder) {
			delete(ns.notes, uuid)
		}
	}
}

// held is the note of container uuid when it is held, otherwise nil.
func (ns *OpenNotes) held(uuid string) *OpenNote {
	ns.mu.Lock()
	defer ns.mu.Unlock()
	return ns.notes[uuid]
}
