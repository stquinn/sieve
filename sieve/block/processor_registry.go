package block

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"sieve/sieve/ai"
	"sieve/sieve/domain"
	"sieve/sieve/fencedblock"
)

// RegionShape is the kind-qualified delimiter pair a processor relies on — the
// "angle brackets" that bound its on-disk regions. It rides with the SerDes
// (the code that writes <!--s:…--> is the code that finds it), so it is supplied
// for free by the embedded FencedDeserializer / ProseProcessor. A zero value
// (empty Head) means "I have no document region" — every registered flavour
// declares one, so it is only produced by a kind-less (partially built) mock.
type RegionShape struct {
	Kind string // the kind a matched region is tagged with (e.g. "diagram", "prose")
	Head string // opening token, kind-qualified (e.g. "```diagram", "<!--s:")
	Tail string // closing token (e.g. "```", "<!--/s:")
}

// IsZero reports that the processor declares no document region.
func (s RegionShape) IsZero() bool { return s.Head == "" }

// Wraps reports that `content` is EXACTLY one region of this shape — the head
// opening its first line, the tail closing its last, and nothing outside either.
// It is how a pasted fenced span is recognised as the same round-trip a
// "sieve/<kind>" clipboard view is, instead of being claimed by a general text
// matcher.
//
// Only KIND-QUALIFIED heads can answer: a marker shape opens with a token that
// does not end at the line break, and a marker span is document structure rather
// than a block's portable form.
func (s RegionShape) Wraps(content string) bool {
	if s.IsZero() || s.Tail == "" {
		return false
	}
	span := strings.TrimSpace(content)
	if len(span) <= len(s.Head)+len(s.Tail) || !strings.HasSuffix(span, s.Tail) {
		return false
	}
	if !strings.HasPrefix(span, s.Head) {
		return false
	}
	// The head must be the WHOLE opening token: "```code" must not claim a
	// "```codegen" fence, whose kind is a language this shape knows nothing about.
	return span[len(s.Head)] == '\n'
}

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

// NestedParentID reports the id of the composite block this source was rendered
// inside, when the entry came from a sub-element nested in another sieve block (the
// frontend stamps Context["parentId"]). ok is false for a top-level source. A nested
// source has no addressable id of its own — only the parent's — so it can never be
// replaced in place; see SupportedActions.asAdditive.
func (e ContentEntry) NestedParentID() (string, bool) {
	if e.Context == nil {
		return "", false
	}
	if v, present := e.Context["parentId"]; present {
		if s, isStr := v.(string); isStr && s != "" {
			return s, true
		}
	}
	return "", false
}

// HolderID reports the id of the block whose HELD content this entry carries —
// content a source refers to but does not carry in its attrs, read server-side by
// MaterialiseEntries. ok is false for an ordinary entry.
//
// The holder is what makes the content reachable at all, so an offer that stands
// only on a held entry can never replace it; see DetectExtractions.
func (e ContentEntry) HolderID() (string, bool) {
	if e.Context == nil {
		return "", false
	}
	if s, isStr := e.Context["holderId"].(string); isStr && s != "" {
		return s, true
	}
	return "", false
}

// heldBy returns a copy of this entry stamped as content blockID holds. The
// FRAMEWORK stamps it, never the processor that produced the content: the
// source-survives rule it triggers is the framework's invariant, and a materialiser
// must not be able to forget it.
func (e ContentEntry) heldBy(blockID string) ContentEntry {
	ctx := make(map[string]interface{}, len(e.Context)+1)
	for k, v := range e.Context {
		ctx[k] = v
	}
	ctx["holderId"] = blockID
	e.Context = ctx
	return e
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
	// BlockStatusTimeout is the terminal state a job whose Work timed out settles
	// into (distinct from a generic ERROR so the client can say "timed out"). The
	// literal "TIMEOUT" is what the frontend renderers key off — keep it in sync.
	BlockStatusTimeout = "TIMEOUT"
)

type BlockMode string

const (
	BlockModeBlock BlockMode = "block"
	BlockModeProse BlockMode = "prose" // content + <!--s:ID--> markers, owned by ProseProcessor
)

// Action is an operation a processor can perform on a set of ContentEntry views.
// Recognition (IsSupportedContent) enumerates the actions an entry set supports,
// context-blind; each endpoint filters for the action it cares about (smart-paste →
// ActionPaste; extract menu → ActionExtract/ActionTransform).
type Action string

const (
	ActionPaste          Action = "paste"            // clipboard/source content -> new block
	ActionExtract        Action = "extract"          // additive: new block alongside (source survives)
	ActionTransform      Action = "transform"        // replace the source block in place
	ActionUndoSmartPaste Action = "undo-smart-paste" // replace a smart-pasted block with its raw text as prose
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

// asAdditive returns a copy of this offer with any in-place TRANSFORM demoted to an
// additive EXTRACT. Used for a source nested inside a composite (entries carry a
// parentId): TRANSFORM would ReplaceBlock(parentId) and clobber the whole composite —
// its only addressable id is the parent's. Extracting a copy alongside the surviving
// parent is the only safe mechanic. The label the user sees ("Convert to X") is
// unchanged; only the mechanic goes additive.
func (s SupportedActions) asAdditive() SupportedActions {
	out := SupportedActions{Kind: s.Kind}
	for _, a := range s.Actions {
		if a == ActionTransform {
			continue // drop the in-place transform
		}
		out.Actions = append(out.Actions, a)
	}
	if !out.Has(ActionExtract) && s.Has(ActionTransform) {
		out.Actions = append(out.Actions, ActionExtract) // ...replacing it with an extract
	}
	return out
}

// KindProse is the prose kind name. It lives with the registry/kind constants, NOT
// in the kind-agnostic data model. Parsing never branches on it (that is
// ProseProcessor.Accepts + orderedProseLast).
const KindProse = "prose"

// KindReference is the reference kind name — a pointer to an address, whether it
// stands in the document tree or inside another block's payload as an element.
// It names the one kind an edge can be carried as, so the code that mints an
// element edge and the code that harvests one agree on the spelling.
const KindReference = "reference"

// RelTarget and RelAttach are the two roles a reference can declare in its `rel`
// attr: what the reference IS to whatever holds it. A target names material the
// holder is about; an attachment names material the holder was handed.
//
// The role is AUTHORED and it decides — a consumer reads `rel` first and only
// falls back to what the address observably names when `rel` declares neither
// role. That fallback is why an undeclared reference still classifies, and the
// declaration is why "attach the document you are already in" can be said at
// all, which no address can express.
const (
	RelTarget = "target"
	RelAttach = "attach"
)

// JobContext is the complete input to a processor's DescribeJob.
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
	// OnBlockReplaced renders an in-place TRANSFORM: swap the block identified by oldID
	// with a new block (newKind/newID + attrs). markdown is the serialized fence for the
	// breakglass markdown editor.
	OnBlockReplaced(uuid, oldID, newKind, newID string, attrs map[string]interface{}, markdown string)
	// OnBlockRemoved renders a block leaving the container. A transform is not a
	// removal — it keeps the slot and announces both ids through OnBlockReplaced.
	OnBlockRemoved(uuid, blockID string)
	// OnOrderChanged renders a reorder. order is the container's COMPLETE child id
	// order for the same reason the set-order op carries one: installing a whole
	// order is idempotent, so a duplicate or late event lands the client in the
	// same place. It names nothing that arrived or left — those have their own
	// events.
	OnOrderChanged(uuid string, order []string)
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
//   - Async work after creation:                DescribeJob
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
//     ident.New() BEFORE Transform precisely so Transform can key
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
// DescribeJob's JobContext carries a notify func so a processor can push intermediate
// attr updates to the client mid-job — e.g. push src immediately after saving an
// asset, before the slower AI describe completes. OnChange is the synchronous hook
// after a user edit; setting status to PENDING schedules a follow-up job.
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
	// DescribeJob returns the async work this block needs after creation (AI
	// describe, language refine, image localise, link fetch), or nil when the block
	// has NO async work. jctx carries an immutable doc snapshot and a notify func
	// for mid-job attr pushes. The framework owns the lifecycle: it runs Work on a
	// category worker pool, then Apply on success. A nil *ProcessorJob is NEVER
	// submitted to the engine — it means "no job for this block". A non-nil
	// *ProcessorJob is always real async work and MUST carry a non-empty Label. The
	// "no async work" predicate MUST match InitAttrs' complete-vs-pending predicate
	// on the same attrs: a block created PENDING here must return a job, and one
	// created COMPLETE must return nil — otherwise it hangs (created pending, no job).
	DescribeJob(jctx JobContext) *ProcessorJob
	// OnChange reacts synchronously to a user edit of this block (e.g. re-run
	// heuristics). Setting status to PENDING schedules a follow-up RunJob.
	OnChange(block *SieveBlock)
	// Mode reports how this kind renders and persists: block or prose.
	Mode() BlockMode
	// BuildContext produces this block's contribution to AI context. seen guards
	// against ref cycles when a block pulls in others.
	BuildContext(block SieveBlock, doc DocView, seen map[string]bool) AIContext
	// MarkdownRepresentation renders the block as human/AI-facing markdown (e.g. a
	// diagram → ```mermaid …```). Distinct from Serialize, which is the on-disk form.
	// uuid is the document context — needed by asset-bearing kinds to build a served
	// URL (/ui/assets/<uuid>/<filename>); kinds with no asset reference ignore it.
	MarkdownRepresentation(block SieveBlock, uuid string) string
	// Serialize renders the block to its on-disk form. THIS is the whole point of
	// the block-document model: each flavour owns how its kind persists, and the
	// save spine just walks blocks and asks each one. Structured (YAML) kinds share
	// one implementation (FencedSerializer, embedded — free); prose owns the custom
	// content + <!--s:ID--> marker form (ProseProcessor). No kind-switch in the spine.
	Serialize(block SieveBlock) (string, error)
	// Accepts reports whether this flavour claims a parsed region (the recognition
	// half of deserialization) — by its own Kind OR any declared alias. Deserialize
	// then builds the block(s) — the inverse of Serialize, always canonicalising to
	// this flavour's own Kind regardless of which alias the region matched.
	// Structured kinds share one impl (FencedDeserializer, embedded); prose is the
	// terminal mop-up (ProseProcessor). No kind-switch in the codec.
	Accepts(region Region) bool
	Deserialize(region Region) ([]SieveBlock, error)
	// Shapes returns the kind-qualified delimiter pairs this flavour's regions use
	// on disk — the segmentation half of recognition — one per head token this
	// flavour answers to: its own Kind FIRST, then one per declared alias, in
	// declaration order. A flavour with no aliases returns a single-element slice.
	// Supplied for free by the embedded FencedDeserializer (from Kind + Aliases).
	Shapes() []RegionShape
}

// FencedSerializer is the ONE shared serialization for YAML/fenced block flavours.
// Every structured processor embeds it, so code/diagram/ai/log/web-clip/card/image/
// link all persist as ```kind\n<yaml>\n``` for free — "one implementation."
type FencedSerializer struct{}

// Serialize renders any block-mode kind as ```kind\n<yaml>\n``` using the shared
// literal-style machinery — registry-free, so it serializes code, diagram, etc.
// uniformly without needing a BlockProcessor.
func (FencedSerializer) Serialize(block SieveBlock) (string, error) {
	attrs := block.Attrs
	// Aliases live on the STRUCT, not in Attrs — unlike id: Merge replaces
	// Aliases wholesale, so a mirrored copy in Attrs would go stale. They are
	// injected at the persistence boundary only, over a copy, because processors
	// build throwaway blocks over live Attrs maps.
	if len(block.Aliases) > 0 {
		attrs = make(map[string]interface{}, len(block.Attrs)+1)
		for k, v := range block.Attrs {
			attrs[k] = v
		}
		attrs["aliases"] = append([]string(nil), block.Aliases...)
	}
	body, err := fencedblock.SerializeYaml(attrs)
	if err != nil {
		return "", err
	}
	return "```" + block.Kind + "\n" + body + "\n```", nil
}

// FencedDeserializer is the ONE shared deserialization for YAML/fenced flavours —
// the mirror of FencedSerializer. Kind is the fence tag this flavour answers to
// (set at construction, alongside the FencedSerializer embed).
//
// Aliases are OTHER fence tags this flavour also answers to, so a kind can be
// renamed on disk without stranding documents carrying the old tag. An aliased
// fence is scanned, Accepts, and Deserializes, but always CANONICALISES to Kind
// and never to the alias it matched. This is unrelated to SieveBlock.Aliases,
// which names one BLOCK within a document; an alias here names a FENCE TAG a
// whole kind answers to.
//
// An id-less body is hydrated by NewSieveBlock (mint-on-parse, exactly as prose
// mints) — serialized docs always carry an id, so round-trips are stable.
type FencedDeserializer struct {
	Kind    string
	Aliases []string
}

func (d FencedDeserializer) Accepts(region Region) bool {
	if region.Kind == "" {
		return false
	}
	if region.Kind == d.Kind {
		return true
	}
	for _, alias := range d.Aliases {
		if region.Kind == alias {
			return true
		}
	}
	return false
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
	// Lift aliases BEFORE NewSieveBlock: it may clone attrs when the id differs,
	// and the delete must land on the map that gets cloned.
	aliases := d.liftAliases(attrs)
	blk := NewSieveBlock(d.Kind, id, attrs)
	blk.Aliases = aliases
	return []SieveBlock{blk}, nil
}

// liftAliases REMOVES the persisted aliases key from attrs and returns it as the
// struct-side slice. The delete is required: Attrs must not keep a second copy
// that Merge would leave stale.
func (d FencedDeserializer) liftAliases(attrs map[string]interface{}) []string {
	raw, ok := attrs["aliases"]
	if !ok {
		return nil
	}
	delete(attrs, "aliases")
	items, ok := raw.([]interface{})
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, it := range items {
		if s, ok := it.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
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

// Shapes derives the fenced delimiter pairs from Kind and Aliases — every
// structured flavour gets ```Kind … ``` recognition for free by embedding, plus
// one ```alias … ``` pair per declared Aliases entry. The canonical Kind is
// ALWAYS first: Shapes()[0] is the canonical shape. Returns nil when Kind is
// empty, so a partially-constructed mock is never taken for a catch-all shape by
// DocumentCodec.scanner.
func (d FencedDeserializer) Shapes() []RegionShape {
	if d.Kind == "" {
		return nil
	}
	shapes := make([]RegionShape, 0, 1+len(d.Aliases))
	shapes = append(shapes, RegionShape{Kind: d.Kind, Head: "```" + d.Kind, Tail: "```"})
	for _, alias := range d.Aliases {
		shapes = append(shapes, RegionShape{Kind: alias, Head: "```" + alias, Tail: "```"})
	}
	return shapes
}

// WrapsAnyShape reports whether content is exactly one of THIS flavour's fenced
// spans — its canonical Kind's, or any declared alias's. It is the one place
// "is this content my own fence, under any tag I answer to" is asked.
func (d FencedDeserializer) WrapsAnyShape(content string) bool {
	for _, s := range d.Shapes() {
		if s.Wraps(content) {
			return true
		}
	}
	return false
}

type BlockServices struct {
	// AI is the concrete AI business service. block core deliberately imports ai
	// here: the governing invariant is directional — a business service must never
	// depend on block (ai imports no block), but block depending on the ai service
	// is fine. So AIPort was inverting an edge that never needed inverting.
	AI          *ai.AIService
	Documents   DocumentsPort
	Assets      AssetsPort
	LinkPreview LinkPreviewPort
	State       StatePort
	Plantuml    PlantumlPort
	// Nodes dereferences a Sieve coordinate. It is injected rather than reached
	// for because the resolver lives in editor/, which imports this package.
	Nodes NodesPort
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
//
// PANICS when a fence tag `processor` answers to (its Shapes() — Kind plus every
// declared alias) is already claimed by a DIFFERENTLY-KINDED registered
// processor: two flavours owning one on-disk head is silent document mangling on
// the next load. Re-registering the SAME kind is a legitimate replace and is
// exempt.
func RegisterProcessor(processor BlockProcessor) {
	registryMu.Lock()
	defer registryMu.Unlock()
	kind := processor.Kind()
	assertNoFenceTagCollision(kind, processor)
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

// assertNoFenceTagCollision panics when any shape `processor` declares shares
// its Kind (the on-disk head) with a shape declared by a processor already
// registered under a DIFFERENT kind. Runs under registryMu, held by the
// caller.
func assertNoFenceTagCollision(kind string, processor BlockProcessor) {
	for _, s := range processor.Shapes() {
		if s.Kind == "" {
			continue
		}
		for _, pm := range pasteMatchers {
			if pm.Kind == kind {
				continue // the slot this registration is (re)claiming
			}
			for _, existing := range pm.Processor.Shapes() {
				if existing.Kind == s.Kind {
					panic(fmt.Sprintf(
						"block.RegisterProcessor(%q): fence tag %q already claimed by processor %q",
						kind, s.Kind, pm.Kind))
				}
			}
		}
	}
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

// Block ids are minted by ident.New — opaque UUIDv7, carrying no kind. The
// kind-prefix scheme that lived here ("XX-YYYY", 2 random bytes behind a 2-3 char
// prefix) gave 65,536 values per prefix with no collision check anywhere, which
// put a 300-paragraph note at a ~50% chance of a duplicate prose id (#75).
// Nothing ever inferred kind from an id prefix, so nothing replaces it.

type SelfExtractable interface {
	AllowSelfExtraction() bool
}

// RawContenter is the optional interface a processor implements to expose the raw
// source text its block was built from. Used by "Undo Smart Paste" to recover the
// pre-detection text, and lets prose embedding avoid hard-coding source-bearing kinds
// by name. A kind that has no raw text simply does not implement it.
type RawContenter interface {
	RawContent(blk SieveBlock) string
}

// ContentMaterialiser is the optional interface a processor implements when its
// block HOLDS content its attrs do not carry — a reference's held file, which lives in
// the document directory and is readable only from Go. The frontend cannot send such
// content, so without this every recogniser is blind to it.
//
// The implementer's whole job is handing the bytes over as ordinary content: whether
// they are fit to hand over at all (readable, textual, small enough to edit) is its
// decision, and what any kind then makes of them is emphatically not.
type ContentMaterialiser interface {
	MaterialiseContent(uuid string, attrs map[string]interface{}) []ContentEntry
}

// MaterialiseEntries returns entries plus whatever content the blocks they describe
// are holding out of band, each stamped with its holder. Every sieve/<kind> view is
// offered to its own processor, so a kind that holds content is recognised through
// the ordinary registry walk and no caller needs to know which kinds hold anything.
//
// Nothing is cached: the bytes are on disk and the block is a live reference to
// them, so a cached copy would extract content the file no longer has.
func MaterialiseEntries(uuid string, entries []ContentEntry) []ContentEntry {
	var held []ContentEntry
	for _, e := range entries {
		kind, attrs, ok := e.SieveAttrs()
		if !ok {
			continue
		}
		m, isMaterialiser := GetProcessor(kind).(ContentMaterialiser)
		if !isMaterialiser {
			continue
		}
		// No id, no holder to stamp — and the survives-rule the stamp triggers is
		// the only thing that keeps an extraction from replacing its own source.
		holder, _ := attrs["id"].(string)
		if holder == "" {
			continue
		}
		for _, c := range m.MaterialiseContent(uuid, attrs) {
			held = append(held, c.heldBy(holder))
		}
	}
	if len(held) == 0 {
		return entries
	}
	out := make([]ContentEntry, 0, len(entries)+len(held))
	out = append(out, entries...)
	return append(out, held...)
}

// BlockParent is the optional capability a processor implements when its block's
// payload holds child blocks — elements, which live inside the parent and
// nowhere else. Implementing it IS the has-children predicate: a caller asks
// GetProcessor(kind).(BlockParent) rather than naming the kinds that nest.
//
// Children returns the parent's elements in order. Each carries ITS OWN attrs
// map — the one stored inside the parent's payload — so an attr written through
// an element lands in what the parent persists; the list itself is a fresh read.
type BlockParent interface {
	Children(blk *SieveBlock) []*SieveBlock
}

// TextBearer is the optional capability a processor implements when its block's
// payload holds human-readable text a text service may read. Implementing it IS
// the participation predicate: nothing enumerates the kinds that bear text — a
// caller asks the registry (TextBearerFor) and a kind that answers takes part.
//
// NormalisedText returns the block's text as segments, in the processor's own
// order. Each segment's Text must be the STORED bytes verbatim: the offsets and
// quotes a consumer derives are anchored in those bytes, so trimming, unescaping
// or re-rendering on the way out silently invalidates every mark made from them.
// A processor mints its own locators and is the only thing that reads one back.
type TextBearer interface {
	NormalisedText(blk *SieveBlock) []domain.TextSegment
}

// TextBearerFor returns kind's processor as a TextBearer, or false when the kind
// bears no readable text (an unregistered kind included). It is the whole
// participation test — a caller that asks this never names a kind.
func TextBearerFor(kind string) (TextBearer, bool) {
	bearer, ok := GetProcessor(kind).(TextBearer)
	return bearer, ok
}

// ErrTextStale is what UpdateText returns when the run it was asked to replace
// is no longer there: the quote does not occur in the located segment as many
// times as the requested occurrence demands. It is a normal outcome, not a
// fault — the text moved on between the read that produced the anchor and the
// write that acts on it — and the block is left exactly as it was. Callers
// test for it with errors.Is.
var ErrTextStale = errors.New("text: the quote no longer resolves at its occurrence")

// TextUpdater is the optional capability a processor implements when text a
// TextBearer handed out can be written back. Implementing it IS the
// participation predicate, exactly as TextBearer's is: a caller asks the
// registry (TextUpdaterFor) rather than naming the kinds that accept edits.
//
// UpdateText replaces one anchored run of blk's text with replacement, writing
// the result into blk's payload. locator names the segment, and only the
// processor that minted it may read it.
//
// THE ANCHOR IS QUOTE PLUS OCCURRENCE, AND IT IS RESOLVED IN THE SEGMENT'S
// CURRENT TEXT. A processor finds occurrence N of quote where it NOW sits and
// writes there, so an edit that displaced it since the anchor was taken costs
// nothing; if occurrence N is not there at all, the processor returns
// ErrTextStale and changes NOTHING. start and end are the offsets the requester
// last saw: a hint a processor may use to narrow a search in a large payload,
// never a range it may write to on their word alone.
//
// A processor expresses the edit by WRITING payload values on blk. Its caller
// merges the resulting attrs, so a value that is not written is left as it was
// and a key cannot be removed this way.
type TextUpdater interface {
	UpdateText(blk *SieveBlock, locator string, start, end int, quote string, occurrence int, replacement string) error
}

// TextUpdaterFor returns kind's processor as a TextUpdater, or false when the
// kind's text cannot be written back (an unregistered kind included). A kind
// may bear text without accepting edits to it; the two capabilities are asked
// for separately.
func TextUpdaterFor(kind string) (TextUpdater, bool) {
	updater, ok := GetProcessor(kind).(TextUpdater)
	return updater, ok
}

// MarkdownContenter is the optional interface a processor implements when a given
// block's raw content can itself BE document markdown (e.g. a code block whose
// language is markdown). Prose embedding ("Embed in Document") consults it to
// insert such content directly into the document instead of a fenced
// representation — the escape hatch for markdown captured as a code block.
// Pairs with RawContenter, which supplies the content to unwrap.
type MarkdownContenter interface {
	ContentIsMarkdown(blk SieveBlock) bool
}

// wrapsAnyShaper is the optional capability FirstPasteMatch's pass 1b uses to
// ask a processor "is this content exactly your own fenced form". Every
// structured/fenced flavour gets it by embedding FencedDeserializer. Prose does
// not implement it: RegionShape.Wraps is unsatisfiable for a marker shape, so
// asserting the interface loses no match it could have made.
type wrapsAnyShaper interface {
	WrapsAnyShape(content string) bool
}

// FirstPasteMatch returns the kind and processor that claims these entries on a
// PASTE (registration order = priority), or ok=false. This is the paste operation
// ONLY — extract/convert goes through DetectExtractions, which is free to offer
// cross-kind upgrades the way paste must not.
//
// Two passes, because a paste has two jobs and they must not collide:
//
//  1. SELF-KIND (round-trip): a copied block declares its own kind, and the
//     processor whose Kind() matches claims it FIRST. A copied code block comes
//     back as code — never silently "upgraded" to another kind just because some
//     other processor (e.g. diagram on mermaid source) would also match it.
//     Because the right processor is *selected* here, the upgrading processor's
//     Transform is never invoked on the paste, so nothing needs to gate Transform.
//     The declaration has two spellings and both count: the sieve/<kind> clipboard
//     view, and the block's own fenced form, whose kind is written on the fence.
//
//  2. GENERAL (new content / upgrades): nobody's own view → first registered
//     claimer wins, with PROSE consulted LAST (it is the terminal flavour and can
//     claim any sieve view). This is where "paste raw mermaid text → diagram" lives.
//
// The registry owns its internals (matcher list + lock); callers ask, they do not
// iterate pasteMatchers directly.
func FirstPasteMatch(entries []ContentEntry) (kind string, processor BlockProcessor, fromDetection bool, ok bool) {
	registryMu.RLock()
	defer registryMu.RUnlock()

	// Pass 1 — self-kind round-trip (NOT detection), by clipboard view…
	for _, e := range entries {
		k, _, sieveOK := e.SieveAttrs()
		if !sieveOK {
			continue
		}
		for i := range pasteMatchers {
			if pasteMatchers[i].Kind == k && pasteMatchers[i].Processor.IsSupportedContent(entries).Has(ActionPaste) {
				return pasteMatchers[i].Kind, pasteMatchers[i].Processor, false, true
			}
		}
	}
	// …and by the block's own fenced form, which names its kind just as plainly.
	// A processor that does not claim its own fence in IsSupportedContent is not
	// promoted here, so this widens precedence only where a kind already said the
	// bytes are its own. The shape check goes first because it is a handful of
	// string compares gating IsSupportedContent, which is not always cheap; the
	// two give the same answer in either order.
	for _, e := range entries {
		for i := range pasteMatchers {
			w, wrapsSelf := pasteMatchers[i].Processor.(wrapsAnyShaper)
			if !wrapsSelf || !w.WrapsAnyShape(e.Content) {
				continue
			}
			if pasteMatchers[i].Processor.IsSupportedContent(entries).Has(ActionPaste) {
				return pasteMatchers[i].Kind, pasteMatchers[i].Processor, false, true
			}
		}
	}

	// Pass 2 — general detection (smart paste being clever).
	proseIdx := -1
	for i := range pasteMatchers {
		if pasteMatchers[i].Processor.Mode() == BlockModeProse {
			proseIdx = i
			continue
		}
		if pasteMatchers[i].Processor.IsSupportedContent(entries).Has(ActionPaste) {
			return pasteMatchers[i].Kind, pasteMatchers[i].Processor, true, true
		}
	}
	if proseIdx >= 0 && pasteMatchers[proseIdx].Processor.IsSupportedContent(entries).Has(ActionPaste) {
		return pasteMatchers[proseIdx].Kind, pasteMatchers[proseIdx].Processor, true, true
	}
	return "", nil, false, false
}

// DetectExtractions composes the affordance offer: for each registered kind that can
// build from these entries via extract/transform, its SupportedActions. The frontend
// renders the menu from this. Self-kind is skipped unless AllowSelfExtraction.
func DetectExtractions(sourceKind string, entries []ContentEntry) []SupportedActions {
	registryMu.RLock()
	defer registryMu.RUnlock()

	// A source nested inside a composite has no id of its own — TRANSFORM would
	// replace the parent and clobber it (defect #1, data loss). Demote every offer to
	// additive-only when any entry carries a parentId.
	nested := false
	// unheld is the entry set MINUS content a source is merely holding — what an
	// in-place TRANSFORM would still have to work from once the source it replaced
	// (and the file that reached it) is gone.
	unheld := make([]ContentEntry, 0, len(entries))
	for _, e := range entries {
		if _, ok := e.NestedParentID(); ok {
			nested = true
		}
		if _, isHeld := e.HolderID(); !isHeld {
			unheld = append(unheld, e)
		}
	}
	anyHeld := len(unheld) < len(entries)

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
		sa := pm.Processor.IsSupportedContent(entries)
		if !sa.Has(ActionExtract) && !sa.Has(ActionTransform) {
			continue
		}
		if nested {
			sa = sa.asAdditive()
		}
		// An offer that stands ONLY on content the source is holding must be
		// additive: an in-place TRANSFORM would replace the very block the content
		// was read out of, destroying the extraction's own source. Asking the
		// processor again without the held entries is what tells the two apart —
		// an offer that survives that (prose embedding a reference as a link)
		// keeps its transform.
		if anyHeld && sa.Has(ActionTransform) &&
			!pm.Processor.IsSupportedContent(unheld).Has(ActionTransform) {
			sa = sa.asAdditive()
		}
		offers = append(offers, sa)
	}
	return offers
}
