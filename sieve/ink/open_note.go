package ink

import (
	"bytes"
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

// noteLogs reads the whole published log of the Digital Note in a container as it stands now,
// says what seq that log is known to reach, and rewinds a log found short of it.
type noteLogs interface {
	noteLog(uuid string) ([]byte, error)
	// stands is the seq the note's published log is known to reach; false when nothing knows.
	stands(uuid string) (uint32, bool)
	// rewind cuts the note's log to its last good record and has what it lost synced again; the
	// note is then heard as its log restarted.
	rewind(uuid string) error
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

// heads reports whether log is the log k names followed by more.
func (k logKey) heads(log []byte) bool {
	return len(log) > k.length && k.names(log[:k.length])
}

// OpenNote is one Digital Note held while a view of it is open, the seq it stands at, and the
// destinations holding it. Page answers and stroke changes are handed out under one lock, each
// naming the seq it reflects, so a consumer holding a page answered at seq S takes every change
// above S and drops every one at or below it.
//
// The note's log is replayed only when something needs the replay. A page answered with its kept
// drawing needs none: the note then stands at the drawing's key with no replay, and is replayed up
// to exactly that key when a record is committed or a page must be exported. A drawing kept before
// the log grew by strokes alone is still the answer: it is sent first, and the note is then
// replayed and the strokes after the drawing handed out as changes.
//
// A whole replay that ends short of the seq the log is known to reach (noteLogs.stands) finds the
// log damaged: it is reported once and rewound, and the note takes no record until it is
// restarted. A kept drawing whose key is short of that seq is no answer. It is safe for concurrent
// use.
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
	// damaged is a replay found short of where the log is known to stand, until the next Restart.
	damaged bool
}

// load replays the note's log: up to the key the note stands at when it stands at one and the log
// still starts with what that key names, otherwise whole as it stands now, and then checked
// against the seq the log is known to reach. o.mu is held.
func (o *OpenNote) load() error {
	stands, known := o.logs.stands(o.uuid)
	log, err := o.logs.noteLog(o.uuid)
	if err != nil {
		return err
	}
	whole := true
	if o.at.length > 0 && o.at.length <= len(log) && o.at.names(log[:o.at.length]) {
		log, whole = log[:o.at.length], o.at.length == len(log)
	}
	note := NewStrokeBasedNote(o.uuid)
	cursor, read := note.Read(log)
	o.note, o.sum = note, sha256.New()
	o.sum.Write(log[:read])
	o.at = logKey{length: read, seq: cursor.Seq}
	o.sum.Sum(o.at.sum[:0])
	if whole && known && cursor.Seq < stands && !o.damaged {
		logger.Warn("ink: an open note's log ends short", "container", o.uuid, "seq", cursor.Seq, "stands", stands)
		o.damaged = true
		if err := o.logs.rewind(o.uuid); err != nil {
			logger.Error("ink: rewinding a short log", "container", o.uuid, "err", err.Error())
		}
	}
	return nil
}

// AnswerPage calls send with page as the note stands, and returns what send returns. kept, which
// may be nil, is asked for the page's kept drawing and the key it says it was made at: when the
// note stands at that key the drawing is the answer's Drawing, and otherwise the answer is the
// page's Export. A note not yet replayed whose log is the one a kept drawing's key names is
// answered with the drawing and stays unreplayed. One whose log is that log followed by stroke
// records alone is answered with the drawing at the drawing's seq, and after send returns changed
// is called with each stroke change those records make, on any page; with a nil changed, or any
// other record after the drawing, the answer is the page's Export. An absent page is ErrNoSuchPage
// and send is not called. kept, send and changed run while the note is held, so no other change is
// handed out between the answer being built and the last of them returning; none may call back
// into the note. A note with no published log is ErrSyncing, whatever page is asked.
func (o *OpenNote) AnswerPage(page link.ID, kept func() (drawing []byte, key string), send func(PageAnswer) error, changed func(StrokeChange)) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	var drawing []byte
	var madeAt string
	if kept != nil {
		drawing, madeAt = kept()
	}
	if o.note == nil && drawing != nil {
		if key, ok := parseLogKey(madeAt); ok && (o.at == key || o.at == logKey{}) {
			stands, known := o.logs.stands(o.uuid)
			log, err := o.logs.noteLog(o.uuid)
			if err != nil {
				return err
			}
			if key.names(log) && (!known || key.seq >= stands) {
				o.at = key
				return send(PageAnswer{Seq: key.seq, Key: madeAt, Drawing: drawing})
			}
			if tail, ok := o.strokesAfter(key, log); ok && changed != nil && (o.at == logKey{}) && (!known || key.seq+uint32(len(tail)) >= stands) {
				o.at = key
				if err := send(PageAnswer{Seq: key.seq, Key: madeAt, Drawing: drawing}); err != nil {
					return err
				}
				if err := o.load(); err != nil {
					return err
				}
				for _, rec := range tail {
					o.take(rec, changed)
				}
				return nil
			}
		}
	}
	if o.note == nil {
		if err := o.load(); err != nil {
			return err
		}
	}
	if o.at.length == 0 {
		return fmt.Errorf("%w: %s", ErrSyncing, o.uuid)
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
// below the note's seq is already held and changes nothing. One past the next seq has the note
// replayed whole, which finds a log short of where it is known to stand; a record that is still
// not the next, or any record while the note is damaged, is dropped. send runs while the note is
// held, as AnswerPage's does.
func (o *OpenNote) Commit(rec link.Record, send func(StrokeChange)) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.damaged || (o.note != nil && rec.Seq <= o.at.seq) {
		return
	}
	if o.note == nil && !o.replay(false) {
		return
	}
	if rec.Seq > o.at.seq+1 && !o.replay(true) {
		return
	}
	if rec.Seq <= o.at.seq {
		return
	}
	o.take(rec, send)
}

// replay loads the note, whole when whole and otherwise as load chooses, and reports whether it
// could; a failure is logged. o.mu is held.
func (o *OpenNote) replay(whole bool) bool {
	if whole {
		o.at = logKey{}
	}
	if err := o.load(); err != nil {
		logger.Error("ink: replaying an open note", "container", o.uuid, "err", err.Error())
		return false
	}
	return true
}

// strokesAfter are the records of log after the log key names, when log is that log followed by
// whole stroke-add and stroke-remove lines and nothing else.
func (o *OpenNote) strokesAfter(key logKey, log []byte) ([]link.Record, bool) {
	if !key.heads(log) {
		return nil, false
	}
	var tail []link.Record
	for rest := log[key.length:]; len(rest) > 0; {
		end := bytes.IndexByte(rest, '\n')
		if end < 0 {
			return nil, false
		}
		rec, err := link.ParseJSONLine(rest[:end+1])
		if err != nil || (rec.Op != link.OpStrokeAdd && rec.Op != link.OpStrokeRemove) {
			return nil, false
		}
		tail = append(tail, rec)
		rest = rest[end+1:]
	}
	return tail, true
}

// take applies rec to the replayed note and calls send with the stroke change it made, if any. A
// record while the note is damaged, or one that is not the next, is dropped. o.mu is held.
func (o *OpenNote) take(rec link.Record, send func(StrokeChange)) {
	if o.damaged || rec.Seq != o.at.seq+1 {
		return
	}
	line, err := rec.JSONLine()
	if err != nil {
		logger.Error("ink: an open note's record has no line", "container", o.uuid, "seq", rec.Seq, "err", err.Error())
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

// Restart forgets where the note stood and that it was damaged, replays its log again as it now
// stands when it had been replayed, which may stand at an earlier record once its replica has been
// rewound, and then calls send while the note is held, so every change handed out after send
// follows the log as it now stands.
func (o *OpenNote) Restart(send func()) {
	o.mu.Lock()
	defer o.mu.Unlock()
	replayed := o.note != nil
	o.note, o.sum, o.at, o.damaged = nil, nil, logKey{}, false
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
