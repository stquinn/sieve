package link

import "sync"

// Replica is this Sieve's copy of one note's log, however it is stored.
type Replica interface {
	// Cursor is how far the replica holds the log.
	Cursor() Cursor
	// Append stores one record, whose canonical body is body, if and only if Cursor.Accept takes
	// it; on any error neither the stored log nor the cursor changes.
	Append(r Record, body []byte) error
	// SetAside moves what the replica holds out of the way, keeping it, and starts the replica
	// again from the zero Cursor.
	SetAside() error
}

// Replicas opens the replica of a note by the companion's note id, creating an empty one if
// none is held.
type Replicas interface {
	Open(note ID) (Replica, error)
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
	aside   [][]Record
}

func (r *MemoryReplica) Cursor() Cursor {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.cursor
}

func (r *MemoryReplica) Append(rec Record, body []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	next := r.cursor
	if err := next.Accept(rec, body); err != nil {
		return err
	}
	r.cursor = next
	r.records = append(r.records, rec)
	return nil
}

func (r *MemoryReplica) SetAside() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.aside = append(r.aside, r.records)
	r.records, r.cursor = nil, Cursor{}
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
