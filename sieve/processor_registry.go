package sieve

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"

	"sieve/sieve/fencedblock"
)

// ContentEntry is one item from the browser clipboard DataTransfer.
type ContentEntry struct {
	MIMEType string                 `json:"mimeType"`
	Content  string                 `json:"content"`
	Context  map[string]interface{} `json:"context,omitempty"`
}

// Block status constants.
const (
	BlockStatusPending    = "PENDING"
	BlockStatusDispatched = "DISPATCHED"
	BlockStatusComplete   = "COMPLETE"
	BlockStatusError      = "ERROR"
)

type BlockMode string

const (
	BlockModeBlock  BlockMode = "block"
	BlockModeInline BlockMode = "inline"
	BlockModeProse  BlockMode = "prose" // content + <!--s:ID--> markers, owned by ProseProcessor
)

// JobContext is the complete input to a processor's RunJob.
// EditorService assembles it at dispatch time — processors never reach back into services.
type JobContext struct {
	Ctx    context.Context
	UUID   string
	Doc    DocView // immutable, lock-free snapshot of the document
	Block  *SieveBlock
	Notify func(blockID string, attrs map[string]interface{})
}

// BlockLifecycleListener listens to block lifecycle events from the framework.
type BlockLifecycleListener interface {
	OnBlockCreated(uuid, kind, blockID string, attrs map[string]interface{}, serialisedForm string)
	OnBlockUpdated(uuid, blockID string, attrs map[string]interface{}, serialisedForm string)
	OnBlockPromoted(uuid, blockID string, replacement string)
}

// BlockProcessor is implemented by every SieveBlock Kind.
//
// Services are injected at construction via NewXxxProcessor(svc BlockServices)
// and available on every method as p.svc — no need to pass them call by call.
//
// PasteMatch receives uuid and blockID so processors that need to persist
// assets synchronously during paste (e.g. smart-image) can do so with the
// correct ID before CreateBlock is called.
//
// RunJob receives a notify func so processors can push intermediate attr
// updates to the client mid-job (e.g. push src immediately after save,
// before the slower AI describe completes).
type BlockProcessor interface {
	InitAttrs(id string, overrides map[string]interface{}) map[string]interface{}
	IsBlock(entries []ContentEntry) bool
	Transform(entries []ContentEntry, uuid string, blockID string) map[string]interface{}
	RunJob(jctx JobContext) error
	JobLabel(block *SieveBlock) string
	OnChange(block *SieveBlock)
	Mode() BlockMode
	BuildContext(block SieveBlock, doc DocView, seen map[string]bool) string
	MarkdownRepresentation(block SieveBlock) string
	// Serialize renders the block to its on-disk form. THIS is the whole point of
	// the block-document model: each flavour owns how its kind persists, and the
	// save spine just walks blocks and asks each one. Structured (YAML) kinds share
	// one implementation (FencedSerializer, embedded — free); prose owns the custom
	// content + <!--s:ID--> marker form (ProseProcessor). No kind-switch in the spine.
	Serialize(block SieveBlock) (string, error)
	// Accepts reports whether this flavour claims a parsed region (the recognition
	// half of deserialization). Deserialize then builds the block(s) — the inverse
	// of Serialize. Structured kinds share one impl (FencedDeserializer, embedded);
	// inline flavours never claim a document region (InlineDeserializer); prose is
	// the terminal mop-up (ProseProcessor). No kind-switch in the codec.
	Accepts(region Region) bool
	Deserialize(region Region) ([]SieveBlock, error)
}

// FencedSerializer is the ONE shared serialization for YAML/fenced block flavours.
// Every structured processor embeds it, so code/diagram/ai/log/web-clip/card/image/
// link all persist as ```kind\n<yaml>\n``` for free — "one implementation."
type FencedSerializer struct{}

// Serialize renders a structured block as its canonical fenced YAML form.
func (FencedSerializer) Serialize(block SieveBlock) (string, error) {
	return serializeFencedBlock(block)
}

// InlineSerializer is the shared serialization for INLINE flavours — `[!kind]
// {json} [!kind-end]`, the form the inline parser reads back. Inline-mode
// processors embed it instead of FencedSerializer.
type InlineSerializer struct{}

// Serialize renders an inline block as its bracketed JSON form.
func (InlineSerializer) Serialize(block SieveBlock) (string, error) {
	return serializeInlineBlock(block)
}

// FencedDeserializer is the ONE shared deserialization for YAML/fenced flavours —
// the mirror of FencedSerializer. Kind is the fence tag this flavour answers to
// (set at construction, alongside the FencedSerializer embed). Accepts claims a
// fenced region whose tag matches; Deserialize parses the YAML body into one
// block. An id-less body is hydrated by newSieveBlock (mint-on-parse, exactly as
// prose mints) — serialized docs always carry an id, so round-trips are stable.
type FencedDeserializer struct{ Kind string }

func (d FencedDeserializer) Accepts(region Region) bool {
	return region.Kind != "" && region.Kind == d.Kind
}

func (d FencedDeserializer) Deserialize(region Region) ([]SieveBlock, error) {
	attrs, err := fencedblock.DeserializeYaml(region.Body)
	if err != nil {
		return nil, err
	}
	id, _ := attrs["id"].(string)
	return []SieveBlock{newSieveBlock(d.Kind, id, "", attrs)}, nil
}

// InlineDeserializer is embedded by inline flavours. Inline things are NOT Sieve
// blocks (project_inline_not_a_block): they are never recognised from disk during
// document parse, so Accepts is always false and Deserialize is a no-op. The pair
// exists only to satisfy the BlockProcessor interface uniformly.
type InlineDeserializer struct{}

func (InlineDeserializer) Accepts(Region) bool                      { return false }
func (InlineDeserializer) Deserialize(Region) ([]SieveBlock, error) { return nil, nil }

type BlockServices struct {
	AI          AIPort
	Documents   DocumentsPort
	Assets      AssetsPort
	Jobs        *JobTracker // not a port: no processor calls it; used by EditorService
	LinkPreview LinkPreviewPort
	State       StatePort
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

// UnregisterProcessor removes kind from the registry and paste-matcher list.
// Intended for test teardown only.
func UnregisterProcessor(kind string) {
	registryMu.Lock()
	defer registryMu.Unlock()
	delete(processorRegistry, kind)
	for i, pm := range pasteMatchers {
		if pm.Kind == kind {
			pasteMatchers = append(pasteMatchers[:i], pasteMatchers[i+1:]...)
			break
		}
	}
}

// GetProcessor returns the registered processor for kind, or nil.
func GetProcessor(kind string) BlockProcessor {
	registryMu.RLock()
	defer registryMu.RUnlock()
	return processorRegistry[kind]
}

// GenerateBlockID returns "XX-YYYY" where XX = first two chars of kind.
func GenerateBlockID(kind string) string {
	b := make([]byte, 2)
	_, _ = rand.Read(b)
	prefix := kind
	if len(prefix) > 2 {
		prefix = prefix[:2]
	}
	return prefix + "-" + hex.EncodeToString(b)
}

// GenerateBlockIDFor generates an ID for kind, using the processor's IDPrefix()
// method if available (e.g. SmartImageProcessor returns "img").
func GenerateBlockIDFor(kind string) string {
	registryMu.RLock()
	p := processorRegistry[kind]
	registryMu.RUnlock()
	type hasPrefix interface{ IDPrefix() string }
	if hp, ok := p.(hasPrefix); ok {
		return GenerateBlockID(hp.IDPrefix())
	}
	return GenerateBlockID(kind)
}

type ExtractionCandidate struct {
	Kind string `json:"kind"`
}

type SelfExtractable interface {
	AllowSelfExtraction() bool
}

// DetectExtractions finds which registered blocks can handle the given entries.
// Used by the frontend context menu to offer "Extract as Diagram", etc.
func DetectExtractions(sourceKind string, entries []ContentEntry) []ExtractionCandidate {
	registryMu.RLock()
	defer registryMu.RUnlock()

	var candidates []ExtractionCandidate
	for _, pm := range pasteMatchers {
		if pm.Kind == sourceKind {
			allowSelf := false
			if se, ok := pm.Processor.(SelfExtractable); ok {
				allowSelf = se.AllowSelfExtraction()
			}
			if !allowSelf {
				continue
			}
		}

		if pm.Processor.IsBlock(entries) {
			candidates = append(candidates, ExtractionCandidate{Kind: pm.Kind})
		}
	}
	return candidates
}
