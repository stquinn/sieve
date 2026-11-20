package ink

import (
	"errors"
	"fmt"
	"math"
	"strconv"
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
// record folded in; until its first catch-up is published it holds no strokes.jsonl. The
// container's strokes.jsonl asset is the published log and the truth; its block is a copy of the
// replica's fold and cursor, saved only after the queue has reached the asset, and so its
// note_synced_seq is never ahead of the asset. A catch-up — the records from a HEAD past the
// replica's cursor to its DONE — is staged outside the library and published at the DONE (Settle)
// in one write. The block is saved when the note settles, when a note-header or page record is
// appended while it follows, and by End when anything published changed since the last save; a
// stroke record alone never saves it. A log found damaged — on open, after a write, or by a reader
// — is rewound (NoteReplica.Rewind) to its last good record. Call End after every session.
type NoteReplicas struct {
	containers *services.BlockContainerService
	staging    *NoteStaging
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

// NewNoteReplicas holds the replicas of the companion of identity companion in containers,
// staging their catch-ups in staging. The digital-note kind must be registered in the registry
// containers was built over.
func NewNoteReplicas(containers *services.BlockContainerService, staging *NoteStaging, companion string) *NoteReplicas {
	return &NoteReplicas{
		containers: containers, staging: staging, kind: NewDigitalNoteKind(), companion: companion,
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

// Open returns the note's replica. A held note's asset is replayed to find its cursor; a log that
// does not replay whole, or to the seq its face states, is rewound to its last good record, and
// otherwise a staged catch-up that follows it is resumed. An unknown note's replica is at the zero
// cursor with nothing on disk. A replica whose write failed is dropped and opened again from its
// asset.
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

// Rewind rewinds the replica of the note held in container uuid, opening it if it is not open, as
// NoteReplica.Rewind does to seq, and returns the note and the seq the replica then stands at. A
// container that holds none of this companion's notes is ErrNoSuchNote.
func (rs *NoteReplicas) Rewind(uuid string, seq uint32) (link.ID, uint32, error) {
	note, ok, err := rs.noteOf(uuid)
	if err != nil {
		return link.ID{}, 0, err
	}
	if !ok {
		return link.ID{}, 0, fmt.Errorf("%w: %s holds no note of %s", ErrNoSuchNote, uuid, rs.companion)
	}
	opened, err := rs.Open(note)
	if err != nil {
		return link.ID{}, 0, err
	}
	r := opened.(*NoteReplica)
	if err := r.Rewind(seq); err != nil {
		return link.ID{}, 0, err
	}
	return note, r.Cursor().Seq, nil
}

// noteOf is the note whose open replica or held container is uuid; false when none is.
func (rs *NoteReplicas) noteOf(uuid string) (link.ID, bool, error) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	for note, r := range rs.open {
		if r.UUID() == uuid {
			return note, true, nil
		}
	}
	if err := rs.find(); err != nil {
		return link.ID{}, false, err
	}
	for note, h := range rs.held {
		if h.uuid == uuid {
			return note, true, nil
		}
	}
	return link.ID{}, false, nil
}

// publishedSeq is the seq the published log of the open replica whose container is uuid stands
// at: its cursor, except while it catches up, when it is the cursor the catch-up began at. False
// when no open replica holds that container.
func (rs *NoteReplicas) publishedSeq(uuid string) (uint32, bool) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	for _, r := range rs.open {
		if r.UUID() == uuid {
			r.mu.Lock()
			defer r.mu.Unlock()
			if r.state == stateCatchingUp {
				return r.published.Seq, true
			}
			return r.cursor.Seq, true
		}
	}
	return 0, false
}

// isFollowing reports whether the note's open replica follows, so that what is appended to it is
// published as it is written; false while it catches up or is rewound, true for a note with no
// open replica.
func (rs *NoteReplicas) isFollowing(note link.ID) bool {
	rs.mu.Lock()
	r, ok := rs.open[note]
	rs.mu.Unlock()
	return !ok || r.isFollowing()
}

// takePublished is what the last Settle of the note's open replica published and nobody has yet
// taken; false when there is none.
func (rs *NoteReplicas) takePublished(note link.ID) (Publication, bool) {
	rs.mu.Lock()
	r, ok := rs.open[note]
	rs.mu.Unlock()
	if !ok {
		return Publication{}, false
	}
	return r.takePublished()
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

// log is the published log of the open replica whose container is uuid, as it stands now: its
// asset, followed by its queue while it follows, so it holds every record published or about to
// be; a catch-up's records are not in it until they are published. False when no open replica
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
// stand now while it follows, and as they stood at its published log while it catches up. False
// when no open replica holds that container, and while the one that does has no published log: the
// note is then what its block was last saved as.
func (rs *NoteReplicas) attrsOf(uuid string) (map[string]interface{}, bool) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	for _, r := range rs.open {
		if r.UUID() == uuid {
			r.mu.Lock()
			defer r.mu.Unlock()
			switch {
			case r.state == stateCatchingUp && r.published.Seq == 0, r.state == stateRewound && r.cursor.Seq == 0:
				return nil, false
			case r.state == stateCatchingUp:
				return r.publishedAttrs, true
			}
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

// End writes every open replica's queue, then saves the block of each that follows and changed
// since its last save, and releases them all. A replica catching up writes its queue to staging
// and publishes nothing, so the next Open resumes it. A replica whose write failed is released
// unsaved, so its block stays behind its asset; one whose write found its log damaged is rewound,
// which is no error. The next Have or Open looks for containers again.
func (rs *NoteReplicas) End() error {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	var errs []error
	for note, r := range rs.open {
		if err := r.end(); err != nil && !errors.Is(err, link.ErrRewound) {
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
// open and then only appended to, except by a rewind. Appended lines are queued and are written
// when the queue passes its size, on a short timer, before every save of its block, and on Flush,
// Settle or End: while the replica follows, to the asset, which must then be the length it was
// left at plus what was written, or the replica is rewound to its last good record and the write
// is link.ErrRewound; while it catches up, to staging. A failed write is reported by every later
// Append and Flush. It is safe for concurrent use.
type NoteReplica struct {
	owner *NoteReplicas
	note  link.ID

	mu        sync.Mutex
	state     replicaState
	container *domain.BlockContainer
	cursor    link.Cursor
	fold      *StrokeBasedNote
	queue     []byte
	timer     *time.Timer
	err       error
	// changed is the fold or cursor having moved since the block was last saved.
	changed bool
	// length is how many bytes the published log was left at.
	length int64
	// published is the cursor the published log stands at, and publishedAttrs the block's attrs
	// at it; both are kept only while the replica catches up.
	published      link.Cursor
	publishedAttrs map[string]interface{}
	// publication is what the last Settle published, until it is taken.
	publication *Publication
}

// replicaState is where a replica's appends go.
type replicaState uint8

const (
	// stateFollowing publishes each append into the library as it is written.
	stateFollowing replicaState = iota
	// stateCatchingUp stages each append outside the library until Settle publishes them together.
	stateCatchingUp
	// stateRewound takes no append: the replica stands where a rewind left it until a Begin.
	stateRewound
)

// Publication is the records one Settle published, in seq order. First is the published log
// having been empty before them: the note had no log for a reader to stand on.
type Publication struct {
	Records []link.Record
	First   bool
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
// first record taken creates the note's container with it folded in. While the replica follows, a
// note-header, page-add, page-remove or page-template record also writes the queue and saves the
// block; a failure of that save is logged and left to the next save. A rewound replica takes
// nothing and is link.ErrRewound, as is a write that finds the log damaged, which leaves the cursor
// where the rewind put it; any other error leaves the cursor as it was.
func (r *NoteReplica) Append(rec link.Record, body []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.err != nil {
		return r.err
	}
	if r.state == stateRewound {
		return link.ErrRewound
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
	if r.state == stateFollowing && rec.Op != link.OpStrokeAdd && rec.Op != link.OpStrokeRemove {
		if err := r.save(); errors.Is(err, link.ErrRewound) {
			return err
		} else if err != nil {
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

// Rewind starts the replica again from the cursor at seq, or the nearest one below it that the
// published log still replays to. The queue and any catch-up under way, staged records and all,
// are dropped. The block is saved at that cursor when its face stands elsewhere; then, when the
// published log holds more than the records kept, the whole of it is kept as the next free
// strokes.aside-N.jsonl asset and the records kept are published in its place, none at all as no
// strokes.jsonl. The replica takes no append until its next Begin.
func (r *NoteReplica) Rewind(seq uint32) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.err != nil {
		return r.err
	}
	return r.rewind(seq)
}

// Begin starts a catch-up when head is past the cursor: the queue is written to the asset, and
// what is appended from now until Settle is staged. A replica resumed from staging is catching up
// already, whatever head is; a rewound one takes appends again.
func (r *NoteReplica) Begin(head uint32) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.err != nil {
		return r.err
	}
	if r.state == stateRewound {
		r.state = stateFollowing
	}
	if r.state == stateCatchingUp || head <= r.cursor.Seq {
		return nil
	}
	if err := r.flush(); err != nil {
		return err
	}
	r.state, r.published, r.publishedAttrs = stateCatchingUp, r.cursor, r.attrs()
	return nil
}

// Settle is the note's DONE. A replica catching up writes its queue to staging, reads the staged
// records back and replays them from the published cursor; they must reach the cursor the
// replica holds, or the replica is rewound to its published log and Settle is link.ErrRewound.
// They are then published into the container in one write — the whole log when there was none,
// otherwise one append — the block is saved and the staged file dropped, and the replica follows.
// A replica that follows saves its block if it changed. A rewound replica settles nothing and is
// link.ErrRewound.
func (r *NoteReplica) Settle() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.err != nil {
		return r.err
	}
	switch r.state {
	case stateFollowing:
		return r.saveSettled()
	case stateRewound:
		return link.ErrRewound
	}
	r.stopTimer()
	if err := r.flush(); err != nil {
		return err
	}
	if r.container == nil {
		r.state, r.publishedAttrs = stateFollowing, nil
		return nil
	}
	uuid := r.container.UUID()
	staged, err := r.owner.staging.Resume(uuid, r.published)
	if err != nil {
		r.err = err
		return err
	}
	if len(staged.Records) == 0 {
		staged.Cursor = r.published
	}
	if staged.Cursor != r.cursor {
		logger.Warn("ink: a note's staged catch-up does not reach its cursor", "note", r.note.String(), "container", uuid,
			"reached", staged.Cursor.Seq, "cursor", r.cursor.Seq)
		if err := r.rewind(r.published.Seq); err != nil {
			return err
		}
		return link.ErrRewound
	}
	first := r.published.Seq == 0
	if len(staged.Records) > 0 {
		if err := r.writeLog(staged.Bytes, first); err != nil {
			return err
		}
		r.publication = &Publication{Records: staged.Records, First: first}
		r.changed = true
	}
	r.state, r.publishedAttrs = stateFollowing, nil
	if err := r.saveSettled(); err != nil {
		return err
	}
	return r.owner.staging.Drop(uuid)
}

// saveSettled saves a settled replica's block. A failed write of the log, or one that found it
// damaged, is returned; a failed save of the block alone is logged and left to the next save. r.mu
// is held.
func (r *NoteReplica) saveSettled() error {
	if err := r.save(); err != nil {
		if r.err != nil || errors.Is(err, link.ErrRewound) {
			return err
		}
		logger.Error("ink: saving a settled note's block", "note", r.note.String(), "err", err.Error())
	}
	return nil
}

// rewind is Rewind. A failure sticks. r.mu is held.
func (r *NoteReplica) rewind(seq uint32) error {
	r.stopTimer()
	r.queue = r.queue[:0]
	r.state, r.published, r.publishedAttrs, r.publication = stateRewound, link.Cursor{}, nil, nil
	if r.container == nil {
		r.cursor, r.fold, r.length, r.changed = link.Cursor{}, NewHeaderFold(""), 0, false
		return nil
	}
	uuid := r.container.UUID()
	if err := r.owner.staging.Drop(uuid); err != nil {
		r.err = err
		return err
	}
	var log []byte
	if asset, err := r.owner.containers.LoadAsset(r.container, StrokesKey); err == nil {
		log = asset.Body()
	}
	r.fold = NewHeaderFold(uuid)
	cursor, read := r.fold.ReadTo(log, seq)
	r.cursor, r.length = cursor, int64(read)
	if err := r.cut(log, read); err != nil {
		r.err = fmt.Errorf("ink: rewinding note %s: %w", r.note, err)
		return r.err
	}
	logger.Warn("ink: a note's log rewound", "note", r.note.String(), "container", uuid, "seq", cursor.Seq, "cut", len(log)-read)
	return nil
}

// cut saves the block at the cursor when its face stands elsewhere, changing nothing of it but
// note_synced_seq when the cursor is at zero, so a note synced again keeps what it was until its
// log is published, and, when log, the published
// log, holds more than its first read bytes, keeps the whole of it aside and publishes those bytes
// in its place. r.mu is held.
func (r *NoteReplica) cut(log []byte, read int) error {
	svc := r.owner.containers
	if synced, _ := strconv.ParseUint(r.container.Storable().Meta()["note_synced_seq"], 10, 32); uint32(synced) != r.cursor.Seq {
		attrs := r.attrs()
		if r.cursor.Seq == 0 {
			attrs = map[string]interface{}{"note_synced_seq": 0}
		}
		r.container.Merge(attrs)
		saved, err := svc.Save(r.container)
		if err != nil {
			return err
		}
		r.container = saved
	}
	r.changed = false
	if read == len(log) {
		return nil
	}
	if _, err := svc.SaveAsset(r.container, r.asideKey(), log); err != nil {
		return err
	}
	var err error
	if read == 0 {
		err = svc.DeleteAsset(r.container, StrokesKey)
	} else {
		_, err = svc.SaveAsset(r.container, StrokesKey, log[:read])
	}
	if err != nil {
		return err
	}
	reloaded, err := svc.Load(r.container.UUID())
	if err != nil {
		return err
	}
	r.container = reloaded
	return nil
}

// asideKey is the first strokes.aside-N.jsonl, N from 1, the container does not hold. r.mu is
// held.
func (r *NoteReplica) asideKey() string {
	held := map[string]bool{}
	for _, a := range r.container.Assets() {
		held[a.Key()] = true
	}
	for n := 1; ; n++ {
		if key := fmt.Sprintf("strokes.aside-%d.jsonl", n); !held[key] {
			return key
		}
	}
}

// load opens the container uuid: its asset is replayed to the cursor, and a log that does not
// replay whole, or replays short of its face's note_synced_seq, is rewound to its last good record.
// Otherwise a staged catch-up that follows the asset is then replayed on from it, and the replica
// catches up from where it reaches; one that cannot be read is logged and left to the next Settle.
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
	r.cursor, r.length = cursor, int64(read)
	if synced, _ := strconv.ParseUint(c.Storable().Meta()["note_synced_seq"], 10, 32); read < len(log) || uint32(synced) > cursor.Seq {
		logger.Warn("ink: a note's log is damaged", "container", uuid, "seq", cursor.Seq, "synced", synced, "unread", len(log)-read)
		return r.rewind(math.MaxUint32)
	}
	staged, err := r.owner.staging.Resume(uuid, cursor)
	if err != nil {
		logger.Warn("ink: a staged catch-up could not be resumed", "container", uuid, "err", err.Error())
		return nil
	}
	if len(staged.Records) == 0 {
		return nil
	}
	r.state, r.published, r.publishedAttrs = stateCatchingUp, cursor, r.attrs()
	for _, rec := range staged.Records {
		r.fold.Apply(rec)
	}
	r.cursor, r.changed = staged.Cursor, true
	return nil
}

// isFollowing reports whether the replica follows. r.mu is not held.
func (r *NoteReplica) isFollowing() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.state == stateFollowing
}

// takePublished is the publication of the last Settle, once. r.mu is not held.
func (r *NoteReplica) takePublished() (Publication, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	p := r.publication
	r.publication = nil
	if p == nil {
		return Publication{}, false
	}
	return *p, true
}

// end writes the queue and, unless the replica catches up, saves the block. r.mu is not held.
func (r *NoteReplica) end() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.state == stateCatchingUp {
		r.stopTimer()
		return r.flush()
	}
	return r.save()
}

// stopTimer stops the queue's timer. r.mu is held.
func (r *NoteReplica) stopTimer() {
	if r.timer != nil {
		r.timer.Stop()
		r.timer = nil
	}
}

// save writes the queue and, when the replica changed since its last save, saves its block. It
// is called only while the replica follows. r.mu is held.
func (r *NoteReplica) save() error {
	r.stopTimer()
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

// log is the asset followed, while the replica follows, by the queue, read under r.mu so no
// append falls between the two. r.mu is not held.
func (r *NoteReplica) log() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []byte
	if asset, err := r.owner.containers.LoadAsset(r.container, StrokesKey); err == nil {
		out = append(out, asset.Body()...)
	}
	if r.state == stateCatchingUp {
		return out
	}
	return append(out, r.queue...)
}

// flush writes the queue: to the asset while the replica follows, to staging while it catches
// up; a failure sticks. r.mu is held.
func (r *NoteReplica) flush() error {
	if r.err != nil {
		return r.err
	}
	if len(r.queue) == 0 {
		return nil
	}
	if r.state == stateCatchingUp {
		if err := r.owner.staging.Append(r.container.UUID(), r.queue); err != nil {
			r.err = fmt.Errorf("ink: writing note %s: %w", r.note, err)
			return r.err
		}
	} else if err := r.writeLog(r.queue, false); err != nil {
		return err
	}
	r.queue = r.queue[:0]
	return nil
}

// writeLog writes data into the published log, as the whole log when replace and otherwise
// appended to it. The asset must then be the length the log was left at plus data, or data alone
// when replace; anything else is the log damaged under the replica, which is rewound to its last
// good record, and is link.ErrRewound. A failed write sticks. r.mu is held.
func (r *NoteReplica) writeLog(data []byte, replace bool) error {
	svc := r.owner.containers
	write, want := svc.AppendAsset, r.length+int64(len(data))
	if replace {
		write, want = svc.SaveAsset, int64(len(data))
	}
	asset, err := write(r.container, StrokesKey, data)
	if err != nil {
		r.err = fmt.Errorf("ink: writing note %s: %w", r.note, err)
		return r.err
	}
	if got := asset.Size(); got != want {
		logger.Warn("ink: a note's log is not the length it was left at", "note", r.note.String(), "container", r.uuid(),
			"bytes", got, "want", want)
		if err := r.rewind(math.MaxUint32); err != nil {
			return err
		}
		return link.ErrRewound
	}
	r.length = want
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
