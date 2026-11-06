package ink

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"sieve/logger"
	"sieve/sieve/domain"
	"sieve/sieve/ink/link"
	"sieve/sieve/services"
)

// The queue of a replica reaches its asset once it holds this many bytes, or this long after its
// first unwritten line, whichever comes first.
const (
	flushBytes = 64 << 10
	flushAfter = 250 * time.Millisecond
)

// NoteReplicas is this Sieve's replicas of one companion's notes, each a digital-note block
// container found by (note_companion, note_source_id) in its face. It implements link.Replicas.
// A replica's saves write its block and face over the container's .meta as stored, so a
// description written meanwhile, through writeMeta or not, is kept.
//
// A container is created on the first record appended to its replica, never on Open, with that
// record folded in. The container's strokes.jsonl asset is the log and the truth; its block is a
// copy of the replica's fold and cursor, saved only after the queue has reached the asset, and so
// its note_synced_seq is never ahead of the asset. The block is saved when the note is caught up
// (CaughtUp), when a note-header or page record is appended after that, and by End when anything
// changed since the last save; a stroke record alone never saves it. Call End after every session.
type NoteReplicas struct {
	containers *services.BlockContainerService
	kind       DigitalNoteKind
	companion  string
	flushBytes int
	flushAfter time.Duration

	mu sync.Mutex
	// held is each found container's uuid and face seq, nil until the next Have or Open looks.
	held map[link.ID]heldNote
	open map[link.ID]*NoteReplica
}

// heldNote is a container found for a note: its uuid, and the note_synced_seq of its face.
type heldNote struct {
	uuid   string
	synced uint32
}

var _ link.Replicas = (*NoteReplicas)(nil)

// NewNoteReplicas holds the replicas of the companion of identity companion in containers. The
// digital-note kind must be registered in the registry containers was built over.
func NewNoteReplicas(containers *services.BlockContainerService, companion string) *NoteReplicas {
	return &NoteReplicas{
		containers: containers, kind: NewDigitalNoteKind(), companion: companion,
		flushBytes: flushBytes, flushAfter: flushAfter, open: map[link.ID]*NoteReplica{},
	}
}

// Have is the open replica's cursor seq, otherwise the note_synced_seq of the note's container,
// read from .meta without opening the asset; 0 when no container is held.
func (rs *NoteReplicas) Have(note link.ID) (uint32, error) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	if r, ok := rs.open[note]; ok && !r.broken() {
		return r.Cursor().Seq, nil
	}
	if err := rs.find(); err != nil {
		return 0, err
	}
	return rs.held[note].synced, nil
}

// Open returns the note's replica. A held note's asset is replayed to find its cursor, and a
// damaged tail is cut off the asset there; an unknown note's replica is at the zero cursor with
// nothing on disk. A replica whose write failed is dropped and opened again from its asset.
func (rs *NoteReplicas) Open(note link.ID) (link.Replica, error) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	if r, ok := rs.open[note]; ok && !r.broken() {
		return r, nil
	}
	if err := rs.find(); err != nil {
		return nil, err
	}
	r := &NoteReplica{owner: rs, note: note, fold: NewHeaderFold("")}
	if h, ok := rs.held[note]; ok {
		if err := r.load(h.uuid); err != nil {
			return nil, err
		}
	}
	rs.open[note] = r
	return r, nil
}

// UUID is the container uuid of the note's open replica, otherwise of its held container; "" when
// neither holds one.
func (rs *NoteReplicas) UUID(note link.ID) (string, error) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	if r, ok := rs.open[note]; ok {
		if uuid := r.UUID(); uuid != "" {
			return uuid, nil
		}
	}
	if err := rs.find(); err != nil {
		return "", err
	}
	return rs.held[note].uuid, nil
}

// CaughtUp is the companion having sent the note to its head: the open replica's queue is written
// and its block saved if it changed since its last save, and from now on a note-header or page
// record appended to it saves the block too. A note with no open replica is left alone.
func (rs *NoteReplicas) CaughtUp(note link.ID) error {
	rs.mu.Lock()
	r, ok := rs.open[note]
	rs.mu.Unlock()
	if !ok {
		return nil
	}
	return r.caughtUp()
}

// Notes are the open replicas that hold a container, as their folds and cursors stand, which may
// be ahead of what their blocks show.
func (rs *NoteReplicas) Notes() []SyncedNote {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	var notes []SyncedNote
	for _, r := range rs.open {
		if n, ok := r.synced(); ok {
			notes = append(notes, n)
		}
	}
	return notes
}

// log is the whole log of the open replica whose container is uuid, as it stands now: its asset
// followed by its queue, so it holds every record appended so far. False when no open replica
// holds that container.
func (rs *NoteReplicas) log(uuid string) ([]byte, bool) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	for _, r := range rs.open {
		if r.UUID() == uuid {
			return r.log(), true
		}
	}
	return nil, false
}

// attrsOf are the block attrs of the open replica whose container is uuid, as its fold and cursor
// stand now. False when no open replica holds that container.
func (rs *NoteReplicas) attrsOf(uuid string) (map[string]interface{}, bool) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	for _, r := range rs.open {
		if r.UUID() == uuid {
			r.mu.Lock()
			defer r.mu.Unlock()
			return r.attrs(), true
		}
	}
	return nil, false
}

// writeMeta applies edit to the .meta of the container uuid under the lock of the open replica
// holding it, whose handle then holds what was written. False, with nothing written, when no open
// replica holds that container.
func (rs *NoteReplicas) writeMeta(uuid string, edit func(domain.DocumentMeta)) (bool, error) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	for _, r := range rs.open {
		if r.UUID() != uuid {
			continue
		}
		r.mu.Lock()
		defer r.mu.Unlock()
		saved, err := rs.containers.SaveMeta(uuid, edit)
		if err == nil {
			r.container = saved
		}
		return true, err
	}
	return false, nil
}

// errForgotten is the write of a replica whose container was deleted.
var errForgotten = errors.New("ink: the note's container was deleted")

// forget drops the open replica whose container is uuid, its queue unwritten, so that nothing it
// is given reaches a container again, and looks for containers afresh at the next Have or Open.
// restore puts back what forget dropped, as it stood, for a container whose delete failed.
func (rs *NoteReplicas) forget(uuid string) (restore func()) {
	type dropped struct {
		note  link.ID
		r     *NoteReplica
		queue []byte
		err   error
	}
	var gone []dropped
	rs.mu.Lock()
	defer rs.mu.Unlock()
	for note, r := range rs.open {
		if r.UUID() != uuid {
			continue
		}
		r.mu.Lock()
		if r.timer != nil {
			r.timer.Stop()
			r.timer = nil
		}
		gone = append(gone, dropped{note: note, r: r, queue: r.queue, err: r.err})
		r.queue, r.err = nil, errForgotten
		r.mu.Unlock()
		delete(rs.open, note)
	}
	rs.held = nil
	return func() {
		rs.mu.Lock()
		defer rs.mu.Unlock()
		for _, d := range gone {
			d.r.mu.Lock()
			d.r.queue, d.r.err = d.queue, d.err
			if len(d.r.queue) > 0 && d.r.timer == nil {
				d.r.timer = time.AfterFunc(rs.flushAfter, d.r.flushLater)
			}
			d.r.mu.Unlock()
			rs.open[d.note] = d.r
		}
		rs.held = nil
	}
}

// End writes every open replica's queue, then saves the block of each that changed since its
// last save, and releases them all. A replica whose write failed is released unsaved, so its
// block stays behind its asset. The next Have or Open looks for containers again.
func (rs *NoteReplicas) End() error {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	var errs []error
	for note, r := range rs.open {
		if err := r.end(); err != nil {
			errs = append(errs, fmt.Errorf("note %s: %w", note, err))
		}
	}
	rs.open = map[link.ID]*NoteReplica{}
	rs.held = nil
	return errors.Join(errs...)
}

// find fills held from the face of this companion's containers, once until End. Of two
// containers for one note, the later uuid is held. rs.mu is held.
func (rs *NoteReplicas) find() error {
	if rs.held != nil {
		return nil
	}
	found, err := rs.containers.Find(KindDigitalNote, map[string]string{"note_companion": rs.companion})
	if err != nil {
		return err
	}
	held := map[link.ID]heldNote{}
	for uuid, meta := range found {
		note, err := link.ParseID(meta["note_source_id"])
		if err != nil {
			continue
		}
		if prior, twice := held[note]; twice {
			logger.Warn("ink: two containers hold one note", "note", note.String(), "uuids", prior.uuid+" "+uuid)
			if prior.uuid > uuid {
				continue
			}
		}
		synced, _ := strconv.ParseUint(meta["note_synced_seq"], 10, 32)
		held[note] = heldNote{uuid: uuid, synced: uint32(synced)}
	}
	rs.held = held
	return nil
}

// NoteReplica is one note's replica: a digital-note container's strokes.jsonl, read once on
// open and then only appended to. Appended lines are queued and reach the asset when the queue
// passes its size, on a short timer, before every save of its block, and on Flush, SetAside or End;
// a failed write is reported by every later Append and Flush. It is safe for concurrent use.
type NoteReplica struct {
	owner *NoteReplicas
	note  link.ID

	mu        sync.Mutex
	container *domain.BlockContainer
	cursor    link.Cursor
	fold      *StrokeBasedNote
	queue     []byte
	timer     *time.Timer
	err       error
	// changed is the fold or cursor having moved since the block was last saved.
	changed bool
	// following is the note caught up to its head, so that a structural record saves the block.
	following bool
}

var _ link.Replica = (*NoteReplica)(nil)

func (r *NoteReplica) Cursor() link.Cursor {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.cursor
}

// UUID is the note's container uuid, "" before its first record.
func (r *NoteReplica) UUID() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.container == nil {
		return ""
	}
	return r.container.UUID()
}

// Append takes rec if Cursor.Accept does, folds it into the header and queues its line; the
// first record taken creates the note's container with it folded in. Once the note is caught up, a
// note-header, page-add, page-remove or page-template record also writes the queue and saves the
// block; a failure of that save is logged and left to the next save. Any error leaves the cursor as
// it was.
func (r *NoteReplica) Append(rec link.Record, body []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.err != nil {
		return r.err
	}
	next := r.cursor
	if err := next.Accept(rec, body); err != nil {
		return err
	}
	line, err := rec.JSONLine()
	if err != nil {
		return err
	}
	if len(r.queue)+len(line) > r.owner.flushBytes {
		if err := r.flush(); err != nil {
			return err
		}
	}
	r.fold.Apply(rec)
	if r.container == nil {
		c, err := r.owner.containers.Create(KindDigitalNote, r.attrs())
		if err != nil {
			r.fold = NewHeaderFold("")
			return err
		}
		r.container, r.fold.id = c, c.UUID()
	}
	r.cursor = next
	r.queue = append(r.queue, line...)
	r.changed = true
	if r.following && rec.Op != link.OpStrokeAdd && rec.Op != link.OpStrokeRemove {
		if err := r.save(); err != nil {
			logger.Error("ink: saving a note's block", "note", r.note.String(), "err", err.Error())
		}
		return nil
	}
	if r.timer == nil {
		r.timer = time.AfterFunc(r.owner.flushAfter, r.flushLater)
	}
	return nil
}

// Flush writes the queue to the asset.
func (r *NoteReplica) Flush() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.flush()
}

// SetAside writes the queue, moves strokes.jsonl to an aside asset in the same container, kept,
// and starts again from the zero cursor in the same container. The block's note_synced_seq is
// saved as 0 before the asset moves.
func (r *NoteReplica) SetAside() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.flush(); err != nil {
		return err
	}
	if r.container != nil {
		if err := r.moveAside(); err != nil {
			r.err = err
			return err
		}
		logger.Warn("ink: replica set aside", "note", r.note.String(), "container", r.container.UUID())
	}
	r.cursor, r.fold, r.changed, r.following = link.Cursor{}, NewHeaderFold(r.uuid()), true, false
	return nil
}

// moveAside saves the block at seq 0, copies the asset to the next free aside key and deletes
// it. r.mu is held.
func (r *NoteReplica) moveAside() error {
	svc := r.owner.containers
	r.container.Merge(map[string]interface{}{"note_synced_seq": 0})
	saved, err := svc.Save(r.container)
	if err != nil {
		return err
	}
	r.container = saved
	asset, err := svc.LoadAsset(saved, StrokesKey)
	if err != nil {
		return nil
	}
	aside := 1
	for _, a := range saved.Assets() {
		if strings.HasPrefix(a.Key(), "strokes.aside-") {
			aside++
		}
	}
	if _, err := svc.SaveAsset(saved, fmt.Sprintf("strokes.aside-%d.jsonl", aside), asset.Body()); err != nil {
		return err
	}
	if err := svc.DeleteAsset(saved, StrokesKey); err != nil {
		return err
	}
	reloaded, err := svc.Load(saved.UUID())
	if err != nil {
		return err
	}
	r.container = reloaded
	return nil
}

// load opens the container uuid: its asset is replayed to the cursor, a damaged tail is cut off
// the asset, and a block whose face is past the cursor is saved at the cursor.
func (r *NoteReplica) load(uuid string) error {
	svc := r.owner.containers
	c, err := svc.Load(uuid)
	if err != nil {
		return err
	}
	r.container, r.fold = c, NewHeaderFold(uuid)
	var log []byte
	if asset, err := svc.LoadAsset(c, StrokesKey); err == nil {
		log = asset.Body()
	}
	cursor, read := r.fold.Read(log)
	r.cursor = cursor
	if read < len(log) {
		logger.Warn("ink: cutting a damaged log", "container", uuid, "seq", cursor.Seq, "bytes", len(log)-read)
		if _, err := svc.SaveAsset(c, StrokesKey, log[:read]); err != nil {
			return err
		}
	}
	if synced, _ := strconv.ParseUint(c.Storable().Meta()["note_synced_seq"], 10, 32); uint32(synced) > cursor.Seq {
		c.Merge(r.attrs())
		saved, err := svc.Save(c)
		if err != nil {
			return err
		}
		r.container = saved
	}
	return nil
}

// caughtUp saves the block and marks the note followed. r.mu is not held.
func (r *NoteReplica) caughtUp() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.following = true
	return r.save()
}

// end writes the queue and saves the block. r.mu is not held.
func (r *NoteReplica) end() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.save()
}

// save writes the queue and, when the replica changed since its last save, saves its block. r.mu
// is held.
func (r *NoteReplica) save() error {
	if r.timer != nil {
		r.timer.Stop()
		r.timer = nil
	}
	if err := r.flush(); err != nil {
		return err
	}
	if !r.changed || r.container == nil {
		return nil
	}
	r.container.Merge(r.attrs())
	saved, err := r.owner.containers.Save(r.container)
	if err != nil {
		return err
	}
	r.container, r.changed = saved, false
	return nil
}

// synced is the replica as Settings shows a note, false before it has a container. r.mu is not
// held.
func (r *NoteReplica) synced() (SyncedNote, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.container == nil {
		return SyncedNote{}, false
	}
	whiteboard := false
	for _, p := range r.fold.Pages() {
		whiteboard = whiteboard || p.Bounds == link.BoundsUnbounded
	}
	return SyncedNote{UUID: r.container.UUID(), Title: r.fold.Title(), Pages: r.fold.PageCount(), Seq: r.cursor.Seq,
		Companion: r.owner.companion, Device: r.fold.Header().Device.Name, Whiteboard: whiteboard}, true
}

// log is the asset followed by the queue, read under r.mu so no append falls between the two. r.mu
// is not held.
func (r *NoteReplica) log() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []byte
	if asset, err := r.owner.containers.LoadAsset(r.container, StrokesKey); err == nil {
		out = append(out, asset.Body()...)
	}
	return append(out, r.queue...)
}

// flush appends the queue to the asset; a failure sticks. r.mu is held.
func (r *NoteReplica) flush() error {
	if r.err != nil {
		return r.err
	}
	if len(r.queue) == 0 {
		return nil
	}
	if _, err := r.owner.containers.AppendAsset(r.container, StrokesKey, r.queue); err != nil {
		r.err = fmt.Errorf("ink: writing note %s: %w", r.note, err)
		return r.err
	}
	r.queue = r.queue[:0]
	return nil
}

// flushLater is the timer's flush.
func (r *NoteReplica) flushLater() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.timer = nil
	if err := r.flush(); err != nil {
		logger.Error("ink: timed write failed", "err", err.Error())
	}
}

func (r *NoteReplica) broken() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.err != nil
}

// attrs are the block's attrs for the replica as it stands. r.mu is held.
func (r *NoteReplica) attrs() map[string]interface{} {
	return r.owner.kind.Attrs(r.fold, Provenance{Companion: r.owner.companion, SourceID: r.note, SyncedSeq: r.cursor.Seq})
}

// uuid is the container's uuid, "" before it exists. r.mu is held.
func (r *NoteReplica) uuid() string {
	if r.container == nil {
		return ""
	}
	return r.container.UUID()
}
