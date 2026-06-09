# Go-Heavy Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the HTTP-based `flushSave()` / `scheduleSave()` pattern with an EditorService-owned ShadowDocument backed by a persistent WebSocket, eliminating rawYaml staleness and the dual-ownership save problem.

**Architecture:** EditorService (new type in `sieve` package) holds one ShadowDocument per open document in memory. ShadowDocument tracks `Mode` ("wysiwyg" or "markdown"). In WYSIWYG mode `Flush()` runs Remux (substituting block fences with authoritative block state); in markdown mode `Flush()` saves `shadow.Markdown` verbatim (the user IS editing the YAML). Mode transitions are handled by `EnterMarkdown` / `EnterWysiwyg` methods on EditorService — no external ClearBlocks needed. TipTap sends full markdown on every change. `flushSave()` in JS becomes a WebSocket `flush` message. DocumentService contract is unchanged.

**Tech Stack:** Go 1.25, `github.com/gorilla/websocket` (already in go.mod as indirect), `sieve/sieve/fencedblock`, chi router, TipTap `onUpdate` hook.

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Create | `sieve/editor_service.go` | SieveBlock, ShadowDocument, Remux, EditorService |
| Create | `sieve/editor_service_test.go` | Unit tests for shadow logic and Remux |
| Create | `requesthandlers/ws_handler.go` | WebSocket upgrade + message dispatch |
| Modify | `sieve/service_provider.go` | Add `Editor *EditorService` field |
| Modify | `handlers.go` | Register WsHandler |
| Modify | `app.go` | Call FlushAll in final-close path |
| Modify | `frontend/src/static/editor.js` | WebSocket lifecycle, doc-update, flushSave migration, mode switch |

---

## Task 1: SieveBlock, ShadowDocument, and Remux

**Files:**
- Create: `sieve/editor_service.go`
- Create: `sieve/editor_service_test.go`

- [ ] **Step 1.1: Write failing tests**

Create `sieve/editor_service_test.go`:

```go
package sieve

import (
	"strings"
	"testing"
)

func TestRemux_replacesBlockInWysiwyg(t *testing.T) {
	md := "# Hello\n\n```ai-block\nid: ab-1234\nquestion: What?\nresponse: Old answer\nstatus: COMPLETE\n```\n\nSome prose."
	shadow := &ShadowDocument{
		UUID:     "test-uuid",
		Markdown: md,
		Mode:     "wysiwyg",
		Blocks: map[string]*SieveBlock{
			"ab-1234": {
				ID:   "ab-1234",
				Kind: "ai-block",
				Attrs: map[string]interface{}{
					"id":       "ab-1234",
					"question": "What?",
					"response": "New answer",
					"status":   "COMPLETE",
				},
			},
		},
	}

	result := shadow.Remux()

	if !strings.Contains(result, "response: New answer") {
		t.Errorf("expected Remux to update response, got:\n%s", result)
	}
	if strings.Contains(result, "response: Old answer") {
		t.Errorf("expected Remux to remove old response, got:\n%s", result)
	}
	if !strings.Contains(result, "Some prose.") {
		t.Errorf("expected prose to be preserved, got:\n%s", result)
	}
}

func TestRemux_markdownModeIsNoop(t *testing.T) {
	md := "# Hello\n\n```ai-block\nid: ab-1234\nresponse: original\n```"
	shadow := &ShadowDocument{
		UUID:     "test-uuid",
		Markdown: md,
		Mode:     "markdown",
		Blocks: map[string]*SieveBlock{
			"ab-1234": {
				ID:   "ab-1234",
				Kind: "ai-block",
				Attrs: map[string]interface{}{
					"id":       "ab-1234",
					"response": "this should NOT appear",
				},
			},
		},
	}

	result := shadow.Remux()

	if result != md {
		t.Errorf("expected Remux to be no-op in markdown mode, got:\n%s", result)
	}
}

func TestRemux_emptyBlocksIsNoop(t *testing.T) {
	md := "# Hello\n\n```ai-block\nid: ab-1234\nresponse: untouched\n```"
	shadow := &ShadowDocument{
		UUID:     "test-uuid",
		Markdown: md,
		Mode:     "wysiwyg",
		Blocks:   make(map[string]*SieveBlock),
	}

	result := shadow.Remux()

	if result != md {
		t.Errorf("expected no change with empty Blocks, got:\n%s", result)
	}
}

func TestShadowDocument_setBlockCreatesEntry(t *testing.T) {
	shadow := &ShadowDocument{
		UUID:   "test-uuid",
		Mode:   "wysiwyg",
		Blocks: make(map[string]*SieveBlock),
	}

	shadow.setBlock("code", "cb-0001", map[string]interface{}{
		"id":     "cb-0001",
		"source": "fmt.Println()",
	})

	blk, ok := shadow.Blocks["cb-0001"]
	if !ok {
		t.Fatal("expected block cb-0001 to exist")
	}
	if blk.Kind != "code" {
		t.Errorf("expected Kind=code, got %q", blk.Kind)
	}
}

func TestShadowDocument_setBlockMergesAttrs(t *testing.T) {
	shadow := &ShadowDocument{
		UUID: "test-uuid",
		Mode: "wysiwyg",
		Blocks: map[string]*SieveBlock{
			"cb-0001": {
				ID:   "cb-0001",
				Kind: "code",
				Attrs: map[string]interface{}{
					"id":       "cb-0001",
					"source":   "old",
					"language": "unknown",
				},
			},
		},
	}

	shadow.setBlock("code", "cb-0001", map[string]interface{}{
		"language": "python",
		"status":   "COMPLETE",
	})

	blk := shadow.Blocks["cb-0001"]
	if blk.Attrs["source"] != "old" {
		t.Errorf("expected source to be preserved, got %v", blk.Attrs["source"])
	}
	if blk.Attrs["language"] != "python" {
		t.Errorf("expected language=python, got %v", blk.Attrs["language"])
	}
	if blk.Attrs["status"] != "COMPLETE" {
		t.Errorf("expected status=COMPLETE, got %v", blk.Attrs["status"])
	}
}
```

- [ ] **Step 1.2: Run tests — expect compile failure**

```bash
go test ./sieve/... -run "TestRemux|TestShadowDocument" -v
```
Expected: compile error — `ShadowDocument`, `SieveBlock` not defined.

- [ ] **Step 1.3: Implement SieveBlock, ShadowDocument, Remux, parseAllBlocks**

Create `sieve/editor_service.go`:

```go
package sieve

import (
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
	"sieve/sieve/fencedblock"
)

// SieveBlock is the Go representation of any fenced YAML block.
// Kind comes from the fence info string — it is never written to the YAML body.
type SieveBlock struct {
	ID    string
	Kind  string                 // from fence info string
	Attrs map[string]interface{} // all YAML fields including "id"
}

// ShadowDocument holds the in-memory editor state for one open document.
// Mode controls how Flush and Remux behave ("wysiwyg" or "markdown").
type ShadowDocument struct {
	UUID     string
	Markdown string                 // full document from TipTap; block rawYaml may be stale
	Blocks   map[string]*SieveBlock // user-edited blocks; authoritative over shadow.Markdown
	Mode     string                 // "wysiwyg" (default) or "markdown"
	mu       sync.Mutex
	timer    *time.Timer
	onFlush  func()
}

func newShadow(uuid, body string, onFlush func()) *ShadowDocument {
	return &ShadowDocument{
		UUID:     uuid,
		Markdown: body,
		Blocks:   make(map[string]*SieveBlock),
		Mode:     "wysiwyg",
		onFlush:  onFlush,
	}
}

func (s *ShadowDocument) setMarkdown(md string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Markdown = md
	s.resetDebounce()
}

// setBlock creates or merges attrs into the named block. kind is only used
// when creating a new entry; subsequent calls preserve the existing Kind.
func (s *ShadowDocument) setBlock(kind, blockID string, attrs map[string]interface{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if blk, ok := s.Blocks[blockID]; ok {
		for k, v := range attrs {
			blk.Attrs[k] = v
		}
	} else {
		merged := make(map[string]interface{}, len(attrs))
		for k, v := range attrs {
			merged[k] = v
		}
		s.Blocks[blockID] = &SieveBlock{ID: blockID, Kind: kind, Attrs: merged}
	}
	s.resetDebounce()
}

func (s *ShadowDocument) resetDebounce() {
	if s.onFlush == nil {
		return
	}
	if s.timer != nil {
		s.timer.Stop()
	}
	s.timer = time.AfterFunc(1*time.Second, s.onFlush)
}

func (s *ShadowDocument) stopDebounce() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
}

// Remux returns shadow.Markdown with each block in shadow.Blocks replaced by
// a freshly serialised fence. In markdown mode it returns Markdown verbatim —
// the user is editing raw YAML directly, so no substitution is needed.
func (s *ShadowDocument) Remux() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Mode == "markdown" {
		return s.Markdown
	}
	out := s.Markdown
	for _, blk := range s.Blocks {
		updated, err := fencedblock.Replace[map[string]interface{}](out, blk.Kind, blk.ID, blk.Attrs)
		if err == nil {
			out = updated
		}
	}
	return out
}

// parseAllBlocks scans body for all named fenced blocks (```kind where kind != "")
// and returns them keyed by block ID. Used when re-entering WYSIWYG mode so that
// any block YAML the user edited directly in markdown mode is picked up.
func parseAllBlocks(body string) map[string]*SieveBlock {
	blocks := make(map[string]*SieveBlock)
	lines := strings.Split(body, "\n")
	i := 0
	for i < len(lines) {
		line := lines[i]
		if strings.HasPrefix(line, "```") && len(line) > 3 {
			kind := strings.TrimPrefix(line, "```")
			j := i + 1
			for j < len(lines) && lines[j] != "```" {
				j++
			}
			if j < len(lines) {
				content := strings.Join(lines[i+1:j], "\n")
				var attrs map[string]interface{}
				if yaml.Unmarshal([]byte(content), &attrs) == nil {
					if id, ok := attrs["id"].(string); ok && id != "" {
						blocks[id] = &SieveBlock{ID: id, Kind: kind, Attrs: attrs}
					}
				}
				i = j + 1
				continue
			}
		}
		i++
	}
	return blocks
}
```

- [ ] **Step 1.4: Run tests — expect pass**

```bash
go test ./sieve/... -run "TestRemux|TestShadowDocument" -v
```
Expected: 5 tests PASS.

- [ ] **Step 1.5: Commit**

```bash
git add sieve/editor_service.go sieve/editor_service_test.go
git commit -m "feat(editor): SieveBlock, ShadowDocument, mode-aware Remux"
```

---

## Task 2: EditorService

**Files:**
- Modify: `sieve/editor_service.go`
- Modify: `sieve/editor_service_test.go`

- [ ] **Step 2.1: Write failing EditorService tests**

Append to `sieve/editor_service_test.go`:

```go
func TestEditorService_FlushWritesToDisk(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds)

	doc, err := ds.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	doc.SetBody([]byte("# Hello\n\n```ai-block\nid: ab-1234\nresponse: original\nstatus: COMPLETE\n```"))
	doc, err = ds.Save(doc)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	uuid := doc.UUID()

	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	es.UpdateMarkdown(uuid, "# Hello\n\n```ai-block\nid: ab-1234\nresponse: original\nstatus: COMPLETE\n```")
	es.UpdateBlock(uuid, "ai-block", "ab-1234", map[string]interface{}{
		"id":       "ab-1234",
		"response": "updated by user",
		"status":   "COMPLETE",
	})

	if err := es.Flush(uuid); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	reloaded, err := ds.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("LoadByUUID: %v", err)
	}
	if !strings.Contains(string(reloaded.Body()), "updated by user") {
		t.Errorf("expected flushed content to contain updated response, got:\n%s", reloaded.Body())
	}
}

func TestEditorService_EnterMarkdownEmbedsBlocks(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds)

	doc, _ := ds.New()
	doc.SetBody([]byte("# Doc\n\n```code\nid: cb-0001\nsource: old\nstatus: COMPLETE\n```"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()

	_ = es.Open(uuid)
	es.UpdateMarkdown(uuid, "# Doc\n\n```code\nid: cb-0001\nsource: old\nstatus: COMPLETE\n```")
	es.UpdateBlock(uuid, "code", "cb-0001", map[string]interface{}{
		"id":     "cb-0001",
		"source": "updated source",
		"status": "COMPLETE",
	})

	seed := es.EnterMarkdown(uuid)
	if !strings.Contains(seed, "updated source") {
		t.Errorf("expected EnterMarkdown seed to include updated block, got:\n%s", seed)
	}

	// After entering markdown mode, Flush should save verbatim — not re-apply stale Blocks
	es.UpdateMarkdown(uuid, seed)
	if err := es.Flush(uuid); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	reloaded, _ := ds.LoadByUUID(uuid)
	if !strings.Contains(string(reloaded.Body()), "updated source") {
		t.Errorf("expected disk to contain updated source after markdown-mode flush")
	}
}

func TestEditorService_EnterWysiwygReparsesBlocks(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds)

	doc, _ := ds.New()
	doc.SetBody([]byte("# Doc\n\n```code\nid: cb-0001\nsource: original\nstatus: COMPLETE\n```"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()

	_ = es.Open(uuid)
	_ = es.EnterMarkdown(uuid)

	// User edits block YAML directly in markdown mode
	es.UpdateMarkdown(uuid, "# Doc\n\n```code\nid: cb-0001\nsource: hand-edited\nstatus: COMPLETE\n```")

	es.EnterWysiwyg(uuid)

	// Now UpdateBlock should merge into the re-parsed block
	es.UpdateBlock(uuid, "code", "cb-0001", map[string]interface{}{
		"language": "go",
	})

	if err := es.Flush(uuid); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	reloaded, _ := ds.LoadByUUID(uuid)
	body := string(reloaded.Body())
	if !strings.Contains(body, "hand-edited") {
		t.Errorf("expected hand-edited source to be preserved, got:\n%s", body)
	}
	if !strings.Contains(body, "language: go") {
		t.Errorf("expected UpdateBlock to have applied language, got:\n%s", body)
	}
}
```

- [ ] **Step 2.2: Run tests — expect compile failure**

```bash
go test ./sieve/... -run "TestEditorService" -v
```
Expected: compile error — `EditorService`, `NewEditorService` not defined.

- [ ] **Step 2.3: Implement EditorService**

Append to `sieve/editor_service.go`:

```go
// EditorService is the Go-side editor model. It holds one ShadowDocument per
// open document and coordinates all save operations. DocumentService owns disk.
type EditorService struct {
	documents *DocumentService
	mu        sync.RWMutex
	shadows   map[string]*ShadowDocument
}

// NewEditorService creates an EditorService backed by the given DocumentService.
func NewEditorService(documents *DocumentService) *EditorService {
	return &EditorService{
		documents: documents,
		shadows:   make(map[string]*ShadowDocument),
	}
}

// Open loads a document from disk and creates an in-memory ShadowDocument.
// shadow.Blocks starts empty; blocks are populated via UpdateBlock as users edit.
func (es *EditorService) Open(uuid string) error {
	doc, err := es.documents.LoadByUUID(uuid)
	if err != nil {
		return err
	}
	shadow := newShadow(uuid, string(doc.Body()), func() { _ = es.Flush(uuid) })

	es.mu.Lock()
	es.shadows[uuid] = shadow
	es.mu.Unlock()
	return nil
}

// Close flushes the shadow to disk and removes it. Called when the WebSocket closes.
func (es *EditorService) Close(uuid string) {
	_ = es.Flush(uuid)

	es.mu.Lock()
	shadow, ok := es.shadows[uuid]
	delete(es.shadows, uuid)
	es.mu.Unlock()

	if ok {
		shadow.stopDebounce()
	}
}

// UpdateMarkdown stores the latest full markdown from TipTap and resets the debounce.
func (es *EditorService) UpdateMarkdown(uuid, markdown string) {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow != nil {
		shadow.setMarkdown(markdown)
	}
}

// UpdateBlock merges attrs into the named block, creating it if needed.
// kind is only used when creating a new block entry.
func (es *EditorService) UpdateBlock(uuid, kind, blockID string, attrs map[string]interface{}) {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow != nil {
		shadow.setBlock(kind, blockID, attrs)
	}
}

// EnterMarkdown switches the shadow to markdown mode.
// It first computes Remux() to embed all current block state into shadow.Markdown,
// then sets mode = "markdown" so that subsequent Flush calls save verbatim.
// Returns the merged markdown to use as the seed for the markdown editor.
func (es *EditorService) EnterMarkdown(uuid string) string {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return ""
	}
	shadow.mu.Lock()
	merged := shadow.Remux() // embed block state before clearing tracking
	shadow.Markdown = merged
	shadow.Mode = "markdown"
	shadow.mu.Unlock()
	return merged
}

// EnterWysiwyg switches the shadow back to WYSIWYG mode.
// It re-parses shadow.Blocks from the current shadow.Markdown so that any block
// YAML the user edited directly in markdown mode is picked up for future Remux calls.
func (es *EditorService) EnterWysiwyg(uuid string) {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return
	}
	shadow.mu.Lock()
	shadow.Blocks = parseAllBlocks(shadow.Markdown)
	shadow.Mode = "wysiwyg"
	shadow.mu.Unlock()
}

// Flush writes the Remuxed shadow to disk via DocumentService.
// In markdown mode Remux() returns shadow.Markdown verbatim.
func (es *EditorService) Flush(uuid string) error {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return nil
	}

	merged := shadow.Remux()

	doc, err := es.documents.LoadByUUID(uuid)
	if err != nil {
		return err
	}
	doc.SetBody([]byte(merged))
	_, err = es.documents.Save(doc)
	return err
}

// FlushAll writes all open shadows to disk. Called on application shutdown.
func (es *EditorService) FlushAll() {
	es.mu.RLock()
	uuids := make([]string, 0, len(es.shadows))
	for uuid := range es.shadows {
		uuids = append(uuids, uuid)
	}
	es.mu.RUnlock()
	for _, uuid := range uuids {
		_ = es.Flush(uuid)
	}
}
```

Note: `EnterMarkdown` calls `shadow.Remux()` while already holding `shadow.mu` (double-lock). Fix by computing Remux before acquiring the lock:

```go
func (es *EditorService) EnterMarkdown(uuid string) string {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return ""
	}
	merged := shadow.Remux() // acquires and releases shadow.mu internally
	shadow.mu.Lock()
	shadow.Markdown = merged
	shadow.Mode = "markdown"
	shadow.mu.Unlock()
	return merged
}
```

- [ ] **Step 2.4: Run tests — expect pass**

```bash
go test ./sieve/... -run "TestRemux|TestShadowDocument|TestEditorService" -v
```
Expected: 8 tests PASS.

- [ ] **Step 2.5: Build check**

```bash
go build ./...
```

- [ ] **Step 2.6: Commit**

```bash
git add sieve/editor_service.go sieve/editor_service_test.go
git commit -m "feat(editor): EditorService — mode-aware Flush, EnterMarkdown, EnterWysiwyg"
```

---

## Task 3: WebSocket Handler

**Files:**
- Create: `requesthandlers/ws_handler.go`

- [ ] **Step 3.1: Promote gorilla/websocket to a direct dependency**

```bash
go get github.com/gorilla/websocket@v1.5.3
```
Expected: go.mod updated — `github.com/gorilla/websocket v1.5.3` without `// indirect`.

- [ ] **Step 3.2: Create the WebSocket handler**

Create `requesthandlers/ws_handler.go`:

```go
package requesthandlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"sieve/logger"
	"sieve/sieve"
)

// WsHandler manages one persistent WebSocket connection per open document.
// It dispatches incoming messages to EditorService and sends acks back.
type WsHandler struct {
	ServiceProvider *sieve.ServiceProvider
	upgrader        websocket.Upgrader
}

func NewWsHandler(sp *sieve.ServiceProvider) *WsHandler {
	return &WsHandler{
		ServiceProvider: sp,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
	}
}

func (h *WsHandler) RegisterPaths(r chi.Router) {
	r.Get("/api/ws", h.handleWS)
}

func (h *WsHandler) handleWS(w http.ResponseWriter, r *http.Request) {
	uuid := r.URL.Query().Get("uuid")
	if uuid == "" {
		http.Error(w, "uuid required", http.StatusBadRequest)
		return
	}

	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		logger.Warn("ws: upgrade failed", "uuid", uuid, "err", err)
		return
	}
	defer conn.Close()

	if err := h.ServiceProvider.Editor.Open(uuid); err != nil {
		logger.Warn("ws: could not open shadow", "uuid", uuid, "err", err)
	}
	defer h.ServiceProvider.Editor.Close(uuid)

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
		case "doc-update":
			h.handleDocUpdate(uuid, raw)
		case "block-update":
			h.handleBlockUpdate(uuid, raw)
		case "flush":
			h.handleFlush(conn, uuid)
		case "enter-markdown":
			h.handleEnterMarkdown(conn, uuid)
		case "enter-wysiwyg":
			h.handleEnterWysiwyg(uuid)
		}
	}
}

func (h *WsHandler) handleDocUpdate(uuid string, raw []byte) {
	var msg struct {
		Markdown string `json:"markdown"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		return
	}
	h.ServiceProvider.Editor.UpdateMarkdown(uuid, msg.Markdown)
}

func (h *WsHandler) handleBlockUpdate(uuid string, raw []byte) {
	var msg struct {
		ID    string                 `json:"id"`
		Kind  string                 `json:"kind"`
		Attrs map[string]interface{} `json:"attrs"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		return
	}
	h.ServiceProvider.Editor.UpdateBlock(uuid, msg.Kind, msg.ID, msg.Attrs)
}

func (h *WsHandler) handleFlush(conn *websocket.Conn, uuid string) {
	_ = h.ServiceProvider.Editor.Flush(uuid)
	ack, _ := json.Marshal(map[string]string{"type": "flush-ack", "uuid": uuid})
	_ = conn.WriteMessage(websocket.TextMessage, ack)
}

// handleEnterMarkdown: embed current block state into Markdown, set mode = markdown,
// return merged content to JS as the seed for the markdown editor.
func (h *WsHandler) handleEnterMarkdown(conn *websocket.Conn, uuid string) {
	merged := h.ServiceProvider.Editor.EnterMarkdown(uuid)
	resp, _ := json.Marshal(map[string]string{
		"type":     "markdown-content",
		"uuid":     uuid,
		"markdown": merged,
	})
	_ = conn.WriteMessage(websocket.TextMessage, resp)
}

// handleEnterWysiwyg: re-parse shadow.Blocks from shadow.Markdown, set mode = wysiwyg.
func (h *WsHandler) handleEnterWysiwyg(uuid string) {
	h.ServiceProvider.Editor.EnterWysiwyg(uuid)
}
```

- [ ] **Step 3.3: Build check**

```bash
go build ./...
```
Expected: no errors.

- [ ] **Step 3.4: Commit**

```bash
git add requesthandlers/ws_handler.go go.mod go.sum
git commit -m "feat(ws): WebSocket handler — doc-update, block-update, flush, mode switching"
```

---

## Task 4: Wire EditorService and WsHandler

**Files:**
- Modify: `sieve/service_provider.go`
- Modify: `handlers.go`

- [ ] **Step 4.1: Add Editor field to ServiceProvider**

In `sieve/service_provider.go`, add `Editor *EditorService` to the struct:

```go
type ServiceProvider struct {
	Store     store.Store
	Documents *DocumentService
	Assets    *AssetService
	State     *StateService
	Prompts   *PromptService
	AI        *AIService
	Editor    *EditorService
}
```

In `Init()`, after `s.AI = NewAIService(...)`, add:

```go
s.Editor = NewEditorService(s.Documents)
```

- [ ] **Step 4.2: Register WsHandler in handlers.go**

In `handlers.go`, add `requesthandlers.NewWsHandler(sp)` to the `requestHandlers` slice, after `InternalizeHandler`:

```go
requesthandlers.NewWsHandler(sp),
```

- [ ] **Step 4.3: Build check**

```bash
go build ./...
```

- [ ] **Step 4.4: Commit**

```bash
git add sieve/service_provider.go handlers.go
git commit -m "feat(editor): wire EditorService into ServiceProvider; register WsHandler"
```

---

## Task 5: Shutdown Wiring

**Files:**
- Modify: `app.go`

- [ ] **Step 5.1: Call FlushAll in the final-close path**

In `app.go`, update `beforeClose`. On the first call it vetoes and emits `app:closing` (so JS can do its flush + wait for jobs). On the second call (`a.closing == true`, after `App.Quit()` is called by JS), call FlushAll before allowing the close:

```go
func (a *App) beforeClose(ctx context.Context) bool {
	if a.closing {
		if a.ServiceProvider.Editor != nil {
			a.ServiceProvider.Editor.FlushAll()
		}
		return false
	}
	if a.State != nil {
		x, y := runtime.WindowGetPosition(ctx)
		w, h := runtime.WindowGetSize(ctx)
		session := a.State.LoadSession()
		session.Window = sieve.Window{X: x, Y: y, Width: w, Height: h}
		_ = a.State.SaveSession(session)
	}
	logger.Info("beforeClose: vetoing and requesting flush")
	runtime.EventsEmit(ctx, "app:closing")
	return true
}
```

- [ ] **Step 5.2: Build check**

```bash
go build ./...
```

- [ ] **Step 5.3: Commit**

```bash
git add app.go
git commit -m "feat(editor): FlushAll on final app close"
```

---

## Task 6: JS WebSocket Connection and doc-update

**Files:**
- Modify: `frontend/src/static/editor.js`

- [ ] **Step 6.1: Add WebSocket state variables and helpers**

Near the top of the editor IIFE (alongside `var saveTimer = null`), add:

```js
var editorWs = null
var editorWsPending = []
var editorWsAwaiters = {}   // type → { resolve, reject }
```

Add these helper functions after the existing `scheduleSave` / `flushSave` functions:

```js
function openEditorWs(uuid) {
  if (editorWs) { editorWs.close(); editorWs = null }
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  editorWs = new WebSocket(proto + '//' + location.host + '/api/ws?uuid=' + encodeURIComponent(uuid))

  editorWs.onopen = function () {
    editorWsPending.forEach(function (m) { editorWs.send(m) })
    editorWsPending = []
  }

  editorWs.onmessage = function (event) {
    var msg = JSON.parse(event.data || '{}')
    var awaiter = editorWsAwaiters[msg.type]
    if (awaiter) {
      delete editorWsAwaiters[msg.type]
      awaiter.resolve(msg)
    }
    if (msg.type === 'flush-ack') {
      document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: false } }))
      document.dispatchEvent(new CustomEvent('editor:saved', { detail: { uuid: msg.uuid } }))
    }
    if (msg.type === 'markdown-content') {
      document.dispatchEvent(new CustomEvent('editor:markdown-content', { detail: msg }))
    }
  }

  editorWs.onerror = function (err) { console.error('[editor] ws error', err) }
}

function closeEditorWs() {
  if (editorWs) { editorWs.close(); editorWs = null }
  editorWsPending = []
  editorWsAwaiters = {}
}

function wsSend(msg) {
  var data = JSON.stringify(msg)
  if (editorWs && editorWs.readyState === WebSocket.OPEN) {
    editorWs.send(data)
  } else {
    editorWsPending.push(data)
  }
}

function wsSendAndAwait(type, msg) {
  return new Promise(function (resolve, reject) {
    var ackType = type + '-ack'
    var timer = setTimeout(function () {
      delete editorWsAwaiters[ackType]
      reject(new Error('ws timeout: ' + type))
    }, 5000)
    editorWsAwaiters[ackType] = {
      resolve: function (m) { clearTimeout(timer); resolve(m) },
      reject: function (e) { clearTimeout(timer); reject(e) },
    }
    wsSend(msg)
  })
}
```

- [ ] **Step 6.2: Open WebSocket on initEditor; close on destroy**

In `initEditor`, in the `if (currentEditor)` block that destroys the old editor, add `closeEditorWs()`:

```js
if (currentEditor) {
  flushSave()
  currentEditor.destroy()
  currentEditor = null
  closeEditorWs()   // ← add this
}
```

After `currentUuid = uuid`, add:

```js
openEditorWs(uuid)
```

- [ ] **Step 6.3: Replace scheduleSave with wsSend in onUpdate**

In the `onUpdate` handler, replace `scheduleSave(uuid, md)` with:

```js
wsSend({ type: 'doc-update', uuid: uuid, markdown: md })
```

Keep `lastSyncedBody = md` — it is still used for stats and markdown-mode seeding.

- [ ] **Step 6.4: Build check — verify no syntax errors**

```bash
go build ./...
```

Then `wails dev`, open a note. Check browser DevTools → Network → WS tab shows a connection to `/api/ws`. Typing in the editor should no longer fire HTTP saves.

- [ ] **Step 6.5: Commit**

```bash
git add frontend/src/static/editor.js
git commit -m "feat(editor): WebSocket connection + doc-update replaces scheduleSave"
```

---

## Task 7: flushSave Migration and Mode Switching

**Files:**
- Modify: `frontend/src/static/editor.js`

- [ ] **Step 7.1: Replace flushSave implementation**

Find the existing `flushSave` function and replace its body. Prompts (uuid starts with `prompt:`) still use HTTP:

```js
function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  if (!currentUuid) return Promise.resolve()
  if (currentUuid.startsWith('prompt:')) {
    return doSave(currentUuid, getMarkdown())
  }
  return wsSendAndAwait('flush', { type: 'flush', uuid: currentUuid })
    .catch(function (err) {
      console.warn('[editor] flush timeout, continuing:', err)
    })
}
```

- [ ] **Step 7.2: Update mode switch to use enter-markdown / enter-wysiwyg**

Find the `switchMode` function (where `currentMode` is toggled). Replace the section that seeds the markdown editor with the following pattern when switching TO markdown mode:

```js
// Switching to markdown — request merged content from EditorService
wsSend({ type: 'enter-markdown', uuid: currentUuid })
document.addEventListener('editor:markdown-content', function onMdContent(e) {
  if (e.detail.uuid !== currentUuid) return
  document.removeEventListener('editor:markdown-content', onMdContent)
  lastSyncedBody = e.detail.markdown
  mountMarkdown(currentMountEl, currentUuid, e.detail.markdown)
}, { once: true })
```

When switching back TO wysiwyg mode, add before `mountWysiwyg`:

```js
wsSend({ type: 'enter-wysiwyg', uuid: currentUuid })
```

- [ ] **Step 7.3: Remove scheduleSave and saveTimer**

`scheduleSave` is no longer needed — the Go debounce in EditorService handles timing. Remove the `scheduleSave` function and the `var saveTimer = null` declaration. Search for any remaining references:

```bash
grep -n "scheduleSave\|saveTimer" frontend/src/static/editor.js
```
Expected: zero results (after removal).

`doSave` must stay — it handles prompt saves via HTTP.

- [ ] **Step 7.4: Verify call sites**

Check that all `flushSave()` call sites still work with the new implementation:

```bash
grep -n "flushSave" frontend/src/static/editor.js
```

Each call site that previously relied on the HTTP save round-trip now relies on the WebSocket flush ack.

- [ ] **Step 7.5: Integration smoke test**

`wails dev`:
1. Open a note → type → no HTTP saves in Network tab, WebSocket messages visible
2. Wait ~1s → document saves (Go debounce)
3. Switch to markdown mode → content arrives from WebSocket `markdown-content` message
4. Edit raw YAML in markdown mode, switch back to WYSIWYG → shadow re-parsed from edited markdown
5. Close app → Go logs show FlushAll

- [ ] **Step 7.6: Commit**

```bash
git add frontend/src/static/editor.js
git commit -m "feat(editor): flushSave → WebSocket; mode switch via enter-markdown/enter-wysiwyg"
```

---

## Task 8: Full Verification

- [ ] **Step 8.1: Run all Go tests**

```bash
go test ./...
```
Expected: all PASS.

- [ ] **Step 8.2: Final cleanup check**

```bash
grep -n "scheduleSave\|saveTimer" frontend/src/static/editor.js
```
Expected: zero results.

- [ ] **Step 8.3: Final commit**

```bash
git add -A
git commit -m "feat(editor): Go-heavy frontend complete — EditorService + WebSocket replaces HTTP save"
```
