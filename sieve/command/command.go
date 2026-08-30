package command

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"sieve/sieve/domain"
	"sieve/sieve/services"
)

const Category = "commands" // opaque to the engine; own worker pool

const (
	StatusPending  = "PENDING"
	StatusComplete = "COMPLETE"
	StatusError    = "ERROR"
)

// Command families are the NAMESPACE/DISCOVERY axis of the command plane — which
// verbs exist and how they are grouped — NEVER a policy axis. Per-command
// preconditions live in Build; the dispatcher only integrity-checks that the
// invoked verb's family matches what the caller thought it invoked.
const (
	FamilyAI   = "ai"   // AI-CLI-backed commands producing ai-block results
	FamilyUtil = "util" // deterministic local utilities producing command-result blocks
)

// Context is everything a command knows about its invocation site. Commands read
// fields OPPORTUNISTICALLY and never require them; a bad or absent context
// decodes to the empty floor.
//
// It has TWO AUTHORS, and the distinction is load-bearing:
//
//   - The lens authors the SelectionContext half (DocUUID, SelectedText,
//     BlockID(s), Raw) — a typed core plus the full tolerant bag, decoded from
//     the envelope's `context` JSON.
//   - The COMPOSER authors Attachments and Body. They arrive as their own
//     envelope fields (`attachments`, `body`) because `@` and the message itself
//     are composer affordances, not properties of the selection — and they are
//     NEVER read out of the context JSON, so a lens cannot forge either.
//
// They land here rather than on new Build parameters precisely because Context
// is already "what the command knows about its invocation site" and every
// command takes it — so every command can have them without a single existing
// Build signature changing.
type Context struct {
	DocUUID      string                 `json:"docUuid"`
	SelectedText string                 `json:"selectedText"`
	BlockID      string                 `json:"blockId"`
	BlockIDs     []string               `json:"blockIds"`
	Raw          map[string]interface{} // everything the lens sent, untyped
	// Attachments and Body are composer-authored and json:"-" ON PURPOSE: both
	// are filled from the envelope, never from the context JSON.
	Attachments domain.Attachments `json:"-"`
	// Body is everything the composer wrote after the verb line, in order. A
	// command consumes it or ignores it; an empty body is the ordinary case.
	Body Blocks `json:"-"`
}

// NewContext decodes the lens-authored context JSON and attaches what the
// composer authored — the attachment list and the message body. Attachments go
// through domain.Attachment.Normalised — the same door the block attr path uses
// — so an address-less entry never reaches a command.
func NewContext(raw json.RawMessage, attachments []domain.Attachment, body Blocks) Context {
	ctx := Context{Raw: make(map[string]interface{})}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &ctx.Raw)
		_ = json.Unmarshal(raw, &ctx)
		if ctx.Raw == nil {
			ctx.Raw = make(map[string]interface{})
		}
	}
	for _, a := range attachments {
		if normalised, ok := a.Normalised(); ok {
			ctx.Attachments = append(ctx.Attachments, normalised)
		}
	}
	ctx.Body = body
	return ctx
}

type Block struct {
	Kind  string                 `json:"kind"`
	Attrs map[string]interface{} `json:"attrs"`
}

// Blocks is an ordered list of blocks: the shape a composed message takes on the
// command plane, whether a composer authored it or a command built it.
//
// THE KIND VOCABULARY IS SPELLED HERE AS LITERALS. `command` sits BELOW `block`
// in the package DAG — block reaches ai, ai reaches command — so the kind names
// and attr keys read below cannot be imported. They must equal what the block
// package and its processors declare.
type Blocks []Block

// AttrValue renders the list into the canonical element-payload form a block's
// attrs bag holds: a list of {kind, attrs} maps. It must stay this form and not
// []Block — a struct marshals its fields in declaration order and a map in
// sorted-key order, so mixing the two rewrites the YAML on the second save.
//
// An empty list renders as nil: absent is the empty case for an element slot.
func (b Blocks) AttrValue() []interface{} {
	if len(b) == 0 {
		return nil
	}
	out := make([]interface{}, 0, len(b))
	for _, el := range b {
		attrs := el.Attrs
		if attrs == nil {
			attrs = map[string]interface{}{}
		}
		out = append(out, map[string]interface{}{"kind": el.Kind, "attrs": attrs})
	}
	return out
}

// Markdown flattens the list to the one text a prompt is composed from, blocks
// separated by a blank line. A block contributing nothing is dropped, so the
// result of an empty or text-less list is the empty string.
func (b Blocks) Markdown() string {
	spans := make([]string, 0, len(b))
	for _, el := range b {
		if span := el.markdown(); span != "" {
			spans = append(spans, span)
		}
	}
	return strings.Join(spans, "\n\n")
}

// The two kinds whose text is not simply their content. Every other kind is
// read as prose, so a new kind reads as what it says rather than as nothing.
const (
	kindCode      = "code"
	kindReference = "reference"
)

// markdown renders one block as the text a prompt reads it as: code fenced and
// tagged with its language, a reference contributing nothing (an address reaches
// a prompt as an attachment, not as text), anything else as its content.
func (b Block) markdown() string {
	switch b.Kind {
	case kindReference:
		return ""
	case kindCode:
		source, _ := b.Attrs["source"].(string)
		if strings.TrimSpace(source) == "" {
			return ""
		}
		language, _ := b.Attrs["language"].(string)
		return "```" + language + "\n" + strings.TrimRight(source, "\n") + "\n```"
	default:
		content, _ := b.Attrs["content"].(string)
		return strings.TrimSpace(content)
	}
}

// stampIdentity sets the block's "id" attr to the job's correlationID, giving
// the frontend's stale-detection a stable key that matches the JobEngine's
// JobID. Commands never invent their own id — identity is a dispatcher concern.
// No-op on a nil block or empty id.
func (b *Block) stampIdentity(id string) {
	if b == nil || id == "" {
		return
	}
	if b.Attrs == nil {
		b.Attrs = make(map[string]interface{}, 1)
	}
	b.Attrs["id"] = id
}

type Outcome struct { // wire-blind: WsHandler maps this to command-result frames
	Status string
	Block  *Block
	Err    string
}

type Info struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Family      string `json:"family"`
	ResultKind  string `json:"resultKind"`
}

// Command is one registered verb. Implementations are STATELESS SINGLETONS:
// immutable dependencies injected at the composition root; ALL per-request
// state flows through Build's args and the returned Job's closures. Build
// validates the command's OWN preconditions and fails fast — a Build error
// becomes an immediate ERROR result. The dispatcher enforces nothing per-command.
type Command interface {
	Name() string
	Description() string
	// Family is the command's namespace/discovery bucket (FamilyAI / FamilyUtil).
	// It is descriptive metadata for grouping + an envelope integrity check —
	// never a policy gate (policy lives in Build).
	Family() string
	// ResultKind advises the block kind the command expects to return (e.g.
	// "ai-block", "command-result"). The result block's own Kind remains the
	// runtime truth; this is a hint for discovery/UI, not a contract.
	ResultKind() string
	Build(text string, ctx Context) (Job, error)
}

type Job struct {
	Label   string
	Pending *Block
	Work    func() (Block, error)
}

type Registry struct {
	engine *services.JobEngine
	mu     sync.RWMutex
	cmds   map[string]Command
	order  []string
}

func NewRegistry() *Registry {
	return &Registry{
		cmds: make(map[string]Command),
	}
}

func (r *Registry) SetEngine(e *services.JobEngine) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.engine = e
}

func (r *Registry) Register(c Command) {
	r.mu.Lock()
	defer r.mu.Unlock()
	name := c.Name()
	if _, exists := r.cmds[name]; exists {
		panic(fmt.Sprintf("command %q already registered", name))
	}
	r.cmds[name] = c
	r.order = append(r.order, name)
}

func (r *Registry) List() []Info {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Info, 0, len(r.order))
	for _, name := range r.order {
		if c, ok := r.cmds[name]; ok {
			out = append(out, Info{
				Name:        c.Name(),
				Description: c.Description(),
				Family:      c.Family(),
				ResultKind:  c.ResultKind(),
			})
		}
	}
	return out
}

func (r *Registry) lookup(name string) Command {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.cmds[name]
}

// Dispatch is pure MECHANISM — the spec's "mechanism on the wire, policy in
// the tool" applied to the dispatcher itself: lookup → family-integrity check →
// Build → PENDING → submit → terminal emit. It knows nothing of AI, tiers, or
// documents.
//
// expectedFamily is the family the CALLER believes it invoked (off the wire
// envelope). It is an INTEGRITY check — "you invoked the verb you think you
// invoked" — not a policy gate: a non-empty value that disagrees with the
// registered command's Family() short-circuits to ERROR before Build, so the
// job is never submitted. An empty expectedFamily skips the check (tolerant
// floor, consistent with the plane's opportunistic-context principle).
//
// ctx arrives already built (NewContext) rather than as raw JSON: the envelope
// has TWO context-bearing fields — the lens-authored `context` and the
// composer-authored `attachments` — and assembling them at the wire edge keeps
// "where a Context comes from" in one place instead of splitting it across the
// dispatcher's parameter list.
func (r *Registry) Dispatch(cmd, expectedFamily, text string, ctx Context, correlationID string, emit func(Outcome)) {
	c := r.lookup(cmd)
	if c == nil {
		emit(Outcome{Status: StatusError, Err: "unknown command: /" + cmd})
		return
	}
	if expectedFamily != "" && expectedFamily != c.Family() {
		emit(Outcome{Status: StatusError, Err: fmt.Sprintf(
			"family mismatch for /%s: sent %q, registered %q", cmd, expectedFamily, c.Family())})
		return
	}
	job, err := c.Build(text, ctx)
	if err != nil {
		emit(Outcome{Status: StatusError, Err: err.Error()})
		return
	}

	r.mu.RLock()
	eng := r.engine
	r.mu.RUnlock()

	if eng == nil {
		emit(Outcome{Status: StatusError, Err: "command engine uninitialized"})
		return
	}

	// Identity is stamped by the MECHANISM, not the command: attrs.id ==
	// correlationID == the JobEngine's JobID, so the frontend's stale-detection
	// can match this block against the server's active/queued job sets.
	job.Pending.stampIdentity(correlationID)
	emit(Outcome{Status: StatusPending, Block: job.Pending})

	eng.Submit(services.JobDescriptor{
		Category: Category,
		Meta:     domain.JobInfo{JobID: correlationID, Label: job.Label},
		Work:     func() (any, error) { return job.Work() },
		OnFinished: func(res any) {
			out := Outcome{Status: StatusComplete}
			if b, ok := res.(Block); ok && b.Kind != "" {
				b.stampIdentity(correlationID)
				out.Block = &b
			}
			emit(out)
		},
		OnError: func(err error) {
			emit(Outcome{Status: StatusError, Err: err.Error()})
		},
	})
}

func (r *Registry) Cancel(correlationID string) {
	r.mu.RLock()
	eng := r.engine
	r.mu.RUnlock()
	if eng != nil {
		eng.Cancel(correlationID)
	}
}
