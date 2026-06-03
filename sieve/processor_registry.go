package sieve

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"
)

// PasteEntry is one item from the browser clipboard DataTransfer.
// MIMEType is the raw MIME type string (e.g. "text/plain", "text/html").
// Content is the UTF-8 string value returned by clipboardData.getData(mimeType).
type PasteEntry struct {
	MIMEType string `json:"mimeType"`
	Content  string `json:"content"`
}

// Block status constants.
const (
	BlockStatusPending    = "PENDING"
	BlockStatusDispatched = "DISPATCHED"
	BlockStatusComplete   = "COMPLETE"
	BlockStatusError      = "ERROR"
)

// BlockLifecycleListener listens to block lifecycle events from the framework.
type BlockLifecycleListener interface {
	OnBlockCreated(uuid, kind, blockID, rawYaml string)
	OnBlockUpdated(uuid, blockID, rawYaml string)
}

// BlockProcessor is implemented by every SieveBlock Kind.
//
// InitAttrs is the schema declaration. It returns the complete, valid initial
// YAML map for a new block — every field at its zero value, overridden by
// whatever the creation trigger supplied. Called by CreateBlock regardless of
// how the block was created (UI command, paste, API).
//
// PasteMatch is secondary: it detects whether pasted content should become
// this Kind and extracts override values to pass into InitAttrs. Processors
// that have no paste trigger return false, nil from PasteMatch.
type BlockProcessor interface {
	InitAttrs(id string, overrides map[string]interface{}) map[string]interface{}
	PasteMatch(entries []PasteEntry) (matched bool, overrides map[string]interface{})
	BuildContext(block SieveBlock, doc ShadowDocument) string
	RunJob(ctx context.Context, uuid string, block *SieveBlock, svc Services) error
	JobLabel(block *SieveBlock) string

	// OnChange is called synchronously after any block mutation (creation or
	// update). block is a mutable copy of the shadow block state. Implementations
	// may update block.Attrs in-place. To request a background async job, set
	// block.Attrs["status"] = BlockStatusPending.
	OnChange(block *SieveBlock, svc Services)
}

// Services is the dependency bag passed to BlockProcessor.RunJob.
type Services struct {
	AI        *AIService
	Documents *DocumentService
	Assets    *AssetService
	Jobs      *JobTracker
}

var (
	registryMu        sync.RWMutex
	processorRegistry = map[string]BlockProcessor{}
	pasteMatchers     []struct {
		Kind      string
		Processor BlockProcessor
	}
)

// RegisterProcessor registers kind → processor. Registration order sets
// paste-match priority — more-specific kinds must be registered first.
// Re-registering the same kind updates the processor in-place rather than
// appending a duplicate entry to pasteMatchers.
func RegisterProcessor(kind string, processor BlockProcessor) {
	registryMu.Lock()
	defer registryMu.Unlock()
	processorRegistry[kind] = processor
	for i, pm := range pasteMatchers {
		if pm.Kind == kind {
			pasteMatchers[i].Processor = processor
			return
		}
	}
	pasteMatchers = append(pasteMatchers, struct {
		Kind      string
		Processor BlockProcessor
	}{Kind: kind, Processor: processor})
}

// GetProcessor returns the registered processor for kind, or nil.
func GetProcessor(kind string) BlockProcessor {
	registryMu.RLock()
	defer registryMu.RUnlock()
	return processorRegistry[kind]
}

// GenerateBlockID returns "XX-YYYY" where XX = first two chars of kind
// and YYYY = 4 random hex chars. Example: "co-a3f9" for kind "code".
func GenerateBlockID(kind string) string {
	b := make([]byte, 2)
	_, _ = rand.Read(b)
	prefix := kind
	if len(prefix) > 2 {
		prefix = prefix[:2]
	}
	return prefix + "-" + hex.EncodeToString(b)
}
