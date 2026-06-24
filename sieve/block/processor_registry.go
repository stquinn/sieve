package block

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"strings"
	"sync"

	"sieve/sieve/fencedblock"
)

// RegionShape is the kind-qualified delimiter pair a processor relies on — the
// "angle brackets" that bound its on-disk regions. It rides with the SerDes
// (the code that writes <!--s:…--> is the code that finds it), so it is supplied
// for free by the embedded FencedDeserializer / ProseProcessor. A zero value
// (empty Head) means "I have no document region" — inline flavours.
type RegionShape struct {
	Kind string // the kind a matched region is tagged with (e.g. "diagram", "prose")
	Head string // opening token, kind-qualified (e.g. "```diagram", "<!--s:")
	Tail string // closing token (e.g. "```", "<!--/s:")
}

// IsZero reports that the processor declares no document region (inline flavours).
func (s RegionShape) IsZero() bool { return s.Head == "" }

// ContentEntry is one item from the browser clipboard DataTransfer.
type ContentEntry struct {
	MIMEType string                 `json:"mimeType"`
	Content  string                 `json:"content"`
	Context  map[string]interface{} `json:"context,omitempty"`
}

// SieveAttrs deserializes a framework "sieve/<kind>" view. Alongside a renderer's
// own custom views, the frontend emits one such entry for every sieve block —
// mimeType "sieve/<kind>", content = JSON.stringify(attrs) — so a matcher can key
// off the kind and read the block's attrs directly (rebuild a block from them, or
// just read fields). kind is the mime suffix; ok is false when the entry is not a
// sieve view or its body is not a JSON object (e.g. the "sieve/slice" array).
func (e ContentEntry) SieveAttrs() (kind string, attrs map[string]interface{}, ok bool) {
	if !strings.HasPrefix(e.MIMEType, "sieve/") {
		return "", nil, false
	}
	kind = strings.TrimPrefix(e.MIMEType, "sieve/")
	if strings.TrimSpace(e.Content) == "" {
		return kind, nil, false
	}
	if err := json.Unmarshal([]byte(e.Content), &attrs); err != nil {
		return kind, nil, false
	}
	return kind, attrs, true
}

func (e ContentEntry) IsSieveType(p BlockProcessor) bool {
	kind, _, ok := e.SieveAttrs()
	return ok && kind == p.Kind()
}

func (e ContentEntry) AsAttrsForNewBlock(p BlockProcessor) map[string]interface{} {
	if !e.IsSieveType(p) {
		return nil
	}
	_, attrs, ok := e.SieveAttrs()
	if !ok {
		return nil
	}
	dst := make(map[string]interface{}, len(attrs))
	for k, v := range attrs {
		if k != "id" {
			dst[k] = v
		}
	}
	return dst
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

// Action is an operation a processor can perform on a set of ContentEntry views.
// Recognition (IsSupportedContent) enumerates the actions an entry set supports,
// context-blind; each endpoint filters for the action it cares about (smart-paste →
// ActionPaste; extract menu → ActionExtract/ActionTransform).
type Action string

const (
	ActionPaste     Action = "paste"     // clipboard/source content -> new block
	ActionExtract   Action = "extract"   // additive: new block alongside (source survives)
	ActionTransform Action = "transform" // replace the source block in place
)

// SupportedActions is one processor's offer for a set of entries: its Kind plus the
// operations it supports. Empty Actions == "this kind cannot be built from these
// entries" (the old IsBlock==false). The registry composes a []SupportedActions.
type SupportedActions struct {
	Kind    string   `json:"kind"`
	Actions []Action `json:"actions"`
}

// Has reports whether this offer includes action a.
func (s SupportedActions) Has(a Action) bool {
	for _, x := range s.Actions {
		if x == a {
			return true
		}
	}
	return false
}

// KindProse is the prose kind name. It lives with the registry/kind constants, NOT
// in the kind-agnostic data model. Parsing never branches on it (that is
// ProseProcessor.Accepts + orderedProseLast); it remains only because prose names
// its own identity and EditorService.PromoteBlock still hand-builds a prose block.
// TRANSITIONAL: the affordances redesign (recognition returns offers; promote
// becomes prose's TRANSFORM) dissolves the PromoteBlock dependency and retires this.
const KindProse = "prose"

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
// The WYSIWYG client renders structured blocks from attrs alone — no markdown is
// used for rendering. markdown carries the block's backend-serialized fence, used
// ONLY by the breakglass markdown-mode editor (a verbatim buffer that must hold a
// parseable, id-preserving fence for a block inserted while in that mode).
type BlockLifecycleListener interface {
	OnBlockCreated(uuid, kind, blockID string, attrs map[string]interface{}, markdown string, index int)
	OnBlockUpdated(uuid, blockID string, attrs map[string]interface{})
	OnBlockPromoted(uuid, blockID string, replacement string)
}

// BlockProcessor is the contract every SieveBlock Kind implements — the central
// extension point of the block-document model. One processor owns everything about
// its kind: how it is recognised from pasted/extracted content, how a new block is
// seeded, what async work it runs, how it reacts to edits, how it feeds AI, and how
// it persists to and parses back from disk. The framework never switches on kind;
// it walks blocks and asks each processor.
//
// Construction & services: a processor is built once via NewXxxProcessor(svc
// BlockServices); the injected services are held as p.svc and available on every
// method, so service handles are never threaded through call signatures.
//
// The methods fall into lifecycle phases:
//
//   - Recognition & creation (paste + extract): IsSupportedContent, Transform, InitAttrs
//   - Async work after creation:                RunJob, JobLabel
//   - Reaction to user edits:                   OnChange
//   - Identity:                                 Mode
//   - AI context:                               BuildContext, MarkdownRepresentation
//   - Persistence — serialize:                  Serialize
//   - Persistence — deserialize:                Accepts, Deserialize, Shape
//
// Recognition & creation in detail. A "source" (clipboard paste or an explicit
// Extract action) arrives as an ordered []ContentEntry — multiple *views* of the
// same thing: a renderer's custom views (e.g. a diagram's raw source as text/plain)
// plus the framework's universal "sieve/<kind>" view carrying the source block's
// attrs as a JSON map (decode with ContentEntry.SieveAttrs). The flow is:
//
//  1. IsSupportedContent(entries) — enumerates the operations a block of MY kind
//     supports for these views. Empty Actions == no match. Used by FirstPasteMatch
//     (paste) and DetectExtractions (the Extract menu). It must be side-effect free
//     and order-independent (any matching entry wins). Typed "sieve/<kind>" views
//     should be preferred over loose text so a diagram is not mistaken for plain code.
//  2. Transform(entries, uuid, blockID, action) — runs ONLY on the chosen processor,
//     on both the paste and extract paths. It distils the entries into the attr
//     *overrides* that seed the new block, and performs any synchronous, id-keyed
//     side effects. When a view spans more than one entry, prefer the typed
//     "sieve/<kind>" view (it wins over generic text heuristics). Parameters:
//     • entries — the same views handed to IsSupportedContent.
//     • uuid    — the document/tab this block is being created in (asset scope).
//     • blockID — the *pre-allocated id of the new block*. It is minted by
//     GenerateBlockIDFor(kind) BEFORE Transform precisely so Transform can key
//     side effects to it — e.g. smart-image writes the SVG/asset file under this
//     id, so the asset filename and the block share identity. The framework then
//     creates the block with this exact id and these overrides.
//     • action  — the operation chosen by the caller (ActionPaste/Extract/Transform);
//     a processor reads it only if its overrides differ by operation.
//     Return nil to decline (extract reports an error; paste falls through).
//  3. InitAttrs(id, overrides) — builds the canonical attr map for a fresh block of
//     this kind: sets defaults (status, createdAt, kind-specific fields), then layers
//     the Transform overrides on top. id is never overridable via overrides.
//
// RunJob receives a notify func (on JobContext) so a processor can push intermediate
// attr updates to the client mid-job — e.g. push src immediately after saving an
// asset, before the slower AI describe completes. OnChange is the synchronous hook
// after a user edit; setting status to PENDING schedules a follow-up RunJob.
type BlockProcessor interface {
	//return the KIND of Block this processor supports
	Kind() string
	// InitAttrs returns the full attr map for a new block of this kind: kind
	// defaults plus the Transform overrides, with id pinned (not overridable).
	InitAttrs(id string, overrides map[string]interface{}) map[string]interface{}
	// IsSupportedContent enumerates the operations a block of this kind supports for
	// these content views, context-blind. Empty Actions == no match. Side-effect free,
	// order-independent. Drives paste-match and the extract menu. See the interface doc.
	IsSupportedContent(entries []ContentEntry) SupportedActions
	// Transform distils the matched entries into attr overrides for the new block,
	// doing any synchronous id-keyed side effects. blockID is the pre-allocated id.
	// action is the operation chosen by the caller (ActionPaste/Extract/Transform);
	// a processor reads it only if its overrides differ by operation (e.g. prose embed).
	// Returns nil to decline.
	Transform(entries []ContentEntry, uuid string, blockID string, action Action) map[string]interface{}
	// RunJob performs this kind's async post-create work (AI describe, language
	// refine, image localise). jctx carries an immutable doc snapshot and a notify
	// func for mid-job attr pushes.
	RunJob(jctx JobContext) error
	// JobLabel is the human-readable label shown while RunJob is in flight ("" = no job).
	JobLabel(block *SieveBlock) string
	// OnChange reacts synchronously to a user edit of this block (e.g. re-run
	// heuristics). Setting status to PENDING schedules a follow-up RunJob.
	OnChange(block *SieveBlock)
	// Mode reports how this kind renders and persists: block, inline, or prose.
	Mode() BlockMode
	// BuildContext produces this block's contribution to AI context. seen guards
	// against ref cycles when a block pulls in others.
	BuildContext(block SieveBlock, doc DocView, seen map[string]bool) AIContext
	// MarkdownRepresentation renders the block as human/AI-facing markdown (e.g. a
	// diagram → ```mermaid …```). Distinct from Serialize, which is the on-disk form.
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
	// Shape returns the kind-qualified delimiter pair this flavour's regions use
	// on disk — the segmentation half of recognition. Supplied for free by the
	// embedded FencedDeserializer (from Kind); inline flavours return a zero shape.
	Shape() RegionShape
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
// block. An id-less body is hydrated by NewSieveBlock (mint-on-parse, exactly as
// prose mints) — serialized docs always carry an id, so round-trips are stable.
type FencedDeserializer struct{ Kind string }

func (d FencedDeserializer) Accepts(region Region) bool {
	return region.Kind != "" && region.Kind == d.Kind
}

func (d FencedDeserializer) Deserialize(region Region) ([]SieveBlock, error) {
	// region.Body == region.Raw (shape-driven scanner: verbatim span).
	// Strip the opening fence line ("```kind\n") and closing fence line ("```"
	// with optional trailing newline) to recover the YAML interior.
	body := d.fencedBody(region.Raw)
	attrs, err := fencedblock.DeserializeYaml(body)
	if err != nil {
		return nil, err
	}
	id, _ := attrs["id"].(string)
	return []SieveBlock{NewSieveBlock(d.Kind, id, attrs)}, nil
}

// fencedBody strips the opening and closing fence delimiter lines from the raw
// shape span, returning just the YAML interior. The raw span is of the form:
// "```{kind}\n{yaml}\n```\n". An empty-body fence returns "".
func (d FencedDeserializer) fencedBody(raw string) string {
	// Drop the opening fence line (everything up to and including the first \n).
	nl := strings.IndexByte(raw, '\n')
	if nl < 0 {
		return ""
	}
	after := raw[nl+1:]
	// Drop the closing fence line (last non-empty line starting with "```").
	// Walk back from the end to find the start of the closing fence line.
	s := strings.TrimRight(after, "\n")
	last := strings.LastIndexByte(s, '\n')
	if last < 0 {
		// Only one line between delimiters (the closing fence itself).
		return ""
	}
	return s[:last+1] // includes the trailing \n of the last body line
}

// Shape derives the fenced delimiter pair from Kind — every structured flavour
// gets ```Kind … ``` recognition for free by embedding. Returns a zero
// RegionShape when Kind is empty so that partially-constructed mocks (Kind: "")
// are never misidentified as a catch-all shape by DocumentCodec.scanner.
func (d FencedDeserializer) Shape() RegionShape {
	if d.Kind == "" {
		return RegionShape{}
	}
	return RegionShape{Kind: d.Kind, Head: "```" + d.Kind, Tail: "```"}
}

// InlineDeserializer is embedded by inline flavours. Inline things are NOT Sieve
// blocks (project_inline_not_a_block): they are never recognised from disk during
// document parse, so Accepts is always false and Deserialize is a no-op. The pair
// exists only to satisfy the BlockProcessor interface uniformly.
type InlineDeserializer struct{}

func (InlineDeserializer) Accepts(Region) bool                      { return false }
func (InlineDeserializer) Deserialize(Region) ([]SieveBlock, error) { return nil, nil }

// Shape: inline things are never document regions (Accepts is already false).
func (InlineDeserializer) Shape() RegionShape { return RegionShape{} }

type BlockServices struct {
	AI          AIPort
	Documents   DocumentsPort
	Assets      AssetsPort
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
func RegisterProcessor(processor BlockProcessor) {
	registryMu.Lock()
	kind := processor.Kind()
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

// ResetRegistry clears the processor registry and paste-matcher list. Test
// support only — lets a test start from a known-empty registry across packages
// (the registry is package-global). Not used in production.
func ResetRegistry() {
	registryMu.Lock()
	defer registryMu.Unlock()
	processorRegistry = map[string]BlockProcessor{}
	pasteMatchers = nil
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

type SelfExtractable interface {
	AllowSelfExtraction() bool
}

// FirstPasteMatch returns the kind and processor that claims these entries on a
// PASTE (registration order = priority), or ok=false. This is the paste operation
// ONLY — extract/convert goes through DetectExtractions, which is free to offer
// cross-kind upgrades the way paste must not.
//
// Two passes, because a paste has two jobs and they must not collide:
//
//  1. SELF-KIND (round-trip): a copied block carries a sieve/<kind> view; the
//     processor whose Kind() == that view claims it FIRST. A copied code block
//     comes back as code — never silently "upgraded" to another kind just because
//     some other processor (e.g. diagram on mermaid source) would also match it.
//     Because the right processor is *selected* here, the upgrading processor's
//     Transform is never invoked on the paste, so nothing needs to gate Transform.
//
//  2. GENERAL (new content / upgrades): nobody's own view → first registered
//     claimer wins, with PROSE consulted LAST (it is the terminal flavour and can
//     claim any sieve view). This is where "paste raw mermaid text → diagram" lives.
//
// The registry owns its internals (matcher list + lock); callers ask, they do not
// iterate pasteMatchers directly.
func FirstPasteMatch(entries []ContentEntry) (kind string, processor BlockProcessor, ok bool) {
	registryMu.RLock()
	defer registryMu.RUnlock()

	// Pass 1 — self-kind: a sieve/<kind> view is reclaimed by its own processor.
	for _, e := range entries {
		k, _, sieveOK := e.SieveAttrs()
		if !sieveOK {
			continue
		}
		for i := range pasteMatchers {
			if pasteMatchers[i].Kind == k && pasteMatchers[i].Processor.IsSupportedContent(entries).Has(ActionPaste) {
				return pasteMatchers[i].Kind, pasteMatchers[i].Processor, true
			}
		}
	}

	// Pass 2 — general detection, prose terminal last.
	proseIdx := -1
	for i := range pasteMatchers {
		if pasteMatchers[i].Processor.Mode() == BlockModeProse {
			proseIdx = i // defer prose to last
			continue
		}
		if pasteMatchers[i].Processor.IsSupportedContent(entries).Has(ActionPaste) {
			return pasteMatchers[i].Kind, pasteMatchers[i].Processor, true
		}
	}
	if proseIdx >= 0 && pasteMatchers[proseIdx].Processor.IsSupportedContent(entries).Has(ActionPaste) {
		return pasteMatchers[proseIdx].Kind, pasteMatchers[proseIdx].Processor, true
	}
	return "", nil, false
}

// DetectExtractions composes the affordance offer: for each registered kind that can
// build from these entries via extract/transform, its SupportedActions. The frontend
// renders the menu from this. Self-kind is skipped unless AllowSelfExtraction.
func DetectExtractions(sourceKind string, entries []ContentEntry) []SupportedActions {
	registryMu.RLock()
	defer registryMu.RUnlock()

	var offers []SupportedActions
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
		if sa := pm.Processor.IsSupportedContent(entries); sa.Has(ActionExtract) || sa.Has(ActionTransform) {
			offers = append(offers, sa)
		}
	}
	return offers
}
