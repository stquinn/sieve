package block

import (
	"sieve/logger"
	"sieve/sieve/domain"
)

// SnapshotForJob captures, under ONE lock, both a deep copy of the target block
// — a top-level block or an element of one — (for the processor to mutate) and an immutable DocView of the whole document
// (for the job to resolve any block by id). Returns false, and a nil view, if the
// block is absent.
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
func (s *ShadowDocument) SnapshotForJob(blockID string) (domain.SieveBlock, ContainerView, bool) {
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
	target, _ := s.locate(blocks, blockID)
	if target == nil {
		return domain.SieveBlock{}, nil, false
	}
	doc := DocView{
		ContainerAddressing: ContainerAddressing{UUID: s.UUID},
		rawAuthoritative:    s.rawAuthoritative,
		mdModeBuffer:        s.mdModeBuffer,
		Blocks:              append([]domain.SieveBlock(nil), blocks...),
		codec:               s.codec,
	}
	return target.Clone(), doc, true
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
