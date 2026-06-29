package block

import (
	"sieve/logger"
	"sync"
)

// ContextProvider extracts plain-text AI context from a block.
// BlockProcessor already satisfies this interface.
// seen is threaded through recursion to prevent cycles — pass it on
// whenever calling BuildContextForID from within BuildContext.
type ContextProvider interface {
	BuildContext(block SieveBlock, doc DocView, seen map[string]bool) AIContext
}

var (
	contextProviderMu       sync.RWMutex
	contextProviderRegistry = map[string]ContextProvider{}
)

// RegisterContextProvider registers a ContextProvider override for kind.
// Use this for non-processor implementors of context assembly.
func RegisterContextProvider(kind string, provider ContextProvider) {
	contextProviderMu.Lock()
	defer contextProviderMu.Unlock()
	contextProviderRegistry[kind] = provider
}

// GetContextProvider returns the ContextProvider for kind.
// Checks the override registry first; falls back to GetProcessor.
// Returns nil if neither registry has an entry for kind.
func GetContextProvider(kind string) ContextProvider {
	contextProviderMu.RLock()
	if cp, ok := contextProviderRegistry[kind]; ok {
		contextProviderMu.RUnlock()
		return cp
	}
	contextProviderMu.RUnlock()
	return GetProcessor(kind)
}

// BuildContextForID is the single recursive primitive for context assembly.
// It finds the block with id, looks up its provider by kind, and calls BuildContext.
// The dispatch is entirely by block kind — a ref to "img-1234" routes to
// SmartImageProcessor, a prose ref routes to ProseProcessor, etc.
// seen prevents cycles; always pass the same map through a recursion chain.
// Returns "" if id is already seen, block not found, or no provider registered.
//
//	func BuildContextForID(id string, doc DocView, seen map[string]bool) string {
//		if id == "" || id == "doc" || seen[id] {
//			return ""
//		}
//		seen[id] = true
//		block, found := NewDocumentCodec(GlobalRegistry()).findBlockByID(doc.Markdown, id)
//		if !found {
//			return ""
//		}
//		cp := GetContextProvider(block.Kind)
//		if cp == nil {
//			return ""
//		}
//		return cp.BuildContext(block, doc, seen)
//	}
func BuildContextForID(id string, doc DocView, seen map[string]bool) AIContext {
	if id == "" || seen[id] {
		return AIContext{}
	}
	seen[id] = true
	if id == "doc" {
		return AIContext{Content: doc.deriveMarkdown()}
	}
	// Uniform dispatch: every block — prose included — resolves by id (GetBlock) and
	// routes to its kind's registered ContextProvider. Prose is NOT special-cased
	// here; ProseProcessor.BuildContext returns its content, exactly as the code
	// provider returns its source. Kind matters only inside the provider.
	if b, ok := doc.GetBlock(id); ok {
		cp := GetContextProvider(b.Kind)
		if cp == nil {
			logger.Warn("ContextProvider: no provider registered for block kind %q", b.Kind)
			return AIContext{}
		}
		return cp.BuildContext(SieveBlock{ID: b.ID, Kind: b.Kind, Attrs: b.Attrs}, doc, seen)
	}
	// Fallback: structured blocks parseable straight from markdown (markdown mode).
	found, ok := NewDocumentCodec(GlobalRegistry()).findBlockByID(doc.deriveMarkdown(), id)
	if !ok {
		logger.Warn("ContextProvider: block ID %q not found in doc or blocks map", id)
		return AIContext{}
	}
	cp := GetContextProvider(found.Kind)
	if cp == nil {
		logger.Warn("ContextProvider: no provider registered for block kind %q", found.Kind)
		return AIContext{}
	}
	return cp.BuildContext(found, doc, seen)
}
