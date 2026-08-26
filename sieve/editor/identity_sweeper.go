package editor

import (
	"fmt"

	"sieve/logger"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/services"
)

// IdentitySweeper runs the load-time migration pipeline (block.DocumentMigrator)
// over every document in the attached library.
//
// Migration is otherwise LAZY — a document is upgraded when it is opened — which
// leaves documents nobody has opened carrying legacy short handles, unaddressable
// from outside their own document. This is what /migrate-ids exists to close.
type IdentitySweeper struct {
	docs  *services.DocumentService
	codec *block.DocumentCodec
}

func NewIdentitySweeper(docs *services.DocumentService, codec *block.DocumentCodec) *IdentitySweeper {
	return &IdentitySweeper{docs: docs, codec: codec}
}

// SweepLibrary migrates every document, rewriting only those that changed. A
// document that fails to parse or save is counted in Failures and skipped — one
// bad document must not abort the sweep over a whole library.
func (s *IdentitySweeper) SweepLibrary() domain.IdentitySweepResult {
	var out domain.IdentitySweepResult
	if s == nil || s.docs == nil || s.codec == nil {
		out.Failures = append(out.Failures, "no library attached")
		return out
	}

	// AllUUIDs, not List: List covers only filed Library notes, and most documents
	// at any moment are unfiled buffers.
	uuids, err := s.docs.AllUUIDs()
	if err != nil {
		out.Failures = append(out.Failures, fmt.Sprintf("list documents: %v", err))
		return out
	}

	for _, uuid := range uuids {
		out.Scanned++
		migrated, count, err := s.sweepOne(uuid)
		switch {
		case err != nil:
			out.Failures = append(out.Failures, fmt.Sprintf("%s: %v", uuid, err))
		case migrated:
			out.Migrated++
			out.BlocksReidentified += count
		}
	}
	logger.Info("migrate: library sweep complete",
		"scanned", out.Scanned, "migrated", out.Migrated,
		"blocks", out.BlocksReidentified, "failures", len(out.Failures))
	return out
}

// sweepOne migrates a single document, reporting whether it changed and how many
// blocks were re-identified. A document with nothing to upgrade is NOT rewritten,
// so a clean library produces no version churn.
func (s *IdentitySweeper) sweepOne(uuid string) (bool, int, error) {
	doc, err := s.docs.LoadByUUID(uuid)
	if err != nil {
		return false, 0, fmt.Errorf("load: %w", err)
	}
	before, err := s.codec.Deserialize(string(doc.Body()))
	if err != nil {
		return false, 0, fmt.Errorf("parse: %w", err)
	}
	after, changed := block.DocumentMigrator{}.Migrate(before, uuid)
	if !changed {
		return false, 0, nil
	}
	body, err := s.codec.Serialize(after)
	if err != nil {
		return false, 0, fmt.Errorf("serialize: %w", err)
	}
	doc.SetBody([]byte(body))
	if _, err := s.docs.Save(doc); err != nil {
		return false, 0, fmt.Errorf("save: %w", err)
	}
	return true, s.countReidentified(before, after), nil
}

// countReidentified counts positions whose id moved. The migrator preserves
// order, so a positional comparison is exact.
func (s *IdentitySweeper) countReidentified(before, after []block.SieveBlock) int {
	n := 0
	for i := range after {
		if i < len(before) && before[i].ID != after[i].ID {
			n++
		}
	}
	return n
}
