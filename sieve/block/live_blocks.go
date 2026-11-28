package block

import (
	"fmt"
	"sync"
	"time"

	"sieve/sieve/domain"
)

// LiveBlocks is the live, ordered block list of one open container, the lock
// that guards it, and the job protocol run against it: a block's job is claimed,
// patched, written into and recovered through these methods and no others.
//
// It is the sole owner of its data and its mutex: every read or write that
// needs the lock is a method here, taken under mu internally. A container type
// that embeds it guards its own state with the same mu, so one open container
// has one lock. Nothing outside package block takes it.
type LiveBlocks struct {
	// Blocks is the authoritative ordered block list, held directly.
	Blocks []domain.SieveBlock
	mu     sync.Mutex
	// changed is the owner's hook, set at construction, called under mu after
	// PatchBlock and MergeBlock change the list and after no other method. Nil
	// is a no-op.
	changed func()
}

// notifyChanged calls the owner's hook. Caller holds l.mu.
func (l *LiveBlocks) notifyChanged() {
	if l.changed != nil {
		l.changed()
	}
}

// MergeBlock creates or patches the named block — a top-level block or an
// element of one — applying the merge semantic
// (SieveBlock.Merge: attrs additive, aliases replaced when present). For a new id
// it appends a fresh block. kind is only used when creating the entry; subsequent
// merges preserve the existing Kind.
func (l *LiveBlocks) MergeBlock(patch domain.SieveBlock) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if b := l.findBlock(patch.ID); b != nil {
		b.Merge(patch)
	} else {
		nb := domain.SieveBlock{ID: patch.ID, Kind: patch.Kind}
		nb.Merge(patch)
		l.Blocks = append(l.Blocks, nb)
	}
	l.notifyChanged()
}

// PatchBlock merges patch into the block it names — a top-level block or an
// element of one — when the list still holds it, and reports whether it did.
// Unlike MergeBlock it never creates one: a job's result for a block that has
// since gone has nowhere to land.
func (l *LiveBlocks) PatchBlock(patch domain.SieveBlock) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.findBlock(patch.ID)
	if b == nil {
		return false
	}
	b.Merge(patch)
	l.notifyChanged()
	return true
}

// IndexOfBlock returns the top-level position of id, or -1 if the list does not
// hold it. Caller must NOT hold l.mu.
func (l *LiveBlocks) IndexOfBlock(id string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	for i := range l.Blocks {
		if l.Blocks[i].ID == id {
			return i
		}
	}
	return -1
}

// DeleteBlockAttr removes a single key from an existing block's attrs.
// Used to expunge transient fields (e.g. hint) that a job has consumed.
func (l *LiveBlocks) DeleteBlockAttr(blockID, key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if b := l.findBlock(blockID); b != nil {
		delete(b.Attrs, key)
	}
}

// BlockIDs returns the top-level child ids in order — the container's order as
// a value, without the blocks hanging off it.
func (l *LiveBlocks) BlockIDs() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	ids := make([]string, len(l.Blocks))
	for i, b := range l.Blocks {
		ids[i] = b.ID
	}
	return ids
}

// findBlock returns a pointer to the block with the given ID within the live
// list — a top-level block or an element of one — or nil. ASSUMES l.mu is held
// by the caller. A top-level pointer aliases the live slice; an element's
// carries the attrs map stored in its parent's payload, so an attr written
// through it lands in what the parent persists, and nothing else of it does.
func (l *LiveBlocks) findBlock(id string) *domain.SieveBlock {
	b, _ := l.locate(l.Blocks, id)
	return b
}

// locate finds the block id among blocks — at the top level, or as an element
// of one, at any depth — and returns it with the top-level block that is it or
// holds it, or nil. Caller holds l.mu when blocks is the live list.
func (l *LiveBlocks) locate(blocks []domain.SieveBlock, id string) (found, top *domain.SieveBlock) {
	for i := range blocks {
		if blocks[i].ID == id {
			return &blocks[i], &blocks[i]
		}
	}
	for i := range blocks {
		if el := l.elementOf(&blocks[i], id); el != nil {
			return el, &blocks[i]
		}
	}
	return nil, nil
}

// elementOf finds the element id among the elements parent holds, at any
// depth, or nil.
func (l *LiveBlocks) elementOf(parent *domain.SieveBlock, id string) *domain.SieveBlock {
	holder, ok := GetProcessor(parent.Kind).(BlockParent)
	if !ok {
		return nil
	}
	for _, el := range holder.Children(parent) {
		if el.ID == id {
			return el
		}
		if deeper := l.elementOf(el, id); deeper != nil {
			return deeper
		}
	}
	return nil
}

// SnapshotHolder returns a deep copy of the top-level block that is id or holds
// it as an element, or false if the list holds neither. It is the block a
// change to an element is told to the client as.
func (l *LiveBlocks) SnapshotHolder(id string) (domain.SieveBlock, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, top := l.locate(l.Blocks, id); top != nil {
		return top.Clone(), true
	}
	return domain.SieveBlock{}, false
}

// eachBlock calls fn for every block of the live list, top-level blocks and
// their elements at any depth. Caller holds l.mu.
func (l *LiveBlocks) eachBlock(fn func(b *domain.SieveBlock)) {
	var walk func(b *domain.SieveBlock)
	walk = func(b *domain.SieveBlock) {
		fn(b)
		if holder, ok := GetProcessor(b.Kind).(BlockParent); ok {
			for _, el := range holder.Children(b) {
				walk(el)
			}
		}
	}
	for i := range l.Blocks {
		walk(&l.Blocks[i])
	}
}

// SnapshotBlock returns a deep copy of the block with id — a top-level block or
// an element of one — (fresh Attrs map), or false if absent. The copy is safe to
// read/mutate outside the lock.
func (l *LiveBlocks) SnapshotBlock(id string) (domain.SieveBlock, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.findBlock(id)
	if b == nil {
		return domain.SieveBlock{}, false
	}
	return b.Clone(), true
}

// SnapshotBlocks returns a DEEP copy of the live list (each block's Attrs is a
// fresh map). The copy is therefore safe to read after the lock is released, even
// while a concurrent job mutates the live list — callers (FrontendBlocks, status
// polls) must not race the live Attrs maps, which an aliased copy would.
func (l *LiveBlocks) SnapshotBlocks() []domain.SieveBlock {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]domain.SieveBlock, len(l.Blocks))
	for i := range l.Blocks {
		out[i] = l.Blocks[i].Clone()
	}
	return out
}

// TryDispatch atomically transitions the block from PENDING to DISPATCHED and
// returns a deep copy of the now-DISPATCHED block. Returns false (no change) if
// the block is absent or not PENDING — so the caller dispatches a job exactly
// once even under concurrent calls.
func (l *LiveBlocks) TryDispatch(id string) (domain.SieveBlock, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.findBlock(id)
	if b == nil || b.Status() != BlockStatusPending {
		return domain.SieveBlock{}, false
	}
	b.Attrs["status"] = BlockStatusDispatched
	return b.Clone(), true
}

// AppendElement adds el to the end of the element list the block with id holds
// under key, or makes it the whole list when startOver is set, and returns a deep
// copy of the block as it now stands. It refuses a block that is absent or whose
// job is not running: elements are written into a slot only while its block is
// being answered. It does not call the owner's hook; the job's end saves.
func (l *LiveBlocks) AppendElement(id, key string, el domain.SieveBlock, startOver bool) (domain.SieveBlock, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.findBlock(id)
	if b == nil {
		return domain.SieveBlock{}, fmt.Errorf("block %q is not in this document", id)
	}
	if status := b.Status(); status != BlockStatusDispatched {
		return domain.SieveBlock{}, fmt.Errorf("block %q is not being answered (status %s)", id, status)
	}
	var list domain.Elements
	if !startOver {
		list = append(list, domain.DecodeElements(b.Attrs[key])...)
	}
	b.SetElements(key, append(list, el))
	return b.Clone(), nil
}

// ResetStuckDispatched flips every DISPATCHED block — top-level or an element of
// one — older than threshold (or with no createdAt) back to PENDING and returns
// their ids, so the caller can re-queue their jobs. Used on (re)open to recover
// jobs stranded by a crash/restart.
func (l *LiveBlocks) ResetStuckDispatched(threshold time.Duration) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var stuck []string
	l.eachBlock(func(blk *domain.SieveBlock) {
		if blk.Status() != BlockStatusDispatched {
			return
		}
		createdAt := blk.StringAttr("createdAt")
		stale := createdAt == ""
		if !stale {
			if t, err := time.Parse(time.RFC3339, createdAt); err == nil && time.Since(t) > threshold {
				stale = true
			}
		}
		if stale {
			blk.Attrs["status"] = BlockStatusPending
			stuck = append(stuck, blk.ID)
		}
	})
	return stuck
}

// JobHolder is what a block's job runs against: the live blocks of one open
// container, through the job protocol, and the snapshot a job is described
// from. Every method takes the holder's lock itself; a caller holds none.
type JobHolder interface {
	TryDispatch(id string) (domain.SieveBlock, bool)
	SnapshotHolder(id string) (domain.SieveBlock, bool)
	PatchBlock(patch domain.SieveBlock) bool
	DeleteBlockAttr(blockID, key string)
	AppendElement(id, key string, el domain.SieveBlock, startOver bool) (domain.SieveBlock, error)
	ResetStuckDispatched(threshold time.Duration) []string
	// SnapshotForJob returns, under one lock, a deep copy of the block blockID —
	// a top-level block or an element of one — and an immutable view of the
	// whole container, or false if the block is absent.
	SnapshotForJob(blockID string) (domain.SieveBlock, ContainerView, bool)
}
