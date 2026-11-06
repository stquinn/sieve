package ink

import (
	"encoding/json"
	"fmt"
	"slices"
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
// it is open, and the destinations holding it. Page answers and stroke changes are handed out under
// one lock, each naming the seq it reflects, so a consumer holding a page answered at seq S takes
// every change above S and drops every one at or below it. It is safe for concurrent use.
type OpenNote struct {
	uuid string
	logs noteLogs

	mu   sync.Mutex
	note *StrokeBasedNote
	seq  uint32
	// holders are the destinations holding the note, in the order they first held it.
	holders []string
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

// Open is the note of container uuid, held by holder from now until it releases it, and replayed
// from its log on the first Open since nobody held it. The note is registered before its log is
// read, so a record committed while it is being read reaches it through Commit; a failed read
// leaves nothing registered. A container that is not a Digital Note is ErrNoSuchPage.
func (ns *OpenNotes) Open(uuid, holder string) (*OpenNote, error) {
	ns.mu.Lock()
	if o, ok := ns.notes[uuid]; ok {
		ns.mu.Unlock()
		o.mu.Lock()
		defer o.mu.Unlock()
		if o.note == nil {
			return nil, fmt.Errorf("%w: %s", ErrNoSuchPage, uuid)
		}
		o.hold(holder)
		return o, nil
	}
	o := &OpenNote{uuid: uuid, logs: ns.logs, holders: []string{holder}}
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
