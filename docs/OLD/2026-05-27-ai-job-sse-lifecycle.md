# AI Job Lifecycle via Go SSE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace JS-side `trackJob()` call sites with Go-broadcast `ai:job-started` / `ai:job-ended` SSE events, making Go the single source of truth for AI job lifecycle and eliminating JS call sites that manually track status bar state.

**Architecture:** A new `JobTracker` struct (in `requesthandlers/`) is the shared in-flight job registry. Both `AiHandler` and `InternalizeHandler` hold a pointer to it. Each handler emits `ai:job-started` / `ai:job-ended` SSE events at job boundaries, and registers/deregisters from the tracker. A new `GET /api/ai/active-jobs` endpoint (registered on `AiHandler`) replaces both the existing `/api/ai/active` (on `AiHandler`) and `/api/internalize/active` (on `InternalizeHandler`) endpoints. `ai-actions.js` becomes a pure SSE consumer — `trackJob()` is deleted and `window.SieveAI.loadActiveJobs()` replaces the old active-jobs fetches in `editor.js`.

**Tech Stack:** Go (chi, `sync.RWMutex`), vanilla JS, HTMX SSE extension, Wails v2

---

## Current State (verified 2026-06-01)

### Go — what exists and needs replacing

| Handler | Current tracking | Route to remove |
|---------|-----------------|-----------------|
| `AiHandler` | `activeJobs sync.Map` (blkID → struct{}) | `GET /api/ai/active` → `handleActiveJobs` |
| `InternalizeHandler` | `activeJobs sync.Map` (blkID → struct{}) | `GET /api/internalize/active` → `handleActiveJobs` |

`evaluateAndFile` runs **synchronously** in the HTTP handler (no goroutine). Job events wrap it directly.

`runAiBlock` is the async goroutine for ask/explain. Job events belong here, **not** in `handleAiAsk`/`handleAiExplain`.

`runInBackground` is the async goroutine for web clips. Job events belong here.

### JS — actual `trackJob` call sites (verified via grep)

| Line | Site | Direction |
|------|------|-----------|
| ~460–462 | web-clip new block (doInternalize) | +1 start |
| ~630–632 | `sse:ai:block-resolved` handler | −1 end |
| ~647–649 | `sse:ai:web-clip-resolved` handler | −1 end |
| ~793–794 | `runAiJob` ask/explain start | +1 start |
| ~1414–1415 | retry-path ask/explain start | +1 start |
| ~1436–1438 | retry-path ask/explain fetch error | −1 end |
| ~1484–1486 | web-clip retry start | +1 start |
| ~1499–1500 | web-clip retry error (path 1) | −1 end |
| ~1504–1505 | web-clip retry error (path 2) | −1 end |

State variables to delete: `window.__sieveActiveWebClips` (line ~26), `pendingAiBlkIds` (line ~34).

---

## File Map

| Action | File | Change |
|--------|------|--------|
| **Create** | `requesthandlers/job_tracker.go` | `JobTracker` struct + `JobInfo` type |
| **Create** | `requesthandlers/job_tracker_test.go` | Unit tests for `JobTracker` |
| **Modify** | `requesthandlers/ai_handler.go` | Replace `activeJobs sync.Map`; add `JobTracker` field; emit job events from `evaluateAndFile` and `runAiBlock`; replace `GET /api/ai/active` with `GET /api/ai/active-jobs` |
| **Modify** | `requesthandlers/internalize_handler.go` | Replace `activeJobs sync.Map` with `JobTracker`; emit job events from `runInBackground`; remove `GET /api/internalize/active` |
| **Modify** | `handlers.go` | Create `JobTracker` instance; inject into both handlers |
| **Modify** | `frontend/src/static/ai-actions.js` | Rewrite as SSE consumer; remove `trackJob()`; add `loadActiveJobs()` |
| **Modify** | `frontend/src/static/editor.js` | Remove all `trackJob()` call sites; remove `pendingAiBlkIds`; remove `window.__sieveActiveWebClips`; replace `/api/internalize/active` fetch with `SieveAI.loadActiveJobs()` |
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

- [ ] **Step 6: Commit**

```bash
git add requesthandlers/job_tracker.go requesthandlers/job_tracker_test.go
git commit -m "feat(ai-sse): add JobTracker — shared in-flight AI job registry"
```

---

## Task 2: AiHandler — emit ai:job-started / ai:job-ended

**Files:**
- Modify: `requesthandlers/ai_handler.go`

**Note on current structure:** `handleAiAsk` and `handleAiExplain` now return immediately after inserting the pending block — they launch `go runAiBlock(...)` and return `{id, fence}`. Job lifecycle events belong in `runAiBlock`, NOT in the handlers themselves. `evaluateAndFile` is synchronous and wraps directly.

- [ ] **Step 1: Replace activeJobs sync.Map with JobTracker field; add helper methods**

Replace the `AiHandler` struct (currently lines 19–24) and add two helpers after it. Also remove `"sync"` from imports if it is no longer needed after this change (verify other uses first — `sync` may still be used elsewhere in the file).

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

- [ ] **Step 2: Replace GET /api/ai/active with GET /api/ai/active-jobs in RegisterPaths**

Replace the existing `r.Get("/api/ai/active", h.handleActiveJobs)` line and delete the `handleActiveJobs` method. The new route delegates to `JobTracker`:

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

Delete the entire `handleActiveJobs` method that currently serves `{"active": [ids...]}`.

- [ ] **Step 3: Wrap evaluateAndFile with job lifecycle events**

`evaluateAndFile` is synchronous. Emit `ai:job-started` after the document-exists check, then defer `ai:job-ended`. The job ID is the document ID (same value used for tab spinner targeting).

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

- [ ] **Step 4: Wrap runAiBlock with job lifecycle events**

`runAiBlock` is the goroutine where ask/explain work actually happens. Replace the `activeJobs.Store`/`Delete` calls with `emitJobStarted`/`emitJobEnded`. Emit `ai:job-ended` **after** `ai:block-resolved` so the editor updates before the spinner clears — call it explicitly at the end rather than using defer.

Replace the current `runAiBlock` (currently at lines ~213–257):

```go
func (h *AiHandler) runAiBlock(uuid, blkID, blockType, content, history, question string, imageBlockIds []string) {
	label := "Asking AI..."
	if blockType == "EXPLAIN" {
		label = "Explaining..."
	}
	h.emitJobStarted(blkID, label, uuid, false)

	settings := h.ServiceProvider.State.LoadSettings()
	model := settings.Model

	var resp string
	var runErr error
	if blockType == "ASK" {
		resp, runErr = h.ServiceProvider.AI.RunAsk(content, history, question, uuid, imageBlockIds)
	} else {
		resp, runErr = h.ServiceProvider.AI.RunExplain(content, history, uuid, imageBlockIds)
	}

	var status, completedAt string
	if runErr != nil {
		if strings.Contains(runErr.Error(), "timeout") {
			status = "TIMEOUT"
		} else {
			status = "ERROR"
		}
		model = ""
		resp = ""
		h.resolveAiBlockStatus(uuid, blkID, status, blockType)
	} else {
		status = "COMPLETE"
		completedAt = time.Now().UTC().Format(time.RFC3339)
		if err := h.ServiceProvider.AI.ResolveAiBlock(uuid, blkID, resp, model, blockType); err != nil {
			logger.Error("runAiBlock: ResolveAiBlock failed", "id", blkID, "err", err)
		}
	}

	payload, _ := json.Marshal(map[string]string{
		"uuid":        uuid,
		"blkId":       blkID,
		"status":      status,
		"response":    resp,
		"model":       model,
		"completedAt": completedAt,
	})
	if h.Broadcast != nil {
		h.Broadcast("ai:block-resolved", string(payload))
	}

	// Emit ended after ai:block-resolved so the editor updates before the spinner clears.
	h.emitJobEnded(blkID, uuid)
}
```

- [ ] **Step 5: Compile check**

```bash
go build ./...
```

- [ ] **Step 6: Commit**

```bash
git add requesthandlers/ai_handler.go
git commit -m "feat(ai-sse): AiHandler emits ai:job-started/ended and serves /api/ai/active-jobs"
```

---

## Task 3: InternalizeHandler — emit ai:job-started / ai:job-ended

**Files:**
- Modify: `requesthandlers/internalize_handler.go`

Replace `activeJobs sync.Map` with `JobTracker`, emit SSE events from `runInBackground`, and remove `/api/internalize/active`.

- [ ] **Step 1: Replace activeJobs sync.Map with JobTracker field**

Replace the struct definition (currently lines 27–31):

```go
type InternalizeHandler struct {
	ServiceProvider *sieve.ServiceProvider
	Broadcast       func(event, data string)
	JobTracker      *JobTracker
}
```

Remove `"sync"` from imports (no longer needed).

- [ ] **Step 2: Remove /api/internalize/active from RegisterPaths and delete handleActiveJobs**

```go
func (h *InternalizeHandler) RegisterPaths(r chi.Router) {
	r.Post("/api/internalize", h.handleInternalize)
}
```

Delete the entire `handleActiveJobs` method (currently lines ~38–48).

- [ ] **Step 3: Update runInBackground to use JobTracker and emit job events**

Add `"net/url"` to imports. The label uses the URL hostname.

Emit `ai:job-ended` **after** `ai:web-clip-resolved` so the editor block updates before the spinner clears — call it explicitly at the end, not via defer.

Replace `runInBackground` (currently lines ~125–167):

```go
func (h *InternalizeHandler) runInBackground(uuid, id, source, mode, docContent string) {
	label := "Fetching web page..."
	if mode == "summarise" {
		label = "Summarising web page..."
	}
	if u, err := url.Parse(source); err == nil && u.Host != "" {
		if mode == "summarise" {
			label = "Summarising " + u.Host
		} else {
			label = "Fetching " + u.Host
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

- [ ] **Step 4: Compile check**

```bash
go build ./...
```

- [ ] **Step 5: Commit**

```bash
git add requesthandlers/internalize_handler.go
git commit -m "feat(ai-sse): InternalizeHandler emits ai:job-started/ended via shared JobTracker"
```

---

## Task 4: Wire JobTracker in handlers.go

**Files:**
- Modify: `handlers.go` (lines ~156–168)

- [ ] **Step 1: Create JobTracker and inject into both handlers**

In `newAPIHandler()`, create the tracker before the handler slice:

```go
tracker := requesthandlers.NewJobTracker()
```

Update the two handler initialisations:

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

- [ ] **Step 3: Commit**

```bash
git add handlers.go
git commit -m "feat(ai-sse): wire shared JobTracker into AiHandler and InternalizeHandler"
```

---

## Task 5: Rewrite ai-actions.js as SSE consumer

**Files:**
- Modify: `frontend/src/static/ai-actions.js`

Remove `trackJob()`, `activeJobLabels`, and the tab-spinner direct manipulation from `saveAndPost`. Replace with SSE listeners (`sse:ai:job-started`, `sse:ai:job-ended`) and `loadActiveJobs()`.

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

Use grep to verify exact line numbers before editing — they may have shifted from those listed below.

- [ ] **Step 1: Remove state variable declarations (~lines 26, 34)**

Delete:
```js
window.__sieveActiveWebClips = window.__sieveActiveWebClips || new Set()
```
and:
```js
var pendingAiBlkIds = new Set()
```

Also delete the comment on line ~24 ("Populated from /api/internalize/active on each note load...").

- [ ] **Step 2: Replace the Promise.all tab-load fetch (~lines 56–72)**

The current code fetches both the editor content AND `/api/internalize/active` in a `Promise.all` and seeds `window.__sieveActiveWebClips`. Replace it with a single editor-load fetch and a separate `loadActiveJobs()` call:

```js
fetch('/api/editor/load?uuid=' + encodeURIComponent(uuid))
  .then(function (r) { return r.json() })
  .then(function (data) {
    window.SieveAI && window.SieveAI.loadActiveJobs()
    // ... rest of editor init using data (unchanged)
```

Preserve ALL existing editor initialisation logic inside the `.then` — only the `Promise.all` wrapper, second fetch, and `activeData`/`window.__sieveActiveWebClips` seeding are removed.

- [ ] **Step 3: Remove web-clip start tracking (~lines 460–462)**

Find and delete:
```js
window.__sieveActiveWebClips.add(resp.id)
var wcLabel = (mode === 'summarise' ? 'Summarising ' : 'Fetching ') + extractDomain(source)
window.SieveAI && window.SieveAI.trackJob(1, resp.id, wcLabel)
```

- [ ] **Step 4: Remove ask/explain end tracking in sse:ai:block-resolved (~lines 630–632)**

Find and delete:
```js
if (data.blkId && pendingAiBlkIds.has(data.blkId)) {
  pendingAiBlkIds.delete(data.blkId)
  window.SieveAI && window.SieveAI.trackJob(-1, data.blkId)
}
```
Leave all other code in the `sse:ai:block-resolved` handler intact.

- [ ] **Step 5: Remove web-clip end tracking in sse:ai:web-clip-resolved (~lines 647–649)**

Find and delete:
```js
if (data.blkId && window.__sieveActiveWebClips.has(data.blkId)) {
  window.__sieveActiveWebClips.delete(data.blkId)
  window.SieveAI && window.SieveAI.trackJob(-1, data.blkId)
}
```
Leave all other code in the `sse:ai:web-clip-resolved` handler intact.

- [ ] **Step 6: Remove ask/explain start tracking in runAiJob (~lines 793–794)**

Find and delete:
```js
pendingAiBlkIds.add(blkId)
window.SieveAI && window.SieveAI.trackJob(1, blkId, type === 'explain' ? 'Explaining...' : 'Asking AI...')
```

- [ ] **Step 7: Remove ask/explain start tracking on retry path (~lines 1414–1415)**

Find and delete (second occurrence of same pattern):
```js
pendingAiBlkIds.add(blkId)
window.SieveAI && window.SieveAI.trackJob(1, blkId, type === 'explain' ? 'Explaining...' : 'Asking AI...')
```

- [ ] **Step 8: Remove ask/explain error cleanup on retry path (~lines 1436–1438)**

Find and delete:
```js
if (pendingAiBlkIds.has(blkId)) {
  pendingAiBlkIds.delete(blkId)
  window.SieveAI && window.SieveAI.trackJob(-1, blkId)
}
```

- [ ] **Step 9: Remove web-clip retry start tracking (~lines 1484–1486)**

Find and delete:
```js
window.__sieveActiveWebClips.add(blkId)
var wcRetryLabel = (detail.mode === 'summarise' ? 'Summarising ' : 'Fetching ') + extractDomain(detail.source)
window.SieveAI && window.SieveAI.trackJob(1, blkId, wcRetryLabel)
```

- [ ] **Step 10: Remove web-clip retry error cleanup — both paths (~lines 1499–1505)**

Find and delete both occurrences:
```js
window.__sieveActiveWebClips.delete(blkId)
window.SieveAI && window.SieveAI.trackJob(-1, blkId)
```

- [ ] **Step 11: Compile check (Go) + verify no trackJob references remain**

```bash
go build ./...
grep -n "trackJob\|pendingAiBlkIds\|__sieveActiveWebClips\|internalize/active" frontend/src/static/editor.js
```
Expected: `go build` clean, grep returns no results.

- [ ] **Step 12: Commit**

```bash
git add frontend/src/static/editor.js
git commit -m "feat(ai-sse): editor.js — remove trackJob call sites and web-clip/ask tracking state"
```

---

## Task 7: index.html — add SSE relay divs for new events

**Files:**
- Modify: `frontend/src/index.html`

The existing relay divs (lines ~30–31) relay `sse:ai:block-resolved` and `sse:ai:web-clip-resolved`. Add equivalent divs so `document.addEventListener('sse:ai:job-started', ...)` and `sse:ai:job-ended` in `ai-actions.js` fire reliably.

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

- [ ] **Step 1: Full compile check and tests**

```bash
go build ./...
go test ./...
```
Expected: all pass.

- [ ] **Step 2: Verify no old endpoints are called**

```bash
grep -rn "internalize/active\|/api/ai/active[^-]" frontend/src/
```
Expected: no results.

- [ ] **Step 3: Start dev server**

```bash
wails dev
```

- [ ] **Step 4: Verify smartFile (tab spinner + status bar)**

1. Open a note with content.
2. Right-click → "Smart File".
3. **Expected:** Status bar left shows "Filing note..." with spinner. Active tab shows rotating arc spinner. Meta panel thinking spinner appears.
4. After completion: all spinners disappear, status bar empty, tab icon returns to normal.

- [ ] **Step 5: Verify Ask/Explain (status bar only, no tab spinner)**

1. Create an AI block and run Ask.
2. **Expected:** Status bar shows "Asking AI...". Tab spinner does NOT appear (spinTab=false).
3. After AI resolves: status bar clears, block updates with response.

- [ ] **Step 6: Verify web clip (status bar only)**

1. Paste a URL as a web clip.
2. **Expected:** Status bar shows "Fetching \<hostname\>".
3. After fetch: status bar clears, web-clip block updates.

- [ ] **Step 7: Verify tab switch restores active jobs**

1. Start a long-running web clip.
2. Switch to a different note tab and back.
3. **Expected:** Status bar still shows the web clip label (restored via `loadActiveJobs()`).

- [ ] **Step 8: Verify close guard**

1. Start a long-running smartFile (~30s).
2. Immediately close the app window.
3. **Expected:** "Closing... Waiting for AI background tasks to finish" overlay appears. App stays open until job completes, then quits.
