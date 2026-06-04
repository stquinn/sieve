package sieve

import (
	"sieve/logger"
	"sync"
)

// ContextProvider extracts plain-text AI context from a block.
// BlockProcessor already satisfies this interface.
// seen is threaded through recursion to prevent cycles — pass it on
// whenever calling BuildContextForID from within BuildContext.
type ContextProvider interface {
	BuildContext(block SieveBlock, doc ShadowDocument, seen map[string]bool) string
}

var (
	contextProviderMu       sync.RWMutex
	contextProviderRegistry = map[string]ContextProvider{}
)

// RegisterContextProvider registers a ContextProvider override for kind.
// Use this for non-processor implementors (e.g. BlockAnchorProvider).
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
// SmartImageProcessor, "blk-1234" routes to BlockAnchorProvider, etc.
// seen prevents cycles; always pass the same map through a recursion chain.
// Returns "" if id is already seen, block not found, or no provider registered.
//
//	func BuildContextForID(id string, doc ShadowDocument, seen map[string]bool) string {
//		if id == "" || id == "doc" || seen[id] {
//			return ""
//		}
//		seen[id] = true
//		block, found := FindBlockByID(doc.Markdown, id)
//		if !found {
//			return ""
//		}
//		cp := GetContextProvider(block.Kind)
//		if cp == nil {
//			return ""
//		}
//		return cp.BuildContext(block, doc, seen)
//	}
func BuildContextForID(id string, doc ShadowDocument, seen map[string]bool) string {
	if id == "" || seen[id] {
		return ""
	}
	seen[id] = true
	if id == "doc" {
		return doc.Markdown
	}
	var block SieveBlock
	logger.Debug("ContextProvider: looking up context for block ID %q", id)
	for _, blk := range doc.Blocks {
		logger.Debug("ContextProvider: checking block ID %q (kind %q)", blk.ID, blk.Kind)
	}
	if blk, ok := doc.Blocks[id]; ok {
		block = *blk
	} else {
		found, ok := FindBlockByID(doc.Markdown, id)
		if !ok {
			logger.Warn("ContextProvider: block ID %q not found in doc or blocks map", id)
			return ""
		}
		block = found
	}
	cp := GetContextProvider(block.Kind)
	if cp == nil {
		logger.Warn("ContextProvider: no provider registered for block kind %q", block.Kind)
		return ""
	}
	return cp.BuildContext(block, doc, seen)
}
