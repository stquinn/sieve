# Job Engine Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the language leaf that breaks the `ai → block` import cycle, then build the communal `JobEngine` + generalised `JobTracker` foundation — fully unit-tested, wired to no production caller yet.

**Architecture:** This is **Phase 0 + Phase A** of the communal-job-engine design (`docs/superpowers/specs/2026-06-30-async-ai-job-queue-design.md`). Phase 0 moves `block/language_heuristics.go` to a new `sieve/lang` leaf so `ai` stops importing `block` (the smell that forced `block.AIPort`). Phase A adds the generalised `JobTracker` (Active **and** Queued lists, `jobs:changed`, `/api/jobs`) and the `JobEngine` (one communal instance, a bounded worker pool per `Category`) as new, additive code in `services`. **Nothing existing is rewired or deleted here** — both changes are non-breaking, every commit builds green. The behaviour-changing cutover (delete `block.AIPort`, declarative processors, `EditorService` document entries, retire the old tracker writers, fold in close-all, frontend) is **Plan 2 (Phase B/C)**, written after this lands.

**Tech Stack:** Go. Tests: `go test ./...`; concurrency tests run under `-race` (`go test ./sieve/services/... -race`). Compile check: `go build ./...` (no npm step). Module path root is `sieve` (packages import as `sieve/sieve/<pkg>`).

## Global Constraints

- **No loose/free functions** — behaviour belongs as a method on the type that owns its data. (CLAUDE.md Design Principles.)
- **`Category` is opaque data to the engine** — no `switch category`, no central enum. Category constants are owned by the *submitting* subsystem, not defined in `services`.
- **Worker pools size the *consumer* side** — `worker_pools` values are worker counts, never queue depth. Queues are effectively unbounded (a fixed large channel buffer is the runaway backstop).
- **Additive only** — do not modify `block.AIPort`, processors, `EditorService.RunJob`, `ai_handler`, or the frontend in this plan. Keep existing `JobTracker.Start/End/Active/ServeActiveJobs` working.
- **Commit messages:** no `Co-Authored-By` trailer (project convention).
- **Tests live with the type they exercise** — white-box tests go in the type's own package.

## Out of Scope / Deferred (do NOT do here — these are Plan 2)

- Deleting `block.AIPort` / retyping `BlockServices.AI` / `BlockingAIPort`.
- `block.ProcessorJob`, `DescribeJob`, `services.JobRunner`, the `Apply→finish` wrap.
- `EditorService` document-lifecycle entries (`CloseDocument`/`CloseAll`/`FileDocument`/…).
- Retiring `editor_service.go`'s `jobs.Start/End` or `ai_handler.go`'s `emitJob*`.
- `worker_pools` settings field + root wiring of the engine (engine is constructed only in tests here).
- Frontend status-bar lists / event rename consumption / removing `/api/ai/active-jobs`.
- The close-all fold and `close_filing_test.go` retirement.

---

## Task 1: Extract `sieve/lang` leaf (Phase 0 — kills the `ai → block` cycle)

**Files:**
- Create: `sieve/lang/heuristics.go` (moved from `sieve/block/language_heuristics.go`, package `block` → `lang`)
- Create: `sieve/lang/heuristics_test.go` (moved from `sieve/block/language_heuristics_test.go`, package `block` → `lang`)
- Delete: `sieve/block/language_heuristics.go`, `sieve/block/language_heuristics_test.go`
- Modify: `sieve/ai/ai_service.go` (3 refs at lines 276, 280, 290)
- Modify: `sieve/block/processors/code_processor.go` (refs at lines 52, 146, 149, 167, 177, 243)

**Interfaces:**
- Produces (package `lang`, names unchanged from their current `block` form — do **not** rename in this task):
  - `var CanonicalLanguages map[string]string`
  - `var KnownLanguages map[string]bool`
  - `func DetectByHeuristics(source, hint string) (string, bool)`
  - `func IsConfidentLanguage(lang string) bool`
  - `func LooksLikeCode(source string) bool`
- The file is self-contained (imports only `encoding/json`, `regexp`, `strings`; the only `block` tokens in it are inside comments). The test file is `package block` with **zero** `block.`-qualified references, so only its package clause changes.

- [ ] **Step 1: Verify the symbols' full consumer set before moving**

Run: `grep -rln "KnownLanguages\|CanonicalLanguages\|DetectByHeuristics\|IsConfidentLanguage\|LooksLikeCode" --include=*.go sieve/`
Expected: exactly `sieve/block/language_heuristics.go`, `sieve/block/language_heuristics_test.go`, `sieve/ai/ai_service.go`, `sieve/block/processors/code_processor.go`. If any other file appears, add it to this task's modify list and update its refs identically in Step 4.

- [ ] **Step 2: Move the implementation file**

Run: `git mv sieve/block/language_heuristics.go sieve/lang/heuristics.go`
Then change line 1 of `sieve/lang/heuristics.go` from `package block` to `package lang`. Nothing else in the file changes.

- [ ] **Step 3: Move the test file**

Run: `git mv sieve/block/language_heuristics_test.go sieve/lang/heuristics_test.go`
Then change its `package block` clause to `package lang`. It calls the symbols unqualified (same package), so no other edit is needed.

- [ ] **Step 4: Re-qualify the two consumers**

In `sieve/ai/ai_service.go`: add `"sieve/sieve/lang"` to the import block and change `block.CanonicalLanguages` → `lang.CanonicalLanguages`, `block.KnownLanguages` → `lang.KnownLanguages`, `block.DetectByHeuristics` → `lang.DetectByHeuristics`. Then check whether `block` is still referenced anywhere else in the file — `grep -n "block\." sieve/ai/ai_service.go`. If zero matches, remove `"sieve/sieve/block"` from its imports.

In `sieve/block/processors/code_processor.go`: add `"sieve/sieve/lang"` to the import block and change all of `block.DetectByHeuristics` → `lang.DetectByHeuristics`, `block.LooksLikeCode` → `lang.LooksLikeCode`, `block.IsConfidentLanguage` → `lang.IsConfidentLanguage`. (This file keeps importing `block` — it uses many other `block.` symbols.)

- [ ] **Step 5: Build + vet + test the three affected packages**

Run: `go build ./... && go vet ./sieve/lang/... ./sieve/ai/... ./sieve/block/...`
Expected: no errors.
Run: `go test ./sieve/lang/... ./sieve/ai/... ./sieve/block/...`
Expected: PASS (the moved test now runs as `package lang`).

- [ ] **Step 6: Assert the cycle is gone**

Run: `go list -deps sieve/sieve/ai | grep -x sieve/sieve/block && echo "STILL IMPORTS BLOCK — investigate" || echo "OK: ai no longer imports block"`
Expected: `OK: ai no longer imports block`. If it still imports `block`, find the remaining `block.` reference in `ai/` (`grep -rn "block\." sieve/ai/`), and either it is another misfiled leaf (out of scope — note it and stop) or a genuine dependency (note it; the spec's clean-decoupling claim needs revisiting).

- [ ] **Step 7: Commit**

```bash
git add sieve/lang/ sieve/ai/ai_service.go sieve/block/processors/code_processor.go
git commit -m "refactor(lang): extract language heuristics to sieve/lang leaf

Moves CanonicalLanguages/KnownLanguages/DetectByHeuristics/
IsConfidentLanguage/LooksLikeCode out of block into a stdlib-only
leaf shared by ai and the code processor. Removes the ai->block
import edge (verified via go list -deps); neither knows the other."
```

---

## Task 2: Generalise `JobTracker` (Active + Queued, `jobs:changed`, `/api/jobs`) — additive

**Files:**
- Modify: `sieve/services/job_tracker.go`
- Test: `sieve/services/job_tracker_test.go` (create if absent)

**Interfaces:**
- Consumes: nothing.
- Produces (new, used by Task 3 and Plan 2):
  - `JobInfo` gains `State string \`json:"state,omitempty"\`` and `Category string \`json:"category,omitempty"\`` (keeps existing `JobID`, `Label`, `DocID`, `SpinTab`).
  - `func (t *JobTracker) Enqueue(info JobInfo)` — records `State:"queued"`, broadcasts `jobs:changed`.
  - `func (t *JobTracker) Activate(jobID string)` — sets `State:"active"`, broadcasts `jobs:changed`.
  - `func (t *JobTracker) Finish(jobID string)` — removes the job, broadcasts `jobs:changed`.
  - `func (t *JobTracker) Queued() []JobInfo` — insertion-ordered, `State=="queued"`.
  - `func (t *JobTracker) ServeJobs(w http.ResponseWriter, r *http.Request)` — `GET /api/jobs` → `{"active":[...],"queued":[...]}`.
- Existing `Start`/`End`/`Active`/`ServeActiveJobs` (and the `ai:job-*` events) remain for legacy callers; this task only makes them maintain insertion order and an explicit `State` so the new accessors see legacy jobs too.

- [ ] **Step 1: Write the failing test for the new queued→active→finish lifecycle**

Create/extend `sieve/services/job_tracker_test.go`:

```go
package services

import (
	"encoding/json"
	"testing"
)

func TestJobTracker_QueuedActiveFinishLifecycle(t *testing.T) {
	var events []string
	tr := NewJobTracker()
	tr.Broadcast = func(event, data string) { events = append(events, event) }

	tr.Enqueue(JobInfo{JobID: "j1", Label: "Refining…", Category: "ai"})
	if got := tr.Queued(); len(got) != 1 || got[0].JobID != "j1" || got[0].State != "queued" {
		t.Fatalf("after Enqueue, Queued()=%+v", got)
	}
	if got := tr.Active(); len(got) != 0 {
		t.Fatalf("after Enqueue, Active() should be empty, got %+v", got)
	}

	tr.Activate("j1")
	if got := tr.Queued(); len(got) != 0 {
		t.Fatalf("after Activate, Queued() should be empty, got %+v", got)
	}
	if got := tr.Active(); len(got) != 1 || got[0].State != "active" {
		t.Fatalf("after Activate, Active()=%+v", got)
	}

	tr.Finish("j1")
	if len(tr.Active()) != 0 || len(tr.Queued()) != 0 {
		t.Fatalf("after Finish, both lists should be empty")
	}
	for _, e := range events {
		if e != "jobs:changed" {
			t.Fatalf("new lifecycle must only emit jobs:changed, saw %q", e)
		}
	}
}

func TestJobTracker_QueuedPreservesInsertionOrder(t *testing.T) {
	tr := NewJobTracker()
	for _, id := range []string{"a", "b", "c"} {
		tr.Enqueue(JobInfo{JobID: id})
	}
	got := tr.Queued()
	if len(got) != 3 || got[0].JobID != "a" || got[1].JobID != "b" || got[2].JobID != "c" {
		t.Fatalf("Queued() not in insertion order: %+v", got)
	}
}

func TestJobTracker_ServeJobsShape(t *testing.T) {
	tr := NewJobTracker()
	tr.Enqueue(JobInfo{JobID: "q1"})
	tr.Enqueue(JobInfo{JobID: "a1"})
	tr.Activate("a1")

	rec := newJSONRecorder()
	tr.ServeJobs(rec, nil)
	var body struct {
		Active []JobInfo `json:"active"`
		Queued []JobInfo `json:"queued"`
	}
	if err := json.Unmarshal(rec.Bytes(), &body); err != nil {
		t.Fatalf("ServeJobs body not JSON: %v", err)
	}
	if len(body.Active) != 1 || body.Active[0].JobID != "a1" {
		t.Fatalf("active=%+v", body.Active)
	}
	if len(body.Queued) != 1 || body.Queued[0].JobID != "q1" {
		t.Fatalf("queued=%+v", body.Queued)
	}
}
```

Add a tiny recorder helper at the bottom of the test file (avoids importing `httptest` if the package doesn't already):

```go
import "bytes"

type jsonRecorder struct{ buf bytes.Buffer; hdr map[string][]string }
func newJSONRecorder() *jsonRecorder { return &jsonRecorder{hdr: map[string][]string{}} }
func (r *jsonRecorder) Header() map[string][]string { return r.hdr }
func (r *jsonRecorder) Write(p []byte) (int, error) { return r.buf.Write(p) }
func (r *jsonRecorder) WriteHeader(int)             {}
func (r *jsonRecorder) Bytes() []byte               { return r.buf.Bytes() }
```

(If the package already imports `net/http/httptest`, use `httptest.NewRecorder()` instead and delete this helper. `ServeJobs`'s signature is `http.ResponseWriter, *http.Request`; `*jsonRecorder` must satisfy `http.ResponseWriter` — the three methods above do.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./sieve/services/ -run TestJobTracker -v`
Expected: FAIL — `Enqueue`/`Activate`/`Finish`/`Queued`/`ServeJobs` undefined, and `JobInfo` has no `State`/`Category`.

- [ ] **Step 3: Implement the additive generalisation**

In `sieve/services/job_tracker.go`: add the two fields to `JobInfo`:

```go
type JobInfo struct {
	JobID    string `json:"jobId"`
	Label    string `json:"label"`
	DocID    string `json:"docId,omitempty"`
	SpinTab  bool   `json:"spinTab"`
	State    string `json:"state,omitempty"`    // "queued" | "active"
	Category string `json:"category,omitempty"`
}
```

Add an insertion-order slice to the struct (next to `jobs map[string]JobInfo`): `order []string`. Then add the methods:

```go
func (t *JobTracker) Enqueue(info JobInfo) {
	info.State = "queued"
	t.mu.Lock()
	if _, exists := t.jobs[info.JobID]; !exists {
		t.order = append(t.order, info.JobID)
	}
	t.jobs[info.JobID] = info
	t.mu.Unlock()
	t.broadcastJobs()
}

func (t *JobTracker) Activate(jobID string) {
	t.mu.Lock()
	if info, ok := t.jobs[jobID]; ok {
		info.State = "active"
		t.jobs[jobID] = info
	}
	t.mu.Unlock()
	t.broadcastJobs()
}

func (t *JobTracker) Finish(jobID string) {
	t.mu.Lock()
	if _, ok := t.jobs[jobID]; ok {
		delete(t.jobs, jobID)
		for i, id := range t.order {
			if id == jobID {
				t.order = append(t.order[:i], t.order[i+1:]...)
				break
			}
		}
	}
	t.mu.Unlock()
	t.broadcastJobs()
}

func (t *JobTracker) Queued() []JobInfo { return t.listByState("queued") }

func (t *JobTracker) listByState(state string) []JobInfo {
	t.mu.RLock()
	defer t.mu.RUnlock()
	out := []JobInfo{}
	for _, id := range t.order {
		if j := t.jobs[id]; j.State == state {
			out = append(out, j)
		}
	}
	return out
}

func (t *JobTracker) broadcastJobs() {
	if t.Broadcast == nil {
		return
	}
	payload := map[string][]JobInfo{"active": t.listByState("active"), "queued": t.listByState("queued")}
	data, _ := json.Marshal(payload)
	t.Broadcast("jobs:changed", string(data))
}

func (t *JobTracker) ServeJobs(w http.ResponseWriter, r *http.Request) {
	payload := map[string][]JobInfo{"active": t.listByState("active"), "queued": t.listByState("queued")}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(payload)
}
```

Now make the **legacy** path consistent so old jobs appear in the new accessors and `Active()` excludes queued ones. Update `Start` to set `State` and maintain `order`:

```go
func (t *JobTracker) Start(info JobInfo) {
	info.State = "active"
	t.mu.Lock()
	if _, exists := t.jobs[info.JobID]; !exists {
		t.order = append(t.order, info.JobID)
	}
	t.jobs[info.JobID] = info
	t.mu.Unlock()
	if t.Broadcast != nil {
		data, _ := json.Marshal(info)
		t.Broadcast("ai:job-started", string(data)) // legacy event unchanged
	}
}
```

Update `End` to also drop the order entry (keep its `ai:job-ended` broadcast as-is). Update `Active()` to return only active-state jobs in order:

```go
func (t *JobTracker) Active() []JobInfo { return t.listByState("active") }
```

(Replace the old map-iteration body of `Active()` with this delegation.)

- [ ] **Step 4: Run the new tests + the full services suite**

Run: `go test ./sieve/services/ -run TestJobTracker -v`
Expected: PASS.
Run: `go test ./sieve/services/...`
Expected: PASS (legacy callers/tests unaffected — `Start`/`End` keep emitting `ai:job-*`).

- [ ] **Step 5: Build + confirm legacy route still served**

Run: `go build ./...`
Expected: no errors. (`ServeActiveJobs` and the `/api/ai/active-jobs` route are untouched; `ServeJobs` is new and not yet routed — Plan 2 routes `/api/jobs`.)

- [ ] **Step 6: Commit**

```bash
git add sieve/services/job_tracker.go sieve/services/job_tracker_test.go
git commit -m "feat(services): generalise JobTracker with queued/active lists

Adds State+Category to JobInfo and Enqueue/Activate/Finish/Queued/
ServeJobs broadcasting jobs:changed, with insertion-ordered lists.
Legacy Start/End/Active/ServeActiveJobs kept intact for current
callers; engine becomes the sole new-method writer in a later task."
```

---

## Task 3: `JobDescriptor` + communal `JobEngine` (per-`Category` bounded worker pools)

**Files:**
- Create: `sieve/services/job_engine.go`
- Test: `sieve/services/job_engine_test.go`

**Interfaces:**
- Consumes (from Task 2): `*JobTracker`, `JobInfo`, `Enqueue/Activate/Finish`.
- Produces (used by Plan 2):
  - `type JobDescriptor struct { Category string; Meta JobInfo; Work func() (any, error); OnFinished func(result any); OnError func(err error) }`
  - `func NewJobEngine(sizes map[string]int, defaultN int, tracker *JobTracker) *JobEngine`
  - `func (e *JobEngine) Submit(d JobDescriptor)`
- Behaviour: `Submit` registers the job QUEUED with the tracker, routes to the worker pool for `d.Category` (lazily created; size from `sizes[category]`, else `defaultN`), and on a free worker marks it ACTIVE, runs `Work` (panic-safe), marks it finished, then calls `OnFinished(result)` or `OnError(err)`. A `nil` `Work` is treated as an immediate `(nil, nil)` success. The engine never inspects the meaning of `Category`.

- [ ] **Step 1: Write the failing concurrency + routing test**

Create `sieve/services/job_engine_test.go`:

```go
package services

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// helper: a Work fn that tracks peak concurrency within its category.
func concurrencyProbe(active *int32, peak *int32, hold time.Duration) func() (any, error) {
	return func() (any, error) {
		cur := atomic.AddInt32(active, 1)
		for {
			p := atomic.LoadInt32(peak)
			if cur <= p || atomic.CompareAndSwapInt32(peak, p, cur) {
				break
			}
		}
		time.Sleep(hold)
		atomic.AddInt32(active, -1)
		return "ok", nil
	}
}

func TestJobEngine_CapsConcurrencyPerCategory(t *testing.T) {
	tr := NewJobTracker()
	eng := NewJobEngine(map[string]int{"ai": 3}, 4, tr)

	var active, peak int32
	var wg sync.WaitGroup
	const n = 12
	wg.Add(n)
	for i := 0; i < n; i++ {
		probe := concurrencyProbe(&active, &peak, 30*time.Millisecond)
		eng.Submit(JobDescriptor{
			Category:   "ai",
			Meta:       JobInfo{JobID: string(rune('a' + i))},
			Work:       probe,
			OnFinished: func(any) { wg.Done() },
			OnError:    func(error) { wg.Done() },
		})
	}
	wg.Wait()
	if peak > 3 {
		t.Fatalf("ai pool peak %d > limit 3", peak)
	}
	if peak < 2 {
		t.Fatalf("expected real parallelism (peak>=2), got %d", peak)
	}
}

func TestJobEngine_UnknownCategoryUsesDefault(t *testing.T) {
	eng := NewJobEngine(map[string]int{"ai": 1}, 2, NewJobTracker())
	var active, peak int32
	var wg sync.WaitGroup
	const n = 6
	wg.Add(n)
	for i := 0; i < n; i++ {
		probe := concurrencyProbe(&active, &peak, 30*time.Millisecond)
		eng.Submit(JobDescriptor{
			Category:   "exec", // not in sizes → default 2
			Meta:       JobInfo{JobID: string(rune('a' + i))},
			Work:       probe,
			OnFinished: func(any) { wg.Done() },
			OnError:    func(error) { wg.Done() },
		})
	}
	wg.Wait()
	if peak > 2 || peak < 2 {
		t.Fatalf("default pool should cap at exactly 2, got peak %d", peak)
	}
}

func TestJobEngine_RunsEachJobOnceAndDrivesTracker(t *testing.T) {
	var mu sync.Mutex
	events := map[string]int{}
	tr := NewJobTracker()
	tr.Broadcast = func(event, _ string) { mu.Lock(); events[event]++; mu.Unlock() }
	eng := NewJobEngine(map[string]int{"ai": 2}, 2, tr)

	var ran int32
	var wg sync.WaitGroup
	wg.Add(5)
	for i := 0; i < 5; i++ {
		eng.Submit(JobDescriptor{
			Category:   "ai",
			Meta:       JobInfo{JobID: string(rune('a' + i))},
			Work:       func() (any, error) { atomic.AddInt32(&ran, 1); return nil, nil },
			OnFinished: func(any) { wg.Done() },
		})
	}
	wg.Wait()
	if ran != 5 {
		t.Fatalf("expected 5 runs, got %d", ran)
	}
	// each job emits at least an enqueue + activate + finish jobs:changed
	mu.Lock()
	defer mu.Unlock()
	if events["jobs:changed"] < 5*3 {
		t.Fatalf("expected >=15 jobs:changed events, got %d", events["jobs:changed"])
	}
}

func TestJobEngine_PanicInWorkIsIsolated(t *testing.T) {
	eng := NewJobEngine(map[string]int{"ai": 1}, 1, NewJobTracker())
	done := make(chan struct{}, 2)

	eng.Submit(JobDescriptor{
		Category: "ai", Meta: JobInfo{JobID: "boom"},
		Work:    func() (any, error) { panic("kaboom") },
		OnError: func(error) { done <- struct{}{} },
	})
	eng.Submit(JobDescriptor{
		Category: "ai", Meta: JobInfo{JobID: "after"},
		Work:       func() (any, error) { return nil, nil },
		OnFinished: func(any) { done <- struct{}{} },
	})

	for i := 0; i < 2; i++ {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("a panicking job killed the pool — second job never ran")
		}
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./sieve/services/ -run TestJobEngine -v`
Expected: FAIL — `JobEngine`, `JobDescriptor`, `NewJobEngine` undefined.

- [ ] **Step 3: Implement the engine + internal worker pool**

Create `sieve/services/job_engine.go`:

```go
package services

import (
	"fmt"
	"sync"
)

// queueBacklog is the per-pool buffer depth — a runaway backstop, not a tuning
// knob. Pools are effectively unbounded for Sieve's workloads; what we configure
// is worker count, not depth.
const queueBacklog = 1024

// JobDescriptor is the unit of work the engine runs. Category is opaque data the
// engine routes on — it never switches on its meaning.
type JobDescriptor struct {
	Category   string
	Meta       JobInfo
	Work       func() (any, error)
	OnFinished func(result any)
	OnError    func(err error)
}

// JobEngine is the one communal producer/consumer engine: a bounded worker pool
// per Category, all pools identical, differing only by configured worker count.
type JobEngine struct {
	tracker  *JobTracker
	defaultN int
	sizes    map[string]int
	mu       sync.Mutex
	pools    map[string]*workerPool
}

func NewJobEngine(sizes map[string]int, defaultN int, tracker *JobTracker) *JobEngine {
	if defaultN < 1 {
		defaultN = 1
	}
	if sizes == nil {
		sizes = map[string]int{}
	}
	return &JobEngine{tracker: tracker, defaultN: defaultN, sizes: sizes, pools: map[string]*workerPool{}}
}

func (e *JobEngine) Submit(d JobDescriptor) {
	if e.tracker != nil {
		meta := d.Meta
		meta.Category = d.Category
		e.tracker.Enqueue(meta)
	}
	e.poolFor(d.Category).submit(d)
}

func (e *JobEngine) poolFor(category string) *workerPool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if p, ok := e.pools[category]; ok {
		return p
	}
	n := e.defaultN
	if sz, ok := e.sizes[category]; ok && sz > 0 {
		n = sz
	}
	p := newWorkerPool(n, e.run)
	e.pools[category] = p
	return p
}

func (e *JobEngine) run(d JobDescriptor) {
	if e.tracker != nil {
		e.tracker.Activate(d.Meta.JobID)
	}
	result, err := safeWork(d.Work)
	if e.tracker != nil {
		e.tracker.Finish(d.Meta.JobID)
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

func safeWork(work func() (any, error)) (result any, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("job panicked: %v", r)
		}
	}()
	if work == nil {
		return nil, nil
	}
	return work()
}

// workerPool is N goroutines draining one buffered channel. All categories use
// the same implementation; only n differs.
type workerPool struct {
	jobs chan JobDescriptor
}

func newWorkerPool(n int, run func(JobDescriptor)) *workerPool {
	if n < 1 {
		n = 1
	}
	p := &workerPool{jobs: make(chan JobDescriptor, queueBacklog)}
	for i := 0; i < n; i++ {
		go func() {
			for d := range p.jobs {
				run(d)
			}
		}()
	}
	return p
}

func (p *workerPool) submit(d JobDescriptor) { p.jobs <- d }
```

- [ ] **Step 4: Run the engine tests under the race detector**

Run: `go test ./sieve/services/ -run TestJobEngine -race -v`
Expected: PASS, no race warnings.

- [ ] **Step 5: Full services suite + build + vet**

Run: `go test ./sieve/services/... -race`
Expected: PASS.
Run: `go build ./... && go vet ./sieve/services/...`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add sieve/services/job_engine.go sieve/services/job_engine_test.go
git commit -m "feat(services): communal JobEngine with per-Category worker pools

One engine, one bounded worker pool per Category (worker count from
config, default fallback, unknown category -> default). Submit drives
the JobTracker (enqueue/activate/finish) and runs Work panic-safe on a
free worker. Category is opaque data the engine routes on; no switch,
no enum. Not yet wired to producers (Plan 2)."
```

---

## Self-Review

**Spec coverage (this plan = Phase 0 + Phase A only):**
- `sieve/lang` extraction killing `ai → block` → Task 1 (with an explicit `go list -deps` assertion).
- Generalised `JobTracker` (Active+Queued, `jobs:changed`, `/api/jobs` via `ServeJobs`) → Task 2.
- Communal `JobEngine`, per-`Category` bounded worker pools, opaque-`Category` routing, panic isolation, tracker drive → Task 3.
- Everything else in the spec (port deletion, declarative processors, `JobRunner`, `EditorService` document entries, tracker-writer retirement, close-all fold, settings `worker_pools`, frontend, name-rename consumption) is **explicitly Plan 2** — listed in *Out of Scope*. Each of these depends on the foundation built here and on signatures that emerge from it.

**Placeholder scan:** none — every code step shows complete code; every run step shows the exact command and expected result.

**Type consistency:** `JobInfo` fields (`State`, `Category`) introduced in Task 2 are consumed unchanged in Task 3 (`meta.Category = d.Category`; `Enqueue/Activate/Finish` by `JobID`). `JobDescriptor`/`NewJobEngine`/`Submit` signatures in Task 3's Interfaces match the test usage and implementation. `lang` symbol names in Task 1 are kept identical to their `block` originals (no rename), so the consumer edits are pure requalification.

**Note on naming:** `lang.IsConfidentLanguage` stutters slightly in the new package; a de-stutter to `lang.IsConfident` is deliberately deferred (it would add rename churn across `code_processor.go` for no functional gain). Plan 2 can fold that rename in when it rewrites the code processor's job to `DescribeJob`.
