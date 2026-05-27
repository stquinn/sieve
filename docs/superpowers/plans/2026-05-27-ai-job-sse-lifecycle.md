# AI Job Lifecycle via Go SSE Implementation Plan

## PLAN NEEDS UPDATING BASED ON CHANGES INTRODUCED IN @2026-05-27-ai-block-refactor.md

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace JS-side `trackJob()` call sites with Go-broadcast `ai:job-started` / `ai:job-ended` SSE events, making Go the single source of truth for AI job lifecycle and eliminating ~11 JS call sites that manually track status bar state.

**Architecture:** A new `JobTracker` struct (in `requesthandlers/`) is the shared in-flight job registry. Both `AiHandler` and `InternalizeHandler` hold a pointer to it. Each handler emits `ai:job-started` / `ai:job-ended` SSE events at job boundaries, and registers/deregisters from the tracker. A new `GET /api/ai/active-jobs` endpoint (registered on `AiHandler`) serves the tracker's state so the JS status bar can restore after a tab switch. `ai-actions.js` becomes a pure SSE consumer — `trackJob()` is deleted and `window.SieveAI.loadActiveJobs()` replaces the old `/api/internalize/active` call in `editor.js`.

**Tech Stack:** Go (chi, `sync.RWMutex`), vanilla JS, HTMX SSE extension, Wails v2

---

## File Map

| Action | File | Change |
|--------|------|--------|
| **Create** | `requesthandlers/job_tracker.go` | `JobTracker` struct + `JobInfo` type |
| **Create** | `requesthandlers/job_tracker_test.go` | Unit tests for `JobTracker` |
| **Modify** | `requesthandlers/ai_handler.go` | Add `JobTracker` field; emit job events from `evaluateAndFile`, `handleAiAsk`, `handleAiExplain`; add `/api/ai/active-jobs` route |
| **Modify** | `requesthandlers/internalize_handler.go` | Replace `activeJobs sync.Map` with `JobTracker`; emit job events from `runInBackground`; remove `/api/internalize/active` |
| **Modify** | `handlers.go` | Create `JobTracker` instance; inject into both handlers |
| **Modify** | `frontend/src/static/ai-actions.js` | Rewrite as SSE consumer; remove `trackJob()`; add `loadActiveJobs()` |
| **Modify** | `frontend/src/static/editor.js` | Remove 11 `trackJob()` call sites; remove `pendingAiBlkIds`; remove `window.__sieveActiveWebClips`; call `loadActiveJobs()` on tab load |
| **Modify** | `frontend/src/index.html` | Add SSE relay divs for new events |

---

## Task 1: JobTracker struct

**Files:**
- Create: `requesthandlers/job_tracker.go`
- Create: `requesthandlers/job_tracker_test.go`

- [ ] **Step 1: Write the failing test**

```go
// requesthandlers/job_tracker_test.go
package requesthandlers

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestJobTracker_EmptyOnCreate(t *testing.T) {
	tracker := NewJobTracker()
	if got := tracker.Active(); len(got) != 0 {
		t.Errorf("expected 0 active jobs, got %d", len(got))
	}
}

func TestJobTracker_StartAddsJob(t *testing.T) {
	tracker := NewJobTracker()
	tracker.Start(JobInfo{JobID: "j1", Label: "Filing note...", DocID: "doc1", SpinTab: true})
	active := tracker.Active()
	if len(active) != 1 {
		t.Fatalf("expected 1 job, got %d", len(active))
	}
	if active[0].JobID != "j1" || active[0].Label != "Filing note..." {
		t.Errorf("unexpected job: %+v", active[0])
	}
}

func TestJobTracker_EndRemovesJob(t *testing.T) {
	tracker := NewJobTracker()
	tracker.Start(JobInfo{JobID: "j1", Label: "Asking AI...", DocID: "doc1", SpinTab: false})
	tracker.End("j1")
	if got := tracker.Active(); len(got) != 0 {
		t.Errorf("expected 0 active jobs after End, got %d", len(got))
	}
}

func TestJobTracker_EndUnknownIDIsNoop(t *testing.T) {
	tracker := NewJobTracker()
	tracker.End("nonexistent") // must not panic
}

func TestJobTracker_MultipleJobs(t *testing.T) {
	tracker := NewJobTracker()
	tracker.Start(JobInfo{JobID: "j1", Label: "Filing note...", DocID: "d1", SpinTab: true})
	tracker.Start(JobInfo{JobID: "j2", Label: "Asking AI...", DocID: "d2", SpinTab: false})
	if len(tracker.Active()) != 2 {
		t.Errorf("expected 2 jobs")
	}
	tracker.End("j1")
	if len(tracker.Active()) != 1 {
		t.Errorf("expected 1 job after removing j1")
	}
}

func TestJobTracker_ServeActiveJobs(t *testing.T) {
	tracker := NewJobTracker()
	tracker.Start(JobInfo{JobID: "j1", Label: "Explaining...", DocID: "doc1", SpinTab: false})

	req := httptest.NewRequest("GET", "/api/ai/active-jobs", nil)
	w := httptest.NewRecorder()
	tracker.ServeActiveJobs(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var body struct {
		Jobs []JobInfo `json:"jobs"`
	}
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Jobs) != 1 || body.Jobs[0].JobID != "j1" {
		t.Errorf("unexpected jobs: %+v", body.Jobs)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
go test ./requesthandlers/ -run TestJobTracker -v
```
Expected: compile error — `NewJobTracker`, `JobInfo`, etc. not defined.

- [ ] **Step 3: Implement JobTracker**

```go
// requesthandlers/job_tracker.go
package requesthandlers

import (
	"encoding/json"
	"net/http"
	"sync"
)

// JobInfo is the payload for ai:job-started SSE events and GET /api/ai/active-jobs.
type JobInfo struct {
	JobID   string `json:"jobId"`
	Label   string `json:"label"`
	DocID   string `json:"docId,omitempty"`
	SpinTab bool   `json:"spinTab"`
}

// JobTracker is a thread-safe registry of in-flight AI jobs.
// Shared between AiHandler and InternalizeHandler via handlers.go.
type JobTracker struct {
	mu   sync.RWMutex
	jobs map[string]JobInfo
}

func NewJobTracker() *JobTracker {
	return &JobTracker{jobs: make(map[string]JobInfo)}
}

func (t *JobTracker) Start(info JobInfo) {
	t.mu.Lock()
	t.jobs[info.JobID] = info
	t.mu.Unlock()
}

func (t *JobTracker) End(jobID string) {
	t.mu.Lock()
	delete(t.jobs, jobID)
	t.mu.Unlock()
}

func (t *JobTracker) Active() []JobInfo {
	t.mu.RLock()
	defer t.mu.RUnlock()
	out := make([]JobInfo, 0, len(t.jobs))
	for _, j := range t.jobs {
		out = append(out, j)
	}
	return out
}

// ServeActiveJobs handles GET /api/ai/active-jobs.
// Returns {"jobs": [...]} for the JS status bar to restore state after a tab switch.
func (t *JobTracker) ServeActiveJobs(w http.ResponseWriter, r *http.Request) {
	jobs := t.Active()
	if jobs == nil {
		jobs = []JobInfo{}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string][]JobInfo{"jobs": jobs})
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
go test ./requesthandlers/ -run TestJobTracker -v
```
Expected: all 6 tests PASS.

- [ ] **Step 5: Compile check**

```bash
go build ./...
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add requesthandlers/job_tracker.go requesthandlers/job_tracker_test.go
git commit -m "feat(ai-sse): add JobTracker — shared in-flight AI job registry"
```

---

## Task 2: AiHandler — emit ai:job-started / ai:job-ended

**Files:**
- Modify: `requesthandlers/ai_handler.go`

- [ ] **Step 1: Add helper methods and JobTracker field to AiHandler**

Add the `JobTracker` field to the struct and two private helpers. The helpers keep the broadcast + tracker calls co-located so each handler method is a one-liner at the boundary.

Replace the `AiHandler` struct definition (lines 15–19) and add helpers after it:

```go
type AiHandler struct {
	ServiceProvider  *sieve.ServiceProvider
	EmitNotesChanged func()
	Broadcast        func(event, data string)
	JobTracker       *JobTracker
}

func (h *AiHandler) emitJobStarted(jobID, label, docID string, spinTab bool) {
	if h.JobTracker != nil {
		h.JobTracker.Start(JobInfo{JobID: jobID, Label: label, DocID: docID, SpinTab: spinTab})
	}
	if h.Broadcast != nil {
		data, _ := json.Marshal(map[string]interface{}{
			"jobId": jobID, "label": label, "docId": docID, "spinTab": spinTab,
		})
		h.Broadcast("ai:job-started", string(data))
	}
}

func (h *AiHandler) emitJobEnded(jobID, docID string) {
	if h.JobTracker != nil {
		h.JobTracker.End(jobID)
	}
	if h.Broadcast != nil {
		data, _ := json.Marshal(map[string]string{"jobId": jobID, "docId": docID})
		h.Broadcast("ai:job-ended", string(data))
	}
}
```

- [ ] **Step 2: Add /api/ai/active-jobs route to RegisterPaths**

Add one line to `RegisterPaths`:

```go
func (h *AiHandler) RegisterPaths(r chi.Router) {
	r.Post("/api/ai/smartFile/{id}", h.handleAiSmartFile)
	r.Post("/api/ai/smartMetadata/{id}", h.handleAiSmartMetadata)
	r.Post("/api/ai/keepAndFile/{uuid}", h.handleAiKeepAndFile)
	r.Post("/api/ai/ask", h.handleAiAsk)
	r.Post("/api/ai/explain", h.handleAiExplain)
	r.Post("/api/ai/refine-language", h.handleRefineLanguage)
	r.Post("/api/ai/describe-image", h.handleDescribeImage)
	r.Get("/api/link-preview", h.handleLinkPreview)
	r.Get("/api/ai/active-jobs", func(w http.ResponseWriter, r *http.Request) {
		if h.JobTracker != nil {
			h.JobTracker.ServeActiveJobs(w, r)
		} else {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"jobs":[]}`))
		}
	})
}
```

- [ ] **Step 3: Wrap evaluateAndFile with job lifecycle events**

`evaluateAndFile` is called by smartFile (fileAfter=true), smartMetadata (fileAfter=false), and keepAndFile (fileAfter=true). Emit `ai:job-started` after the document-exists check, then defer `ai:job-ended` so it fires on every return path (success and error).

Replace `evaluateAndFile` (lines 62–101):

```go
func (h *AiHandler) evaluateAndFile(w http.ResponseWriter, id string, fileAfter bool, allowDiscard bool) {
	_, err := h.ServiceProvider.Documents.LoadByUUID(id)
	if err != nil {
		http.Error(w, "document not found", http.StatusNotFound)
		return
	}

	label := "Updating metadata..."
	if fileAfter {
		label = "Filing note..."
	}
	h.emitJobStarted(id, label, id, true)
	defer h.emitJobEnded(id, id)

	outcome, err := h.ServiceProvider.AI.EvaluateAndFileDoc(id, fileAfter, allowDiscard)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	session := h.ServiceProvider.State.LoadSession()
	if !outcome.Discarded && outcome.Document != nil {
		for i := range session.Tabs {
			if session.Tabs[i].ID == id {
				session.Tabs[i].Status = outcome.Document.Meta().Status()
				session.Tabs[i].DisplayName = outcome.Document.Meta().DisplayName()
				if outcome.Document.Meta().UserIntent() != nil {
					session.Tabs[i].UserIntent = *outcome.Document.Meta().UserIntent()
				}
				break
			}
		}
	}
	_ = h.ServiceProvider.State.SaveSession(session)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(outcome)
	if h.EmitNotesChanged != nil {
		h.EmitNotesChanged()
	}
}
```

- [ ] **Step 4: Wrap handleAiAsk with job lifecycle events**

Emit `ai:job-started` before `RunAsk` and defer `ai:job-ended` so it fires on all return paths. Guarded by `req.BlkID != ""` (same guard as the existing `ai:block-resolved` broadcast, since we need a stable job ID).

In `handleAiAsk`, insert after the pre-save block (after line 138 in the original, before `resp, err := h.ServiceProvider.AI.RunAsk(...)`):

```go
	if req.BlkID != "" && req.NoteUUID != "" {
		h.emitJobStarted(req.BlkID, "Asking AI...", req.NoteUUID, false)
		defer h.emitJobEnded(req.BlkID, req.NoteUUID)
	}
```

The full function becomes:

```go
func (h *AiHandler) handleAiAsk(w http.ResponseWriter, r *http.Request) {
	var req askRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if req.BlkID != "" && req.Body != "" && req.NoteUUID != "" {
		for attempt := 0; attempt < 3; attempt++ {
			doc, err := h.ServiceProvider.Documents.LoadByUUID(req.NoteUUID)
			if err != nil {
				logger.Error("handleAiAsk: load for pre-save failed", "err", err)
				break
			}
			doc.SetBody([]byte(req.Body))
			if _, err := h.ServiceProvider.Documents.Save(doc); err != nil {
				if errors.Is(err, store.ErrStaleStorable) {
					continue
				}
				logger.Error("handleAiAsk: save body failed", "err", err)
			}
			break
		}
	}

	if req.BlkID != "" && req.NoteUUID != "" {
		h.emitJobStarted(req.BlkID, "Asking AI...", req.NoteUUID, false)
		defer h.emitJobEnded(req.BlkID, req.NoteUUID)
	}

	resp, err := h.ServiceProvider.AI.RunAsk(req.Content, req.History, req.Question, req.NoteUUID, req.ImageBlockIds)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if req.BlkID != "" && req.NoteUUID != "" {
		model := h.ServiceProvider.State.LoadSettings().Model
		completedAt := time.Now().UTC().Format(time.RFC3339)
		if err := h.ServiceProvider.AI.ResolveAiBlock(req.NoteUUID, req.BlkID, resp, model, "ASK"); err != nil {
			logger.Error("handleAiAsk: ResolveAiBlock failed", "err", err)
		} else if h.Broadcast != nil {
			data, _ := json.Marshal(map[string]string{
				"uuid":        req.NoteUUID,
				"blkId":       req.BlkID,
				"status":      "COMPLETE",
				"response":    resp,
				"model":       model,
				"completedAt": completedAt,
			})
			h.Broadcast("ai:block-resolved", string(data))
		}
	}

	w.Header().Set("Content-Type", "text/plain")
	w.Write([]byte(resp))
}
```

- [ ] **Step 5: Wrap handleAiExplain with job lifecycle events**

Same pattern as ask. The full function:

```go
func (h *AiHandler) handleAiExplain(w http.ResponseWriter, r *http.Request) {
	var req explainRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if req.BlkID != "" && req.Body != "" && req.NoteUUID != "" {
		for attempt := 0; attempt < 3; attempt++ {
			doc, err := h.ServiceProvider.Documents.LoadByUUID(req.NoteUUID)
			if err != nil {
				logger.Error("handleAiExplain: load for pre-save failed", "err", err)
				break
			}
			doc.SetBody([]byte(req.Body))
			if _, err := h.ServiceProvider.Documents.Save(doc); err != nil {
				if errors.Is(err, store.ErrStaleStorable) {
					continue
				}
				logger.Error("handleAiExplain: save body failed", "err", err)
			}
			break
		}
	}

	if req.BlkID != "" && req.NoteUUID != "" {
		h.emitJobStarted(req.BlkID, "Explaining...", req.NoteUUID, false)
		defer h.emitJobEnded(req.BlkID, req.NoteUUID)
	}

	resp, err := h.ServiceProvider.AI.RunExplain(req.Content, req.History, req.NoteUUID, req.ImageBlockIds)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if req.BlkID != "" && req.NoteUUID != "" {
		model := h.ServiceProvider.State.LoadSettings().Model
		completedAt := time.Now().UTC().Format(time.RFC3339)
		if err := h.ServiceProvider.AI.ResolveAiBlock(req.NoteUUID, req.BlkID, resp, model, "EXPLAIN"); err != nil {
			logger.Error("handleAiExplain: ResolveAiBlock failed", "err", err)
		} else if h.Broadcast != nil {
			data, _ := json.Marshal(map[string]string{
				"uuid":        req.NoteUUID,
				"blkId":       req.BlkID,
				"status":      "COMPLETE",
				"response":    resp,
				"model":       model,
				"completedAt": completedAt,
			})
			h.Broadcast("ai:block-resolved", string(data))
		}
	}

	w.Header().Set("Content-Type", "text/plain")
	w.Write([]byte(resp))
}
```

- [ ] **Step 6: Compile check**

```bash
go build ./...
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add requesthandlers/ai_handler.go
git commit -m "feat(ai-sse): AiHandler emits ai:job-started/ended and serves /api/ai/active-jobs"
```

---

## Task 3: InternalizeHandler — emit ai:job-started / ai:job-ended

**Files:**
- Modify: `requesthandlers/internalize_handler.go`

The `InternalizeHandler` runs web-clip jobs in a goroutine. It already has an `activeJobs sync.Map`. We replace that with the shared `JobTracker`, emit the SSE events, and remove the now-redundant `/api/internalize/active` endpoint.

The label for the status bar is derived from `mode` and the URL hostname using `net/url`.

- [ ] **Step 1: Replace activeJobs sync.Map with JobTracker field**

Replace the struct definition (lines 27–31):

```go
type InternalizeHandler struct {
	ServiceProvider *sieve.ServiceProvider
	Broadcast       func(event, data string)
	JobTracker      *JobTracker
}
```

Remove `"sync"` from imports (it's no longer used directly).

- [ ] **Step 2: Remove RegisterPaths entry for /api/internalize/active**

Replace `RegisterPaths` (lines 33–36):

```go
func (h *InternalizeHandler) RegisterPaths(r chi.Router) {
	r.Post("/api/internalize", h.handleInternalize)
}
```

- [ ] **Step 3: Delete the handleActiveJobs method**

Delete the entire `handleActiveJobs` method (lines 38–48). It is replaced by `GET /api/ai/active-jobs` served from `JobTracker.ServeActiveJobs`.

- [ ] **Step 4: Update runInBackground to use JobTracker and emit job events**

The web-clip label uses the URL hostname. Add `"net/url"` to imports.

Replace `runInBackground` (lines 125–167):

```go
func (h *InternalizeHandler) runInBackground(uuid, id, source, mode, docContent string) {
	label := "Fetching web page..."
	if mode == "summarise" {
		label = "Summarising web page..."
	}
	if u, err := url.Parse(source); err == nil && u.Host != "" {
		host := u.Host
		if mode == "summarise" {
			label = "Summarising " + host
		} else {
			label = "Fetching " + host
		}
	}

	if h.JobTracker != nil {
		h.JobTracker.Start(JobInfo{JobID: id, Label: label, DocID: uuid, SpinTab: false})
		defer h.JobTracker.End(id)
	}
	if h.Broadcast != nil {
		data, _ := json.Marshal(map[string]interface{}{
			"jobId": id, "label": label, "docId": uuid, "spinTab": false,
		})
		h.Broadcast("ai:job-started", string(data))
		endData, _ := json.Marshal(map[string]string{"jobId": id, "docId": uuid})
		defer h.Broadcast("ai:job-ended", string(endData))
	}

	settings := h.ServiceProvider.State.LoadSettings()
	model := settings.Model

	title, content, cliErr := h.ServiceProvider.AI.RunWebClip(uuid, id, source, mode, docContent)

	var status, errMsg, completedAt string
	if cliErr != nil {
		if strings.Contains(cliErr.Error(), "timeout") {
			status = "TIMEOUT"
		} else {
			status = "ERROR"
			errMsg = "Claude could not retrieve this page. Check that your MCP configuration can access this URL."
			model = ""
		}
		title = ""
		content = ""
	} else {
		status = "COMPLETE"
		completedAt = time.Now().UTC().Format(time.RFC3339)
	}

	if err := h.ServiceProvider.AI.ResolveWebClip(uuid, id, title, content, model, errMsg, status, completedAt); err != nil {
		logger.Error("handleInternalize: ResolveWebClip failed", "id", id, "err", err)
	}

	payload, _ := json.Marshal(map[string]string{
		"uuid":        uuid,
		"blkId":       id,
		"status":      status,
		"title":       title,
		"content":     content,
		"model":       model,
		"completedAt": completedAt,
		"error":       errMsg,
	})
	if h.Broadcast != nil {
		h.Broadcast("ai:web-clip-resolved", string(payload))
	}
}
```

Note: `ai:job-ended` fires via defer **before** `ai:web-clip-resolved` due to Go's defer LIFO ordering. This is correct — the status bar clears first, then the editor block updates.

Wait — actually we want `ai:web-clip-resolved` to fire before `ai:job-ended` so the editor updates its block before the spinner disappears. Reverse the defer order by not deferring `ai:job-ended` — instead call it explicitly at the end:

```go
func (h *InternalizeHandler) runInBackground(uuid, id, source, mode, docContent string) {
	label := "Fetching web page..."
	if mode == "summarise" {
		label = "Summarising web page..."
	}
	if u, err := url.Parse(source); err == nil && u.Host != "" {
		host := u.Host
		if mode == "summarise" {
			label = "Summarising " + host
		} else {
			label = "Fetching " + host
		}
	}

	if h.JobTracker != nil {
		h.JobTracker.Start(JobInfo{JobID: id, Label: label, DocID: uuid, SpinTab: false})
	}
	if h.Broadcast != nil {
		data, _ := json.Marshal(map[string]interface{}{
			"jobId": id, "label": label, "docId": uuid, "spinTab": false,
		})
		h.Broadcast("ai:job-started", string(data))
	}

	settings := h.ServiceProvider.State.LoadSettings()
	model := settings.Model

	title, content, cliErr := h.ServiceProvider.AI.RunWebClip(uuid, id, source, mode, docContent)

	var status, errMsg, completedAt string
	if cliErr != nil {
		if strings.Contains(cliErr.Error(), "timeout") {
			status = "TIMEOUT"
		} else {
			status = "ERROR"
			errMsg = "Claude could not retrieve this page. Check that your MCP configuration can access this URL."
			model = ""
		}
		title = ""
		content = ""
	} else {
		status = "COMPLETE"
		completedAt = time.Now().UTC().Format(time.RFC3339)
	}

	if err := h.ServiceProvider.AI.ResolveWebClip(uuid, id, title, content, model, errMsg, status, completedAt); err != nil {
		logger.Error("handleInternalize: ResolveWebClip failed", "id", id, "err", err)
	}

	payload, _ := json.Marshal(map[string]string{
		"uuid":        uuid,
		"blkId":       id,
		"status":      status,
		"title":       title,
		"content":     content,
		"model":       model,
		"completedAt": completedAt,
		"error":       errMsg,
	})
	if h.Broadcast != nil {
		h.Broadcast("ai:web-clip-resolved", string(payload))
	}

	// Emit ended after web-clip-resolved so the editor updates before the spinner clears.
	if h.JobTracker != nil {
		h.JobTracker.End(id)
	}
	if h.Broadcast != nil {
		endData, _ := json.Marshal(map[string]string{"jobId": id, "docId": uuid})
		h.Broadcast("ai:job-ended", string(endData))
	}
}
```

- [ ] **Step 5: Update imports**

The file needs `"net/url"` added and `"sync"` removed. Verify the full import block:

```go
import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"sieve/logger"
	"sieve/sieve"
	"sieve/sieve/webclip"
	"sieve/store"
)
```

- [ ] **Step 6: Compile check**

```bash
go build ./...
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add requesthandlers/internalize_handler.go
git commit -m "feat(ai-sse): InternalizeHandler emits ai:job-started/ended via shared JobTracker"
```

---

## Task 4: Wire JobTracker in handlers.go

**Files:**
- Modify: `handlers.go` (lines ~156–168)

- [ ] **Step 1: Create JobTracker and inject into both handlers**

In `newAPIHandler()`, create the tracker before the handler slice and pass it to both `AiHandler` and `InternalizeHandler`:

```go
tracker := requesthandlers.NewJobTracker()
```

Then update the two handler initialisations:

```go
&requesthandlers.AiHandler{
    ServiceProvider: sp,
    JobTracker: tracker,
    EmitNotesChanged: func() {
        logger.Info("AI: notes changed event")
        hub.broadcast("notes:changed", "{}")
    },
    Broadcast: hub.broadcast,
},
&requesthandlers.InternalizeHandler{
    ServiceProvider: sp,
    JobTracker:      tracker,
    Broadcast:       hub.broadcast,
},
```

- [ ] **Step 2: Compile check**

```bash
go build ./...
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add handlers.go
git commit -m "feat(ai-sse): wire shared JobTracker into AiHandler and InternalizeHandler"
```

---

## Task 5: Rewrite ai-actions.js as SSE consumer

**Files:**
- Modify: `frontend/src/static/ai-actions.js`

Remove `trackJob()`, `activeJobLabels`, and the direct-manipulation `saveAndPost` cleanup. Replace with SSE listeners and `loadActiveJobs()`.

- [ ] **Step 1: Rewrite ai-actions.js**

```js
// ai-actions.js — Status bar driven by ai:job-started / ai:job-ended SSE events from Go.
// Exposes window.SieveAI namespace; maintains window.__sieveActiveJobs for the close-guard.
(function() {
  // activeJobs: jobId → {label, docId, spinTab}. Populated by SSE events and loadActiveJobs().
  var activeJobs = {};
  window.__sieveActiveJobs = 0;

  function updateStatusBar() {
    var sbLeft = document.querySelector('.status-bar__left');
    if (!sbLeft) return;
    var ids = Object.keys(activeJobs);
    if (ids.length === 0) { sbLeft.innerHTML = ''; return; }

    var firstLabel = activeJobs[ids[0]].label;
    var span = document.createElement('span');
    span.className = 'flex items-center gap-1.5';
    var spinner = document.createElement('span');
    spinner.className = 'w-[10px] h-[10px] shrink-0 rounded-full border-[1.5px] border-solid border-tn-cyan border-t-transparent animate-spin';
    var text = document.createElement('span');
    var extra = ids.length > 1 ? ' +' + (ids.length - 1) + ' more' : '';
    text.textContent = firstLabel + extra;
    span.appendChild(spinner);
    span.appendChild(text);
    sbLeft.innerHTML = '';
    sbLeft.appendChild(span);
  }

  function setEvaluating(id, isEval) {
    var tab = document.querySelector('.group[data-tab-id="' + id + '"]');
    if (tab) {
      var normal = tab.querySelector('.tab-icon-normal');
      var spinner = tab.querySelector('.tab-spinner');
      if (isEval) {
        if (normal) normal.classList.add('hidden');
        if (spinner) spinner.classList.remove('hidden');
      } else {
        if (normal) normal.classList.remove('hidden');
        if (spinner) spinner.classList.add('hidden');
      }
    }
    var metaSpinner = document.getElementById('meta-thinking-spinner');
    if (metaSpinner) {
      var mount = document.getElementById('tiptap-mount');
      if (mount && mount.getAttribute('data-uuid') === id) {
        if (isEval) metaSpinner.classList.remove('hidden');
        else metaSpinner.classList.add('hidden');
      }
    }
  }

  function parseSSEDetail(e) {
    try { return JSON.parse(e.detail || '{}'); } catch (_) { return {}; }
  }

  document.addEventListener('sse:ai:job-started', function(e) {
    var data = parseSSEDetail(e);
    if (!data.jobId) return;
    activeJobs[data.jobId] = { label: data.label || 'Working...', docId: data.docId, spinTab: !!data.spinTab };
    window.__sieveActiveJobs = Object.keys(activeJobs).length;
    if (data.spinTab && data.docId) setEvaluating(data.docId, true);
    updateStatusBar();
  });

  document.addEventListener('sse:ai:job-ended', function(e) {
    var data = parseSSEDetail(e);
    if (!data.jobId) return;
    var job = activeJobs[data.jobId] || {};
    delete activeJobs[data.jobId];
    window.__sieveActiveJobs = Object.keys(activeJobs).length;
    var docId = job.docId || data.docId;
    var spinTab = job.spinTab != null ? job.spinTab : !!data.spinTab;
    if (spinTab && docId) setEvaluating(docId, false);
    updateStatusBar();
  });

  function saveAndPost(url, id) {
    var p = window._editorSave ? window._editorSave() : Promise.resolve();
    p.then(function() {
      if (!id) {
        var mount = document.getElementById('tiptap-mount');
        if (mount) id = mount.getAttribute('data-uuid');
      }
      if (id) {
        fetch(url + id, { method: 'POST' });
        // Go emits ai:job-started and ai:job-ended via SSE — no JS tracking needed here.
      }
    });
  }

  window.SieveAI = {
    // loadActiveJobs: called by editor.js on tab load to restore status bar state.
    // Replaces the old /api/internalize/active call.
    loadActiveJobs: function() {
      fetch('/api/ai/active-jobs')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var jobs = data.jobs || [];
          jobs.forEach(function(job) {
            if (!job.jobId) return;
            activeJobs[job.jobId] = { label: job.label || 'Working...', docId: job.docId, spinTab: !!job.spinTab };
            if (job.spinTab && job.docId) setEvaluating(job.docId, true);
          });
          window.__sieveActiveJobs = Object.keys(activeJobs).length;
          updateStatusBar();
        })
        .catch(function() {});
    },
    smartFile:        function(id) { saveAndPost('/api/ai/smartFile/',    id); },
    smartMetadata:    function(id) { saveAndPost('/api/ai/smartMetadata/', id); },
    keepAndSmartFile: function(id) { saveAndPost('/api/ai/keepAndFile/',  id); }
  };
})();
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/static/ai-actions.js
git commit -m "feat(ai-sse): ai-actions.js becomes SSE consumer — remove trackJob(), add loadActiveJobs()"
```

---

## Task 6: editor.js — remove trackJob call sites

**Files:**
- Modify: `frontend/src/static/editor.js`

There are 11 `trackJob` call sites and two sets of tracking state (`pendingAiBlkIds`, `window.__sieveActiveWebClips`) to remove. The tab load code calling `/api/internalize/active` is also replaced.

- [ ] **Step 1: Remove pendingAiBlkIds and window.__sieveActiveWebClips declarations**

Find the declarations near lines 23–30 and delete them. They look like:

```js
window.__sieveActiveWebClips = window.__sieveActiveWebClips || new Set()
// ...
var pendingAiBlkIds = new Set()
```

Delete both lines.

- [ ] **Step 2: Replace the tab-load active-jobs fetch (lines ~56–63)**

The current code is a `Promise.all` that fetches both the editor content and `/api/internalize/active`:

```js
Promise.all([
  fetch('/api/editor/load?uuid=' + encodeURIComponent(uuid)).then(function (r) { return r.json() }),
  fetch('/api/internalize/active').then(function (r) { return r.json() }).catch(function () { return { active: [] } }),
]).then(function (results) {
    var activeData = results[1]
    window.__sieveActiveWebClips = new Set(activeData.active || [])
    // ... (editor init using results[0])
```

Replace with a simple single fetch, and call `loadActiveJobs` separately:

```js
fetch('/api/editor/load?uuid=' + encodeURIComponent(uuid))
  .then(function (r) { return r.json() })
  .then(function (data) {
    window.SieveAI && window.SieveAI.loadActiveJobs();
    // ... (rest of editor init using data — same as before but using results[0])
```

Note: verify the exact shape of the `Promise.all` block and preserve all existing editor initialisation logic — only the second fetch and `activeData` usage is removed.

- [ ] **Step 3: Remove trackJob(1) at web-clip start (lines ~427–429)**

Find:
```js
window.__sieveActiveWebClips.add(resp.id)
var wcLabel = (mode === 'summarise' ? 'Summarising ' : 'Fetching ') + extractDomain(source)
window.SieveAI && window.SieveAI.trackJob(1, resp.id, wcLabel)
```

Delete all three lines.

- [ ] **Step 4: Remove trackJob(-1) at ask/explain SSE completion (lines ~597–599)**

Find:
```js
if (data.blkId && pendingAiBlkIds.has(data.blkId)) {
  pendingAiBlkIds.delete(data.blkId)
  window.SieveAI && window.SieveAI.trackJob(-1, data.blkId)
}
```

Delete all three lines (the guard and its body). Leave any other code in the `sse:ai:block-resolved` handler intact.

- [ ] **Step 5: Remove trackJob(-1) at web-clip SSE completion (lines ~647–649)**

Find:
```js
if (data.blkId && window.__sieveActiveWebClips.has(data.blkId)) {
  window.__sieveActiveWebClips.delete(data.blkId)
  window.SieveAI && window.SieveAI.trackJob(-1, data.blkId)
}
```

Delete all three lines. Leave any other code in the `sse:ai:web-clip-resolved` handler intact.

- [ ] **Step 6: Remove trackJob(1) at ask/explain start — first occurrence (lines ~826–827)**

Find (inside `runAiJob` or equivalent):
```js
pendingAiBlkIds.add(blkId)
window.SieveAI && window.SieveAI.trackJob(1, blkId, type === 'explain' ? 'Explaining...' : 'Asking AI...')
```

Delete both lines.

- [ ] **Step 7: Remove trackJob(-1) at ask/explain fetch error — first occurrence (lines ~840–842)**

Find:
```js
if (pendingAiBlkIds.has(blkId)) {
  pendingAiBlkIds.delete(blkId)
  window.SieveAI && window.SieveAI.trackJob(-1, blkId)
}
```

Delete all three lines (Go will emit `ai:job-ended` when the handler returns its error, so JS cleanup is no longer needed).

- [ ] **Step 8: Remove trackJob(1) at ask/explain start — second occurrence (lines ~1453–1454)**

Find (second ask/explain code path, likely inline/retry):
```js
pendingAiBlkIds.add(blkId)
window.SieveAI && window.SieveAI.trackJob(1, blkId, type === 'explain' ? 'Explaining...' : 'Asking AI...')
```

Delete both lines.

- [ ] **Step 9: Remove trackJob(-1) at ask/explain fetch error — second occurrence (lines ~1466–1468)**

Find:
```js
if (pendingAiBlkIds.has(blkId)) {
  pendingAiBlkIds.delete(blkId)
  window.SieveAI && window.SieveAI.trackJob(-1, blkId)
}
```

Delete all three lines.

- [ ] **Step 10: Remove trackJob(1) at web-clip retry start (lines ~1513–1515)**

Find:
```js
window.__sieveActiveWebClips.add(blkId)
var wcRetryLabel = (detail.mode === 'summarise' ? 'Summarising ' : 'Fetching ') + extractDomain(detail.source)
window.SieveAI && window.SieveAI.trackJob(1, blkId, wcRetryLabel)
```

Delete all three lines.

- [ ] **Step 11: Remove trackJob(-1) at web-clip retry error — both occurrences (lines ~1528–1534)**

Find (two separate catch/error paths):
```js
window.__sieveActiveWebClips.delete(blkId)
window.SieveAI && window.SieveAI.trackJob(-1, blkId)
```

Delete both pairs of lines (two occurrences, ~lines 1528–1529 and ~1533–1534).

- [ ] **Step 12: Commit**

```bash
git add frontend/src/static/editor.js
git commit -m "feat(ai-sse): editor.js — remove 11 trackJob call sites and web-clip/ask tracking state"
```

---

## Task 7: index.html — add SSE relay divs for new events

**Files:**
- Modify: `frontend/src/index.html`

The HTMX SSE extension fires `sse:<eventName>` DOM events for elements that receive SSE messages. The existing relay divs near lines 28–31 ensure `sse:ai:block-resolved` and `sse:ai:web-clip-resolved` bubble as DOM events. Add equivalent divs for the two new events so `document.addEventListener('sse:ai:job-started', ...)` in `ai-actions.js` fires reliably.

- [ ] **Step 1: Add relay divs**

Find:
```html
<div id="ai-sse-relay" hx-trigger="sse:ai:block-resolved" style="display:none"></div>
<div id="webclip-sse-relay" hx-trigger="sse:ai:web-clip-resolved" style="display:none"></div>
```

Replace with:
```html
<div id="ai-sse-relay" hx-trigger="sse:ai:block-resolved" style="display:none"></div>
<div id="webclip-sse-relay" hx-trigger="sse:ai:web-clip-resolved" style="display:none"></div>
<div id="ai-job-started-relay" hx-trigger="sse:ai:job-started" style="display:none"></div>
<div id="ai-job-ended-relay" hx-trigger="sse:ai:job-ended" style="display:none"></div>
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/index.html
git commit -m "feat(ai-sse): add SSE relay divs for ai:job-started and ai:job-ended"
```

---

## Task 8: End-to-End Verification

- [ ] **Step 1: Full compile check**

```bash
go build ./...
```
Expected: no errors.

- [ ] **Step 2: Run all Go tests**

```bash
go test ./...
```
Expected: all pass (especially `TestJobTracker_*`).

- [ ] **Step 3: Start dev server**

```bash
wails dev
```

- [ ] **Step 4: Verify smartFile (tab spinner + status bar)**

1. Open a note with content.
2. Right-click → "Smart File" (or keyboard shortcut).
3. **Expected:** Status bar left shows "Filing note..." with a spinner. The active tab shows the rotating arc spinner (`.tab-spinner`). The meta panel thinking spinner appears.
4. Wait for completion (~30s).
5. **Expected:** All spinners disappear. Status bar left is empty. Tab icon returns to its normal dot.

- [ ] **Step 5: Verify smartMetadata**

1. Open a note.
2. Trigger smart metadata update.
3. **Expected:** Status bar shows "Updating metadata...". Tab spinner active.
4. After completion: all clear.

- [ ] **Step 6: Verify Ask/Explain (status bar only, no tab spinner)**

1. In a note, create an AI block and run Ask.
2. **Expected:** Status bar shows "Asking AI...". Tab spinner does NOT appear (spinTab=false for block-level jobs).
3. After AI resolves: status bar clears. Block updates with response.

- [ ] **Step 7: Verify web clip (status bar only)**

1. Paste a URL as a web clip.
2. **Expected:** Status bar shows "Fetching <hostname>" (e.g., "Fetching github.com").
3. After fetch: status bar clears. Web-clip block updates.

- [ ] **Step 8: Verify tab switch restores active jobs**

1. Start a long-running web clip.
2. Switch to a different note tab.
3. Switch back.
4. **Expected:** Status bar still shows the web clip label (restored via `loadActiveJobs()` call on tab mount).

- [ ] **Step 9: Verify close guard**

1. Start a long-running AI job (smartFile works well — ~30s).
2. Immediately close the app window.
3. **Expected:** "Closing... Waiting for AI background tasks to finish" overlay appears. App stays open until the job completes, then quits.

- [ ] **Step 10: Verify /api/internalize/active is gone (no 404s in console)**

Check browser console / network tab — no requests to `/api/internalize/active` should appear.
