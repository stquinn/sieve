# Ask Panel Slash Commands + `/btw` — Implementation Plan (#55)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

*2026-07-26 · Tracked: #55 · Spec: `docs/design/specs/2026-07-23-ask-panel-slash-commands-btw.md` (read it first — including its 8 amendment notes already folded in: no `sink` on the wire, verbatim `SelectionContext`, badge↔correlationId 1:1, Hide vs Delete exit verbs).*

**Goal:** The Ask panel becomes a command line: `/btw <question>` dispatches a Go-registered AI command as a standard job over a new session-level WS channel and renders the detached ai-block answer in a status-bar-badge-summoned popup — without ever touching the document.

**Architecture:** A reserved session WS channel joins the per-uuid doc channels in `WsHandler`; a Go `command.Registry` (new leaf package `sieve/command` — pure mechanism, AI commands merely its first tenant) routes `Command` envelopes to stateless command declarations that build standard `JobEngine` jobs producing block envelopes; results return correlated (`correlationId`) as `CommandResult` frames. Frontend: a `CommandService` peer beside `BlockService`/`DocumentService` owns the new wire family; the Ask panel parses the door; a `CommandBadges` + `CommandPopup` pair renders the detached block via the existing PM-free `AiBlockRenderer` (its third host).

**Tech stack:** Go (chi, gorilla/websocket, html/template), vanilla JS ES classes (`// @ts-check` + JSDoc), vitest (happy-dom), existing in-process Go WS test harness.

## Global Constraints

- **Backend is the document source of truth**; `/btw` is *standalone* — its block must NEVER enter the ShadowDoc, and nothing on this path may call `softReloadContent` or any doc-channel op.
- **Mechanism on the wire, policy in the tool**: the envelope carries `{family, cmd, args:{text}, correlationId, context}` — NO `sink` field, NO op-shaped args. `SelectionContext` is sent **verbatim** (the D-5 send==shown object, `ask-panel.js` `#lastContext`).
- **Context invariants**: Go commands read context fields *opportunistically, never requiring them*; the floor is the empty context — `/btw` with no open tab must work.
- **Correlated command jobs MUST register in the JobTracker like every other job** (the Job Engine Viewer obligation, `docs/design/extension-job-engine-viewer.md`).
- Prompt placeholders are **single-brace** (`{question}`, `{selection}`, …) — the codebase's `strings.ReplaceAll` convention (`ai_service.go:162-165`), not the spec's illustrative `{{…}}`.
- **Tests never exec CLIs** — stub `CLIRunner` (`captureRunner` pattern, `sieve/ai/ai_service_containment_test.go:178-190`). Run Go tests as `CGO_ENABLED=0 go test ./...`.
- New JS is idiomatic per `docs/how-to-idiomatic-js.md`: one class per file, `#private` fields, `// @ts-check` + JSDoc typedefs on public contracts, frozen value objects, typed `onX(fn)` registration (no new `window.*`, no DOM CustomEvents), singletons constructed at the workspace composition root and handed down.
- All CSS colours via `--theme-*` vars; no hardcoded hex/rgba.
- No React, no new heavy npm deps.
- Commit messages carry NO Co-Authored-By trailer.
- Run everything through the nix flake: `nix develop -c <cmd>`.

## Out of scope (per issue #55)

`/diagram` and additive-sink commands; promote-to-doc button; fuzzy/keyboard-navigable palette; Q&A history/persistence; the workspace-command-plane migration (this issue must merely not preclude it — hence `family` on the envelope from day one).

---

## File Structure

**Go — create:**
- `sieve/command/command.go` — package `command` (dispatcher is MECHANISM; per-command policy lives in `Build`): `Context`, `Block`, `Outcome` (+ status consts), `Info`, `Command` interface, `Job`, `Registry`, `Category`. DAG position: imports `services` only; `ai` imports `command` to implement its commands (`domain ← block ← {processors, services} ← command ← ai ← root`)
- `sieve/ai/btw_command.go` — `BtwCommand` (implements `command.Command`; owns the AI tier gate)
- `sieve/command/registry_test.go`, `sieve/ai/btw_command_test.go`, `sieve/ai/ai_service_btw_test.go`
- `requesthandlers/ws_session_test.go`, `requesthandlers/ws_command_test.go`
- `sieve/services/job_engine_cancel_test.go`

**Go — modify:**
- `requesthandlers/ws_handler.go` — session-mode branch, `sessionChannelKey`, `handleSessionWS`, `handleCommand`, `handleCommandCancel`
- `sieve/services/job_engine.go` — best-effort `Cancel(jobID)`
- `sieve/ai/ai_service.go` — `RunBtw` + `Tier()` accessor
- `sieve/ai/prompts.go` — `DefaultBtwPrompt` + `btw` in the name→default mapping + `ListPrompts` entry
- `sieve/service_provider.go` — `Commands *command.Registry` field, construction + per-command dep injection, `command.Category` pool size
- `handlers.go` — `Commands template.JS` boot field

**JS — create:**
- `frontend/src/static/block/block-channel.js` — `BlockChannel` extracted verbatim from `block-service.js`
- `frontend/src/static/block/command-service.js` — `CommandService`
- `frontend/src/static/shell/command-hint-popover.js` — `CommandHintPopover`
- `frontend/src/static/shell/command-badges.js` — `CommandBadges`
- `frontend/src/static/shell/command-popup.js` — `CommandPopup`
- `frontend/test/command-service.test.js`, `command-hint-popover.test.js`, `command-badges.test.js`, `command-popup.test.js`

**JS/HTML — modify:**
- `frontend/src/static/block/block-service.js` (import BlockChannel), `shell/ask-panel.js` (three doors), `shell/workspace.js` (composition root wiring), `block/renderers/ai-block-renderer.js` (BTW badge label), `ai/ai-actions.js` (filter `category === "commands"`), `frontend/src/index.html` (boot global, `.ask-popup__error`, `.status-bar__command-badges` slot), status-bar/ask-panel CSS file (locate via `grep -rn "status-bar__jobs" frontend/src/static/`), `frontend/test/ask-panel.test.js`, `frontend/test/ai-block-renderer.test.js`, `frontend/test/jobs-snapshot.test.js`

**Wire protocol (frozen here, referenced by every task):**

```
→ { type: "command", family: "ai", cmd: "btw", args: { text: "…" },
    correlationId: "c-1", context: <SelectionContext verbatim | {}> }
← { type: "command-result", correlationId: "c-1", cmd: "btw",
    status: "PENDING"|"COMPLETE"|"ERROR",
    block?: { kind: "ai-block", attrs: {…} },   // PENDING carries the initial envelope; COMPLETE the final one
    error?: "…" }
→ { type: "command-cancel", correlationId: "c-1" }
```

---

### Task 1: Session WS channel (Go)

**Files:**
- Modify: `requesthandlers/ws_handler.go`
- Test: `requesthandlers/ws_session_test.go`

**Interfaces:**
- Consumes: existing `register`/`unregister`/`sendTo` (`ws_handler.go:48-111`).
- Produces: `const sessionChannelKey = "__session__"`; `GET /api/ws?session=1` upgrades to a session channel registered under `sessionChannelKey` in the SAME `channels` map (so `sendTo(sessionChannelKey, v)` works unchanged); `handleSessionWS(conn *websocket.Conn)`. No shadow open/close, no lifecycle listener, no claim-on-write (the session channel is a singleton per workspace; last-registered wins, teardown ownership-guarded exactly like doc channels — the 6e2ccfc lesson).

- [ ] **Step 1: Write the failing tests**

In `requesthandlers/ws_session_test.go` (package `requesthandlers`, reuse `newWsTestServer`/`dialWS`/`readFrame`/`closeAndSettle` from `ws_takeover_test.go:25-106` and `ws_ack_test.go:13-46` — adapt call shapes to those helpers exactly as written there):

```go
// Session socket connects with ?session=1 (no uuid), answers ping with pong,
// and opens NO shadow document.
func TestWS_SessionChannel_PingPong_NoShadow(t *testing.T) {
	srv, sp, _, wsURL := newWsTestServer(t)
	_ = srv
	conn := dialWS(t, wsURL+"?session=1")
	defer conn.Close()
	if err := conn.WriteJSON(map[string]string{"type": "ping"}); err != nil {
		t.Fatal(err)
	}
	msg := readFrame(t, conn)
	if msg["type"] != "pong" {
		t.Fatalf("want pong, got %v", msg)
	}
	// No shadow was opened for the sentinel key.
	if sp.Editor.IsOpen(sessionChannelKey) { // use the harness's existing open-shadow probe; if none exists, assert via Editor state the same way ws_takeover_test.go does
		t.Fatal("session channel must not open a shadow")
	}
}

// Render-backs to the session key land on the CURRENT session socket; a stale
// predecessor's teardown must not evict the successor (ownership guard).
func TestWS_SessionChannel_SuccessorOwnsChannel(t *testing.T) {
	srv, _, h, wsURL := newWsTestServer(t)
	_ = srv
	c1 := dialWS(t, wsURL+"?session=1")
	c2 := dialWS(t, wsURL+"?session=1") // successor registers over c1
	defer c2.Close()
	c1.Close() // stale teardown — must NOT unregister c2
	closeAndSettle(t, c1)
	h.sendTo(sessionChannelKey, map[string]string{"type": "command-result", "correlationId": "c-x", "status": "PENDING"})
	msg := readFrame(t, c2)
	if msg["correlationId"] != "c-x" {
		t.Fatalf("successor did not receive session frame: %v", msg)
	}
}
```

Also assert `GET /api/ws` with neither `uuid` nor `session=1` still 400s (existing behaviour preserved).

- [ ] **Step 2: Run tests to verify they fail**

Run: `nix develop -c bash -c "CGO_ENABLED=0 go test ./requesthandlers/ -run TestWS_SessionChannel -v"`
Expected: FAIL — `sessionChannelKey` undefined / 400 on `?session=1`.

- [ ] **Step 3: Implement session mode in `ws_handler.go`**

```go
// sessionChannelKey is the reserved workspace channel — the session command
// plane's seed (#55). It lives in the SAME channels map as the per-uuid doc
// channels so sendTo() is the one render-back path; the sentinel can never
// collide with a real uuid. No shadow, no claim-on-write: commands are
// workspace traffic, not doc mutations.
const sessionChannelKey = "__session__"
```

At the top of `handleWS` (`ws_handler.go:117`), before the uuid check:

```go
if r.URL.Query().Get("session") == "1" {
	h.handleSessionWS(w, r)
	return
}
```

`handleSessionWS` mirrors `handleWS`'s upgrade + mutex-guarded `writeMsg` closure (`:124-148`) verbatim, then:

```go
ch := &wsConn{write: writeMsg}
h.register(sessionChannelKey, ch)
defer func() {
	h.unregister(sessionChannelKey, ch) // ownership-guarded; no shadow to close
	logger.Info("ws: session channel closed")
}()

for {
	_, raw, err := conn.ReadMessage()
	if err != nil {
		break
	}
	var msg struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		continue
	}
	switch msg.Type {
	case "ping":
		writeMsg(map[string]string{"type": "pong"})
	case "command":
		h.handleCommand(raw) // stub in this task: no-op; implemented in Task 5
	case "command-cancel":
		h.handleCommandCancel(raw) // stub; Task 5
	}
}
```

Add empty `handleCommand(raw []byte)` / `handleCommandCancel(raw []byte)` stubs so this task compiles standalone.

- [ ] **Step 4: Run tests to verify they pass**

Run: `nix develop -c bash -c "CGO_ENABLED=0 go test ./requesthandlers/ -v"`
Expected: PASS, including all pre-existing takeover/ack tests.

- [ ] **Step 5: Commit**

```bash
git add requesthandlers/ws_handler.go requesthandlers/ws_session_test.go
git commit -m "feat(ws): reserved session channel beside per-uuid doc channels (#55)"
```

---

### Task 2: JobEngine best-effort cancellation (Go)

**Files:**
- Modify: `sieve/services/job_engine.go`
- Test: `sieve/services/job_engine_cancel_test.go`

**Interfaces:**
- Produces: `func (e *JobEngine) Cancel(jobID string)` — queued job: never runs, leaves the tracker; active job: callbacks (`OnFinished`/`OnError`) suppressed on completion. **v1 limitation (documented in code):** an in-flight CLI process is not interrupted — it runs to its own timeout; only its result is discarded. This is the "standard job-engine cancellation path" the spec's Delete verb calls; true process interruption is a follow-up.

- [ ] **Step 1: Write the failing tests**

```go
package services

import "testing"

func TestCancel_QueuedJobNeverRunsAndLeavesTracker(t *testing.T) {
	tr := NewJobTracker()
	e := NewJobEngine(map[string]int{"t": 1}, 1, tr)
	gate := make(chan struct{})
	e.Submit(JobDescriptor{Category: "t", Meta: JobInfo{JobID: "j1", Label: "hold"},
		Work: func() (any, error) { <-gate; return nil, nil }})
	ran := false
	e.Submit(JobDescriptor{Category: "t", Meta: JobInfo{JobID: "j2", Label: "victim"},
		Work: func() (any, error) { ran = true; return nil, nil },
		OnFinished: func(any) { ran = true }})
	e.Cancel("j2")
	close(gate)
	done := make(chan struct{})
	e.Submit(JobDescriptor{Category: "t", Meta: JobInfo{JobID: "j3", Label: "sentinel"},
		OnFinished: func(any) { close(done) }})
	<-done
	if ran {
		t.Fatal("cancelled queued job ran or fired callbacks")
	}
	if len(tr.Queued())+len(tr.Active()) != 0 {
		t.Fatalf("cancelled job stuck in tracker: q=%v a=%v", tr.Queued(), tr.Active())
	}
}

func TestCancel_ActiveJobCallbacksSuppressed(t *testing.T) {
	tr := NewJobTracker()
	e := NewJobEngine(map[string]int{"t": 1}, 1, tr)
	started := make(chan struct{})
	release := make(chan struct{})
	fired := false
	finished := make(chan struct{})
	e.Submit(JobDescriptor{Category: "t", Meta: JobInfo{JobID: "j1", Label: "x"},
		Work:       func() (any, error) { close(started); <-release; return "r", nil },
		OnFinished: func(any) { fired = true }})
	<-started
	e.Cancel("j1")
	close(release)
	e.Submit(JobDescriptor{Category: "t", Meta: JobInfo{JobID: "j2", Label: "sentinel"},
		OnFinished: func(any) { close(finished) }})
	<-finished
	if fired {
		t.Fatal("cancelled active job's OnFinished fired")
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `nix develop -c bash -c "CGO_ENABLED=0 go test ./sieve/services/ -run TestCancel -v"`
Expected: FAIL — `e.Cancel` undefined.

- [ ] **Step 3: Implement**

In `job_engine.go`: add `cancelled sync.Map` to `JobEngine` (import `sync` is present).

```go
// Cancel marks jobID cancelled, best-effort: a still-queued job never runs
// (skipped at drain, removed from the tracker); an active job completes its
// Work — an in-flight CLI process is NOT interrupted, it runs to its own
// timeout — but its OnFinished/OnError are suppressed and the result dropped.
func (e *JobEngine) Cancel(jobID string) {
	e.cancelled.Store(jobID, struct{}{})
}

func (e *JobEngine) takeCancelled(jobID string) bool {
	_, ok := e.cancelled.LoadAndDelete(jobID)
	return ok
}
```

Rework `run` (`job_engine.go:67-84`):

```go
func (e *JobEngine) run(d JobDescriptor) {
	if e.takeCancelled(d.Meta.JobID) { // cancelled while queued: never run
		if e.tracker != nil {
			e.tracker.Finish(d.Meta.JobID)
		}
		return
	}
	if e.tracker != nil {
		e.tracker.Activate(d.Meta.JobID)
	}
	result, err := e.safeWork(d.Work)
	if e.tracker != nil {
		e.tracker.Finish(d.Meta.JobID)
	}
	if e.takeCancelled(d.Meta.JobID) { // cancelled while active: drop the result
		return
	}
	if err != nil {
		if d.OnError != nil {
			d.OnError(err)
		}
		return
	}
	if d.OnFinished != nil {
		d.OnFinished(result)
	}
}
```

(If `JobTracker.Finish` is not already a no-op for unknown ids, make it one — check `job_tracker.go:57-70`.)

- [ ] **Step 4: Run tests** — `nix develop -c bash -c "CGO_ENABLED=0 go test ./sieve/services/ -v"` — PASS, including existing engine/tracker tests.

- [ ] **Step 5: Commit**

```bash
git add sieve/services/job_engine.go sieve/services/job_engine_cancel_test.go
git commit -m "feat(jobs): best-effort Cancel on the JobEngine (#55)"
```

---

### Task 3: `sieve/command` — generic registry, dispatcher is mechanism (Go)

**Files:**
- Create: `sieve/command/command.go`
- Test: `sieve/command/registry_test.go`

**Interfaces:**
- Consumes: `services.JobEngine.Submit/Cancel` (Task 2). **Nothing AI-shaped** — no StateService, no tier, no domain import: the dispatcher must run a hypothetical non-AI `/weather` command (HTTP-client dep, no CLI) unchanged.
- Produces (used by Tasks 4/5/6):

```go
package command

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
	DocUUID      string
	SelectedText string
	BlockID      string
	BlockIDs     []string
	Raw          map[string]interface{} // everything the lens sent, untyped
}
func NewContext(raw json.RawMessage) Context

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
// validates the command's OWN preconditions (an AI command gates on tier, a
// network command on connectivity) and fails fast — a Build error becomes an
// immediate ERROR result. The dispatcher enforces nothing per-command.
type Command interface {
	Name() string
	Description() string
	// Build turns raw arg text + context into a job. Pending is the initial
	// detached block envelope the PENDING result carries (nil for effect-only
	// / additive commands); Work returns the final envelope (zero Block for
	// effect-only commands — COMPLETE then carries no block).
	Build(text string, ctx Context) (Job, error)
}
type Job struct {
	Label   string
	Pending *Block
	Work    func() (Block, error)
}

type Registry struct { /* engine *services.JobEngine; mu; cmds map[string]Command; order []string */ }
func NewRegistry() *Registry
func (r *Registry) SetEngine(e *services.JobEngine) // engine is built later in Init, like EditorService's SetEngine
func (r *Registry) Register(c Command)
func (r *Registry) List() []Info // registration order
func (r *Registry) Dispatch(cmd, text string, rawCtx json.RawMessage, correlationID string, emit func(Outcome))
func (r *Registry) Cancel(correlationID string) // JobID == correlationID, passes straight to engine.Cancel
```

- [ ] **Step 1: Write the failing tests**

`registry_test.go` (package `command`). Define a fake command in the test file:

```go
type fakeCommand struct {
	name  string
	build func(text string, ctx Context) (Job, error)
}
func (f *fakeCommand) Name() string        { return f.name }
func (f *fakeCommand) Description() string { return "fake" }
func (f *fakeCommand) Build(text string, ctx Context) (Job, error) {
	return f.build(text, ctx)
}
```

Tests (construct `r := NewRegistry()` + `r.SetEngine(services.NewJobEngine(nil, 1, services.NewJobTracker()))` — note NO settings/state fixture: the registry is policy-free by construction):

```go
// collect gathers outcomes; emit is called from dispatch AND worker goroutines.
func collector() (func(Outcome), chan Outcome) {
	ch := make(chan Outcome, 8)
	return func(o Outcome) { ch <- o }, ch
}

func TestDispatch_PendingThenComplete(t *testing.T) {
	r := testRegistry(t) // helper: NewRegistry + real single-worker engine
	r.Register(&fakeCommand{name: "echo", build: func(text string, _ Context) (Job, error) {
		pend := &Block{Kind: "ai-block", Attrs: map[string]interface{}{"status": "PENDING", "question": text}}
		return Job{Label: "/echo", Pending: pend, Work: func() (Block, error) {
			return Block{Kind: "ai-block", Attrs: map[string]interface{}{"status": "COMPLETE", "response": text}}, nil
		}}, nil
	}})
	emit, ch := collector()
	r.Dispatch("echo", "hi", nil, "c-1", emit)
	first, second := <-ch, <-ch
	if first.Status != StatusPending || first.Block == nil {
		t.Fatalf("want PENDING+block first, got %+v", first)
	}
	if second.Status != StatusComplete || second.Block.Attrs["response"] != "hi" {
		t.Fatalf("want COMPLETE, got %+v", second)
	}
}

func TestDispatch_UnknownCommand(t *testing.T)     // → single ERROR outcome, Err contains "unknown command"
func TestDispatch_BuildErrorFailsFast(t *testing.T) // Build returns error (the command's OWN precondition — e.g. an AI command's tier gate) → single immediate ERROR, NO PENDING, no job submitted (engine tracker stays empty)
func TestDispatch_EffectOnlyCommand(t *testing.T)   // Pending nil + Work returns zero Block → PENDING without block, COMPLETE without block (the additive-command shape)
func TestDispatch_WorkErrorEmitsError(t *testing.T) // Work returns error → PENDING then ERROR with Err set
func TestDispatch_ConcurrentCorrelationsDisjoint(t *testing.T) // two dispatches c-1/c-2, gated Work; each emit closure only ever sees its own correlation's outcomes (pass distinct emit closures; assert counts)
func TestCancel_DropsResult(t *testing.T)          // dispatch with gated Work; Cancel("c-1"); release; assert no COMPLETE arrives after PENDING
func TestNewContext_TypedCoreAndFloor(t *testing.T) {
	ctx := NewContext([]byte(`{"docUuid":"u1","selectedText":"sel","blockId":"b1","blockIds":["b1","b2"],"extra":{"lens":"note"}}`))
	// assert DocUUID/SelectedText/BlockID/BlockIDs populated and Raw["extra"] present
	empty := NewContext(nil)          // zero value
	bad := NewContext([]byte(`nope`)) // tolerant: zero value, no error
	_ = empty; _ = bad
}
```

- [ ] **Step 2: Run to verify failure** — `nix develop -c bash -c "CGO_ENABLED=0 go test ./sieve/command/ -v"` — FAIL (types undefined).

- [ ] **Step 3: Implement `command.go`**

Dispatch body (the load-bearing part):

```go
// Dispatch is pure MECHANISM — the spec's "mechanism on the wire, policy in
// the tool" applied to the dispatcher itself: lookup → Build → PENDING →
// submit → terminal emit. It knows nothing of AI, tiers, or documents; a
// command validates its OWN preconditions inside Build (fail-fast → immediate
// ERROR result) and carries its own dependencies from the composition root.
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
	emit(Outcome{Status: StatusPending, Block: job.Pending}) // nil Block for effect-only (additive) commands
	// JobID == correlationID: Cancel() passes straight through, and the
	// correlated job is in the JobTracker like every other job (the Job
	// Engine Viewer obligation).
	r.engine.Submit(services.JobDescriptor{
		Category: Category,
		Meta:     services.JobInfo{JobID: correlationID, Label: job.Label},
		Work:     func() (any, error) { return job.Work() },
		OnFinished: func(res any) {
			out := Outcome{Status: StatusComplete}
			if b, ok := res.(Block); ok && b.Kind != "" { // zero Block = effect-only: COMPLETE without payload
				out.Block = &b
			}
			emit(out)
		},
		OnError: func(err error) {
			emit(Outcome{Status: StatusError, Err: err.Error()})
		},
	})
}
```

`NewContext`: unmarshal the typed core (`docUuid`/`selectedText`/`blockId`/`blockIds` JSON keys — the SelectionContext field names in `frontend/src/static/editor/selection-model.js:50-63`) AND the full map into `Raw`; any unmarshal error returns the zero value (empty floor). `Register` guards duplicate names (panic — registration is composition-root code). `List` returns registration order.

- [ ] **Step 4: Run tests** — `nix develop -c bash -c "CGO_ENABLED=0 go test ./sieve/command/ -v"` — PASS.

- [ ] **Step 5: Commit**

```bash
git add sieve/command/command.go sieve/command/registry_test.go
git commit -m "feat(command): generic command registry — dispatch is mechanism, policy lives in Build (#55)"
```

---

### Task 4: `/btw` command, `btw` prompt, `AIService.RunBtw` (Go)

**Files:**
- Modify: `sieve/ai/prompts.go`, `sieve/ai/ai_service.go`
- Create: `sieve/ai/btw_command.go`
- Test: `sieve/ai/ai_service_btw_test.go`, `sieve/ai/btw_command_test.go`

**Interfaces:**
- Consumes: `command.Context`/`command.Job`/`command.Block` (Task 3), `block.GetProcessor("ai-block").InitAttrs` (`processor_registry.go:476/256`), `block.GenerateBlockID("ai-block")` (`processor_registry.go:483`), `services.DocumentService.LoadByUUID` (`document_service.go:46-57`), `s.timeoutFor(settings, "btw")` (`ai_service.go:347-352` — `PromptTimeouts["btw"]` fallback `CLITimeoutLong`).
- Produces: `func (s *AIService) RunBtw(question, selection, docTitle, docSummary, docUUID string) (string, error)`; `func (s *AIService) Tier() domain.Tier` (so AI-backed commands gate themselves at Build time — the dispatcher enforces nothing); `type BtwCommand struct` + `func NewBtwCommand(aiSvc *AIService, docs *services.DocumentService) *BtwCommand` implementing `command.Command` (`Name()="btw"`). **The AI tier gate lives HERE, in `Build` — policy in the tool, not the dispatcher.**

- [ ] **Step 1: Write the failing tests**

`ai_service_btw_test.go` — mirror the `captureRunner` construction at `ai_service_containment_test.go:178-218`:

```go
func TestRunBtw_PromptAssemblyAndOp(t *testing.T) {
	cap := &captureRunner{ret: "answer"} // reuse/duplicate the containment test's capture type
	svc := newSmartTestService(t, cap)   // helper mirroring containment test fixture (TierSmart settings)
	out, err := svc.RunBtw("what is KISS", "the selected words", "My Doc", "a summary", "uuid-1")
	if err != nil || out != "answer" {
		t.Fatalf("unexpected: %v %q", err, out)
	}
	if cap.op != "btw" {
		t.Fatalf("op = %q, want btw", cap.op)
	}
	for _, want := range []string{"what is KISS", "the selected words", "My Doc", "a summary", "uuid-1"} {
		if !strings.Contains(cap.prompt, want) {
			t.Fatalf("prompt missing %q", want)
		}
	}
	if strings.Contains(cap.prompt, "{question}") || strings.Contains(cap.prompt, "{selection}") {
		t.Fatal("unreplaced placeholders")
	}
}

func TestRunBtw_TierDumb(t *testing.T)          // dumb fixture → error, runner never called
func TestRunBtw_NoDocUsesStorePathCwd(t *testing.T) // docUUID "" → cap.cwd == storePath fixture dir
func TestRunBtw_TimeoutKey(t *testing.T)        // settings with PromptTimeouts{"btw": 7} → cap.timeout == 7
```

`btw_command_test.go`:

```go
func TestBtwBuild_DetachedAiBlockShape(t *testing.T) {
	// registry with the REAL ai-block processor registered — follow the
	// registration pattern in sieve/block/processors/ai_block_processor_test.go
	c := NewBtwCommand(newSmartTestService(t, &captureRunner{ret: "A"}), nil)
	job, err := c.Build("what is SRP", command.NewContext(nil))
	if err != nil { t.Fatal(err) }
	a := job.Pending.Attrs // Pending is *command.Block — non-nil for detached commands
	if job.Pending.Kind != "ai-block" || a["status"] != "PENDING" || a["question"] != "what is SRP" || a["type"] != "BTW" {
		t.Fatalf("pending envelope wrong: %+v", job.Pending)
	}
	if a["id"] == "" { t.Fatal("no block id minted") }
	done, err := job.Work()
	if err != nil { t.Fatal(err) }
	if done.Attrs["status"] != "COMPLETE" || done.Attrs["response"] != "A" || done.Attrs["completedAt"] == "" {
		t.Fatalf("final envelope wrong: %+v", done)
	}
}

func TestBtwBuild_MetaOnlyContext(t *testing.T) // real DocumentService over t.TempDir() with a saved doc: Work's prompt (captureRunner) contains DisplayName + Summary; NO EditorService/ShadowDoc anywhere in the fixture — meta-only by construction
func TestBtwBuild_MissingDocTolerated(t *testing.T) // ctx.DocUUID = "nope" → Work still succeeds, empty title/summary
func TestBtwBuild_TierDumbFailsFast(t *testing.T) // dumb fixture → Build returns error BEFORE any job exists; runner never called (the gate is the COMMAND's precondition, exercised via the dispatcher as a single immediate ERROR in Task 3's TestDispatch_BuildErrorFailsFast shape)
func TestBtwLabel_Truncates(t *testing.T)        // label "/btw " + text, ellipsised past 40 runes
```

- [ ] **Step 2: Run to verify failure** — `nix develop -c bash -c "CGO_ENABLED=0 go test ./sieve/ai/ -run 'TestRunBtw|TestBtw' -v"` — FAIL.

- [ ] **Step 3: Implement**

`prompts.go` — add `DefaultBtwPrompt` and wire `"btw"` into `GetPromptContent`'s name→default fallback and `ListPrompts` (follow exactly how `ask`/`explain` appear at `prompts.go:34-58` and `:76-104`; display name `"Quick Answer (/btw)"` — this makes it a user-editable prompt tab automatically):

```go
// DefaultBtwPrompt backs the /btw command (#55): concise side-answers; the
// document is ambient disambiguation only. Pushed: a meta-only pointer; the
// model may PULL content via Sieve MCP get_note when genuinely needed (the
// conscious brainstorm-5 fence-crossing: read-only, audit-logged, popup-only).
const DefaultBtwPrompt = `You are answering a quick side-question a writer asked ("/btw") while working on a document. Answer the question concisely and directly, in markdown.

QUESTION:
{question}

SELECTED TEXT (may be empty; if present, the question is likely about it):
{selection}

BACKGROUND — ambient context for disambiguation only. Do not analyze the document, do not suggest edits, and do not mention it unless the question requires it:
- Document title: {doc_title}
- Document summary: {doc_summary}
- Document uuid: {doc_uuid}

If, and only if, the question genuinely requires the document's actual content, call the Sieve MCP tool get_note with the uuid above to read it. Prefer answering directly without it.

Keep the answer short: a few sentences, or a compact list or snippet when clearer. No preamble, no closing questions.`
```

`ai_service.go` — `RunBtw`, modeled exactly on `RunAsk` (`:174-190`):

```go
// RunBtw answers a quick /btw side-question. The document is pointer context
// only (meta strings — this path never touches the ShadowDoc); empty docUUID
// is the floor (no open tab) and falls back to the store root as cwd.
func (s *AIService) RunBtw(question, selection, docTitle, docSummary, docUUID string) (string, error) {
	settings := s.state.LoadSettings()
	if settings.Tier() == domain.TierDumb {
		return "", fmt.Errorf("btw not available in dumb mode")
	}
	prompt, _ := s.prompts.GetPromptContent("btw")
	cwd := s.storePath
	if docUUID != "" {
		cwd = s.noteDir(docUUID)
	}
	p := strings.ReplaceAll(prompt, "{question}", question)
	p = strings.ReplaceAll(p, "{selection}", selection)
	p = strings.ReplaceAll(p, "{doc_title}", docTitle)
	p = strings.ReplaceAll(p, "{doc_summary}", docSummary)
	p = strings.ReplaceAll(p, "{doc_uuid}", docUUID)
	binary, dialect := settings.ResolveCLI()
	return s.runner.Run("btw", binary, dialect, p, settings.Model, s.timeoutFor(settings, "btw"), cwd, s.profile(), s.storePath)
}

// Tier exposes the current capability tier so AI-backed commands can fail
// fast in Build (policy in the tool, never the dispatcher). RunBtw keeps its
// own guard as defence in depth.
func (s *AIService) Tier() domain.Tier { return s.state.LoadSettings().Tier() }
```

`btw_command.go`:

```go
// BtwCommand — the first standalone AI command (#55): a detached ai-block
// built through the normal processor shape; never enters any ShadowDoc.
// Stateless singleton: immutable deps only; per-request state lives in
// Build's args and the Job closures.
type BtwCommand struct {
	ai   *AIService
	docs *services.DocumentService
}

func NewBtwCommand(aiSvc *AIService, docs *services.DocumentService) *BtwCommand {
	return &BtwCommand{ai: aiSvc, docs: docs}
}

func (c *BtwCommand) Name() string        { return "btw" }
func (c *BtwCommand) Description() string { return "Quick answer in a popup — nothing is added to the document" }

func (c *BtwCommand) Build(text string, ctx command.Context) (command.Job, error) {
	// THIS command needs the AI CLI — its precondition, checked here, not by
	// the dispatcher (a non-AI command would check something else or nothing).
	if c.ai.Tier() == domain.TierDumb {
		return command.Job{}, fmt.Errorf("AI commands are unavailable — configure an AI CLI in Settings")
	}
	if strings.TrimSpace(text) == "" {
		return command.Job{}, fmt.Errorf("usage: /btw <question>")
	}
	proc := block.GetProcessor("ai-block")
	id := block.GenerateBlockID("ai-block")
	attrs := proc.InitAttrs(id, map[string]interface{}{
		"question": text,
		"type":     "BTW",
		"ref":      "", // detached: no target graph
	})
	pending := &command.Block{Kind: "ai-block", Attrs: attrs}
	return command.Job{
		Label:   c.label(text),
		Pending: pending,
		Work: func() (command.Block, error) {
			title, summary := c.docMeta(ctx.DocUUID)
			resp, err := c.ai.RunBtw(text, ctx.SelectedText, title, summary, ctx.DocUUID)
			if err != nil {
				return command.Block{}, err
			}
			done := make(map[string]interface{}, len(attrs)+3)
			for k, v := range attrs {
				done[k] = v
			}
			done["status"] = "COMPLETE"
			done["response"] = resp
			done["completedAt"] = time.Now().UTC().Format(time.RFC3339)
			return command.Block{Kind: "ai-block", Attrs: done}, nil
		},
	}, nil
}

// docMeta reads title+summary from disk meta ONLY (LoadByUUID resolves buffers
// too; accepted staleness = the autosave debounce). Every field optional.
func (c *BtwCommand) docMeta(uuid string) (title, summary string) {
	if uuid == "" || c.docs == nil {
		return "", ""
	}
	doc, err := c.docs.LoadByUUID(uuid)
	if err != nil {
		return "", ""
	}
	m := doc.Meta()
	title = m.DisplayName()
	if s := m.Summary(); s != nil {
		summary = *s
	}
	return title, summary
}

func (c *BtwCommand) label(text string) string {
	r := []rune(text)
	if len(r) > 40 {
		return "/btw " + string(r[:40]) + "…"
	}
	return "/btw " + text
}
```

(`ai` already imports `block` — see `processor_registry.go:410-421`'s note that the AIPort inversion was retired; this direction is sanctioned. `ai` importing `command` is the new DAG edge added in Task 3: `command` sits below `ai`, beside `services`.)

- [ ] **Step 4: Run tests** — `nix develop -c bash -c "CGO_ENABLED=0 go test ./sieve/ai/ ./sieve/block/... -v"` — PASS.

- [ ] **Step 5: Commit**

```bash
git add sieve/ai/prompts.go sieve/ai/ai_service.go sieve/ai/btw_command.go sieve/ai/ai_service_btw_test.go sieve/ai/btw_command_test.go
git commit -m "feat(ai): /btw command — detached ai-block via btw prompt, meta-only context (#55)"
```

---

### Task 5: Wire-up — WS command routing, composition root, boot enumeration (Go)

**Files:**
- Modify: `requesthandlers/ws_handler.go` (fill Task 1's stubs), `sieve/service_provider.go`, `handlers.go`, `frontend/src/index.html`
- Test: `requesthandlers/ws_command_test.go`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: `ServiceProvider.Commands *command.Registry`; `window.__sieveCommands = [{name, description}]` boot global; end-to-end `command`/`command-result`/`command-cancel` over the session channel.

- [ ] **Step 1: Write the failing integration tests**

`ws_command_test.go` (package `requesthandlers`). Extend `newWsTestServer` (or add `newWsTestServerWithCommands`) so the ServiceProvider carries a `command.Registry` with a real engine (`services.NewJobEngine(nil, 1, services.NewJobTracker())`) and a test-registered gated fake command (same `fakeCommand` shape as Task 3, defined locally). Tests:

```go
func TestWS_Command_PendingThenCompleteCorrelated(t *testing.T)
// dial ?session=1; send {type:"command", family:"ai", cmd:"fake", args:{text:"hi"},
// correlationId:"c-1", context:{}}; readUntil command-result PENDING (block present),
// then COMPLETE — both carrying correlationId "c-1" and cmd "fake".

func TestWS_Command_ConcurrentCommandsRouteDisjointly(t *testing.T)
// two gated commands c-1/c-2 in flight; release in reverse order; assert each
// result frame's correlationId matches, interleaving-safe.

func TestWS_Command_DocChannelCloseDoesNotOrphan(t *testing.T)
// open a doc channel (?uuid=doc-1) AND the session channel; dispatch a gated
// command; CLOSE the doc socket; release; the COMPLETE still arrives on the
// session socket. ALSO assert the doc channel saw NO insert-block frame —
// detached results never touch the ShadowDoc.

func TestWS_Command_UnknownFamilyAndUnknownCmd(t *testing.T)
// family:"nope" → ERROR result; cmd:"nope" → ERROR result; both correlated.

func TestWS_CommandCancel_SuppressesResult(t *testing.T)
// gated command; send {type:"command-cancel", correlationId:"c-1"}; release;
// expectNoMessage(COMPLETE) on the session socket (reuse ws_takeover_test.go:78-106 helpers).
```

- [ ] **Step 2: Run to verify failure** — `nix develop -c bash -c "CGO_ENABLED=0 go test ./requesthandlers/ -run TestWS_Command -v"` — FAIL (stubs are no-ops, `Commands` registry missing).

- [ ] **Step 3: Implement**

`ws_handler.go` — replace the Task 1 stubs:

```go
// commandEnvelope is the generic session-channel envelope (#55): mechanism on
// the wire, policy in the tool. family exists from day one — the workspace
// command plane's future tenants join without a rename. Context is ferried
// verbatim; the wire does not own its schema.
type commandEnvelope struct {
	Family        string          `json:"family"`
	Cmd           string          `json:"cmd"`
	Args          struct{ Text string `json:"text"` } `json:"args"`
	CorrelationID string          `json:"correlationId"`
	Context       json.RawMessage `json:"context"`
}

func (h *WsHandler) handleCommand(raw []byte) {
	var env commandEnvelope
	if err := json.Unmarshal(raw, &env); err != nil || env.CorrelationID == "" {
		return
	}
	emit := func(o command.Outcome) {
		frame := map[string]interface{}{
			"type":          "command-result",
			"correlationId": env.CorrelationID,
			"cmd":           env.Cmd,
			"status":        o.Status,
		}
		if o.Block != nil {
			frame["block"] = map[string]interface{}{"kind": o.Block.Kind, "attrs": o.Block.Attrs}
		}
		if o.Err != "" {
			frame["error"] = o.Err
		}
		h.sendTo(sessionChannelKey, frame) // session traffic: results follow the CURRENT session socket, not the dispatching one
	}
	reg := h.ServiceProvider.Commands
	// family → registry routing: one registry today; when a second family
	// arrives (workspace command plane) this becomes a map lookup.
	if env.Family != "ai" || reg == nil {
		emit(command.Outcome{Status: command.StatusError, Err: "unknown command family: " + env.Family})
		return
	}
	reg.Dispatch(env.Cmd, env.Args.Text, env.Context, env.CorrelationID, emit)
}

func (h *WsHandler) handleCommandCancel(raw []byte) {
	var msg struct {
		CorrelationID string `json:"correlationId"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil || msg.CorrelationID == "" {
		return
	}
	if h.ServiceProvider.Commands != nil {
		h.ServiceProvider.Commands.Cancel(msg.CorrelationID)
	}
}
```

`service_provider.go`:
- Add field `Commands *command.Registry` to the struct (`:16-30`).
- In `Init` (`:55-113`): `s.Commands = command.NewRegistry()` (no deps — the registry is policy-free); after the engine is built (`:99`), `s.Commands.SetEngine(s.Engine)` and `s.Commands.Register(ai.NewBtwCommand(s.AI, s.Documents))` — each command's deps are injected HERE, at the composition root (a future `/weather` would get an HTTP client, never the AIService).
- Add `command.Category: 2` to the `poolSizes` map (`:92-99`) so commands get their own small pool (still overridable via the `worker_pools` setting).

`handlers.go` (`handleIndex`, `:87-165`): add `Commands template.JS` to the `data` struct:

```go
commandsJSON := []byte("[]")
if h.app.ServiceProvider != nil && h.app.ServiceProvider.Commands != nil {
	if b, err := json.Marshal(h.app.ServiceProvider.Commands.List()); err == nil {
		commandsJSON = b
	}
}
// … in the struct literal:
Commands: template.JS(commandsJSON),
```

`frontend/src/index.html`: next to `window.__sieveCliTimeoutLong` (~line 369) add:

```html
window.__sieveCommands = {{.Commands}};
```

(Remember the wails-dev gotcha: index.html is embedded — the `.go` changes in this task make it go live.)

- [ ] **Step 4: Run tests** — `nix develop -c bash -c "CGO_ENABLED=0 go test ./... "` with `CGO_ENABLED=0` — PASS across the repo, plus `nix develop -c go build ./...`.

- [ ] **Step 5: Commit**

```bash
git add requesthandlers/ws_handler.go requesthandlers/ws_command_test.go sieve/service_provider.go handlers.go frontend/src/index.html
git commit -m "feat(commands): session-channel command dispatch end-to-end + boot enumeration (#55)"
```

---

### Task 6: Extract `BlockChannel` to its own module (JS, mechanical)

**Files:**
- Create: `frontend/src/static/block/block-channel.js`
- Modify: `frontend/src/static/block/block-service.js`

**Interfaces:**
- Produces: `export class BlockChannel` + the `ChannelDelegate` typedef, constructor `(socketFactory, wsUrl, delegate, onIndexMsg)` (`block-service.js:87-93`), public `send(msg)`, `awaitReply`, `awaitAck`, `close()`, `get delegate()` — ALL UNCHANGED. `CommandService` (Task 7) becomes its second consumer.

- [ ] **Step 1: Verify green baseline** — `cd frontend && nix develop -c npm test` — PASS (record count).
- [ ] **Step 2: Move the class** — cut `BlockChannel` (`block-service.js:55-~260`) and the `ChannelDelegate`/`WS_OPEN`/`SURFACE_OPS` definitions it needs into `block-channel.js` verbatim (add `// @ts-check` + a header comment noting it now serves both the per-uuid doc channels and the session command channel); `export class BlockChannel`; in `block-service.js` add `import { BlockChannel } from './block-channel.js'` and delete the moved code. Keep anything BlockService-only (e.g. the routing-index hookup) in `block-service.js`. No behaviour change, no signature change.
- [ ] **Step 3: Run the suite** — `cd frontend && nix develop -c npm test` — same pass count; also `nix develop -c npx vitest run test/service-mirror.test.js` explicitly.
- [ ] **Step 4: Commit**

```bash
git add frontend/src/static/block/block-channel.js frontend/src/static/block/block-service.js
git commit -m "refactor(js): extract BlockChannel — second consumer arriving (#55)"
```

---

### Task 7: `CommandService` — the JS command protocol peer

**Files:**
- Create: `frontend/src/static/block/command-service.js`
- Modify: `frontend/src/static/shell/workspace.js` (composition root)
- Test: `frontend/test/command-service.test.js`

**Interfaces:**
- Consumes: `BlockChannel` (Task 6), boot global `window.__sieveCommands` (read ONCE at the composition root and handed in — the service itself never touches `window`).
- Produces (consumed by Tasks 8/10):

```js
/** @typedef {{ name: string, description: string }} CommandInfo */
/** @typedef {{ correlationId: string, cmd: string, status: 'PENDING'|'COMPLETE'|'ERROR', block?: {kind: string, attrs: Record<string,any>}, error?: string }} CommandResult */
/** @typedef {{ correlationId: string, onResult: (fn: (r: CommandResult) => void) => void, cancel: () => void }} CommandHandle */

export class CommandService {
  constructor({ commands = [], socketFactory, wsUrlFor } = {}) // seams mirror BlockService's (block-service.js:264-288)
  get commands()            // ReadonlyArray<CommandInfo>, frozen
  isRegistered(name)        // boolean
  dispatch(cmd, text, context) // → frozen CommandHandle; context sent VERBATIM (null → {})
}
```

- [ ] **Step 1: Write the failing tests**

`command-service.test.js` — follow the FakeSocket pattern from `test/helpers/service-rig.js` (construct `new CommandService({ commands: [{name:'btw', description:'…'}], socketFactory: (url) => new FakeSocket(url), wsUrlFor: () => 'ws://test/api/ws?session=1' })`; import `FakeSocket` from the rig):

```js
it('opens the session socket lazily on first dispatch and sends the frozen envelope', () => {
  // dispatch('btw', 'what is KISS', {docUuid: 'u1', selectedText: 'sel'})
  // → one FakeSocket created with the session url; after driveOpen():
  // sentOfType('command')[0] deep-equals {type:'command', family:'ai', cmd:'btw',
  //   args:{text:'what is KISS'}, correlationId:'c-1', context:{docUuid:'u1', selectedText:'sel'}}
})
it('null context sends the empty floor {}', () => {})
it('routes PENDING then COMPLETE to the handle listeners, frozen', () => {
  // driveMessage({type:'command-result', correlationId:'c-1', cmd:'btw', status:'PENDING', block:{kind:'ai-block',attrs:{}}})
  // then COMPLETE; listener sees both in order; Object.isFrozen(result)
})
it('two in-flight dispatches route disjointly by correlationId', () => {})
it('drops frames for unknown correlationIds (restart forgets / late-after-cancel)', () => {})
it('cancel() sends command-cancel and stops delivery', () => {})
it('terminal result cleans up the in-flight entry', () => { /* second COMPLETE for same id is dropped */ })
```

- [ ] **Step 2: Run to verify failure** — `cd frontend && nix develop -c npx vitest run test/command-service.test.js` — FAIL (module missing).

- [ ] **Step 3: Implement `command-service.js`**

```js
// @ts-check
// command-service.js — the session-channel protocol peer beside block-service /
// document-service (#55, the #49 transport-blind rule): owns the Command /
// CommandResult wire family, correlation, and the Go-enumerated command list.
// Surfaces (Ask panel, badges) never touch the wire. The session channel is
// workspace-scoped — a /btw needs no document; context is granted, not addressing.
import { BlockChannel } from './block-channel.js'

export class CommandService {
  /** @type {ReadonlyArray<CommandInfo>} */ #commands
  /** @type {(url: string) => WebSocket} */ #socketFactory
  /** @type {() => string} */ #wsUrl
  /** @type {import('./block-channel.js').BlockChannel|null} */ #channel = null
  /** @type {Map<string, Array<(r: CommandResult) => void>>} */ #inflight = new Map()
  #seq = 0

  constructor({ commands = [], socketFactory, wsUrlFor } = {}) {
    this.#commands = Object.freeze(commands.map((c) => Object.freeze({ name: String(c.name), description: String(c.description || '') })))
    this.#socketFactory = socketFactory || ((url) => new WebSocket(url))
    this.#wsUrl = wsUrlFor || CommandService.#defaultUrl
  }

  get commands() { return this.#commands }

  /** @param {string} name */
  isRegistered(name) { return this.#commands.some((c) => c.name === name) }

  /**
   * Dispatch a command. context is the panel's SelectionContext, sent VERBATIM
   * (the D-5 send==shown object); null → the empty floor.
   * @param {string} cmd @param {string} text @param {object|null} context
   * @returns {CommandHandle}
   */
  dispatch(cmd, text, context) {
    const correlationId = 'c-' + (++this.#seq)
    /** @type {Array<(r: CommandResult) => void>} */
    const listeners = []
    this.#inflight.set(correlationId, listeners)
    this.#ensureChannel().send({ type: 'command', family: 'ai', cmd, args: { text }, correlationId, context: context || {} })
    const cancel = () => {
      this.#inflight.delete(correlationId) // late results for a cancelled correlation are dropped
      if (this.#channel) this.#channel.send({ type: 'command-cancel', correlationId })
    }
    return Object.freeze({ correlationId, onResult: (fn) => { listeners.push(fn) }, cancel })
  }

  #ensureChannel() {
    if (!this.#channel) {
      this.#channel = new BlockChannel(this.#socketFactory, this.#wsUrl, {
        applyServerOp: () => {},           // SURFACE_OPS never ride the session channel
        onFlushAck: () => {},
        resolveInsertIndex: () => -1,
        onMessage: (msg) => this.#onFrame(msg),
      }, () => {})
    }
    return this.#channel
  }

  /** @param {Record<string, any>} msg */
  #onFrame(msg) {
    if (!msg || msg.type !== 'command-result') return
    const listeners = this.#inflight.get(msg.correlationId)
    if (!listeners) return
    if (msg.status === 'COMPLETE' || msg.status === 'ERROR') this.#inflight.delete(msg.correlationId)
    const result = Object.freeze(msg)
    listeners.forEach((fn) => fn(result))
  }

  static #defaultUrl() {
    // Mirrors BlockService.#defaultUrl (block-service.js:283-288) with ?session=1 —
    // keep the two in lockstep (dev-server port override included).
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    let host = location.host
    if (/** @type {any} */ (window).__sieveDevServerPort) host = '127.0.0.1:' + /** @type {any} */ (window).__sieveDevServerPort
    return proto + '//' + host + '/api/ws?session=1'
  }
}
```

(Adapt the `ChannelDelegate` object shape to whatever `block-channel.js` exports after Task 6 — the four keys above are the current contract, `block-service.js:31-37`.)

`workspace.js`: in the `SieveWorkspace` constructor beside `new BlockService`/`new DocumentService` (`workspace.js:76-78`):

```js
this.#commandService = new CommandService({ commands: window.__sieveCommands || [] }) // composition root is the ONE sanctioned window read
```

plus a `get commandService()` getter.

- [ ] **Step 4: Run tests** — `cd frontend && nix develop -c npm test` — PASS.
- [ ] **Step 5: Commit**

```bash
git add frontend/src/static/block/command-service.js frontend/src/static/shell/workspace.js frontend/test/command-service.test.js
git commit -m "feat(js): CommandService — session-channel command peer (#55)"
```

---

### Task 8: Ask panel — three doors + Send affordance + inline error

**Files:**
- Modify: `frontend/src/static/shell/ask-panel.js`, `frontend/src/static/shell/workspace.js` (`bootChrome`, ~line 697), `frontend/src/index.html` (error slot)
- Test: `frontend/test/ask-panel.test.js` (extend)

**Interfaces:**
- Consumes: `CommandService.isRegistered/dispatch/commands` (Task 7); `CommandBadges.track(handle, {cmd, text})` (Task 10 — inject as nullable; panel guards `if (this.#badges)`, so this task lands first and Task 10 plugs in).
- Produces: parsing picks the door in `#send()` (`ask-panel.js:207-218`): leading `/` + registered → dispatch (before the active-editor bail — `/btw` with no tab must work); `/` + unknown → inline `.ask-popup__error`, dispatched NOWHERE; no slash → `ed.askAi(...)` **byte-for-byte as today**. Send button label flips to `Run /<cmd>` while the input holds a registered command.

- [ ] **Step 1: Write the failing tests** (extend `ask-panel.test.js`, reusing its `mountPanelDom()`/`fakeEditor()` helpers; add a `fakeCommandService()` with `vi.fn()` spies and a `fakeBadges()`):

```js
it('slash + registered command dispatches with the SHOWN context and never calls askAi', () => {
  // type '/btw what is KISS', trigger send →
  // commandService.dispatch called with ('btw', 'what is KISS', <#lastContext object identity>)
  // badges.track called with the returned handle; editor.askAi NOT called; textarea cleared
})
it('slash command works with NO active editor (empty-context floor)', () => {
  // no active tab: dispatch('btw', 'x', null) still fires — the plain-ask door requires an editor, the command door must not
})
it('slash + unknown shows the inline error and dispatches nowhere', () => {
  // '/nope hi' → .ask-popup__error visible, textContent contains '/nope';
  // dispatch NOT called, askAi NOT called; typing again clears the error
})
it('no slash → askAi payload byte-for-byte as today', () => { /* assert the existing {type:'ask', question, context} shape — reuse the existing send test's assertions */ })
it('send button reads Run /btw while input starts with a registered command, Send otherwise', () => {})
```

- [ ] **Step 2: Run to verify failure** — `cd frontend && nix develop -c npx vitest run test/ask-panel.test.js` — new tests FAIL, old ones PASS.

- [ ] **Step 3: Implement**

`index.html`: inside `#ask-panel` after the `.ask-popup__hint` footer span (~line 143): `<div class="ask-popup__error" hidden></div>`. Style it where the other `.ask-popup__*` rules live (locate: `grep -rn "ask-popup__hint" frontend/src/static/`), colours via `--theme-*`.

`ask-panel.js` — constructor gains an options bag (keep the existing first param untouched; update the `bootChrome` construction site): `constructor(ws, { commandService = null, commandBadges = null } = {})` storing `#commandService`/`#badges`. New/changed private members:

```js
#send() {
  if (!this.#textarea) return
  const val = this.#textarea.value.trim()
  if (!val) return
  if (val.startsWith('/')) { this.#sendCommand(val); return }  // command door FIRST — needs no editor
  const ed = this.#activeEditor()
  if (!ed) return
  /* …existing body unchanged, byte-for-byte… */
}

/** Parsing picks the door (#55): dispatcher has ZERO per-command knowledge —
 *  raw arg text + the shown SelectionContext, verbatim. */
#sendCommand(val) {
  const space = val.indexOf(' ')
  const cmd = (space === -1 ? val.slice(1) : val.slice(1, space)).toLowerCase()
  const text = space === -1 ? '' : val.slice(space + 1).trim()
  if (!this.#commandService || !this.#commandService.isRegistered(cmd)) {
    this.#showCommandError('Unknown command: /' + cmd)
    return
  }
  const ed = this.#activeEditor()
  const context = this.#lastContext || (ed ? ed.getSelectionContext() : null) // D-5 send==shown; null = empty floor
  const handle = this.#commandService.dispatch(cmd, text, context)
  if (this.#badges) this.#badges.track(handle, { cmd, text })
  this.#textarea.value = ''
  this.#refreshSendAffordance()
}

#commandToken(val) {
  const m = /^\/([a-z0-9-]+)(\s|$)/i.exec(val)
  return m && this.#commandService && this.#commandService.isRegistered(m[1].toLowerCase()) ? m[1].toLowerCase() : null
}

#refreshSendAffordance() {
  if (!this.#sendBtn) return
  const token = this.#commandToken(this.#textarea ? this.#textarea.value : '')
  this.#sendBtn.textContent = token ? 'Run /' + token : 'Send'
}

#showCommandError(msg) { /* unhide .ask-popup__error, set textContent */ }
#clearCommandError() { /* hide + clear */ }
```

In `#wireDom()` (`:143-157`): store `#sendBtn` as a field (it's currently a local), and add:

```js
textarea.addEventListener('input', () => { this.#clearCommandError(); this.#refreshSendAffordance() })
```

- [ ] **Step 4: Run tests** — `cd frontend && nix develop -c npm test` — PASS.
- [ ] **Step 5: Commit**

```bash
git add frontend/src/static/shell/ask-panel.js frontend/src/static/shell/workspace.js frontend/src/index.html frontend/test/ask-panel.test.js
git commit -m "feat(ask): slash-command door — parse picks the path, Send flips to Run (#55)"
```

---

### Task 9: `/` hint popover

**Files:**
- Create: `frontend/src/static/shell/command-hint-popover.js`
- Modify: `frontend/src/static/shell/ask-panel.js` (owner), CSS file colocated with ask-panel styles
- Test: `frontend/test/command-hint-popover.test.js`

**Interfaces:**
- Consumes: `CommandService.commands` (via AskPanel).
- Produces: `class CommandHintPopover { constructor(anchorEl); showFor(prefix, commands); hide(); get visible() }` — read-only list (no fuzzy, no keyboard selection, v1), prefix-filtered, positioned above the anchor via `getBoundingClientRect` + rAF viewport clamp (the `context-menu.js:13-33` pattern), hidden on Esc/click-away/send (document-level listeners added on show, removed on hide — `context-menu.js:468-473` pattern).

- [ ] **Step 1: Write the failing tests**

```js
it('shows all commands for bare "/" with name + description rows', () => {})
it('prefix-filters: "/b" keeps btw, "/x" shows nothing and hides', () => {})
it('hides on Escape and on outside click', () => {})
it('is read-only: rows are not buttons, no keyboard selection handlers', () => {})
```

(Construct with a real textarea in happy-dom; call `showFor('b', [{name:'btw', description:'Quick answer'}])` directly.)

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the class (single root `div.command-hint-popover` appended to `document.body`, row per filtered command: `<span class="command-hint__name">/btw</span><span class="command-hint__desc">…</span>`), then wire in `ask-panel.js`'s input listener:

```js
// in #onInput, after #refreshSendAffordance():
const m = /^\/([a-z0-9-]*)$/i.exec(this.#textarea.value) // leading / and still typing the verb
if (m && this.#commandService) this.#hint.showFor(m[1].toLowerCase(), this.#commandService.commands)
else this.#hint.hide()
```

AskPanel constructs `this.#hint = new CommandHintPopover(this.#textarea)` and calls `this.#hint.hide()` in `#send()`/`#dismiss()`. CSS colocated with the ask-panel rules, `--theme-*` only.

- [ ] **Step 4: Run tests** — `cd frontend && nix develop -c npm test` — PASS.
- [ ] **Step 5: Commit**

```bash
git add frontend/src/static/shell/command-hint-popover.js frontend/src/static/shell/ask-panel.js frontend/test/command-hint-popover.test.js <css file>
git commit -m "feat(ask): registered-command hint popover on leading slash (#55)"
```

---

### Task 10: Badge lifecycle + answer popup (AiBlockRenderer's third host)

**Files:**
- Create: `frontend/src/static/shell/command-badges.js`, `frontend/src/static/shell/command-popup.js`
- Modify: `frontend/src/index.html` (badge slot), `frontend/src/static/shell/workspace.js` (`bootChrome`: construct `CommandBadges`, pass to `AskPanel`), `frontend/src/static/block/renderers/ai-block-renderer.js` (BTW badge label), `frontend/src/static/ai/ai-actions.js` (filter command jobs), CSS
- Test: `frontend/test/command-badges.test.js`, `frontend/test/command-popup.test.js`, extend `frontend/test/ai-block-renderer.test.js` and `frontend/test/jobs-snapshot.test.js`

**Interfaces:**
- Consumes: `CommandHandle` (Task 7), `SieveBlock` (`block/sieve-block.js` — `new SieveBlock(kind, attrs)`), `AiBlockRenderer` scratch protocol (`new AiBlockRenderer(block)` + `.render()` + `.update(block)` — the bare-page host pattern, `test/ai-block-renderer.test.js`).
- Produces: `class CommandBadges { constructor(slotEl); track(handle, {cmd, text}) }` and `class CommandPopup { constructor({anchor, onDelete}); show(sieveBlock); update(sieveBlock); hide(); destroy(); get visible() }`.

**Behaviour contract (spec + amendments 3/6/7):**
- One badge per correlationId, independent lifecycle: spinner while pending → lit while holding → gone on Delete. App restart forgets everything (no persistence — trivially true, all state in-memory).
- Click toggles the popup at ANY time (clicking a pending badge opts into the spinner popup — the renderer's own job chrome — which becomes the answer in place); a terminal result auto-summons the popup. The popup NEVER steals keyboard focus (no `.focus()` calls anywhere).
- **Hide** (Esc / click-away / minimize button): popup disappears, badge stays lit. **Delete** (✕/trash, visually distinct): held answer + badge gone for good; on a pending badge Delete also calls `handle.cancel()` — one verb, "remove from existence".
- The badge lives in a new `.status-bar__command-badges` slot **beside** `.status-bar__jobs` (the legacy `ai-actions.js` IIFE rebuilds `.status-bar__jobs`' innerHTML on every `sse:jobs:changed` — co-locating would wipe our badges). To avoid double-painting, `ai-actions.js`'s `applyJobsSnapshot` filters out `category === "commands"` jobs (they have their own badge). The correlated job still registers in the JobTracker (Go side, Task 3) — the Job Engine Viewer's truth stays complete.

- [ ] **Step 1: Write the failing tests**

`command-badges.test.js` (fake handle: `{ correlationId: 'c-1', onResult(fn) { this.fire = fn }, cancel: vi.fn() }`; slot = plain div; stub `CommandPopup`? No — use the real one, happy-dom renders it; reuse the theme-var/MarkdownIt install helpers from `ai-block-renderer.test.js`):

```js
it('track() paints a pending badge (spinner class) labelled with the command', () => {})
it('terminal COMPLETE flips badge to holding and auto-summons the popup with the result block', () => {})
it('ERROR without a block synthesises an ERROR envelope from the question text', () => {})
it('click toggles the popup; clicking a pending badge shows the renderer job chrome', () => {})
it('two tracked handles get independent badges and popups (1:1 correlationId)', () => {})
it('Hide leaves the badge lit and re-openable; Delete removes badge + popup', () => {})
it('Delete on a PENDING badge calls handle.cancel()', () => {})
```

`command-popup.test.js`:

```js
it('show() mounts AiBlockRenderer output (root .sieve-ai-block present) without focusing anything', () => {})
it('update() repaints in place: PENDING chrome becomes the sanctioned-markdown answer', () => {})
it('copy button writes attrs.response to the clipboard', () => { /* stub navigator.clipboard */ })
it('Esc and outside click call onHide path (popup hidden, root removed, listeners detached)', () => {})
it('Delete button invokes the onDelete callback', () => {})
```

`ai-block-renderer.test.js` — add: badge text shows `BTW` for `attrs.type === 'BTW'` (and unchanged `ASK`/`EXPLAIN`).
`jobs-snapshot.test.js` — add: a snapshot entry with `category: "commands"` is not rendered into `.status-bar__jobs`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

`ai-block-renderer.js` `#renderBadge` (`:112`): `badge.textContent = (attrs.type === 'EXPLAIN' || attrs.type === 'BTW') ? attrs.type : 'ASK'`.

`ai-actions.js` `applyJobsSnapshot` (`:78`): filter both lists — `active = (payload.active || []).filter((j) => j.category !== 'commands')` (same for queued) before painting.

`index.html` status bar (~line 163): `<span class="status-bar__command-badges"></span>` immediately before/after `.status-bar__jobs`.

`command-badges.js` (core shape):

```js
// @ts-check
// command-badges.js — status-bar badge lifecycle for correlated command jobs
// (#55): one badge per correlationId (spinner → holding → dismissed); the badge
// IS the re-summon affordance and, later, the Job Engine Viewer's summon seed.
import { SieveBlock } from '../block/sieve-block.js'
import { CommandPopup } from './command-popup.js'

export class CommandBadges {
  /** @type {HTMLElement|null} */ #slot
  /** @type {Map<string, {el: HTMLElement, handle: any, state: string, block: SieveBlock, popup: CommandPopup|null}>} */ #entries = new Map()

  /** @param {HTMLElement|null} slot the .status-bar__command-badges element */
  constructor(slot) { this.#slot = slot }

  /**
   * @param {import('../block/command-service.js').CommandHandle} handle
   * @param {{cmd: string, text: string}} meta
   */
  track(handle, meta) {
    if (!this.#slot) return
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'command-badge command-badge--pending'
    el.title = '/' + meta.cmd + (meta.text ? ' ' + meta.text : '')
    el.setAttribute('aria-label', el.title)
    this.#slot.appendChild(el)
    const entry = {
      el, handle, state: 'pending', popup: null,
      // Local envelope from day zero: an ERROR with no server block still renders.
      block: new SieveBlock('ai-block', { question: meta.text, type: 'BTW', status: 'PENDING', createdAt: new Date().toISOString() }),
    }
    this.#entries.set(handle.correlationId, entry)
    el.addEventListener('click', () => this.#toggle(entry))
    handle.onResult((r) => this.#onResult(entry, r))
  }

  #onResult(entry, r) {
    if (r.block) entry.block = new SieveBlock(r.block.kind, r.block.attrs)
    else if (r.status === 'ERROR') entry.block = new SieveBlock('ai-block', Object.assign({}, entry.block.payload, { status: 'ERROR', error: r.error || '' }))
    if (r.status === 'COMPLETE' || r.status === 'ERROR') {
      entry.state = 'holding'
      entry.el.className = 'command-badge command-badge--holding' + (r.status === 'ERROR' ? ' command-badge--error' : '')
      this.#summon(entry) // terminal result auto-summons (amendment 6)
    } else if (entry.popup && entry.popup.visible) {
      entry.popup.update(entry.block)
    }
  }

  #toggle(entry) {
    if (entry.popup && entry.popup.visible) entry.popup.hide()
    else this.#summon(entry) // pending click = opt-in spinner popup; renders CURRENT state whenever summoned
  }

  #summon(entry) {
    if (!entry.popup) entry.popup = new CommandPopup({ anchor: entry.el, onDelete: () => this.#delete(entry) })
    entry.popup.show(entry.block)
  }

  // Delete = "remove from existence": cancels a pending job, discards a held answer (amendment 7).
  #delete(entry) {
    if (entry.state === 'pending') entry.handle.cancel()
    if (entry.popup) entry.popup.destroy()
    entry.el.remove()
    this.#entries.delete(entry.handle.correlationId)
  }
}
```

`command-popup.js` (core shape — anchored above its badge, `context-menu.js` positioning idiom, never focuses):

```js
// @ts-check
// command-popup.js — the detached-answer popup (#55): the THIRD host of
// AiBlockRenderer (note lens / bare harness / here). An appearance, not an
// interruption: never steals focus. Hide parks the answer on its badge;
// Delete (via onDelete) removes it from existence.
import { AiBlockRenderer } from '../block/renderers/ai-block-renderer.js'

export class CommandPopup {
  #anchor; #onDelete
  /** @type {HTMLElement|null} */ #root = null
  /** @type {AiBlockRenderer|null} */ #renderer = null
  /** @type {import('../block/sieve-block.js').SieveBlock|null} */ #block = null
  /** @type {Array<() => void>} */ #unlisten = []

  constructor({ anchor, onDelete }) { this.#anchor = anchor; this.#onDelete = onDelete }
  get visible() { return !!this.#root }

  show(block) {
    this.#block = block
    if (this.#root) { this.update(block); return }
    const root = document.createElement('div')
    root.className = 'command-popup'
    const bar = document.createElement('div')
    bar.className = 'command-popup__bar'
    bar.append(
      this.#barButton('copy', 'Copy answer', () => navigator.clipboard.writeText(String((this.#block && this.#block.payload.response) || ''))),
      this.#barButton('hide', 'Hide (answer stays on the badge)', () => this.hide()),
      this.#barButton('delete', 'Delete', () => this.#onDelete()), // visually distinct (trash) via CSS
    )
    const body = document.createElement('div')
    body.className = 'command-popup__body' // scrollable + text-selectable via CSS
    this.#renderer = new AiBlockRenderer(block) // scratch host: no blockService, self-filled body
    body.appendChild(this.#renderer.render())
    root.append(bar, body)
    document.body.appendChild(root)
    this.#position(root)
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.hide() } }
    const onClick = (e) => { if (!root.contains(e.target) && e.target !== this.#anchor) this.hide() }
    document.addEventListener('keydown', onKey)
    document.addEventListener('click', onClick)
    this.#unlisten = [() => document.removeEventListener('keydown', onKey), () => document.removeEventListener('click', onClick)]
  }

  update(block) {
    this.#block = block
    if (this.#renderer) this.#renderer.update(block)
    else this.show(block)
  }

  hide() {
    this.#unlisten.forEach((u) => u())
    this.#unlisten = []
    if (this.#root) this.#root.remove()
    this.#root = null
    this.#renderer = null
  }

  destroy() { this.hide() }

  #barButton(kind, label, onClick) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'command-popup__btn command-popup__btn--' + kind
    b.setAttribute('aria-label', label)
    b.title = label
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick() })
    return b
  }

  #position(root) {
    const r = this.#anchor.getBoundingClientRect()
    root.style.position = 'fixed'
    root.style.bottom = (window.innerHeight - r.top + 8) + 'px'
    root.style.right = Math.max(8, window.innerWidth - r.right) + 'px'
    requestAnimationFrame(() => { /* clamp left/top into viewport, context-menu.js:27-33 pattern */ })
  }
}
```

CSS: `.command-badge` (spinner reuses `.status-bar__spinner` keyframes — locate via `grep -rn "status-bar__spinner" frontend/src/static/`), `.command-badge--holding`, `--error`; `.command-popup` (max-height + `overflow-y: auto` on the body, `user-select: text`, `--theme-*` colours, subtle shadow). `workspace.js` `bootChrome`: `const badges = new CommandBadges(document.querySelector('.status-bar__command-badges'))` and pass into the `AskPanel` options bag (Task 8's seam).

- [ ] **Step 4: Run tests** — `cd frontend && nix develop -c npm test` — PASS.
- [ ] **Step 5: Commit**

```bash
git add frontend/src/static/shell/command-badges.js frontend/src/static/shell/command-popup.js frontend/src/static/shell/workspace.js frontend/src/static/block/renderers/ai-block-renderer.js frontend/src/static/ai/ai-actions.js frontend/src/index.html frontend/test/command-badges.test.js frontend/test/command-popup.test.js frontend/test/ai-block-renderer.test.js frontend/test/jobs-snapshot.test.js <css files>
git commit -m "feat(shell): command badges + answer popup — AiBlockRenderer's third host (#55)"
```

---

### Task 11: Gate — full verification, UI drive, docs

- [ ] **Step 1: Full build + test sweep**

```bash
nix develop -c go build ./...
nix develop -c bash -c "CGO_ENABLED=0 go test ./..."
cd frontend && nix develop -c npm test
```

All green, no skips.

- [ ] **Step 2: Type-check the new JS** — ephemeral, per the not-yet-wired-tsc convention:

```bash
cd frontend && nix develop -c bash -c "npm i --no-save typescript && npx tsc --noEmit --allowJs --checkJs --target es2022 --moduleResolution bundler src/static/block/command-service.js src/static/block/block-channel.js src/static/shell/command-hint-popover.js src/static/shell/command-badges.js src/static/shell/command-popup.js"
```

- [ ] **Step 3: Drive the UI yourself** (headless Chrome via chrome-devtools MCP against `nix develop -c wails dev`, external URL `:34115` — never defer to the user):
  1. Type `/` in the Ask panel → hint popover lists `/btw` with its one-liner; `/b` filters; Esc hides.
  2. `/btw what is the KISS acronym` with a doc open → input clears, spinner badge appears in the status bar, document untouched; on completion the popup auto-emerges with the rendered markdown answer; keyboard focus did NOT move (assert `document.activeElement` unchanged).
  3. **The interleave**: trigger Explain on a block, immediately `/btw …` — Explain's answer lands in its ai-block (doc channel), `/btw`'s in the popup (session channel), neither cross-talks; doc undo history intact.
  4. `/nope hi` → inline error, nothing dispatched (no badge).
  5. Badge click toggles the popup; Hide (Esc) parks it, badge stays lit, click re-opens with the same answer; Delete removes badge+popup; Delete during pending cancels (badge gone, no popup ever appears).
  6. Close the doc tab mid-`/btw` → answer still arrives (session channel survives).
  7. `/btw` with NO tab open → works (empty-context floor).
  8. TierDumb degradation (temporarily blank the CLI path in settings): `/btw x` → ERROR popup with the "configure an AI CLI" message.
- [ ] **Step 4: Manual WebKitGTK smoke** — run the real app once (`nix develop -c wails dev` window): repeat scenarios 1–2 and 5; note WebKit key-event quirks (`ISO_Left_Tab` lore — Esc is safe but verify Esc-in-popup doesn't leak to the ask panel dismiss).
- [ ] **Step 5: Docs + issue hygiene**
  - `CLAUDE.md` Key File Locations → "Protocol services" row: add `command-service.js` (session channel: Command/CommandResult, correlation) beside block-service/document-service.
  - `docs/editor-interaction-contract.md`: no editor-keymap changes were made (popup/hint are shell chrome outside the editor focus zones) — add a one-line note under the Esc/panel section only if reviewers want the popup's Esc documented; otherwise leave untouched.
  - Post a completion comment on Forgejo #55 (`tea api`) summarising what shipped + the v1 cancellation limitation; the spec is archived (`git mv` to `docs/design/archive/specs/`) in the same change that closes the issue.
- [ ] **Step 6: Final commit** (docs only) — `git commit -m "docs: command plane seams recorded; #55 gate notes"`.

---

## Design decisions locked by this plan (call out in review)

1. **Session channel = sentinel key in the existing channels map** (`__session__`, `?session=1`) — reuses register/unregister/sendTo and the ownership guard verbatim; no shadow, no claim-on-write. Alternative (parallel `sessionConn` field) rejected: two registries, two guards, same semantics.
2. **The registry is a leaf package `sieve/command`, and the dispatcher is policy-free** (review amendment 2026-07-26): the first draft hard-coded the AI tier gate into `Dispatch` — dispatcher-level AI policy, the same sin as the deleted `sink` field. Now: `Dispatch` = lookup → Build → PENDING → submit → emit, importing only `services`; per-command preconditions live in `Build` (BtwCommand gates on `AIService.Tier()`; a non-AI `/weather` command would check its own or nothing) and fail fast as an immediate ERROR result. Commands are stateless singletons — immutable deps injected at the composition root, per-request state confined to Build args + Job closures. `command.Outcome` keeps the package wire-blind; `WsHandler` (owner of every other frame) maps outcomes to `command-result` frames, and the generic envelope stays in `requesthandlers` until a second family exists.
3. **Cancellation is best-effort v1**: queued jobs never run; active jobs finish their CLI call but the result is dropped and callbacks suppressed. True process interruption needs a ctx-threaded `CLIRunner` — follow-up, noted in code.
4. **`JobID == correlationId`** — Cancel passes straight through, and the correlated job sits in the JobTracker under its wire identity (viewer obligation). The detached block's own id stays a block concern.
5. **Badges get their own slot beside `.status-bar__jobs`** — the legacy IIFE innerHTML-rebuilds that container per SSE snapshot; co-locating would wipe badge state. `ai-actions` filters `category === "commands"` so pending work isn't double-painted. Unification lands with the Job Engine Viewer (X-C slice), not here.
6. **PENDING result carries the initial block envelope** (per the spec's flow diagram), but the badge also builds a local fallback envelope so a pre-job ERROR (unknown cmd, TierDumb) still renders in the popup.
