package link

import (
	"errors"
	"sync"
)

// ErrRewound is a replica that stands at an earlier cursor than its caller last saw: it found what
// it holds damaged and rewound itself, or it was rewound and no HEAD has begun it since. The note
// must be opened again from the replica's cursor.
var ErrRewound = errors.New("the replica was rewound")

// Replica is this Sieve's copy of one note's log, however it is stored.
type Replica interface {
	// Cursor is how far the replica holds the log.
	Cursor() Cursor
	// Append stores one record, whose canonical body is body, if and only if Cursor.Accept takes
	// it; on any other error neither the stored log nor the cursor changes. It is ErrRewound when
	// the replica found what it holds damaged and rewound itself, and while it is rewound and has
	// not been begun again.
	Append(r Record, body []byte) error
	// Rewind keeps what the replica holds aside and starts it again from the cursor at seq, or the
	// nearest one below it that what it holds still reaches. Every Append is ErrRewound until the
	// next Begin.
	Rewind(seq uint32) error
	// Begin is a HEAD answering an OPEN of the note, which the companion holds to head: the
	// records appended from now until Settle are a catch-up.
	Begin(head uint32) error
	// Settle is the note's DONE: what was appended since Begin is made durable, whole or not at
	// all. It is ErrRewound when the replica found what it holds damaged and rewound itself, and
	// while it is rewound.
	Settle() error
}

// Replicas holds this Sieve's replicas of a companion's notes, by the companion's note id.
type Replicas interface {
	// Open returns the note's replica, an empty one if none is held.
	Open(note ID) (Replica, error)
	// Have is a seq the note's replica is known to hold at least, 0 when none is held, found
	// without opening the replica.
	Have(note ID) (uint32, error)
}

// MemoryReplicas holds replicas in memory. It is safe for concurrent use.
type MemoryReplicas struct {
	mu    sync.Mutex
	notes map[ID]*MemoryReplica
}

// NewMemoryReplicas holds no notes.
func NewMemoryReplicas() *MemoryReplicas { return &MemoryReplicas{notes: map[ID]*MemoryReplica{}} }

// Open returns Replica(note).
func (m *MemoryReplicas) Open(note ID) (Replica, error) { return m.Replica(note), nil }

// Have is the held replica's cursor seq, 0 for a note not held; it creates no replica.
func (m *MemoryReplicas) Have(note ID) (uint32, error) {
	m.mu.Lock()
	r, ok := m.notes[note]
	m.mu.Unlock()
	if !ok {
		return 0, nil
	}
	return r.Cursor().Seq, nil
}

// Replica returns the note's replica, creating an empty one if none is held.
func (m *MemoryReplicas) Replica(note ID) *MemoryReplica {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.notes[note]
	if !ok {
		r = &MemoryReplica{}
		m.notes[note] = r
	}
	return r
}

// MemoryReplica is one note's log held in memory. It is safe for concurrent use.
type MemoryReplica struct {
	mu      sync.Mutex
	cursor  Cursor
	records []Record
	bodies  [][]byte
	aside   [][]Record
	rewound bool
}

func (r *MemoryReplica) Cursor() Cursor {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.cursor
}

func (r *MemoryReplica) Append(rec Record, body []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.rewound {
		return ErrRewound
	}
	next := r.cursor
	if err := next.Accept(rec, body); err != nil {
		return err
	}
	r.cursor = next
	r.records = append(r.records, rec)
	r.bodies = append(r.bodies, append([]byte(nil), body...))
	return nil
}

// Rewind keeps the whole log aside and holds its records up to seq.
func (r *MemoryReplica) Rewind(seq uint32) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.aside = append(r.aside, r.records)
	kept := 0
	for kept < len(r.records) && r.records[kept].Seq <= seq {
		kept++
	}
	r.records, r.bodies = append([]Record(nil), r.records[:kept]...), append([][]byte(nil), r.bodies[:kept]...)
	r.cursor = Cursor{}
	for i, rec := range r.records {
		if err := r.cursor.Accept(rec, r.bodies[i]); err != nil {
			return err
		}
	}
	r.rewound = true
	return nil
}

// Begin ends a rewind; otherwise it does nothing, since a MemoryReplica holds every record as it
// is appended.
func (r *MemoryReplica) Begin(uint32) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.rewound = false
	return nil
}

// Settle is ErrRewound while the replica is rewound; otherwise it does nothing, since a
// MemoryReplica holds every record as it is appended.
func (r *MemoryReplica) Settle() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.rewound {
		return ErrRewound
	}
	return nil
}

// Records is a copy of the log the replica holds, in seq order.
func (r *MemoryReplica) Records() []Record {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Record(nil), r.records...)
}

// Aside is each log set aside, oldest first.
func (r *MemoryReplica) Aside() [][]Record {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([][]Record(nil), r.aside...)
}
