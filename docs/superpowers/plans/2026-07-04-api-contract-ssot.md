# API Contract Single-Source-of-Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `sieve/protocol` the typed single source of truth for the WS protocol, SSE events, and JSON endpoints, with generated docs/OpenAPI/AsyncAPI/JS-constants artifacts, contract tests, and a dev-only `/api/docs` test ground.

**Architecture:** A new leaf-ish package `sieve/protocol` (imports only `sieve/sieve/block`) defines message structs, constants, and a `Registry` describing every WS message, SSE event, and JSON endpoint. `ws_handler.go` dispatch and all broadcast sites are refactored onto it (wire format unchanged). A generator package `sieve/protocol/gen` (driven by `tools/protocolgen`) reflects over the Registry and emits five committed artifacts. Contract tests enforce that artifacts are current and dispatch matches the registry.

**Tech Stack:** Go 1.25, chi v5, gorilla/websocket, gopkg.in/yaml.v3 (already in go.mod), vanilla JS (no build step).

**Spec:** `docs/superpowers/specs/2026-07-04-api-contract-single-source-of-truth-design.md`

## Global Constraints

- **Wire format unchanged.** Every JSON field name and message type string must match the current wire exactly (golden tests enforce this). This is a formalization, not a protocol change.
- **No loose functions.** Behaviour is methods on owning types (`Registry`, `Generator`); constructors (`NewX`) are fine.
- **No npm build step.** Generated JS is a committed plain file; editor.js is a classic IIFE script — it consumes constants via `window.SieveProtocol`, never `import`.
- **Module path is `sieve`** — the new package dir `sieve/protocol/` imports as `sieve/sieve/protocol`.
- **Import DAG:** `protocol` imports `block` only. `services`, `requesthandlers`, root, and `main` may import `protocol`. `gen` may import `protocol` + `requesthandlers`. Nothing imports `gen` except its test and `tools/protocolgen`.
- **Commits:** conventional-commit style, no Co-Authored-By trailer.
- **`wails dev` gotcha:** changes to `frontend/src/index.html` or templates need a `.go` file touch to go live (embedded); `/static/` is live from disk.
- Build check: `go build ./...`. Test: `go test ./...`.

---

### Task 1: `sieve/protocol` — WS message structs, constants, wire-fidelity tests

**Files:**
- Create: `sieve/protocol/messages.go`
- Test: `sieve/protocol/messages_test.go`

**Interfaces:**
- Produces: constants `MsgPing`…`MsgBlockExtracted`; inbound structs `Ping, DocUpdate, Flush, EnterMarkdown, EnterWysiwyg, RetryBlockJob, Extract, BlockOpMsg`; outbound structs + constructors `NewPong(), NewFlushAck(uuid), NewError(message), NewMarkdownContent(uuid, markdown), NewWysiwygContent(uuid, blocks), NewInsertBlock(kind, id string, attrs map[string]interface{}, index int, markdown, token string), NewBlockAttrsUpdated(id, attrs), NewReplaceBlock(oldID, newID, newKind string, attrs map[string]interface{}, newYaml string), NewBlockExtracted(originalID, newID, newKind, newYaml string)`.

- [ ] **Step 1: Write the failing wire-fidelity test**

`sieve/protocol/messages_test.go` — each case marshals a constructor result and compares against the exact JSON the current handlers emit (copied from `requesthandlers/ws_handler.go`):

```go
package protocol

import (
	"encoding/json"
	"testing"
)

func marshal(t *testing.T, v interface{}) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

func TestOutboundWireFidelity(t *testing.T) {
	cases := []struct {
		name string
		msg  interface{}
		want string
	}{
		{"pong", NewPong(), `{"type":"pong"}`},
		{"flush-ack", NewFlushAck("u1"), `{"type":"flush-ack","uuid":"u1"}`},
		{"error", NewError("boom"), `{"type":"error","message":"boom"}`},
		{"markdown-content", NewMarkdownContent("u1", "# hi"),
			`{"type":"markdown-content","uuid":"u1","markdown":"# hi"}`},
		{"wysiwyg-content", NewWysiwygContent("u1", nil),
			`{"type":"wysiwyg-content","uuid":"u1","blocks":null}`},
		{"insert-block", NewInsertBlock("code", "b1", map[string]interface{}{"source": "x"}, 2, "md", "tok-1"),
			`{"type":"insert-block","kind":"code","id":"b1","attrs":{"source":"x"},"index":2,"markdown":"md","token":"tok-1"}`},
		{"block-attrs-updated", NewBlockAttrsUpdated("b1", map[string]interface{}{"status": "DONE"}),
			`{"type":"block-attrs-updated","id":"b1","attrs":{"status":"DONE"}}`},
		{"replace-block", NewReplaceBlock("old", "new", "web-clip", map[string]interface{}{}, "yaml"),
			`{"type":"replace-block","oldId":"old","newId":"new","newKind":"web-clip","attrs":{},"newYaml":"yaml"}`},
		{"block-extracted", NewBlockExtracted("o1", "n1", "code", "yaml"),
			`{"type":"block-extracted","originalId":"o1","newId":"n1","newKind":"code","newYaml":"yaml"}`},
	}
	for _, c := range cases {
		if got := marshal(t, c.msg); got != c.want {
			t.Errorf("%s:\n got  %s\n want %s", c.name, got, c.want)
		}
	}
}

func TestInboundDecodes(t *testing.T) {
	var d DocUpdate
	if err := json.Unmarshal([]byte(`{"type":"doc-update","uuid":"u1","markdown":"m"}`), &d); err != nil || d.Markdown != "m" {
		t.Fatalf("DocUpdate decode: %+v err=%v", d, err)
	}
	var e EnterWysiwyg
	if err := json.Unmarshal([]byte(`{"type":"enter-wysiwyg","uuid":"u1"}`), &e); err != nil || e.Markdown != nil {
		t.Fatalf("EnterWysiwyg: absent markdown must decode to nil pointer, got %+v", e)
	}
	var x Extract
	if err := json.Unmarshal([]byte(`{"type":"extract","blockId":"b","targetKind":"code","operation":"extract","entries":[],"index":3}`), &x); err != nil || x.Index != 3 || x.TargetKind != "code" {
		t.Fatalf("Extract decode: %+v err=%v", x, err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./sieve/protocol/`
Expected: FAIL — package does not exist / undefined identifiers.

- [ ] **Step 3: Write `sieve/protocol/messages.go`**

```go
// Package protocol is the single source of truth for Sieve's wire contract:
// WebSocket messages (both directions), SSE events, and JSON endpoint shapes.
// Handlers and the frontend constants file are derived from it — never define
// a message type string or payload shape anywhere else.
package protocol

import "sieve/sieve/block"

// WS message type discriminators (the "type" field on every message).
const (
	// client → server
	MsgPing          = "ping"
	MsgDocUpdate     = "doc-update"
	MsgFlush         = "flush"
	MsgEnterMarkdown = "enter-markdown"
	MsgEnterWysiwyg  = "enter-wysiwyg"
	MsgRetryBlockJob = "retry-block-job"
	MsgExtract       = "extract"
	MsgBlockOp       = "block-op"

	// server → client
	MsgPong              = "pong"
	MsgFlushAck          = "flush-ack"
	MsgError             = "error"
	MsgMarkdownContent   = "markdown-content"
	MsgWysiwygContent    = "wysiwyg-content"
	MsgInsertBlock       = "insert-block"
	MsgBlockAttrsUpdated = "block-attrs-updated"
	MsgReplaceBlock      = "replace-block"
	MsgBlockExtracted    = "block-extracted"
)

// ── client → server payloads ────────────────────────────────────────────────

type Ping struct {
	Type string `json:"type"`
}

type DocUpdate struct {
	Type     string `json:"type"`
	UUID     string `json:"uuid"`
	Markdown string `json:"markdown"`
}

type Flush struct {
	Type string `json:"type"`
	UUID string `json:"uuid"`
}

type EnterMarkdown struct {
	Type string `json:"type"`
	UUID string `json:"uuid"`
}

// EnterWysiwyg's Markdown is a pointer: nil means "no markdown field present"
// (do not adopt), non-nil (even empty) means adopt the textarea's value.
type EnterWysiwyg struct {
	Type     string  `json:"type"`
	UUID     string  `json:"uuid"`
	Markdown *string `json:"markdown"`
}

type RetryBlockJob struct {
	Type string `json:"type"`
	UUID string `json:"uuid"`
	ID   string `json:"id"`
}

type Extract struct {
	Type       string               `json:"type"`
	UUID       string               `json:"uuid"`
	BlockID    string               `json:"blockId"`
	TargetKind string               `json:"targetKind"`
	Operation  string               `json:"operation"`
	Entries    []block.ContentEntry `json:"entries"`
	Index      int                  `json:"index"`
}

type BlockOpMsg struct {
	Type string        `json:"type"`
	UUID string        `json:"uuid"`
	Op   block.BlockOp `json:"op"`
}

// ── server → client payloads ────────────────────────────────────────────────

type Pong struct {
	Type string `json:"type"`
}

func NewPong() Pong { return Pong{Type: MsgPong} }

type FlushAck struct {
	Type string `json:"type"`
	UUID string `json:"uuid"`
}

func NewFlushAck(uuid string) FlushAck { return FlushAck{Type: MsgFlushAck, UUID: uuid} }

type ErrorMsg struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

func NewError(message string) ErrorMsg { return ErrorMsg{Type: MsgError, Message: message} }

type MarkdownContent struct {
	Type     string `json:"type"`
	UUID     string `json:"uuid"`
	Markdown string `json:"markdown"`
}

func NewMarkdownContent(uuid, markdown string) MarkdownContent {
	return MarkdownContent{Type: MsgMarkdownContent, UUID: uuid, Markdown: markdown}
}

type WysiwygContent struct {
	Type   string                `json:"type"`
	UUID   string                `json:"uuid"`
	Blocks []block.FrontendBlock `json:"blocks"`
}

func NewWysiwygContent(uuid string, blocks []block.FrontendBlock) WysiwygContent {
	return WysiwygContent{Type: MsgWysiwygContent, UUID: uuid, Blocks: blocks}
}

type InsertBlock struct {
	Type     string                 `json:"type"`
	Kind     string                 `json:"kind"`
	ID       string                 `json:"id"`
	Attrs    map[string]interface{} `json:"attrs"`
	Index    int                    `json:"index"`
	Markdown string                 `json:"markdown"`
	Token    string                 `json:"token"`
}

func NewInsertBlock(kind, id string, attrs map[string]interface{}, index int, markdown, token string) InsertBlock {
	return InsertBlock{Type: MsgInsertBlock, Kind: kind, ID: id, Attrs: attrs, Index: index, Markdown: markdown, Token: token}
}

type BlockAttrsUpdated struct {
	Type  string                 `json:"type"`
	ID    string                 `json:"id"`
	Attrs map[string]interface{} `json:"attrs"`
}

func NewBlockAttrsUpdated(id string, attrs map[string]interface{}) BlockAttrsUpdated {
	return BlockAttrsUpdated{Type: MsgBlockAttrsUpdated, ID: id, Attrs: attrs}
}

type ReplaceBlock struct {
	Type    string                 `json:"type"`
	OldID   string                 `json:"oldId"`
	NewID   string                 `json:"newId"`
	NewKind string                 `json:"newKind"`
	Attrs   map[string]interface{} `json:"attrs"`
	NewYaml string                 `json:"newYaml"`
}

func NewReplaceBlock(oldID, newID, newKind string, attrs map[string]interface{}, newYaml string) ReplaceBlock {
	return ReplaceBlock{Type: MsgReplaceBlock, OldID: oldID, NewID: newID, NewKind: newKind, Attrs: attrs, NewYaml: newYaml}
}

type BlockExtracted struct {
	Type       string `json:"type"`
	OriginalID string `json:"originalId"`
	NewID      string `json:"newId"`
	NewKind    string `json:"newKind"`
	NewYaml    string `json:"newYaml"`
}

func NewBlockExtracted(originalID, newID, newKind, newYaml string) BlockExtracted {
	return BlockExtracted{Type: MsgBlockExtracted, OriginalID: originalID, NewID: newID, NewKind: newKind, NewYaml: newYaml}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./sieve/protocol/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add sieve/protocol/
git commit -m "feat(protocol): typed WS message structs and constants with wire-fidelity tests"
```

---

### Task 2: `sieve/protocol` — SSE events, JobInfo move, JSON endpoint structs

**Files:**
- Create: `sieve/protocol/events.go`, `sieve/protocol/endpoints.go`
- Modify: `sieve/services/job_tracker.go` (move `JobInfo` out, alias in), plus its tests
- Test: `sieve/protocol/endpoints_test.go`

**Interfaces:**
- Produces: constants `EventNotesChanged, EventPromptsChanged, EventSessionChanged, EventLibraryChanged, EventJobsChanged`; types `JobInfo`, `JobsChanged{Active, Queued []JobInfo}`, `LoadResponse`, `SaveRequest`, `SaveResponse`, `SmartPasteRequest`, `SmartPasteResponse`, `PasteSliceRequest`, `PasteSliceResponse`, `DetectExtractionsRequest`, `AckResponse`.
- Consumes: `block.ContentEntry`, `block.FrontendBlock`.

- [ ] **Step 1: Inspect the current JobInfo definition**

Run: `grep -n -B2 -A12 "type JobInfo struct" sieve/services/job_tracker.go`
Copy the struct **verbatim** (field names AND json tags) for the next step. Also note every use: `grep -rn "JobInfo" --include="*.go" | grep -v _test`.

- [ ] **Step 2: Write the failing test**

`sieve/protocol/endpoints_test.go`:

```go
package protocol

import (
	"encoding/json"
	"testing"
)

func TestEventNames(t *testing.T) {
	want := map[string]string{
		EventNotesChanged: "notes:changed", EventPromptsChanged: "prompts:changed",
		EventSessionChanged: "session:changed", EventLibraryChanged: "library:changed",
		EventJobsChanged: "jobs:changed",
	}
	for got, expect := range want {
		if got != expect {
			t.Errorf("event constant %q != %q", got, expect)
		}
	}
}

func TestEndpointWireFidelity(t *testing.T) {
	b, _ := json.Marshal(SaveResponse{Version: 3})
	if string(b) != `{"version":3}` {
		t.Errorf("SaveResponse: %s", b)
	}
	b, _ = json.Marshal(AckResponse{Queued: true})
	if string(b) != `{"queued":true}` {
		t.Errorf("AckResponse: %s", b)
	}
	b, _ = json.Marshal(SmartPasteResponse{Matched: true, Kind: "code", ID: "b1", RawYaml: "y"})
	if string(b) != `{"matched":true,"kind":"code","id":"b1","rawYaml":"y"}` {
		t.Errorf("SmartPasteResponse: %s", b)
	}
	b, _ = json.Marshal(LoadResponse{Body: "x", Mode: "wysiwyg", UUID: "u"})
	if string(b) != `{"body":"x","mode":"wysiwyg","uuid":"u"}` {
		t.Errorf("LoadResponse: %s", b)
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./sieve/protocol/`
Expected: FAIL — undefined identifiers.

- [ ] **Step 4: Write `sieve/protocol/events.go`**

```go
package protocol

// SSE event names broadcast on /sse. Payloads for signal-only events are "{}".
const (
	EventNotesChanged   = "notes:changed"
	EventPromptsChanged = "prompts:changed"
	EventSessionChanged = "session:changed"
	EventLibraryChanged = "library:changed"
	EventJobsChanged    = "jobs:changed"
)

// JobInfo is the wire shape of one tracked job (jobs:changed payload and
// GET /api/jobs). Moved here from services so the wire type lives with the
// contract; services.JobTracker is the owner of its lifecycle.
// NOTE TO IMPLEMENTER: replace these fields with the verbatim struct copied in
// Step 1 if it differs — json tags must not change.
type JobInfo struct {
	JobID    string `json:"jobId"`
	Label    string `json:"label"`
	DocID    string `json:"docId,omitempty"`
	SpinTab  bool   `json:"spinTab"`
	State    string `json:"state"`
	Category string `json:"category,omitempty"`
}

// JobsChanged is both the jobs:changed SSE payload and the /api/jobs response.
type JobsChanged struct {
	Active []JobInfo `json:"active"`
	Queued []JobInfo `json:"queued"`
}
```

- [ ] **Step 5: Write `sieve/protocol/endpoints.go`** (shapes copied verbatim from `requesthandlers/editor_handler.go` / `ai_handler.go`)

```go
package protocol

import "sieve/sieve/block"

// GET /api/editor/load?uuid=… response.
type LoadResponse struct {
	Body   string                `json:"body"`
	Mode   string                `json:"mode"`
	UUID   string                `json:"uuid"`
	Blocks []block.FrontendBlock `json:"blocks,omitempty"`
}

// POST /api/editor/save?uuid=… request/response.
type SaveRequest struct {
	Body string `json:"body"`
	Mode string `json:"mode"`
}

type SaveResponse struct {
	Version int `json:"version"`
}

// POST /api/editor/smart-paste request/response.
type SmartPasteRequest struct {
	UUID    string               `json:"uuid"`
	Entries []block.ContentEntry `json:"entries"`
	Index   int                  `json:"index"`
}

type SmartPasteResponse struct {
	Matched bool   `json:"matched"`
	Kind    string `json:"kind,omitempty"`
	ID      string `json:"id,omitempty"`
	RawYaml string `json:"rawYaml,omitempty"`
}

// POST /api/editor/paste-slice request/response.
type PasteSliceRequest struct {
	UUID  string                 `json:"uuid"`
	Slice [][]block.ContentEntry `json:"slice"`
	Index int                    `json:"index"`
}

type PasteSliceResponse struct {
	Blocks []block.FrontendBlock `json:"blocks"`
}

// POST /api/detect-extractions request; response is []block.SupportedActions.
type DetectExtractionsRequest struct {
	SourceKind string               `json:"sourceKind"`
	Entries    []block.ContentEntry `json:"entries"`
}

// POST /api/ai/* fire-and-forget acknowledgement.
type AckResponse struct {
	Queued bool `json:"queued"`
}
```

- [ ] **Step 6: Move JobInfo usage in services**

In `sieve/services/job_tracker.go`: delete the local `JobInfo` struct, add import `"sieve/sieve/protocol"`, and add a type alias so every existing reference keeps compiling:

```go
// JobInfo's wire shape lives in protocol (the contract SSoT); alias keeps
// existing call sites and tests unchanged.
type JobInfo = protocol.JobInfo
```

Replace the literal at `sieve/services/job_tracker.go:93`: `t.Broadcast("jobs:changed", string(data))` → `t.Broadcast(protocol.EventJobsChanged, string(data))`. If `ServeJobs`/broadcast marshal an anonymous `{active,queued}` struct, switch it to `protocol.JobsChanged`.

- [ ] **Step 7: Run tests**

Run: `go build ./... && go test ./sieve/protocol/ ./sieve/services/`
Expected: PASS (job_tracker tests still green — wire unchanged).

- [ ] **Step 8: Commit**

```bash
git add sieve/protocol/ sieve/services/
git commit -m "feat(protocol): SSE event constants, JSON endpoint structs; move JobInfo wire type into protocol"
```

---

### Task 3: `sieve/protocol` — the Registry

**Files:**
- Create: `sieve/protocol/registry.go`
- Test: `sieve/protocol/registry_test.go`

**Interfaces:**
- Produces:

```go
type Direction string
const (DirClientToServer Direction = "client-to-server"; DirServerToClient Direction = "server-to-client")

type WSMessageDef struct { Type string; Dir Direction; Payload reflect.Type; Doc string }
type SSEEventDef struct { Name string; Payload reflect.Type; Doc string } // Payload nil ⇒ "{}"
type EndpointDef struct { Method, Path string; Request, Response reflect.Type; Doc string } // nil ⇒ none

func NewRegistry() *Registry
func (r *Registry) WSMessages() []WSMessageDef
func (r *Registry) WSInboundTypes() []string   // sorted type strings, Dir == DirClientToServer
func (r *Registry) SSEEvents() []SSEEventDef
func (r *Registry) Endpoints() []EndpointDef
```

- [ ] **Step 1: Write the failing test**

```go
package protocol

import "testing"

func TestRegistryInvariants(t *testing.T) {
	r := NewRegistry()
	if n := len(r.WSMessages()); n != 17 {
		t.Errorf("expected 17 WS messages (8 in + 9 out), got %d", n)
	}
	seen := map[string]bool{}
	for _, m := range r.WSMessages() {
		if m.Doc == "" || m.Payload == nil {
			t.Errorf("WS %q: missing Doc or Payload", m.Type)
		}
		if seen[m.Type] {
			t.Errorf("duplicate WS type %q", m.Type)
		}
		seen[m.Type] = true
	}
	if n := len(r.SSEEvents()); n != 5 {
		t.Errorf("expected 5 SSE events, got %d", n)
	}
	if n := len(r.Endpoints()); n != 9 {
		t.Errorf("expected 9 JSON endpoints, got %d", n)
	}
	in := r.WSInboundTypes()
	if len(in) != 8 {
		t.Errorf("expected 8 inbound types, got %v", in)
	}
}
```

- [ ] **Step 2: Run test to verify it fails** — `go test ./sieve/protocol/` → FAIL (undefined `NewRegistry`).

- [ ] **Step 3: Write `sieve/protocol/registry.go`**

```go
package protocol

import (
	"reflect"
	"sort"

	"sieve/sieve/block"
)

type Direction string

const (
	DirClientToServer Direction = "client-to-server"
	DirServerToClient Direction = "server-to-client"
)

type WSMessageDef struct {
	Type    string
	Dir     Direction
	Payload reflect.Type
	Doc     string
}

type SSEEventDef struct {
	Name    string
	Payload reflect.Type // nil ⇒ empty "{}" signal
	Doc     string
}

type EndpointDef struct {
	Method   string
	Path     string
	Request  reflect.Type // nil ⇒ no JSON body
	Response reflect.Type
	Doc      string
}

// Registry is the enumerable index of the wire contract. The generator walks
// it; contract tests compare handlers against it.
type Registry struct {
	ws        []WSMessageDef
	sse       []SSEEventDef
	endpoints []EndpointDef
}

func typeOf(v interface{}) reflect.Type { return reflect.TypeOf(v) }

func NewRegistry() *Registry {
	r := &Registry{}
	// ── WS client → server ──
	r.ws = append(r.ws,
		WSMessageDef{MsgPing, DirClientToServer, typeOf(Ping{}), "Heartbeat; server replies pong."},
		WSMessageDef{MsgDocUpdate, DirClientToServer, typeOf(DocUpdate{}), "Buffer pending markdown (debounced write)."},
		WSMessageDef{MsgFlush, DirClientToServer, typeOf(Flush{}), "Force-flush pending writes to disk; server acks flush-ack."},
		WSMessageDef{MsgEnterMarkdown, DirClientToServer, typeOf(EnterMarkdown{}), "Switch to markdown mode; server returns merged markdown-content."},
		WSMessageDef{MsgEnterWysiwyg, DirClientToServer, typeOf(EnterWysiwyg{}), "Switch to WYSIWYG; optionally adopt textarea markdown; server returns wysiwyg-content."},
		WSMessageDef{MsgRetryBlockJob, DirClientToServer, typeOf(RetryBlockJob{}), "Reset a block's job to pending and re-dispatch."},
		WSMessageDef{MsgExtract, DirClientToServer, typeOf(Extract{}), "Create a block from paste-matched ContentEntry slice (extract/paste/transform)."},
		WSMessageDef{MsgBlockOp, DirClientToServer, typeOf(BlockOpMsg{}), "Apply one granular block operation (create/update/delete/move)."},
	)
	// ── WS server → client ──
	r.ws = append(r.ws,
		WSMessageDef{MsgPong, DirServerToClient, typeOf(Pong{}), "Heartbeat reply."},
		WSMessageDef{MsgFlushAck, DirServerToClient, typeOf(FlushAck{}), "Document persisted to disk."},
		WSMessageDef{MsgError, DirServerToClient, typeOf(ErrorMsg{}), "Operation failed; message is user-displayable."},
		WSMessageDef{MsgMarkdownContent, DirServerToClient, typeOf(MarkdownContent{}), "Merged markdown after enter-markdown."},
		WSMessageDef{MsgWysiwygContent, DirServerToClient, typeOf(WysiwygContent{}), "Reparsed block list after enter-wysiwyg."},
		WSMessageDef{MsgInsertBlock, DirServerToClient, typeOf(InsertBlock{}), "Server-created block render-back; client inserts the authoritative node at index."},
		WSMessageDef{MsgBlockAttrsUpdated, DirServerToClient, typeOf(BlockAttrsUpdated{}), "Block attrs changed (e.g. job status)."},
		WSMessageDef{MsgReplaceBlock, DirServerToClient, typeOf(ReplaceBlock{}), "In-place block transformation render-back."},
		WSMessageDef{MsgBlockExtracted, DirServerToClient, typeOf(BlockExtracted{}), "Extraction/paste succeeded; client swaps its placeholder."},
	)
	// ── SSE ──
	r.sse = append(r.sse,
		SSEEventDef{EventNotesChanged, nil, "Note tree changed (create/delete/move/rename/intent); refresh sidebar."},
		SSEEventDef{EventPromptsChanged, nil, "Prompt saved/deleted/reverted; refresh prompts panel."},
		SSEEventDef{EventSessionChanged, nil, "Tabs opened/closed/reordered; refresh session UI."},
		SSEEventDef{EventLibraryChanged, nil, "Library switched; rebuild layout in place."},
		SSEEventDef{EventJobsChanged, typeOf(JobsChanged{}), "Job tracker state; update spinner and queue panel."},
	)
	// ── JSON endpoints ──
	r.endpoints = append(r.endpoints,
		EndpointDef{"GET", "/api/editor/load", nil, typeOf(LoadResponse{}), "Load a document (query: uuid; prompt:name loads a prompt). WYSIWYG mode includes blocks."},
		EndpointDef{"POST", "/api/editor/save", typeOf(SaveRequest{}), typeOf(SaveResponse{}), "Save body + mode (query: uuid)."},
		EndpointDef{"POST", "/api/editor/smart-paste", typeOf(SmartPasteRequest{}), typeOf(SmartPasteResponse{}), "Single-item paste match; matched=true means Go created a block and will render it back over WS."},
		EndpointDef{"POST", "/api/editor/paste-slice", typeOf(PasteSliceRequest{}), typeOf(PasteSliceResponse{}), "Multi-block paste reconstruction."},
		EndpointDef{"POST", "/api/detect-extractions", typeOf(DetectExtractionsRequest{}), typeOf([]block.SupportedActions{}), "Detect extraction targets for a selection."},
		EndpointDef{"GET", "/api/jobs", nil, typeOf(JobsChanged{}), "Current job tracker state."},
		EndpointDef{"POST", "/api/ai/smartFile/{id}", nil, typeOf(AckResponse{}), "Queue AI file-document job."},
		EndpointDef{"POST", "/api/ai/smartMetadata/{id}", nil, typeOf(AckResponse{}), "Queue AI metadata-update job."},
		EndpointDef{"POST", "/api/ai/keepAndFile/{uuid}", nil, typeOf(AckResponse{}), "Set intent=keep then queue file job."},
	)
	return r
}

func (r *Registry) WSMessages() []WSMessageDef { return r.ws }
func (r *Registry) SSEEvents() []SSEEventDef   { return r.sse }
func (r *Registry) Endpoints() []EndpointDef   { return r.endpoints }

func (r *Registry) WSInboundTypes() []string {
	var out []string
	for _, m := range r.ws {
		if m.Dir == DirClientToServer {
			out = append(out, m.Type)
		}
	}
	sort.Strings(out)
	return out
}
```

- [ ] **Step 4: Run test to verify it passes** — `go test ./sieve/protocol/` → PASS.

- [ ] **Step 5: Commit**

```bash
git add sieve/protocol/registry.go sieve/protocol/registry_test.go
git commit -m "feat(protocol): Registry enumerating WS messages, SSE events, JSON endpoints"
```

---

### Task 4: Registry-driven WS dispatch + unknown-type error

**Files:**
- Modify: `requesthandlers/ws_handler.go`
- Test: `requesthandlers/ws_dispatch_test.go`

**Interfaces:**
- Produces: `func (h *WsHandler) messageHandlers(uuid string, writeMsg func(interface{})) map[string]func(raw []byte)` — keys are exactly the registry's inbound types.
- Consumes: everything from Tasks 1–3.

- [ ] **Step 1: Write the failing completeness test**

`requesthandlers/ws_dispatch_test.go` (white-box, same package):

```go
package requesthandlers

import (
	"reflect"
	"sort"
	"testing"

	"sieve/sieve/protocol"
)

// The dispatch map and the protocol registry must agree exactly: a message
// type in one but not the other is contract drift and fails here.
func TestWSDispatchMatchesRegistry(t *testing.T) {
	h := NewWsHandler(nil)
	m := h.messageHandlers("test-uuid", func(interface{}) {})
	var got []string
	for k := range m {
		got = append(got, k)
	}
	sort.Strings(got)
	want := protocol.NewRegistry().WSInboundTypes()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("dispatch map %v != registry inbound %v", got, want)
	}
}
```

- [ ] **Step 2: Run test to verify it fails** — `go test ./requesthandlers/ -run TestWSDispatchMatchesRegistry` → FAIL (`messageHandlers` undefined).

- [ ] **Step 3: Refactor `ws_handler.go`**

Add import `"sieve/sieve/protocol"`. Add the dispatch-map method:

```go
// messageHandlers is the registry-driven dispatch table: one entry per inbound
// protocol message. TestWSDispatchMatchesRegistry pins it to protocol.Registry,
// so adding a message without registering it (or vice versa) fails the build's
// tests rather than failing silently at runtime.
func (h *WsHandler) messageHandlers(uuid string, writeMsg func(interface{})) map[string]func(raw []byte) {
	return map[string]func(raw []byte){
		protocol.MsgPing:          func([]byte) { writeMsg(protocol.NewPong()) },
		protocol.MsgDocUpdate:     func(raw []byte) { h.handleDocUpdate(uuid, raw) },
		protocol.MsgFlush:         func([]byte) { h.handleFlush(writeMsg, uuid) },
		protocol.MsgEnterMarkdown: func([]byte) { h.handleEnterMarkdown(writeMsg, uuid) },
		protocol.MsgEnterWysiwyg:  func(raw []byte) { h.handleEnterWysiwyg(uuid, raw, writeMsg) },
		protocol.MsgRetryBlockJob: func(raw []byte) { h.handleRetryBlockJob(uuid, raw, writeMsg) },
		protocol.MsgExtract:       func(raw []byte) { h.handleExtract(uuid, raw, writeMsg) },
		protocol.MsgBlockOp:       func(raw []byte) { h.handleBlockOp(uuid, raw, writeMsg) },
	}
}
```

In `handleWS`, build the map once before the read loop and replace the `switch` with:

```go
	handlers := h.messageHandlers(uuid, writeMsg)
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
		if handle, ok := handlers[msg.Type]; ok {
			handle(raw)
		} else {
			logger.Warn("ws: unknown message type", "uuid", uuid, "type", msg.Type)
			writeMsg(protocol.NewError("unknown message type: " + msg.Type))
		}
	}
```

Replace every outbound `map[string]…` literal with the protocol constructor:
- `notifySaved` and `handleFlush`: `writeMsg(protocol.NewFlushAck(uuid))`
- `handleEnterMarkdown`: `writeMsg(protocol.NewMarkdownContent(uuid, merged))`
- `handleEnterWysiwyg`: `writeMsg(protocol.NewWysiwygContent(uuid, blocks))`
- `handleBlockOp` error: `writeMsg(protocol.NewError(fmt.Sprintf("block-op %s failed: %v", msg.Op.Type, err)))`
- `handleExtract` error: `writeMsg(protocol.NewError(fmt.Sprintf("Failed to extract block: %v", err)))`
- `handleExtract` success: `writeMsg(protocol.NewBlockExtracted(p.BlockID, newID, p.TargetKind, rawYaml))`
- `OnBlockCreated`: `writeMsg(protocol.NewInsertBlock(kind, blockID, attrs, index, markdown, token))`
- `OnBlockUpdated`: `writeMsg(protocol.NewBlockAttrsUpdated(blockID, attrs))`
- `OnBlockReplaced`: `writeMsg(protocol.NewReplaceBlock(oldID, newID, newKind, attrs, markdown))`

Replace inbound anonymous decode structs with protocol types where they exist (`protocol.DocUpdate`, `protocol.EnterWysiwyg`, `protocol.RetryBlockJob`, `protocol.Extract`, `protocol.BlockOpMsg`) — keep the `p.Index = -1` default-before-decode behaviour in `handleExtract`.

- [ ] **Step 4: Run tests** — `go build ./... && go test ./requesthandlers/ ./sieve/protocol/` → PASS.

- [ ] **Step 5: Commit**

```bash
git add requesthandlers/ws_handler.go requesthandlers/ws_dispatch_test.go
git commit -m "refactor(ws): registry-driven dispatch, typed protocol messages, error reply on unknown type"
```

---

### Task 5: Sweep remaining literals — SSE broadcasts and JSON handlers onto protocol

**Files:**
- Modify: `handlers.go`, `app.go`, `requesthandlers/editor_handler.go`, `requesthandlers/ai_handler.go`

- [ ] **Step 1: Find every SSE event literal**

Run: `grep -rn '"notes:changed"\|"prompts:changed"\|"session:changed"\|"library:changed"\|"jobs:changed"' --include="*.go" . | grep -v _test | grep -v sieve/protocol`
Expected sites: `handlers.go:136,139,147,164,172`, `app.go:187,219` (list may have drifted — trust the grep).

- [ ] **Step 2: Replace each with the protocol constant**

Add import `"sieve/sieve/protocol"` to `handlers.go` and `app.go`. Replace e.g. `hub.broadcast("notes:changed", "{}")` → `hub.broadcast(protocol.EventNotesChanged, "{}")`, and `runtime.EventsEmit(a.ctx, "notes:changed")` → `runtime.EventsEmit(a.ctx, protocol.EventNotesChanged)`. Re-run the Step 1 grep: zero hits outside `sieve/protocol/` and JS/templates.

- [ ] **Step 3: JSON handlers use protocol structs**

`requesthandlers/editor_handler.go`: delete the local `loadResponse` type and the anonymous request/response structs; use `protocol.LoadResponse`, `protocol.SaveRequest`, `protocol.SaveResponse{Version: …}` (replaces `map[string]int{"version": …}`), `protocol.SmartPasteRequest/Response`, `protocol.PasteSliceRequest/Response`, `protocol.DetectExtractionsRequest`. Keep `req.Index = -1` pre-decode defaults. Replace `h.Broadcast("prompts:changed", "{}")` → `h.Broadcast(protocol.EventPromptsChanged, "{}")`.

`requesthandlers/ai_handler.go`: `ack` writes `protocol.AckResponse{Queued: true}` via `json.NewEncoder`; the `/api/jobs` nil-tracker fallback writes `protocol.JobsChanged{Active: []protocol.JobInfo{}, Queued: []protocol.JobInfo{}}`.

- [ ] **Step 4: Build and test** — `go build ./... && go test ./...` → PASS.

- [ ] **Step 5: Commit**

```bash
git add handlers.go app.go requesthandlers/
git commit -m "refactor: all SSE broadcasts and JSON endpoints use protocol constants and structs"
```

---

### Task 6: Generator core — JSON-schema reflection, spec.json, API.md emitters

**Files:**
- Create: `sieve/protocol/gen/gen.go`, `sieve/protocol/gen/schema.go`
- Test: `sieve/protocol/gen/gen_test.go`

**Interfaces:**
- Produces:

```go
type Generator struct { Reg *protocol.Registry }
func NewGenerator() *Generator
func (g *Generator) SpecJSON() ([]byte, error)   // machine-readable catalog (docs page + tests)
func (g *Generator) APIMarkdown() ([]byte, error) // docs/API.md
func (g *Generator) schemaFor(t reflect.Type) map[string]interface{}
type RouteInfo struct { Method, Path, Handler, Kind string } // Kind: "json-contract" | "htmx"
```

- [ ] **Step 1: Write the failing test**

```go
package gen

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSpecJSONContainsWholeRegistry(t *testing.T) {
	g := NewGenerator()
	b, err := g.SpecJSON()
	if err != nil {
		t.Fatal(err)
	}
	var spec struct {
		WS        []map[string]interface{} `json:"ws"`
		SSE       []map[string]interface{} `json:"sse"`
		Endpoints []map[string]interface{} `json:"endpoints"`
	}
	if err := json.Unmarshal(b, &spec); err != nil {
		t.Fatalf("spec.json is not valid JSON: %v", err)
	}
	if len(spec.WS) != 17 || len(spec.SSE) != 5 || len(spec.Endpoints) != 9 {
		t.Errorf("spec counts ws=%d sse=%d ep=%d", len(spec.WS), len(spec.SSE), len(spec.Endpoints))
	}
}

func TestAPIMarkdownMentionsEveryType(t *testing.T) {
	g := NewGenerator()
	b, err := g.APIMarkdown()
	if err != nil {
		t.Fatal(err)
	}
	md := string(b)
	for _, needle := range []string{"insert-block", "jobs:changed", "/api/editor/smart-paste", "GENERATED FILE", "blockId"} {
		if !strings.Contains(md, needle) {
			t.Errorf("API.md missing %q", needle)
		}
	}
}
```

- [ ] **Step 2: Run to verify FAIL** — `go test ./sieve/protocol/gen/` → FAIL (package missing).

- [ ] **Step 3: Write `schema.go`** — reflection to JSON-schema-ish maps:

```go
package gen

import (
	"reflect"
	"strings"
)

// schemaFor renders a Go type as a JSON-schema-ish map. Attrs bags
// (map[string]interface{}) render as open objects — per-kind attr schemas are
// explicitly out of scope for v1 (see TECH-DEBT).
func (g *Generator) schemaFor(t reflect.Type) map[string]interface{} {
	if t == nil {
		return nil
	}
	switch t.Kind() {
	case reflect.Ptr:
		s := g.schemaFor(t.Elem())
		s["nullable"] = true
		return s
	case reflect.String:
		return map[string]interface{}{"type": "string"}
	case reflect.Bool:
		return map[string]interface{}{"type": "boolean"}
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64,
		reflect.Float32, reflect.Float64:
		return map[string]interface{}{"type": "number"}
	case reflect.Slice, reflect.Array:
		return map[string]interface{}{"type": "array", "items": g.schemaFor(t.Elem())}
	case reflect.Map:
		return map[string]interface{}{"type": "object", "additionalProperties": true}
	case reflect.Interface:
		return map[string]interface{}{}
	case reflect.Struct:
		props := map[string]interface{}{}
		var required []string
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			if f.PkgPath != "" { // unexported
				continue
			}
			tag := f.Tag.Get("json")
			if tag == "-" {
				continue
			}
			name := strings.Split(tag, ",")[0]
			if name == "" {
				name = f.Name
			}
			props[name] = g.schemaFor(f.Type)
			if !strings.Contains(tag, "omitempty") && f.Type.Kind() != reflect.Ptr {
				required = append(required, name)
			}
		}
		s := map[string]interface{}{"type": "object", "properties": props}
		if len(required) > 0 {
			s["required"] = required
		}
		return s
	default:
		return map[string]interface{}{}
	}
}
```

- [ ] **Step 4: Write `gen.go`** — Generator + SpecJSON + APIMarkdown:

```go
// Package gen renders the protocol.Registry into the five committed artifacts.
// Never edit the artifacts by hand — change protocol/ and re-run
// `go generate ./sieve/protocol`.
package gen

import (
	"bytes"
	"encoding/json"
	"fmt"

	"sieve/sieve/protocol"
)

const header = "GENERATED FILE — do not edit. Source: sieve/protocol (go generate ./sieve/protocol)."

type Generator struct {
	Reg *protocol.Registry
}

func NewGenerator() *Generator { return &Generator{Reg: protocol.NewRegistry()} }

func (g *Generator) SpecJSON() ([]byte, error) {
	type wsEntry struct {
		Type   string                 `json:"type"`
		Dir    string                 `json:"dir"`
		Doc    string                 `json:"doc"`
		Schema map[string]interface{} `json:"schema"`
	}
	type sseEntry struct {
		Name   string                 `json:"name"`
		Doc    string                 `json:"doc"`
		Schema map[string]interface{} `json:"schema,omitempty"`
	}
	type epEntry struct {
		Method   string                 `json:"method"`
		Path     string                 `json:"path"`
		Doc      string                 `json:"doc"`
		Request  map[string]interface{} `json:"request,omitempty"`
		Response map[string]interface{} `json:"response,omitempty"`
	}
	spec := struct {
		Comment   string     `json:"_comment"`
		WS        []wsEntry  `json:"ws"`
		SSE       []sseEntry `json:"sse"`
		Endpoints []epEntry  `json:"endpoints"`
		Routes    []RouteInfo `json:"routes"`
	}{Comment: header}
	for _, m := range g.Reg.WSMessages() {
		spec.WS = append(spec.WS, wsEntry{m.Type, string(m.Dir), m.Doc, g.schemaFor(m.Payload)})
	}
	for _, e := range g.Reg.SSEEvents() {
		spec.SSE = append(spec.SSE, sseEntry{e.Name, e.Doc, g.schemaFor(e.Payload)})
	}
	for _, e := range g.Reg.Endpoints() {
		spec.Endpoints = append(spec.Endpoints, epEntry{e.Method, e.Path, e.Doc, g.schemaFor(e.Request), g.schemaFor(e.Response)})
	}
	routes, err := g.Routes()
	if err != nil {
		return nil, err
	}
	spec.Routes = routes
	return json.MarshalIndent(spec, "", "  ")
}

func (g *Generator) APIMarkdown() ([]byte, error) {
	var b bytes.Buffer
	fmt.Fprintf(&b, "<!-- %s -->\n\n# Sieve API\n\n", header)

	b.WriteString("## WebSocket protocol (`/api/ws?uuid=…`)\n\n")
	for _, dir := range []protocol.Direction{protocol.DirClientToServer, protocol.DirServerToClient} {
		if dir == protocol.DirClientToServer {
			b.WriteString("### Client → Server\n\n")
		} else {
			b.WriteString("### Server → Client\n\n")
		}
		b.WriteString("| Type | Payload fields | Purpose |\n|---|---|---|\n")
		for _, m := range g.Reg.WSMessages() {
			if m.Dir != dir {
				continue
			}
			fmt.Fprintf(&b, "| `%s` | %s | %s |\n", m.Type, g.fieldList(m.Payload), m.Doc)
		}
		b.WriteString("\n")
	}

	b.WriteString("## SSE events (`/sse`)\n\n| Event | Payload | Purpose |\n|---|---|---|\n")
	for _, e := range g.Reg.SSEEvents() {
		payload := "`{}` (signal)"
		if e.Payload != nil {
			payload = g.fieldList(e.Payload)
		}
		fmt.Fprintf(&b, "| `%s` | %s | %s |\n", e.Name, payload, e.Doc)
	}

	b.WriteString("\n## JSON endpoints\n\n| Method | Path | Request | Response | Purpose |\n|---|---|---|---|---|\n")
	for _, e := range g.Reg.Endpoints() {
		fmt.Fprintf(&b, "| %s | `%s` | %s | %s | %s |\n",
			e.Method, e.Path, g.fieldList(e.Request), g.fieldList(e.Response), e.Doc)
	}

	routes, err := g.Routes()
	if err != nil {
		return nil, err
	}
	b.WriteString("\n## HTMX route inventory\n\nHTML-fragment endpoints; their contract is the Go template they render.\n\n| Method | Path | Handler |\n|---|---|---|\n")
	for _, rt := range routes {
		if rt.Kind == "htmx" {
			fmt.Fprintf(&b, "| %s | `%s` | %s |\n", rt.Method, rt.Path, rt.Handler)
		}
	}
	return b.Bytes(), nil
}

// fieldList flattens a struct's json field names for table cells.
func (g *Generator) fieldList(t reflect.Type) string {
	if t == nil {
		return "—"
	}
	s := g.schemaFor(t)
	props, ok := s["properties"].(map[string]interface{})
	if !ok {
		if s["type"] == "array" {
			return "array"
		}
		return "object"
	}
	names := make([]string, 0, len(props))
	for k := range props {
		names = append(names, "`"+k+"`")
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}
```

(gen.go imports: `bytes`, `encoding/json`, `fmt`, `reflect`, `sort`, `strings`, `sieve/sieve/protocol`.)

`Routes()` does not exist yet — for this task add a stub returning `nil, nil` in `gen.go` (Task 8 replaces it):

```go
// RouteInfo describes one mounted chi route for the inventory table.
type RouteInfo struct {
	Method  string `json:"method"`
	Path    string `json:"path"`
	Handler string `json:"handler"`
	Kind    string `json:"kind"` // "json-contract" | "htmx"
}

// Routes is completed in the route-inventory task; nil keeps earlier emitters testable.
func (g *Generator) Routes() ([]RouteInfo, error) { return nil, nil }
```

- [ ] **Step 5: Run tests** — `go test ./sieve/protocol/gen/` → PASS.

- [ ] **Step 6: Commit**

```bash
git add sieve/protocol/gen/
git commit -m "feat(protocol/gen): generator core — schema reflection, spec.json and API.md emitters"
```

---

### Task 7: OpenAPI + AsyncAPI emitters

**Files:**
- Create: `sieve/protocol/gen/emit_specs.go`
- Test: append to `sieve/protocol/gen/gen_test.go`

**Interfaces:**
- Produces: `func (g *Generator) OpenAPIYAML() ([]byte, error)`, `func (g *Generator) AsyncAPIYAML() ([]byte, error)`.

- [ ] **Step 1: Write the failing test** (append to `gen_test.go`):

```go
func TestOpenAPIIsValidYAMLWithAllEndpoints(t *testing.T) {
	g := NewGenerator()
	b, err := g.OpenAPIYAML()
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]interface{}
	if err := yaml.Unmarshal(b, &doc); err != nil {
		t.Fatalf("invalid YAML: %v", err)
	}
	paths := doc["paths"].(map[string]interface{})
	if len(paths) != 9 {
		t.Errorf("expected 9 paths, got %d", len(paths))
	}
	if doc["openapi"] != "3.1.0" {
		t.Errorf("openapi version: %v", doc["openapi"])
	}
}

func TestAsyncAPIIsValidYAML(t *testing.T) {
	g := NewGenerator()
	b, err := g.AsyncAPIYAML()
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]interface{}
	if err := yaml.Unmarshal(b, &doc); err != nil {
		t.Fatalf("invalid YAML: %v", err)
	}
	if _, ok := doc["channels"]; !ok {
		t.Error("asyncapi missing channels")
	}
}
```

Add `"gopkg.in/yaml.v3"` to the test imports.

- [ ] **Step 2: Run to verify FAIL** — `go test ./sieve/protocol/gen/` → FAIL.

- [ ] **Step 3: Write `emit_specs.go`**

```go
package gen

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

func (g *Generator) OpenAPIYAML() ([]byte, error) {
	paths := map[string]interface{}{}
	for _, e := range g.Reg.Endpoints() {
		op := map[string]interface{}{
			"summary": e.Doc,
			"responses": map[string]interface{}{
				"200": map[string]interface{}{
					"description": "OK",
					"content": map[string]interface{}{
						"application/json": map[string]interface{}{"schema": g.schemaFor(e.Response)},
					},
				},
			},
		}
		if e.Request != nil {
			op["requestBody"] = map[string]interface{}{
				"required": true,
				"content": map[string]interface{}{
					"application/json": map[string]interface{}{"schema": g.schemaFor(e.Request)},
				},
			}
		}
		// chi {param} syntax matches OpenAPI path templating as-is.
		entry, _ := paths[e.Path].(map[string]interface{})
		if entry == nil {
			entry = map[string]interface{}{}
		}
		entry[strings.ToLower(e.Method)] = op
		paths[e.Path] = entry
	}
	doc := map[string]interface{}{
		"openapi": "3.1.0",
		"info": map[string]interface{}{
			"title":       "Sieve JSON API",
			"version":     "1",
			"description": header,
		},
		"paths": paths,
	}
	return yaml.Marshal(doc)
}

func (g *Generator) AsyncAPIYAML() ([]byte, error) {
	wsMessages := map[string]interface{}{}
	for _, m := range g.Reg.WSMessages() {
		wsMessages[m.Type] = map[string]interface{}{
			"name":        m.Type,
			"summary":     fmt.Sprintf("[%s] %s", m.Dir, m.Doc),
			"payload":     g.schemaFor(m.Payload),
		}
	}
	sseMessages := map[string]interface{}{}
	for _, e := range g.Reg.SSEEvents() {
		payload := g.schemaFor(e.Payload)
		if payload == nil {
			payload = map[string]interface{}{"type": "object"}
		}
		sseMessages[e.Name] = map[string]interface{}{
			"name": e.Name, "summary": e.Doc, "payload": payload,
		}
	}
	doc := map[string]interface{}{
		"asyncapi": "3.0.0",
		"info": map[string]interface{}{
			"title": "Sieve realtime protocol", "version": "1", "description": header,
		},
		"channels": map[string]interface{}{
			"editorWS": map[string]interface{}{
				"address":  "/api/ws?uuid={uuid}",
				"messages": wsMessages,
			},
			"sse": map[string]interface{}{
				"address":  "/sse",
				"messages": sseMessages,
			},
		},
	}
	return yaml.Marshal(doc)
}
```

- [ ] **Step 4: Run tests** — `go test ./sieve/protocol/gen/` → PASS.

- [ ] **Step 5: Commit**

```bash
git add sieve/protocol/gen/
git commit -m "feat(protocol/gen): OpenAPI 3.1 and AsyncAPI 3.0 emitters"
```

---

### Task 8: JS emitter, route inventory, `tools/protocolgen`, generate artifacts

**Files:**
- Create: `sieve/protocol/gen/emit_js.go`, `sieve/protocol/gen/routes.go`, `tools/protocolgen/main.go`, `sieve/protocol/generate.go`
- Modify: `sieve/protocol/gen/gen.go` (delete the `Routes()` stub)
- Generated: `docs/API.md`, `docs/api/openapi.yaml`, `docs/api/asyncapi.yaml`, `frontend/src/static/generated/protocol.js`, `frontend/src/static/generated/protocol-spec.json`
- Test: append to `gen_test.go`

**Interfaces:**
- Produces: `func (g *Generator) ProtocolJS() ([]byte, error)`, `func (g *Generator) Routes() ([]RouteInfo, error)`, `func (g *Generator) WriteAll(repoRoot string) error`.

- [ ] **Step 1: Write the failing tests** (append to `gen_test.go`):

```go
func TestProtocolJSHasEveryConstant(t *testing.T) {
	g := NewGenerator()
	b, err := g.ProtocolJS()
	if err != nil {
		t.Fatal(err)
	}
	js := string(b)
	for _, m := range g.Reg.WSMessages() {
		if !strings.Contains(js, "'"+m.Type+"'") {
			t.Errorf("protocol.js missing WS type %q", m.Type)
		}
	}
	for _, e := range g.Reg.SSEEvents() {
		if !strings.Contains(js, "'"+e.Name+"'") {
			t.Errorf("protocol.js missing SSE event %q", e.Name)
		}
	}
	if !strings.Contains(js, "window.SieveProtocol") {
		t.Error("protocol.js must assign window.SieveProtocol (editor.js is a classic script)")
	}
}

func TestRouteInventoryCoversHandlers(t *testing.T) {
	g := NewGenerator()
	routes, err := g.Routes()
	if err != nil {
		t.Fatal(err)
	}
	byPath := map[string]RouteInfo{}
	for _, r := range routes {
		byPath[r.Method+" "+r.Path] = r
	}
	if r, ok := byPath["GET /api/editor/load"]; !ok || r.Kind != "json-contract" {
		t.Errorf("load route missing or wrong kind: %+v", r)
	}
	if r, ok := byPath["GET /api/sidebar"]; !ok || r.Kind != "htmx" {
		t.Errorf("sidebar route missing or wrong kind: %+v", r)
	}
}
```

- [ ] **Step 2: Run to verify FAIL** — `go test ./sieve/protocol/gen/` → FAIL.

- [ ] **Step 3: Write `emit_js.go`**

JS naming: `SCREAMING_SNAKE` of the type string (`doc-update` → `DOC_UPDATE`, `notes:changed` → `NOTES_CHANGED`).

```go
package gen

import (
	"bytes"
	"fmt"
	"strings"
)

func jsConstName(wire string) string {
	s := strings.NewReplacer("-", "_", ":", "_").Replace(wire)
	return strings.ToUpper(s)
}

// ProtocolJS renders the frontend constants module. It is an ES module (usable
// via import) that ALSO assigns window.SieveProtocol, because editor.js is a
// classic IIFE script that reads the global lazily at runtime.
func (g *Generator) ProtocolJS() ([]byte, error) {
	var b bytes.Buffer
	fmt.Fprintf(&b, "// %s\n\n", header)
	b.WriteString("export const MSG = {\n")
	for _, m := range g.Reg.WSMessages() {
		fmt.Fprintf(&b, "  %s: '%s',\n", jsConstName(m.Type), m.Type)
	}
	b.WriteString("}\n\nexport const SSE = {\n")
	for _, e := range g.Reg.SSEEvents() {
		fmt.Fprintf(&b, "  %s: '%s',\n", jsConstName(e.Name), e.Name)
	}
	b.WriteString("}\n\nwindow.SieveProtocol = { MSG, SSE }\n")
	return b.Bytes(), nil
}
```

- [ ] **Step 4: Write `routes.go`** — per-handler registration onto fresh routers for attribution:

```go
package gen

import (
	"net/http"
	"reflect"
	"sort"

	"github.com/go-chi/chi/v5"

	"sieve/requesthandlers"
)

// Routes builds each RequestHandler zero-valued, registers it on a fresh chi
// router, and walks the result. RegisterPaths only mounts routes (handlers are
// not invoked), so nil service fields are safe. Root-level routes registered
// inline in handlers.go (/, /sse, /static/*, /sieve/{uuid}/{filename}) are
// appended as a static list — keep it in sync when handlers.go changes.
func (g *Generator) Routes() ([]RouteInfo, error) {
	handlers := []requesthandlers.RequestHandler{
		&requesthandlers.SideBarHandler{},
		&requesthandlers.TabHandler{},
		&requesthandlers.ContextMenuHandler{},
		&requesthandlers.MetaHandler{},
		&requesthandlers.EditorHandler{},
		&requesthandlers.SettingsHandler{},
		&requesthandlers.HelpHandler{},
		&requesthandlers.SearchHandler{},
		&requesthandlers.AssetHandler{},
		&requesthandlers.PromptsHandler{},
		&requesthandlers.SessionHandler{},
		&requesthandlers.NoteHandler{},
		&requesthandlers.AiHandler{},
		requesthandlers.NewWsHandler(nil),
	}

	jsonPaths := map[string]bool{}
	for _, e := range g.Reg.Endpoints() {
		jsonPaths[e.Method+" "+e.Path] = true
	}

	var out []RouteInfo
	for _, h := range handlers {
		name := reflect.TypeOf(h).Elem().Name()
		r := chi.NewRouter()
		h.RegisterPaths(r)
		if err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
			kind := "htmx"
			if jsonPaths[method+" "+route] {
				kind = "json-contract"
			}
			out = append(out, RouteInfo{Method: method, Path: route, Handler: name, Kind: kind})
			return nil
		}); err != nil {
			return nil, err
		}
	}
	out = append(out,
		RouteInfo{Method: "GET", Path: "/", Handler: "apiHandler (handlers.go)", Kind: "htmx"},
		RouteInfo{Method: "GET", Path: "/sse", Handler: "sseHub (sse.go)", Kind: "htmx"},
		RouteInfo{Method: "GET", Path: "/static/*", Handler: "apiHandler (handlers.go)", Kind: "htmx"},
		RouteInfo{Method: "GET", Path: "/sieve/{uuid}/{filename}", Handler: "AssetHandler", Kind: "htmx"},
	)
	sort.Slice(out, func(i, j int) bool {
		if out[i].Path != out[j].Path {
			return out[i].Path < out[j].Path
		}
		return out[i].Method < out[j].Method
	})
	return out, nil
}
```

(routes.go imports: `net/http`, `reflect`, `sort`, `github.com/go-chi/chi/v5`, `sieve/requesthandlers`. `chi.Walk` signature: `chi.Walk(r chi.Routes, walkFn chi.WalkFunc) error` with `WalkFunc = func(method, route string, handler http.Handler, middlewares ...func(http.Handler) http.Handler) error`.) Delete the `Routes()` stub from `gen.go`. If any handler's `RegisterPaths` panics on nil fields, guard in the generator (construct that handler with the minimal non-nil field), not by changing the handler.

- [ ] **Step 5: Write `WriteAll` (append to `gen.go`) + `tools/protocolgen/main.go` + `go:generate` hook**

```go
// WriteAll emits every artifact under repoRoot. Paths are the contract's
// committed locations — the generated-files-current test depends on them.
func (g *Generator) WriteAll(repoRoot string) error {
	emit := []struct {
		rel string
		fn  func() ([]byte, error)
	}{
		{"docs/API.md", g.APIMarkdown},
		{"docs/api/openapi.yaml", g.OpenAPIYAML},
		{"docs/api/asyncapi.yaml", g.AsyncAPIYAML},
		{"frontend/src/static/generated/protocol.js", g.ProtocolJS},
		{"frontend/src/static/generated/protocol-spec.json", g.SpecJSON},
	}
	for _, e := range emit {
		data, err := e.fn()
		if err != nil {
			return fmt.Errorf("%s: %w", e.rel, err)
		}
		path := filepath.Join(repoRoot, e.rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			return err
		}
	}
	return nil
}
```

`tools/protocolgen/main.go`:

```go
// Command protocolgen regenerates the committed API-contract artifacts from
// sieve/protocol. Run via: go generate ./sieve/protocol
package main

import (
	"fmt"
	"os"

	"sieve/sieve/protocol/gen"
)

func main() {
	root := "."
	if len(os.Args) > 1 {
		root = os.Args[1]
	}
	if err := gen.NewGenerator().WriteAll(root); err != nil {
		fmt.Fprintln(os.Stderr, "protocolgen:", err)
		os.Exit(1)
	}
	fmt.Println("protocolgen: artifacts written")
}
```

`sieve/protocol/generate.go`:

```go
package protocol

//go:generate go run sieve/tools/protocolgen ../..
```

- [ ] **Step 6: Run tests, generate, inspect**

```bash
go test ./sieve/protocol/gen/     # PASS
go generate ./sieve/protocol      # writes 5 artifacts
head -30 docs/API.md              # eyeball the tables
```

- [ ] **Step 7: Commit (including generated artifacts)**

```bash
git add sieve/protocol/ tools/ docs/API.md docs/api/ frontend/src/static/generated/
git commit -m "feat(protocol/gen): JS constants + route inventory emitters; generate and commit all five artifacts"
```

---

### Task 9: Contract test — generated files are current

**Files:**
- Test: `sieve/protocol/gen/current_test.go`

- [ ] **Step 1: Write the test**

```go
package gen

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// Any change to sieve/protocol without re-running `go generate ./sieve/protocol`
// fails here — the committed artifacts ARE the golden files.
func TestGeneratedArtifactsAreCurrent(t *testing.T) {
	_, thisFile, _, _ := runtime.Caller(0)
	repoRoot := filepath.Join(filepath.Dir(thisFile), "..", "..", "..")

	g := NewGenerator()
	artifacts := []struct {
		rel string
		fn  func() ([]byte, error)
	}{
		{"docs/API.md", g.APIMarkdown},
		{"docs/api/openapi.yaml", g.OpenAPIYAML},
		{"docs/api/asyncapi.yaml", g.AsyncAPIYAML},
		{"frontend/src/static/generated/protocol.js", g.ProtocolJS},
		{"frontend/src/static/generated/protocol-spec.json", g.SpecJSON},
	}
	for _, a := range artifacts {
		want, err := a.fn()
		if err != nil {
			t.Fatalf("%s: generate: %v", a.rel, err)
		}
		got, err := os.ReadFile(filepath.Join(repoRoot, a.rel))
		if err != nil {
			t.Fatalf("%s: read committed artifact: %v (run `go generate ./sieve/protocol`)", a.rel, err)
		}
		if string(got) != string(want) {
			t.Errorf("%s is stale — run `go generate ./sieve/protocol` and commit", a.rel)
		}
	}
}
```

- [ ] **Step 2: Verify it passes, then verify it actually guards**

```bash
go test ./sieve/protocol/gen/ -run TestGeneratedArtifactsAreCurrent   # PASS
```
Temporarily edit a Doc string in `registry.go`, re-run → must FAIL with "stale". Revert the edit, re-run → PASS.

- [ ] **Step 3: Commit**

```bash
git add sieve/protocol/gen/current_test.go
git commit -m "test(protocol): generated artifacts must match the registry (drift fails go test)"
```

---

### Task 10: editor.js consumes generated constants

**Files:**
- Modify: `frontend/src/static/editor/editor.js`, `frontend/src/index.html`

- [ ] **Step 1: Load protocol.js before editor.js**

In `frontend/src/index.html`, add **above** the script tag that loads `editor.js`:

```html
    <script type="module" src="/static/generated/protocol.js"></script>
```

(Timing is safe: editor.js only reads `window.SieveProtocol` inside functions that run on user events, long after modules execute. Remember: index.html is embedded — touch a `.go` file for `wails dev` to pick it up.)

- [ ] **Step 2: Replace the literals**

At the top of the IIFE in editor.js add:

```js
  // Wire constants come from the generated contract (window.SieveProtocol,
  // /static/generated/protocol.js). Never write a message-type literal here.
  function proto() { return window.SieveProtocol }
```

Then replace every WS message-type string literal using this mapping (find them: `grep -n "'ping'\|'pong'\|'doc-update'\|'flush'\|'flush-ack'\|'enter-markdown'\|'enter-wysiwyg'\|'retry-block-job'\|'extract'\|'block-op'\|'markdown-content'\|'wysiwyg-content'\|'insert-block'\|'block-attrs-updated'\|'replace-block'\|'block-extracted'\|'error'" frontend/src/static/editor/editor.js`):

| Literal | Replacement |
|---|---|
| `'ping'` | `proto().MSG.PING` |
| `'pong'` | `proto().MSG.PONG` |
| `'doc-update'` | `proto().MSG.DOC_UPDATE` |
| `'flush'` | `proto().MSG.FLUSH` |
| `'flush-ack'` | `proto().MSG.FLUSH_ACK` |
| `'error'` (WS msg type only — NOT DOM/event strings) | `proto().MSG.ERROR` |
| `'enter-markdown'` | `proto().MSG.ENTER_MARKDOWN` |
| `'enter-wysiwyg'` | `proto().MSG.ENTER_WYSIWYG` |
| `'retry-block-job'` | `proto().MSG.RETRY_BLOCK_JOB` |
| `'extract'` (WS send sites only) | `proto().MSG.EXTRACT` |
| `'block-op'` | `proto().MSG.BLOCK_OP` |
| `'markdown-content'` | `proto().MSG.MARKDOWN_CONTENT` |
| `'wysiwyg-content'` | `proto().MSG.WYSIWYG_CONTENT` |
| `'insert-block'` | `proto().MSG.INSERT_BLOCK` |
| `'block-attrs-updated'` | `proto().MSG.BLOCK_ATTRS_UPDATED` |
| `'replace-block'` | `proto().MSG.REPLACE_BLOCK` |
| `'block-extracted'` | `proto().MSG.BLOCK_EXTRACTED` |

Judgment rule for ambiguous hits (`'extract'`, `'error'`): replace only where the string is a WS `type` field value (in `send({type: …})` calls, `msg.type` comparisons, and `editorWsAwaiters` keys) — not CSS classes, DOM event names, or `block.Action` operation values.

- [ ] **Step 3: Verify by grep and by running**

```bash
grep -n "type: '" frontend/src/static/editor/editor.js        # expect 0 WS-send hits
grep -c "proto().MSG" frontend/src/static/editor/editor.js    # expect ≈ number of former literals
```
Then run the app (`wails dev`), open a note, type (doc-update flows), save (flush-ack), toggle markdown mode and back, paste a URL — watch the console for errors. Drive it headless against `:34115` if preferred.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/static/editor/editor.js frontend/src/index.html
git commit -m "refactor(frontend): editor.js uses generated protocol constants via window.SieveProtocol"
```

---

### Task 11: HTTP endpoint contract tests

**Files:**
- Test: `requesthandlers/contract_test.go`

- [ ] **Step 1: Write the test**

Strategy: for endpoints exercisable without full service wiring, hit the real handler with `httptest` and assert the response unmarshals into the protocol struct with `DisallowUnknownFields` — i.e. the handler emits no field the contract doesn't know.

```go
package requesthandlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"sieve/sieve/protocol"
)

func decodeStrict(t *testing.T, data []byte, into interface{}) {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		t.Errorf("response does not match contract struct %T: %v\nbody: %s", into, err, data)
	}
}

// /api/jobs with a nil tracker exercises the handler's own fallback encoding.
func TestJobsEndpointMatchesContract(t *testing.T) {
	h := &AiHandler{}
	r := chi.NewRouter()
	h.RegisterPaths(r)
	req := httptest.NewRequest(http.MethodGet, "/api/jobs", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	var resp protocol.JobsChanged
	decodeStrict(t, rec.Body.Bytes(), &resp)
}
```

Extend with the endpoints that CAN be served with lightweight wiring — follow how existing tests in this repo construct a `ServiceProvider` (check `grep -rln "ServiceProvider" --include="*_test.go"` for the established pattern; reuse it rather than inventing seams). Minimum additional coverage: `/api/editor/load` for an unknown uuid (returns the empty `LoadResponse`) and `/api/ai/smartFile/{id}` for a missing doc (404 — no body contract). If the repo has no service-construction test helper, cover only the two above and leave a `// TODO(next)` note in the test listing which endpoints need the helper — and record it in the TECH-DEBT entry of Task 13.

- [ ] **Step 2: Run** — `go test ./requesthandlers/ -run Contract` → PASS.

- [ ] **Step 3: Commit**

```bash
git add requesthandlers/contract_test.go
git commit -m "test(contract): JSON endpoint responses validate strictly against protocol structs"
```

---

### Task 12: Dev-only `/api/docs` test ground

**Files:**
- Create: `requesthandlers/docs_handler.go`, `frontend/src/templates/api-docs.html`
- Modify: `handlers.go` (register handler), `app.go` (IsDevBuild method)

**Interfaces:**
- Produces: `DocsHandler{Tmpl *template.Template; IsDev func() bool}`; `func (a *App) IsDevBuild() bool`.

- [ ] **Step 1: `app.go` — dev detection**

```go
// IsDevBuild reports whether this is a `wails dev` / debug build. Used to gate
// the /api/docs test ground out of production binaries.
func (a *App) IsDevBuild() bool {
	if a.ctx == nil {
		return false
	}
	return runtime.Environment(a.ctx).BuildType != "production"
}
```

(`runtime` = `github.com/wailsapp/wails/v2/pkg/runtime`, already imported in app.go.)

- [ ] **Step 2: `requesthandlers/docs_handler.go`**

```go
package requesthandlers

import (
	"html/template"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// DocsHandler serves the dev-only API test ground. Gated by IsDev — in
// production builds the route 404s.
type DocsHandler struct {
	Tmpl  *template.Template
	IsDev func() bool
}

func (h *DocsHandler) RegisterPaths(r chi.Router) {
	r.Get("/api/docs", h.handleDocs)
}

func (h *DocsHandler) handleDocs(w http.ResponseWriter, r *http.Request) {
	if h.IsDev == nil || !h.IsDev() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := h.Tmpl.ExecuteTemplate(w, "api-docs.html", nil); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
```

Register in `handlers.go`'s `requestHandlers` slice: `&requesthandlers.DocsHandler{Tmpl: tmpl, IsDev: app.IsDevBuild},`

- [ ] **Step 3: `frontend/src/templates/api-docs.html`** — self-contained vanilla page:

```html
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Sieve API — dev test ground</title>
<style>
  body { font-family: monospace; margin: 0; display: grid; grid-template-columns: 1fr 420px; height: 100vh; }
  main { overflow-y: auto; padding: 1rem 2rem; }
  aside { border-left: 1px solid #ccc; display: flex; flex-direction: column; overflow: hidden; }
  h1 { font-size: 1.2rem; } h2 { font-size: 1rem; margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  td, th { border: 1px solid #ddd; padding: 4px 8px; text-align: left; vertical-align: top; }
  details { margin: 2px 0; } summary { cursor: pointer; }
  pre { background: #f6f6f6; padding: 6px; overflow-x: auto; font-size: 11px; }
  .pane { flex: 1; display: flex; flex-direction: column; min-height: 0; border-bottom: 1px solid #ccc; }
  .pane h3 { margin: 0; padding: 6px 10px; background: #eee; font-size: 12px; }
  .log { flex: 1; overflow-y: auto; padding: 6px 10px; font-size: 11px; white-space: pre-wrap; }
  .ctl { display: flex; gap: 4px; padding: 6px; }
  .ctl input, .ctl textarea { flex: 1; font-family: monospace; font-size: 11px; }
</style>
</head>
<body>
<main>
  <h1>Sieve API — dev test ground</h1>
  <p>Rendered live from <code>/static/generated/protocol-spec.json</code>. Raw specs:
     <a href="/static/generated/protocol-spec.json">spec.json</a></p>
  <div id="catalog">loading…</div>
</main>
<aside>
  <div class="pane">
    <h3>SSE feed (/sse)</h3>
    <div class="log" id="sse-log"></div>
  </div>
  <div class="pane">
    <h3>WS console (/api/ws)</h3>
    <div class="ctl"><input id="ws-uuid" placeholder="document uuid"><button id="ws-connect">connect</button></div>
    <div class="ctl"><textarea id="ws-msg" rows="3" placeholder='{"type":"ping"}'></textarea><button id="ws-send">send</button></div>
    <div class="log" id="ws-log"></div>
  </div>
</aside>
<script>
(function () {
  'use strict'
  function log(id, cls, text) {
    var el = document.getElementById(id)
    el.textContent += '[' + new Date().toISOString().slice(11, 19) + '] ' + cls + ' ' + text + '\n'
    el.scrollTop = el.scrollHeight
  }
  function schemaBlock(s) {
    return s ? '<details><summary>schema</summary><pre>' + JSON.stringify(s, null, 2) + '</pre></details>' : '—'
  }
  fetch('/static/generated/protocol-spec.json').then(function (r) { return r.json() }).then(function (spec) {
    var h = ''
    h += '<h2>WebSocket messages</h2><table><tr><th>type</th><th>dir</th><th>doc</th><th>payload</th></tr>'
    spec.ws.forEach(function (m) {
      h += '<tr><td><b>' + m.type + '</b></td><td>' + m.dir + '</td><td>' + m.doc + '</td><td>' + schemaBlock(m.schema) + '</td></tr>'
    })
    h += '</table><h2>SSE events</h2><table><tr><th>event</th><th>doc</th><th>payload</th></tr>'
    spec.sse.forEach(function (e) {
      h += '<tr><td><b>' + e.name + '</b></td><td>' + e.doc + '</td><td>' + schemaBlock(e.schema) + '</td></tr>'
    })
    h += '</table><h2>JSON endpoints</h2><table><tr><th>method</th><th>path</th><th>doc</th><th>request</th><th>response</th></tr>'
    spec.endpoints.forEach(function (e) {
      h += '<tr><td>' + e.method + '</td><td><b>' + e.path + '</b></td><td>' + e.doc + '</td><td>' + schemaBlock(e.request) + '</td><td>' + schemaBlock(e.response) + '</td></tr>'
    })
    h += '</table><h2>Full route inventory</h2><table><tr><th>method</th><th>path</th><th>handler</th><th>kind</th></tr>'
    spec.routes.forEach(function (r) {
      h += '<tr><td>' + r.method + '</td><td>' + r.path + '</td><td>' + r.handler + '</td><td>' + r.kind + '</td></tr>'
    })
    h += '</table>'
    document.getElementById('catalog').innerHTML = h

    var es = new EventSource('/sse')
    spec.sse.forEach(function (e) {
      es.addEventListener(e.name, function (ev) { log('sse-log', e.name, ev.data) })
    })
    es.onerror = function () { log('sse-log', 'sse', 'connection error') }
  })

  var ws = null
  document.getElementById('ws-connect').onclick = function () {
    var uuid = document.getElementById('ws-uuid').value.trim()
    if (!uuid) { log('ws-log', '!', 'enter a uuid (open a doc in the app, check /api/jobs or session)'); return }
    if (ws) ws.close()
    ws = new WebSocket('ws://' + location.host + '/api/ws?uuid=' + encodeURIComponent(uuid))
    ws.onopen = function () { log('ws-log', '✓', 'connected ' + uuid) }
    ws.onclose = function () { log('ws-log', '✗', 'closed') }
    ws.onmessage = function (ev) { log('ws-log', '←', ev.data) }
  }
  document.getElementById('ws-send').onclick = function () {
    if (!ws || ws.readyState !== 1) { log('ws-log', '!', 'not connected'); return }
    var raw = document.getElementById('ws-msg').value
    try { JSON.parse(raw) } catch (e) { log('ws-log', '!', 'invalid JSON: ' + e.message); return }
    ws.send(raw); log('ws-log', '→', raw)
  }
})()
</script>
</body>
</html>
```

**Caution:** the WS console attaches a second listener to a doc's shadow — same-doc single-listener constraints apply (`project_sieve_block_constraints`); connect to a doc NOT open in the app, or accept that the app's connection wins. Note this in the page later if it bites.

- [ ] **Step 4: Verify in dev**

Run `wails dev`, browse `http://localhost:34115/api/docs` (drive headless Chrome if preferred): catalog renders, SSE pane logs a `notes:changed` when you create a note, WS console pings→pongs against a test doc uuid. Confirm the template executes (templates are embedded — touch a `.go` file first).

- [ ] **Step 5: Commit**

```bash
git add requesthandlers/docs_handler.go frontend/src/templates/api-docs.html handlers.go app.go
git commit -m "feat(dev): /api/docs test ground — live catalog, SSE viewer, WS console (dev builds only)"
```

---

### Task 13: CLAUDE.md upkeep rules + TECH-DEBT entries

**Files:**
- Modify: `CLAUDE.md`, `docs/TECH-DEBT.md`

- [ ] **Step 1: Add to CLAUDE.md** (new subsection under "Non-Obvious Rules"):

```markdown
- **API contract is code (`sieve/protocol`)** — any new/changed WS message, SSE event, or JSON endpoint MUST be added to `protocol.Registry` and `go generate ./sieve/protocol` re-run (regenerates docs/API.md, docs/api/*.yaml, frontend/src/static/generated/protocol.*). The `TestGeneratedArtifactsAreCurrent` test fails otherwise. Never write a message-type or event-name string literal — use `protocol.Msg*`/`protocol.Event*` in Go and `window.SieveProtocol.MSG/SSE` in JS. Dev API test ground: `/api/docs` (wails dev only).
```

- [ ] **Step 2: Add TECH-DEBT entries** (read `docs/TECH-DEBT.md`, follow its ID/format conventions):

- Per-kind block `Attrs` schemas are documented as open objects only; formal per-kind schema + validation deferred until block processors declare attr schemas.
- Root-level routes (`/`, `/sse`, `/static/*`, `/sieve/…`) are a static list in `sieve/protocol/gen/routes.go` — keep in sync with `handlers.go` (or extract shared registration later).
- Endpoint contract tests cover only handlers runnable without full service wiring (see `requesthandlers/contract_test.go` TODO) — extend when a service-construction test helper exists.

- [ ] **Step 3: Run the full suite one last time**

```bash
go build ./... && go test ./...
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/TECH-DEBT.md
git commit -m "docs: protocol upkeep rules in CLAUDE.md; TECH-DEBT entries for contract follow-ups"
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** SSoT package (T1–3), registry-driven dispatch + unknown-type error (T4), literals sweep (T5), five artifacts incl. markdown + OpenAPI + AsyncAPI + JS + spec.json (T6–8), generated-current test (T9), JS consumption (T10), endpoint contract tests (T11), dev test ground (T12), CLAUDE.md rules (T13). Wire format unchanged throughout — enforced by T1/T2 fidelity tests.
- **Known judgment points for the implementer:** JobInfo field verbatim-copy (T2 S1); chi.Walk exact signature (T8 S4 correction); ambiguous `'extract'`/`'error'` literals in editor.js (T10 mapping rule); endpoint-test wiring depth (T11).
