package command

import (
	"errors"
	"strings"
	"testing"
	"time"

	"sieve/sieve/services"
)

type fakeCommand struct {
	name   string
	family string
	build  func(text string, ctx Context) (Job, error)
}

func (f *fakeCommand) Name() string        { return f.name }
func (f *fakeCommand) Description() string { return "fake command" }
func (f *fakeCommand) Family() string      { return f.family }
func (f *fakeCommand) ResultKind() string  { return "ai-block" }
func (f *fakeCommand) Build(text string, ctx Context) (Job, error) {
	if f.build != nil {
		return f.build(text, ctx)
	}
	return Job{}, nil
}

func testRegistry(t *testing.T) *Registry {
	t.Helper()
	r := NewRegistry()
	tr := services.NewJobTracker()
	eng := services.NewJobEngine(map[string]int{Category: 1}, 1, tr)
	r.SetEngine(eng)
	return r
}

func collector() (func(Outcome), chan Outcome) {
	ch := make(chan Outcome, 8)
	return func(o Outcome) { ch <- o }, ch
}

func TestDispatch_PendingThenComplete(t *testing.T) {
	r := testRegistry(t)
	r.Register(&fakeCommand{name: "echo", build: func(text string, _ Context) (Job, error) {
		pend := &Block{Kind: "ai-block", Attrs: map[string]interface{}{"status": "PENDING", "question": text}}
		return Job{
			Label:   "/echo",
			Pending: pend,
			Work: func() (Block, error) {
				return Block{Kind: "ai-block", Attrs: map[string]interface{}{"status": "COMPLETE", "response": text}}, nil
			},
		}, nil
	}})

	emit, ch := collector()
	r.Dispatch("echo", "", "hi", NewContext(nil, nil), "c-1", emit)

	first := <-ch
	if first.Status != StatusPending || first.Block == nil {
		t.Fatalf("want PENDING+block first, got %+v", first)
	}
	second := <-ch
	if second.Status != StatusComplete || second.Block == nil || second.Block.Attrs["response"] != "hi" {
		t.Fatalf("want COMPLETE, got %+v", second)
	}
}

func TestDispatch_StampsCorrelationIDAsBlockID(t *testing.T) {
	r := testRegistry(t)
	// Command invents NO id — the dispatcher owns identity so attrs.id ==
	// correlationID == the JobEngine's JobID (frontend stale-detection contract).
	r.Register(&fakeCommand{name: "echo", build: func(text string, _ Context) (Job, error) {
		return Job{
			Label:   "/echo",
			Pending: &Block{Kind: "ai-block", Attrs: map[string]interface{}{"status": "PENDING"}},
			Work: func() (Block, error) {
				return Block{Kind: "ai-block", Attrs: map[string]interface{}{"status": "COMPLETE"}}, nil
			},
		}, nil
	}})

	emit, ch := collector()
	r.Dispatch("echo", "", "hi", NewContext(nil, nil), "corr-42", emit)

	pending := <-ch
	if pending.Status != StatusPending || pending.Block == nil {
		t.Fatalf("want PENDING+block, got %+v", pending)
	}
	if pending.Block.Attrs["id"] != "corr-42" {
		t.Fatalf("pending block id = %v, want correlationID corr-42", pending.Block.Attrs["id"])
	}

	terminal := <-ch
	if terminal.Status != StatusComplete || terminal.Block == nil {
		t.Fatalf("want COMPLETE+block, got %+v", terminal)
	}
	if terminal.Block.Attrs["id"] != "corr-42" {
		t.Fatalf("terminal block id = %v, want correlationID corr-42", terminal.Block.Attrs["id"])
	}
}

func TestDispatch_UnknownCommand(t *testing.T) {
	r := testRegistry(t)
	emit, ch := collector()
	r.Dispatch("nope", "", "text", NewContext(nil, nil), "c-1", emit)

	out := <-ch
	if out.Status != StatusError || !strings.Contains(out.Err, "unknown command") {
		t.Fatalf("expected unknown command error, got %+v", out)
	}
}

func TestDispatch_BuildErrorFailsFast(t *testing.T) {
	r := testRegistry(t)
	r.Register(&fakeCommand{name: "failbuild", build: func(text string, _ Context) (Job, error) {
		return Job{}, errors.New("tier dumb fail fast")
	}})

	emit, ch := collector()
	r.Dispatch("failbuild", "", "text", NewContext(nil, nil), "c-1", emit)

	out := <-ch
	if out.Status != StatusError || out.Err != "tier dumb fail fast" {
		t.Fatalf("expected immediate build error, got %+v", out)
	}
	select {
	case unexpected := <-ch:
		t.Fatalf("unexpected outcome after build error: %+v", unexpected)
	default:
	}
}

func TestDispatch_EffectOnlyCommand(t *testing.T) {
	r := testRegistry(t)
	r.Register(&fakeCommand{name: "sideeffect", build: func(text string, _ Context) (Job, error) {
		return Job{
			Label:   "/sideeffect",
			Pending: nil,
			Work: func() (Block, error) {
				return Block{}, nil
			},
		}, nil
	}})

	emit, ch := collector()
	r.Dispatch("sideeffect", "", "text", NewContext(nil, nil), "c-1", emit)

	first := <-ch
	if first.Status != StatusPending || first.Block != nil {
		t.Fatalf("want PENDING with nil Block, got %+v", first)
	}
	second := <-ch
	if second.Status != StatusComplete || second.Block != nil {
		t.Fatalf("want COMPLETE with nil Block, got %+v", second)
	}
}

func TestDispatch_WorkErrorEmitsError(t *testing.T) {
	r := testRegistry(t)
	r.Register(&fakeCommand{name: "workfail", build: func(text string, _ Context) (Job, error) {
		return Job{
			Label:   "/workfail",
			Pending: &Block{Kind: "ai-block", Attrs: map[string]interface{}{"status": "PENDING"}},
			Work: func() (Block, error) {
				return Block{}, errors.New("execution failed")
			},
		}, nil
	}})

	emit, ch := collector()
	r.Dispatch("workfail", "", "text", NewContext(nil, nil), "c-1", emit)

	first := <-ch
	if first.Status != StatusPending {
		t.Fatalf("want PENDING first, got %+v", first)
	}
	second := <-ch
	if second.Status != StatusError || second.Err != "execution failed" {
		t.Fatalf("want ERROR with execution error, got %+v", second)
	}
}

func TestDispatch_ConcurrentCorrelationsDisjoint(t *testing.T) {
	r := testRegistry(t)
	gate := make(chan struct{})
	r.Register(&fakeCommand{name: "gated", build: func(text string, _ Context) (Job, error) {
		return Job{
			Label:   "/gated",
			Pending: &Block{Kind: "ai-block"},
			Work: func() (Block, error) {
				<-gate
				return Block{Kind: "ai-block", Attrs: map[string]interface{}{"val": text}}, nil
			},
		}, nil
	}})

	emit1, ch1 := collector()
	emit2, ch2 := collector()

	r.Dispatch("gated", "", "first", NewContext(nil, nil), "c-1", emit1)
	r.Dispatch("gated", "", "second", NewContext(nil, nil), "c-2", emit2)

	p1 := <-ch1
	p2 := <-ch2
	if p1.Status != StatusPending || p2.Status != StatusPending {
		t.Fatalf("expected both PENDING")
	}

	close(gate)

	c1 := <-ch1
	c2 := <-ch2

	if c1.Block.Attrs["val"] != "first" {
		t.Fatalf("ch1 got wrong block: %+v", c1)
	}
	if c2.Block.Attrs["val"] != "second" {
		t.Fatalf("ch2 got wrong block: %+v", c2)
	}
}

func TestCancel_DropsResult(t *testing.T) {
	r := testRegistry(t)
	gate := make(chan struct{})
	r.Register(&fakeCommand{name: "gated", build: func(text string, _ Context) (Job, error) {
		return Job{
			Label:   "/gated",
			Pending: &Block{Kind: "ai-block"},
			Work: func() (Block, error) {
				<-gate
				return Block{Kind: "ai-block"}, nil
			},
		}, nil
	}})

	emit, ch := collector()
	r.Dispatch("gated", "", "text", NewContext(nil, nil), "c-1", emit)

	p := <-ch
	if p.Status != StatusPending {
		t.Fatalf("expected PENDING first")
	}

	r.Cancel("c-1")
	close(gate)

	// After cancellation, no COMPLETE frame should arrive
	select {
	case out := <-ch:
		t.Fatalf("expected NO outcome after cancellation, got %+v", out)
	case <-time.After(100 * time.Millisecond):
		// Success
	}
}

func TestNewContext_TypedCoreAndFloor(t *testing.T) {
	ctx := NewContext([]byte(`{"docUuid":"u1","selectedText":"sel","blockId":"b1","blockIds":["b1","b2"],"extra":{"lens":"note"}}`), nil)
	if ctx.DocUUID != "u1" || ctx.SelectedText != "sel" || ctx.BlockID != "b1" || len(ctx.BlockIDs) != 2 {
		t.Fatalf("typed context fields not populated: %+v", ctx)
	}
	if ctx.Raw["extra"] == nil {
		t.Fatalf("raw map missing extra field: %+v", ctx.Raw)
	}

	empty := NewContext(nil, nil)
	if empty.DocUUID != "" || empty.Raw == nil {
		t.Fatalf("nil raw context floor failure: %+v", empty)
	}

	bad := NewContext([]byte(`not-json`), nil)
	if bad.DocUUID != "" || bad.Raw == nil {
		t.Fatalf("bad raw context floor failure: %+v", bad)
	}
}

func TestRegistry_ListPreservesOrder(t *testing.T) {
	r := NewRegistry()
	r.Register(&fakeCommand{name: "alpha"})
	r.Register(&fakeCommand{name: "beta"})
	list := r.List()
	if len(list) != 2 || list[0].Name != "alpha" || list[1].Name != "beta" {
		t.Fatalf("List returned unexpected order/content: %+v", list)
	}
}

func TestRegistry_ListIncludesFamilyAndResultKind(t *testing.T) {
	r := NewRegistry()
	r.Register(&fakeCommand{name: "alpha", family: FamilyUtil})
	list := r.List()
	if len(list) != 1 {
		t.Fatalf("expected one Info, got %d", len(list))
	}
	if list[0].Family != FamilyUtil {
		t.Fatalf("Info.Family = %q, want %q", list[0].Family, FamilyUtil)
	}
	// fakeCommand advertises ResultKind "ai-block" — the enrichment must reach Info.
	if list[0].ResultKind != "ai-block" {
		t.Fatalf("Info.ResultKind = %q, want ai-block", list[0].ResultKind)
	}
}

func TestDispatch_FamilyMatchProceeds(t *testing.T) {
	r := testRegistry(t)
	r.Register(&fakeCommand{name: "util-cmd", family: FamilyUtil, build: func(text string, _ Context) (Job, error) {
		return Job{
			Label:   "/util-cmd",
			Pending: &Block{Kind: "command-result", Attrs: map[string]interface{}{"status": "PENDING"}},
			Work: func() (Block, error) {
				return Block{Kind: "command-result", Attrs: map[string]interface{}{"status": "COMPLETE"}}, nil
			},
		}, nil
	}})

	emit, ch := collector()
	r.Dispatch("util-cmd", FamilyUtil, "x", NewContext(nil, nil), "c-1", emit)

	first := <-ch
	if first.Status != StatusPending {
		t.Fatalf("want PENDING (family matched), got %+v", first)
	}
	second := <-ch
	if second.Status != StatusComplete {
		t.Fatalf("want COMPLETE (family matched), got %+v", second)
	}
}

func TestDispatch_FamilyMismatchErrorsBeforeSubmit(t *testing.T) {
	r := testRegistry(t)
	built := false
	r.Register(&fakeCommand{name: "util-cmd", family: FamilyUtil, build: func(text string, _ Context) (Job, error) {
		built = true // must NEVER run — mismatch short-circuits before Build
		return Job{Label: "/util-cmd", Pending: &Block{Kind: "command-result"},
			Work: func() (Block, error) { return Block{Kind: "command-result"}, nil }}, nil
	}})

	emit, ch := collector()
	r.Dispatch("util-cmd", FamilyAI, "x", NewContext(nil, nil), "c-1", emit)

	out := <-ch
	if out.Status != StatusError || !strings.Contains(out.Err, "family mismatch") {
		t.Fatalf("want family-mismatch ERROR, got %+v", out)
	}
	if built {
		t.Fatalf("Build ran despite family mismatch — job must never be submitted")
	}
	// No PENDING/COMPLETE follows a mismatch.
	select {
	case unexpected := <-ch:
		t.Fatalf("unexpected outcome after mismatch: %+v", unexpected)
	default:
	}
}

func TestDispatch_EmptyFamilyIsTolerant(t *testing.T) {
	r := testRegistry(t)
	r.Register(&fakeCommand{name: "util-cmd", family: FamilyUtil, build: func(text string, _ Context) (Job, error) {
		return Job{
			Label:   "/util-cmd",
			Pending: &Block{Kind: "command-result", Attrs: map[string]interface{}{"status": "PENDING"}},
			Work: func() (Block, error) {
				return Block{Kind: "command-result", Attrs: map[string]interface{}{"status": "COMPLETE"}}, nil
			},
		}, nil
	}})

	emit, ch := collector()
	// Empty expectedFamily skips the integrity check even though the command is util.
	r.Dispatch("util-cmd", "", "x", NewContext(nil, nil), "c-1", emit)

	first := <-ch
	if first.Status != StatusPending {
		t.Fatalf("want PENDING (empty family tolerant), got %+v", first)
	}
	second := <-ch
	if second.Status != StatusComplete {
		t.Fatalf("want COMPLETE (empty family tolerant), got %+v", second)
	}
}
