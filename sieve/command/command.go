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

type Outcome struct { // wire-blind: WsHandler maps this to command-result frames
	Status string
	Block  *Block
	Err    string
}

type Info struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// Command is one registered verb. Implementations are STATELESS SINGLETONS:
// immutable dependencies injected at the composition root; ALL per-request
// state flows through Build's args and the returned Job's closures. Build
// validates the command's OWN preconditions and fails fast — a Build error
// becomes an immediate ERROR result. The dispatcher enforces nothing per-command.
type Command interface {
	Name() string
	Description() string
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
// the tool" applied to the dispatcher itself: lookup → Build → PENDING →
// submit → terminal emit. It knows nothing of AI, tiers, or documents.
func (r *Registry) Dispatch(cmd, text string, rawCtx json.RawMessage, correlationID string, emit func(Outcome)) {
	c := r.lookup(cmd)
	if c == nil {
		emit(Outcome{Status: StatusError, Err: "unknown command: /" + cmd})
		return
	}
	job, err := c.Build(text, NewContext(rawCtx))
	if err != nil {
		emit(Outcome{Status: StatusError, Err: err.Error()})
		return
	}
	emit(Outcome{Status: StatusPending, Block: job.Pending})

	r.mu.RLock()
	eng := r.engine
	r.mu.RUnlock()

	if eng == nil {
		emit(Outcome{Status: StatusError, Err: "command engine uninitialized"})
		return
	}

	eng.Submit(services.JobDescriptor{
		Category: Category,
		Meta:     services.JobInfo{JobID: correlationID, Label: job.Label},
		Work:     func() (any, error) { return job.Work() },
		OnFinished: func(res any) {
			out := Outcome{Status: StatusComplete}
			if b, ok := res.(Block); ok && b.Kind != "" {
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
