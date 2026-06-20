package block

import "time"

// This file holds ShadowDocument's snapshot + atomic-mutation methods. Together
// with shadow_document.go they make ShadowDocument the SOLE owner of its data and
// its mutex: every read or write that needs the lock is a method here, taken
// under s.mu internally. EditorService orchestrates (processor dispatch, listener
// notify, persistence) by CALLING these — it never touches s.mu or s's fields.

// cloneBlockDeep returns a value copy of b with a freshly-allocated Attrs map (and
// Aliases slice), so a caller can hand it to a processor / background job that
// mutates Attrs without racing the live tree. Content lives in Attrs, so the map
// copy carries it.
func cloneBlockDeep(b SieveBlock) SieveBlock {
	cp := SieveBlock{ID: b.ID, Kind: b.Kind, Attrs: make(map[string]interface{}, len(b.Attrs))}
	for k, v := range b.Attrs {
		cp.Attrs[k] = v
	}
	if len(b.Aliases) > 0 {
		cp.Aliases = append([]string(nil), b.Aliases...)
	}
	return cp
}

// SnapshotBlock returns a deep copy of the block with id (fresh Attrs map), or
// false if absent. The copy is safe to read/mutate outside the lock.
func (s *ShadowDocument) SnapshotBlock(id string) (SieveBlock, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.findBlock(id)
	if b == nil {
		return SieveBlock{}, false
	}
	return cloneBlockDeep(*b), true
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
		out[i] = cloneBlockDeep(s.Blocks[i])
	}
	return out
}

// SnapshotForJob captures, under ONE lock, both a deep copy of the target block
// (for the processor to mutate) and an immutable DocView of the whole document
// (for the job to resolve any block by id). Returns false if the block is absent.
func (s *ShadowDocument) SnapshotForJob(blockID string) (SieveBlock, DocView, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.findBlock(blockID)
	if b == nil {
		return SieveBlock{}, DocView{}, false
	}
	doc := DocView{
		UUID:         s.UUID,
		Mode:         s.Mode,
		mdModeBuffer: s.mdModeBuffer,
		Blocks:       append([]SieveBlock(nil), s.Blocks...),
		codec:        s.codec,
	}
	return cloneBlockDeep(*b), doc, true
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
	return cloneBlockDeep(*b), true
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

// EnterMarkdownMode seeds the markdown-mode raw buffer and flips to markdown mode.
// The caller derives the seed (via ContentForSave) BEFORE the switch.
func (s *ShadowDocument) EnterMarkdownMode(buf string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.mdModeBuffer = buf
	s.Mode = "markdown"
}

// EnterWysiwygMode re-parses the authoritative tree from the markdown-mode buffer
// (picking up any block YAML edited directly) and flips to WYSIWYG. Returns the
// resulting top-level block count.
func (s *ShadowDocument) EnterWysiwygMode() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reparseDoc(s.mdModeBuffer)
	s.Mode = "wysiwyg"
	return len(s.Blocks)
}
