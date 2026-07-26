package command

import (
	"encoding/json"
	"fmt"
	"sync"

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

// Context is the Go-side read of the lens-authored SelectionContext: a typed
// core + the full tolerant bag. Commands read fields OPPORTUNISTICALLY and
// never require them; a bad or absent context decodes to the empty floor.
type Context struct {
	DocUUID      string                 `json:"docUuid"`
	SelectedText string                 `json:"selectedText"`
	BlockID      string                 `json:"blockId"`
	BlockIDs     []string               `json:"blockIds"`
	Raw          map[string]interface{} // everything the lens sent, untyped
}

func NewContext(raw json.RawMessage) Context {
	ctx := Context{Raw: make(map[string]interface{})}
	if len(raw) == 0 {
		return ctx
	}
	_ = json.Unmarshal(raw, &ctx.Raw)
	_ = json.Unmarshal(raw, &ctx)
	if ctx.Raw == nil {
		ctx.Raw = make(map[string]interface{})
	}
	return ctx
}

type Block struct {
	Kind  string                 `json:"kind"`
	Attrs map[string]interface{} `json:"attrs"`
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
func (r *Registry) Dispatch(cmd, expectedFamily, text string, rawCtx json.RawMessage, correlationID string, emit func(Outcome)) {
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
	job, err := c.Build(text, NewContext(rawCtx))
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
		Meta:     services.JobInfo{JobID: correlationID, Label: job.Label},
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
