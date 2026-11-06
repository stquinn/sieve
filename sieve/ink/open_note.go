package ink

import (
	"encoding/json"
	"fmt"
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

// OpenNote is the full replay of one Digital Note and the seq it stands at, held while a view of
// it is open. Page answers and stroke changes are handed out under one lock, each naming the seq
// it reflects, so a consumer holding a page answered at seq S takes every change above S and
// drops every one at or below it. It is safe for concurrent use.
type OpenNote struct {
	uuid string
	logs noteLogs

	mu   sync.Mutex
	note *StrokeBasedNote
	seq  uint32
}

// load replays the note's whole log as it stands now. o.mu is held.
func (o *OpenNote) load() error {
	log, err := o.logs.noteLog(o.uuid)
	if err != nil {
		return err
	}
	note := NewStrokeBasedNote(o.uuid)
	cursor, _ := note.Read(log)
	o.note, o.seq = note, cursor.Seq
	return nil
}

// AnswerPage calls send with page's export page and the seq it reflects, and returns what send
// returns. An absent page is ErrNoSuchPage and send is not called. send runs while the note is
// held, so no change is handed out between the answer being built and send returning; it must not
// call back into the note.
func (o *OpenNote) AnswerPage(page link.ID, send func(export []byte, seq uint32) error) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	i := o.note.present(page)
	if i < 0 {
		return fmt.Errorf("%w: %s has no page %s", ErrNoSuchPage, o.uuid, page)
	}
	export, err := o.note.ExportPage(i)
	if err != nil {
		return err
	}
	return send(export, o.seq)
}

// Commit applies rec, the record committed after the last one the note holds, and calls send with
// the stroke change it made, if any. A record at or below the note's seq is already held and
// changes nothing. A record past the next seq means records were missed: the note replays its log
// again and hands out nothing for the records in between. send runs while the note is held, as
// AnswerPage's does.
func (o *OpenNote) Commit(rec link.Record, send func(StrokeChange)) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.note == nil || rec.Seq <= o.seq {
		return
	}
	if rec.Seq != o.seq+1 {
		logger.Warn("ink: an open note missed records, replaying its log", "container", o.uuid, "seq", o.seq, "got", rec.Seq)
		if err := o.load(); err != nil {
			logger.Error("ink: replaying an open note", "container", o.uuid, "err", err.Error())
		}
		return
	}
	o.seq = rec.Seq
	switch o.note.Apply(rec) {
	case StrokeAdded:
		send(StrokeChange{Page: rec.Page, Seq: rec.Seq, Added: &rec})
	case StrokeRemoved:
		send(StrokeChange{Page: rec.Page, Seq: rec.Seq, Removed: rec.Stroke})
	}
}

// Restart replays the note's log again as it now stands, which starts from seq 1 once its replica
// has been set aside, and then calls send while the note is held, so every change handed out after
// send is the new log's.
func (o *OpenNote) Restart(send func()) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.note == nil {
		return
	}
	if err := o.load(); err != nil {
		logger.Error("ink: replaying a restarted note", "container", o.uuid, "err", err.Error())
	}
	send()
}

// OpenNotes are the Digital Notes held open for views, by container uuid. A note is held from the
// first Open of its container to Release; a container not held costs nothing. It is safe for
// concurrent use.
type OpenNotes struct {
	logs noteLogs

	mu    sync.Mutex
	notes map[string]*OpenNote
}

// NewOpenNotes holds notes open over the logs svc reads.
func NewOpenNotes(svc *InkService) *OpenNotes {
	return &OpenNotes{logs: svc, notes: map[string]*OpenNote{}}
}

// Open is the note of container uuid, replayed from its log on the first Open since its last
// Release. The note is registered before its log is read, so a record committed while it is being
// read reaches it through Commit; a failed read leaves nothing registered. A container that is
// not a Digital Note is ErrNoSuchPage.
func (ns *OpenNotes) Open(uuid string) (*OpenNote, error) {
	ns.mu.Lock()
	if o, ok := ns.notes[uuid]; ok {
		ns.mu.Unlock()
		o.mu.Lock()
		defer o.mu.Unlock()
		if o.note == nil {
			return nil, fmt.Errorf("%w: %s", ErrNoSuchPage, uuid)
		}
		return o, nil
	}
	o := &OpenNote{uuid: uuid, logs: ns.logs}
	o.mu.Lock()
	defer o.mu.Unlock()
	ns.notes[uuid] = o
	ns.mu.Unlock()
	if err := o.load(); err != nil {
		ns.mu.Lock()
		if ns.notes[uuid] == o {
			delete(ns.notes, uuid)
		}
		ns.mu.Unlock()
		return nil, err
	}
	return o, nil
}

// Commit hands rec, committed to the note in container uuid, to that note if it is held.
func (ns *OpenNotes) Commit(uuid string, rec link.Record, send func(StrokeChange)) {
	ns.mu.Lock()
	o, ok := ns.notes[uuid]
	ns.mu.Unlock()
	if ok {
		o.Commit(rec, send)
	}
}

// Restart restarts the note of container uuid from its log, if it is held, and calls send as
// OpenNote.Restart does.
func (ns *OpenNotes) Restart(uuid string, send func()) {
	ns.mu.Lock()
	o, ok := ns.notes[uuid]
	ns.mu.Unlock()
	if ok {
		o.Restart(send)
	}
}

// Holds reports whether the note of container uuid is held open.
func (ns *OpenNotes) Holds(uuid string) bool {
	ns.mu.Lock()
	defer ns.mu.Unlock()
	_, ok := ns.notes[uuid]
	return ok
}

// Release stops holding the note of container uuid.
func (ns *OpenNotes) Release(uuid string) {
	ns.mu.Lock()
	defer ns.mu.Unlock()
	delete(ns.notes, uuid)
}
