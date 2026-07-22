package block

import (
	"time"

	"sieve/logger"
)

// This file holds ShadowDocument's snapshot + atomic-mutation methods. Together
// with shadow_document.go they make ShadowDocument the SOLE owner of its data and
// its mutex: every read or write that needs the lock is a method here, taken
// under s.mu internally. EditorService orchestrates (processor dispatch, listener
// notify, persistence) by CALLING these — it never touches s.mu or s's fields.

// SnapshotBlock returns a deep copy of the block with id (fresh Attrs map), or
// false if absent. The copy is safe to read/mutate outside the lock.
func (s *ShadowDocument) SnapshotBlock(id string) (SieveBlock, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.findBlock(id)
	if b == nil {
		return SieveBlock{}, false
	}
	return b.cloneDeep(), true
}

// SnapshotBlocks returns a DEEP copy of the live tree (each block's Attrs is a
// fresh map). The copy is therefore safe to read after the lock is released, even
// while a concurrent job mutates the live tree — callers (FrontendBlocks, status
// polls) must not race the live Attrs maps, which an aliased copy would.
func (s *ShadowDocument) SnapshotBlocks() []SieveBlock {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]SieveBlock, len(s.Blocks))
	for i := range s.Blocks {
		out[i] = s.Blocks[i].cloneDeep()
	}
	return out
}

// SnapshotForJob captures, under ONE lock, both a deep copy of the target block
// (for the processor to mutate) and an immutable DocView of the whole document
// (for the job to resolve any block by id). Returns false if the block is absent.
//
// The DocView is READ-ONLY, job-creation-time context: a background job (any async
// task, not just AI) reads it ONLY to build its prompt/context before its long
// operation, and never writes back through it — results flow as a delta merged into
// the LIVE shadow by EditorService. So a snapshot going stale during a minutes-long
// job is correct by design; only the context the job reasoned about is frozen.
//
// In markdown (breakglass) mode the live Blocks tree is frozen while the user edits
// the raw buffer, so a snapshot built from it would be incoherent — a per-block read
// would see stale content. Derive the tree from the authoritative buffer instead, so
// the snapshot is internally consistent. Save is unaffected: deriveMarkdown returns
// the buffer verbatim in markdown mode, never a re-serialization of this tree.
func (s *ShadowDocument) SnapshotForJob(blockID string) (SieveBlock, DocView, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	blocks := s.Blocks
	if s.rawAuthoritative {
		if reparsed, err := s.codec.Deserialize(s.mdModeBuffer); err == nil {
			blocks = reparsed
		} else {
			logger.Warn("editor: markdown-mode snapshot reparse failed", "uuid", s.UUID, "err", err)
		}
	}
	var target *SieveBlock
	for i := range blocks {
		if blocks[i].ID == blockID {
			target = &blocks[i]
			break
		}
	}
	if target == nil {
		return SieveBlock{}, DocView{}, false
	}
	doc := DocView{
		UUID:             s.UUID,
		rawAuthoritative: s.rawAuthoritative,
		mdModeBuffer:     s.mdModeBuffer,
		Blocks:           append([]SieveBlock(nil), blocks...),
		codec:            s.codec,
	}
	return target.cloneDeep(), doc, true
}

// TryDispatch atomically transitions the block from PENDING to DISPATCHED and
// returns a deep copy of the now-DISPATCHED block. Returns false (no change) if
// the block is absent or not PENDING — so the caller dispatches a job exactly
// once even under concurrent calls.
func (s *ShadowDocument) TryDispatch(id string) (SieveBlock, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.findBlock(id)
	if b == nil || b.Status() != BlockStatusPending {
		return SieveBlock{}, false
	}
	b.Attrs["status"] = BlockStatusDispatched
	return b.cloneDeep(), true
}

// ResetStuckDispatched flips every DISPATCHED block older than threshold (or with
// no createdAt) back to PENDING and returns their ids, so the caller can re-queue
// their jobs. Used on (re)open to recover jobs stranded by a crash/restart.
func (s *ShadowDocument) ResetStuckDispatched(threshold time.Duration) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var stuck []string
	for i := range s.Blocks {
		blk := &s.Blocks[i]
		if blk.Status() != BlockStatusDispatched {
			continue
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
	}
	return stuck
}

// EnterMarkdownMode seeds the markdown-mode raw buffer and raises the
// raw-authoritative flag (the buffer becomes the document's truth). The caller
// derives the seed (via ContentForSave) BEFORE the switch.
func (s *ShadowDocument) EnterMarkdownMode(buf string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.mdModeBuffer = buf
	s.rawAuthoritative = true
}

// EnterWysiwygMode COMMITS the markdown-mode edit: it re-parses the authoritative
// tree from the raw buffer (picking up any block YAML edited directly), then
// lowers the raw-authoritative flag AND clears the buffer. Clearing the buffer is
// load-bearing: the reparse consumed it, and leaving it set would let a stale
// buffer masquerade as authoritative on the next round-trip (the derivation is by
// flag now, but a cleared buffer keeps the two in lockstep and holds no dead text).
// Returns the resulting top-level block count.
func (s *ShadowDocument) EnterWysiwygMode() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reparseDoc(s.mdModeBuffer)
	s.rawAuthoritative = false
	s.mdModeBuffer = ""
	return len(s.Blocks)
}
