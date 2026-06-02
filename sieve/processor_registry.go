package sieve

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"
)

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
	PasteMatch(content string) (matched bool, overrides map[string]interface{})
	BuildContext(block SieveBlock, doc ShadowDocument) string
	RunJob(ctx context.Context, block *SieveBlock, svc Services) error
}

// Services is the dependency bag passed to BlockProcessor.RunJob.
type Services struct {
	AI        *AIService
	Documents *DocumentService
	Assets    *AssetService
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
func RegisterProcessor(kind string, processor BlockProcessor) {
	registryMu.Lock()
	defer registryMu.Unlock()
	processorRegistry[kind] = processor
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
