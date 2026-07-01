# Job Engine Cutover (Phase B + C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the communal-job-engine cutover — invert processors to *declare* jobs (`DescribeJob`/`ProcessorJob`), route **every** async job through the `JobEngine`, make `EditorService` the owner of document-lifecycle AI jobs, reduce `AIService` to a blind synchronous brain, delete `block.AIPort`, retire the legacy `JobTracker` writers and `ai:job-*` events, and switch the frontend to the two-list `jobs:changed`/`/api/jobs` model.

**Architecture:** Builds on the landed foundation (`sieve/lang`, `sieve/editor`, generalised `JobTracker`, `services.JobEngine`). Producers stop executing AI: a processor returns a `block.ProcessorJob{Category,Label,Work,Apply}`; `EditorService` turns that into a `services.JobDescriptor` and submits it to the one communal engine via a **private** `submitBlockJob` method (the Apply→finish wrap lives on `EditorService`, which owns the block copy and the attr-diff/shadow merge — there is no separate `JobRunner` type). Document jobs (file/close/metadata) call `es.engine.Submit` directly. The engine drives the tracker (`Enqueue/Activate/Finish`) and is its **sole** writer. `AIService` keeps all evaluation/filing/metadata logic as synchronous methods and knows nothing about categories, the engine, or blocks. The `ai:job-*` → `jobs:changed` and `/api/ai/active-jobs` → `/api/jobs` renames are made safe by a dual-listen frontend bridge that lands before the backend writer switch.

**Tech Stack:** Go (backend), vanilla JS + HTMX + SSE (frontend). Tests: `go test ./...`; concurrency tests `-race` (`go test ./sieve/services/... ./sieve/editor/... -race`). Frontend: vitest (`cd frontend && npx vitest run`) + in-app WebKitGTK smoke. Compile check: `go build ./...`. Module root is `sieve` (packages import as `sieve/sieve/<pkg>`).

## Global Constraints

- **No loose/free functions** — behaviour belongs as a method on the type that owns its data; `New…` constructors are the only exempt package-level funcs. (This is why the Apply→finish wrap is a method on `EditorService`, not a standalone `JobRunner`.)
- **`Category` is opaque data** — no `switch category`, no central enum. The category constant is **producer-owned and lives with the submitters**: `block.CategoryAI = "ai"`, beside `block.ProcessorJob` (used by `block/processors` and `editor`). It must **not** live in `ai` — the `ai` package knows nothing about categories or the engine. Future categories (`exec`, `http`, `dag`) live beside their own producers.
- **`ai` is the blind brain** — imports `lang`, `services` (data types only), `domain`, `store`; never `block`, never the engine, never a category. Every AIService method is synchronous.
- **Worker-pool config values are worker COUNTS**, never queue depth. `worker_pools["ai"]` default **3**, min **1**; unconfigured category → `default` (default **4** if absent).
- **The engine is the sole `JobTracker` writer** by the end — every AI call site produces a descriptor; nothing runs a CLI outside the engine.
- **`user_intent` is user-owned** — AI must never write `Tab.UserIntent` (unchanged; do not regress).
- **Backend is the document source of truth** — block updates render as tracked PM transactions via the existing `applyJobUpdate` → `update-block` path; do NOT introduce `softReloadContent` for job completion (CLAUDE.md Non-Obvious Rules).
- **Commit messages:** no `Co-Authored-By` trailer.
- **Tests live with the type they exercise** — white-box tests in the type's own package.
- **Every commit builds green**; the frontend never has a broken intermediate (the dual-listen bridge, Task B5, lands before the writer switch, Task C1).

## Shared Types (defined once; every task uses these exact names/signatures)

```go
// package block — new file sieve/block/processor_job.go
type ProcessorJob struct {
    Category string                            // e.g. block.CategoryAI; "" ⇒ no async job
    Label    string                            // status-bar label; "" ⇒ no tracker entry
    Work     func() (any, error)               // nil ⇒ Apply runs synchronously, immediate success
    Apply    func(result any, blk *SieveBlock) // mutates blk.Attrs from the Work result
}
const CategoryAI = "ai" // producer-owned category label; ai package stays ignorant of it

// package block — BlockProcessor interface (processor_registry.go), replacing RunJob+JobLabel:
//   DescribeJob(jctx JobContext) ProcessorJob

// package editor — EditorService gains a PRIVATE helper (NOT a separate type):
//   func (es *EditorService) submitBlockJob(job block.ProcessorJob, meta services.JobInfo,
//       blk *block.SieveBlock, onDone func(err error))
// Builds a services.JobDescriptor and submits to es.engine, guaranteeing
// Apply(result, blk) runs on success BEFORE onDone(nil), and onDone(err) with
// Apply skipped on failure. Lives on EditorService because it manipulates
// EditorService-owned data (the block copy + the attr-diff/shadow merge). The
// engine is the one general submission seam; document jobs (Task B6) call
// es.engine.Submit directly too.

// package domain — Settings gains:
//   WorkerPools map[string]int `json:"worker_pools,omitempty"`
```

---

## PHASE B — Backend cutover (declarative jobs, one engine, EditorService owns documents)

## Task B1: `worker_pools` setting

**Files:**
- Modify: `sieve/domain/settings.go` (struct ~`:28`, `ParseSettings` ~`:80`, `DefaultSettings` ~`:132`)
- Test: `sieve/domain/settings_test.go` (extend or create)

**Interfaces:**
- Produces: `domain.Settings.WorkerPools map[string]int`.

- [ ] **Step 1: Write the failing settings test**

Add to `sieve/domain/settings_test.go` (match the file's existing parse-test pattern — inspect it; if it drives `ParseSettings` via a temp file, do that rather than adding a new seam):

```go
func TestParseSettings_WorkerPoolsOverlay(t *testing.T) {
	base := DefaultSettings()
	if base.WorkerPools == nil {
		t.Fatalf("DefaultSettings().WorkerPools should be non-nil (empty map)")
	}
	loaded := /* parse `{"worker_pools":{"ai":5,"exec":8}}` via the existing entrypoint */ nil
	_ = loaded
	// assert loaded.WorkerPools["ai"] == 5 && loaded.WorkerPools["exec"] == 8
}
```

Fill the parse call to match the current test helper (e.g. `ParseSettings(path)` after writing the JSON to a temp file).

- [ ] **Step 2: Run it — verify failure**

Run: `go test ./sieve/domain/ -run TestParseSettings_WorkerPools -v`
Expected: FAIL — `WorkerPools` undefined.

- [ ] **Step 3: Add the field + overlay + default**

In `sieve/domain/settings.go` struct (mirror the `CustomLogParsers map` field tag at `:37`):

```go
	WorkerPools map[string]int `json:"worker_pools,omitempty"`
```

In `ParseSettings` overlay block (mirror the map guard used for `CustomLogParsers`):

```go
	if len(loaded.WorkerPools) > 0 {
		s.WorkerPools = loaded.WorkerPools
	}
```

In `DefaultSettings()`:

```go
	WorkerPools: map[string]int{}, // empty ⇒ every category uses the engine's defaultN
```

- [ ] **Step 4: Run tests + build**

Run: `go test ./sieve/domain/ -run TestParseSettings_WorkerPools -v`
Expected: PASS.
Run: `go build ./...`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add sieve/domain/settings.go sieve/domain/settings_test.go
git commit -m "feat(settings): add worker_pools map setting (per-category worker counts)"
```

---

## Task B2: `block.ProcessorJob` (+ `block.CategoryAI`) + `EditorService.submitBlockJob`

**Files:**
- Create: `sieve/block/processor_job.go`
- Modify: `sieve/editor/editor_service.go` (add `engine *services.JobEngine` field near `jobs` `:23`; add `SetEngine`; add private `submitBlockJob`)
- Test: `sieve/editor/submit_block_job_test.go`

**Interfaces:**
- Consumes: `services.JobEngine`, `services.JobInfo`, `services.JobDescriptor` (foundation); `block.SieveBlock`.
- Produces: `block.ProcessorJob` + `block.CategoryAI`; `EditorService.SetEngine(*services.JobEngine)`; private `EditorService.submitBlockJob(job block.ProcessorJob, meta services.JobInfo, blk *block.SieveBlock, onDone func(err error))`.
- Note: **no `JobRunner` type.** `block.CategoryAI` lives in `block` (both `block/processors` and `editor` import `block`); `ai` never sees it.

- [ ] **Step 1: Define the block-level descriptor + category constant**

Create `sieve/block/processor_job.go`:

```go
package block

// ProcessorJob is the block-level descriptor a processor returns from
// DescribeJob. The framework owns the lifecycle; a processor writes no
// tracking/finish code. Work == nil means no async work — Apply (if any) runs
// synchronously and the job finishes.
type ProcessorJob struct {
	Category string                            // producer-owned category, e.g. CategoryAI
	Label    string                            // status-bar label ("" ⇒ no tracker entry)
	Work     func() (any, error)               // the blocking backend call (e.g. an AI CLI)
	Apply    func(result any, blk *SieveBlock) // mutate blk.Attrs from Work's result
}

// CategoryAI is the engine category for AI (claude CLI) work. It is
// producer-owned opaque data — defined here, beside ProcessorJob, because the
// submitters (block/processors and editor) both import block. The ai package is
// deliberately ignorant of categories and the engine. Future categories
// (exec/http/dag) live beside their own producers.
const CategoryAI = "ai"
```

- [ ] **Step 2: Add the engine field + `SetEngine` to EditorService**

In `sieve/editor/editor_service.go`, near the `jobs *services.JobTracker` field (`:23`):

```go
	engine *services.JobEngine
```

Near `SetJobs` (`:416`):

```go
// SetEngine injects the communal job engine. Post-construction (like SetJobs) so
// the root can build it after the hub-wired JobTracker exists, and so the ~25
// test constructors need no change.
func (es *EditorService) SetEngine(e *services.JobEngine) { es.engine = e }
```

- [ ] **Step 3: Write the failing `submitBlockJob` test**

Create `sieve/editor/submit_block_job_test.go` (white-box, `package editor`). Use the editor package's existing test constructor (inspect `testhelpers_test.go` — e.g. `newTestEditorService(t)`); `submitBlockJob` touches only `es.engine`, so no shadow doc is needed:

```go
package editor

import (
	"errors"
	"sync"
	"testing"
	"time"

	"sieve/sieve/block"
	"sieve/sieve/services"
)

func newEngineEditor(t *testing.T) *EditorService {
	es := newTestEditorService(t) // the existing editor-package helper; adapt name if different
	es.SetEngine(services.NewJobEngine(map[string]int{"ai": 2}, 2, services.NewJobTracker()))
	return es
}

func TestSubmitBlockJob_AppliesThenFinishesOnSuccess(t *testing.T) {
	es := newEngineEditor(t)
	blk := &block.SieveBlock{ID: "b1", Kind: "code", Attrs: map[string]interface{}{}}
	var order []string
	var mu sync.Mutex
	done := make(chan struct{})
	job := block.ProcessorJob{
		Category: block.CategoryAI, Label: "Refining…",
		Work: func() (any, error) { mu.Lock(); order = append(order, "work"); mu.Unlock(); return "go", nil },
		Apply: func(result any, b *block.SieveBlock) {
			mu.Lock(); order = append(order, "apply"); mu.Unlock()
			b.Attrs["language"] = result.(string)
		},
	}
	es.submitBlockJob(job, services.JobInfo{JobID: "b1"}, blk, func(err error) {
		mu.Lock(); order = append(order, "finish"); mu.Unlock()
		if err != nil { t.Errorf("unexpected err: %v", err) }
		close(done)
	})
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("onDone never called")
	}
	if blk.Attrs["language"] != "go" { t.Fatalf("Apply did not mutate blk: %+v", blk.Attrs) }
	if len(order) != 3 || order[0] != "work" || order[1] != "apply" || order[2] != "finish" {
		t.Fatalf("order wrong: %v (want work,apply,finish)", order)
	}
}

func TestSubmitBlockJob_ErrorSkipsApply(t *testing.T) {
	es := newEngineEditor(t)
	blk := &block.SieveBlock{ID: "b1", Attrs: map[string]interface{}{}}
	applied := false
	done := make(chan error, 1)
	job := block.ProcessorJob{
		Category: block.CategoryAI,
		Work:  func() (any, error) { return nil, errors.New("boom") },
		Apply: func(any, *block.SieveBlock) { applied = true },
	}
	es.submitBlockJob(job, services.JobInfo{JobID: "b1"}, blk, func(err error) { done <- err })
	select {
	case err := <-done:
		if err == nil { t.Fatal("expected error to reach onDone") }
	case <-time.After(2 * time.Second):
		t.Fatal("onDone never called")
	}
	if applied { t.Fatal("Apply must NOT run on error") }
}

func TestSubmitBlockJob_NilWorkStillApplies(t *testing.T) {
	es := newEngineEditor(t)
	blk := &block.SieveBlock{ID: "b1", Attrs: map[string]interface{}{}}
	done := make(chan struct{})
	job := block.ProcessorJob{Category: block.CategoryAI, Apply: func(_ any, b *block.SieveBlock) { b.Attrs["applied"] = true }}
	es.submitBlockJob(job, services.JobInfo{JobID: "b1"}, blk, func(err error) {
		if err != nil { t.Errorf("nil Work should be success, got %v", err) }
		close(done)
	})
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("onDone never called")
	}
	if blk.Attrs["applied"] != true { t.Fatalf("Apply should run for nil Work") }
}
```

- [ ] **Step 4: Run it — verify failure**

Run: `go test ./sieve/editor/ -run TestSubmitBlockJob -v`
Expected: FAIL — `submitBlockJob`/`SetEngine`/`block.ProcessorJob`/`block.CategoryAI` undefined.

- [ ] **Step 5: Implement `submitBlockJob`**

In `sieve/editor/editor_service.go`:

```go
// submitBlockJob turns a block ProcessorJob into a JobDescriptor and submits it
// to the communal engine, guaranteeing Apply-before-finish and finish-once. The
// wrap lives here because Apply and onDone (the attr-diff/shadow merge) operate
// on EditorService-owned data. onDone is the caller's finish closure.
func (es *EditorService) submitBlockJob(job block.ProcessorJob, meta services.JobInfo, blk *block.SieveBlock, onDone func(err error)) {
	es.engine.Submit(services.JobDescriptor{
		Category: job.Category,
		Meta:     meta,
		Work:     job.Work,
		OnFinished: func(result any) {
			if job.Apply != nil {
				job.Apply(result, blk)
			}
			onDone(nil)
		},
		OnError: func(err error) { onDone(err) },
	})
}
```

- [ ] **Step 6: Run tests under race + build**

Run: `go test ./sieve/editor/ -run TestSubmitBlockJob -race -v`
Expected: PASS, no race warnings.
Run: `go build ./...`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add sieve/block/processor_job.go sieve/editor/editor_service.go sieve/editor/submit_block_job_test.go
git commit -m "feat(block,editor): ProcessorJob + CategoryAI; EditorService.submitBlockJob wrap

block.ProcessorJob is the producer's job descriptor; block.CategoryAI is
the producer-owned category label (ai package stays ignorant). The
Apply->finish wrap is a private EditorService method (no JobRunner type):
Apply-before-finish, finish-exactly-once (success/error/nil-Work),
submitted to the one communal engine."
```

---

## Task B3: Construct + wire the engine at the root

**Files:**
- Modify: `sieve/service_provider.go` (struct `:14`)
- Modify: `handlers.go` (tracker construction `:122-126`)

**Interfaces:**
- Consumes: `domain.Settings.WorkerPools` (B1), `services.NewJobEngine`, the hub-wired `*services.JobTracker`, `editor.EditorService.SetEngine` (B2).
- Produces: `ServiceProvider.Engine *services.JobEngine`.
- Note: engine is wired but not yet used by any block path (that's B4) — additive.

- [ ] **Step 1: Add the Engine field to ServiceProvider**

In `sieve/service_provider.go` struct (near `Jobs *services.JobTracker` `:23`):

```go
	Engine *services.JobEngine
```

- [ ] **Step 2: Construct the engine beside the hub-wired tracker**

Replace the `handlers.go:122-126` block:

```go
	jobTracker := services.NewJobTracker()
	jobTracker.Broadcast = hub.broadcast
	sp.Jobs = jobTracker
	if sp.Editor != nil {
		sp.Editor.SetJobs(jobTracker)
	}
```

with:

```go
	jobTracker := services.NewJobTracker()
	jobTracker.Broadcast = hub.broadcast
	sp.Jobs = jobTracker

	const defaultWorkers = 4
	sp.Engine = services.NewJobEngine(sp.State.LoadSettings().WorkerPools, defaultWorkers, jobTracker)
	if sp.Editor != nil {
		sp.Editor.SetJobs(jobTracker)
		sp.Editor.SetEngine(sp.Engine)
	}
```

Confirm `sp.State.LoadSettings()` is the correct accessor in this scope (it is used at `service_provider.go:71`); if settings are already cached on `sp`, use that field instead of re-loading.

- [ ] **Step 3: Build + full suite**

Run: `go build ./... && go vet ./sieve/...`
Expected: no errors.
Run: `go test ./...`
Expected: PASS (engine constructed but unused — no behaviour change yet).

- [ ] **Step 4: Commit**

```bash
git add sieve/service_provider.go handlers.go
git commit -m "feat(root): construct communal JobEngine (worker_pools + default 4) and inject into EditorService

Built beside the hub-wired JobTracker (its sole writer); injected via
SetEngine (mirrors SetJobs; no test-constructor churn). Not yet used by
any block path."
```

---

## Task B4: Invert processors to `DescribeJob`; route block jobs through the engine

> Behaviour-changing core. Implement B4a→B4b→B4c and land as ONE green commit (the interface flip cannot build until all processors and the dispatch site are converted). Each sub-section below is a checkpoint, not a separate commit.

**Files:**
- Modify: `sieve/block/processor_registry.go` (interface `:265`, `JobLabel` `:267`, `BlockServices` `:400-406`)
- Modify: `sieve/block/ports.go` (delete `AIPort` `:39-45`)
- Modify: all `sieve/block/processors/*.go` implementing `RunJob`/`JobLabel`
- Modify: `sieve/editor/editor_service.go` (`RunJob :722`)
- Modify: `sieve/service_provider.go` (processor construction `:77-86`)

**Interfaces:**
- Consumes: `block.ProcessorJob`, `block.CategoryAI` (B2), `ai.AIService` (AI processors import `ai` directly), `EditorService.submitBlockJob` (B2).
- Produces: `BlockProcessor.DescribeJob(jctx JobContext) block.ProcessorJob`; `BlockServices` with **no** `AI` field; AI processors holding `*ai.AIService`.

### B4a — interface flip + non-AI processors

- [ ] **Step 1: Change the interface**

In `sieve/block/processor_registry.go`, replace the interface methods `RunJob(jctx JobContext) error` (`:265`) and `JobLabel(block *SieveBlock) string` (`:267`) with:

```go
	// DescribeJob returns the async work (if any) this block needs. A zero
	// ProcessorJob (Category=="" && Work==nil && Apply==nil) means no job.
	DescribeJob(jctx JobContext) ProcessorJob
```

- [ ] **Step 2: Convert each NON-AI processor**

For every processor whose `RunJob` does no AI work (inspect `sieve/block/processors/`; typically prose, diagram, log, smart-link, smart-card), replace its `RunJob`+`JobLabel` with a `DescribeJob`. If the old `RunJob` was a no-op, return a zero `ProcessorJob`:

```go
// DescribeJob: prose blocks have no async work.
func (p *ProseProcessor) DescribeJob(jctx block.JobContext) block.ProcessorJob {
	return block.ProcessorJob{}
}
```

If a non-AI `RunJob` did real synchronous work, move that body into `Apply` with `Work: nil` (the framework still runs it):

```go
func (p *DiagramProcessor) DescribeJob(jctx block.JobContext) block.ProcessorJob {
	return block.ProcessorJob{
		Apply: func(_ any, blk *block.SieveBlock) { /* the old synchronous RunJob body, mutating blk.Attrs */ },
	}
}
```

Inspect each non-AI `RunJob` body first; if it referenced AI, re-classify it for B4b.

### B4b — the four AI processors

- [ ] **Step 3: Give AI processors a direct `*ai.AIService`; delete `AIPort`**

Delete the `AI AIPort` field from `block.BlockServices` (`processor_registry.go:400-406`) and the `AIPort` interface from `sieve/block/ports.go` (`:39-45`). Each of the four AI processors adds an `ai *ai.AIService` field + constructor param, importing `"sieve/sieve/ai"`. Example (code processor):

```go
import (
	// …existing…
	"sieve/sieve/ai"
	"sieve/sieve/lang"
)

type CodeBlockProcessor struct {
	svc block.BlockServices
	ai  *ai.AIService
	// …existing fields…
}

func NewCodeBlockProcessor(svc block.BlockServices, aiSvc *ai.AIService) *CodeBlockProcessor {
	return &CodeBlockProcessor{svc: svc, ai: aiSvc /*, …*/}
}
```

Same for `SmartImageProcessor`, `WebClipBlockProcessor`, `AIBlockProcessor`. (`block/processors → ai` is a new, acyclic edge — `ai` never imports `block`/`block/processors`.)

- [ ] **Step 4: Rewrite each AI `RunJob` as `DescribeJob`**

**Code processor** — replace `RunJob` (`code_processor.go:220-253`) + `JobLabel` (`:211`). Port the confidence-gate conditionals VERBATIM from the current `:236-252` body:

```go
func (p *CodeBlockProcessor) DescribeJob(jctx block.JobContext) block.ProcessorJob {
	blk := jctx.Block
	source, _ := blk.Attrs["source"].(string)
	currentLang, _ := blk.Attrs["language"].(string)
	method, _ := blk.Attrs["detectionMethod"].(string)
	return block.ProcessorJob{
		Category: block.CategoryAI,
		Label:    "Refining language...",
		Work:     func() (any, error) { return p.ai.RefineLanguage(source, currentLang, method) },
		Apply: func(result any, b *block.SieveBlock) {
			detected, _ := result.(string)
			if detected != "" && (lang.IsConfidentLanguage(detected) || !lang.IsConfidentLanguage(currentLang)) {
				b.Attrs["language"] = detected
				b.Attrs["detectionMethod"] = "ai"
			}
			b.Attrs["status"] = block.BlockStatusComplete
			delete(b.Attrs, "hint")
		},
	}
}
```

The error path (`status = BlockStatusError`) is handled by the framework `onDone(err)` in B4c, so `Apply` covers only the success mutation.

**Smart-image processor** — replace `RunJob` (`smart_image_processor.go:186-210`) + `JobLabel` (`:183`). Match the real `domain.ImageDesc` fields and the exact keys the old body set (`:196-210`):

```go
func (p *SmartImageProcessor) DescribeJob(jctx block.JobContext) block.ProcessorJob {
	blk := jctx.Block
	src, _ := blk.Attrs["src"].(string)
	uuid, id := jctx.UUID, blk.ID
	return block.ProcessorJob{
		Category: block.CategoryAI,
		Label:    "Describing image…",
		Work:     func() (any, error) { return p.ai.DescribeImage(uuid, src, id) },
		Apply: func(result any, b *block.SieveBlock) {
			desc := result.(domain.ImageDesc)
			b.Attrs["summary"] = desc.Summary
			b.Attrs["alt"] = desc.Alt
			b.Attrs["detect"] = desc.Detect
			b.Attrs["status"] = block.BlockStatusComplete
		},
	}
}
```

**Web-clip processor** — replace `RunJob` (`web_clip_processor.go:126-164`). It reads `p.svc.Documents.LoadByUUID` to build `docContent` BEFORE the AI call — do that read synchronously in `DescribeJob` and capture it in `Work`:

```go
func (p *WebClipBlockProcessor) DescribeJob(jctx block.JobContext) block.ProcessorJob {
	blk := jctx.Block
	uuid := jctx.UUID
	source, _ := blk.Attrs["source"].(string)
	mode, _ := blk.Attrs["mode"].(string)
	docContent := "" // build via the current LoadByUUID logic from RunJob, synchronously here
	return block.ProcessorJob{
		Category: block.CategoryAI,
		Label:    "Clipping…", // use the current JobLabel string
		Work: func() (any, error) {
			title, content, err := p.ai.RunWebClip(uuid, blk.ID, source, mode, docContent)
			return []string{title, content}, err
		},
		Apply: func(result any, b *block.SieveBlock) {
			tc := result.([]string)
			b.Attrs["title"] = tc[0]
			b.Attrs["content"] = tc[1]
			b.Attrs["status"] = block.BlockStatusComplete
			// port completedAt/model keys exactly from the old RunJob (:145-164)
		},
	}
}
```

**AI-block processor** — replace `RunJob` (`ai_block_processor.go:178+`). Branch on `blk.Attrs["type"] == "EXPLAIN"`:

```go
func (p *AIBlockProcessor) DescribeJob(jctx block.JobContext) block.ProcessorJob {
	blk := jctx.Block
	// gather content/history/question/uuid exactly as the old RunJob did
	isExplain := blk.Attrs["type"] == "EXPLAIN"
	return block.ProcessorJob{
		Category: block.CategoryAI,
		Label:    "Thinking…", // current JobLabel
		Work: func() (any, error) {
			if isExplain {
				return p.ai.RunExplain(content, history, question, uuid)
			}
			return p.ai.RunAsk(content, history, question, uuid)
		},
		Apply: func(result any, b *block.SieveBlock) {
			b.Attrs["response"] = result.(string)
			b.Attrs["status"] = block.BlockStatusComplete
			// port completedAt key from the old body
		},
	}
}
```

Port the exact `content/history/question` extraction and attr keys from each current body — the cited line ranges are the source of truth.

### B4c — dispatch switch in EditorService

- [ ] **Step 5: Rewrite `EditorService.RunJob` to describe→submit**

Replace the body of `EditorService.RunJob` (`editor_service.go:722`): keep the snapshot (`SnapshotForJob`, deep-copy, `attrsBefore` `:732-740`) and the `notify` closure (`:761`), then call `DescribeJob` and hand the finish closure to `submitBlockJob`. **Delete** the `es.jobs.Start(...)` / `defer es.jobs.End(...)` lines (`:749-757`) — the engine drives the tracker via `meta` now. Keep `applyJobUpdate` (`:675`) unchanged.

```go
func (es *EditorService) RunJob(ctx context.Context, uuid, blockID string) {
	snap, doc, ok := es.shadowFor(uuid).SnapshotForJob(blockID) // match current snapshot call :732
	if !ok {
		return
	}
	blkCopy := snap.Clone()                 // match current deep-copy :735-740
	attrsBefore := cloneAttrs(snap.Attrs)   // match current attrsBefore capture
	kind := blkCopy.Kind

	job := block.GetProcessor(kind).DescribeJob(block.JobContext{
		Ctx: ctx, UUID: uuid, Doc: doc, Block: blkCopy, Notify: /* existing notify closure :761 */ nil,
	})
	if job.Category == "" && job.Work == nil && job.Apply == nil {
		return // no job for this block
	}

	meta := services.JobInfo{JobID: blockID, Label: job.Label, DocID: uuid, SpinTab: false}
	finish := func(err error) {
		if err != nil {
			es.applyJobUpdate(uuid, blockID, kind, map[string]interface{}{"status": block.BlockStatusError}, nil, "job-complete")
			return
		}
		updates := map[string]interface{}{}
		var deletes []string
		for k, v := range blkCopy.Attrs {
			if old, had := attrsBefore[k]; !had || !reflect.DeepEqual(old, v) {
				updates[k] = v
			}
		}
		for k := range attrsBefore {
			if _, still := blkCopy.Attrs[k]; !still {
				deletes = append(deletes, k)
			}
		}
		es.applyJobUpdate(uuid, blockID, kind, updates, deletes, "job-complete")
	}

	if es.engine != nil {
		es.submitBlockJob(job, meta, blkCopy, finish)
		return
	}
	// Fallback (engine not wired, e.g. some unit tests): run inline.
	if job.Work != nil {
		r, e := job.Work()
		if e != nil { finish(e); return }
		if job.Apply != nil { job.Apply(r, blkCopy) }
	} else if job.Apply != nil {
		job.Apply(nil, blkCopy)
	}
	finish(nil)
}
```

Match `es.shadowFor`/`snap.Clone`/`cloneAttrs`/`notify` to the CURRENT helper names in the file — inspect and reuse verbatim; do not invent names. The `es.jobs` field/`SetJobs` stay for now (legacy `ServeActiveJobs` still reads the tracker); removed in Phase C.

- [ ] **Step 6: Update processor construction at the root**

In `sieve/service_provider.go:77-86`, drop `AI` from the `BlockServices` literal (`:31`) and pass `s.AI` as the new `*ai.AIService` arg to the four AI processors (e.g. `processors.NewCodeBlockProcessor(svc, s.AI)`). Non-AI processors keep their single-`svc` constructor.

- [ ] **Step 7: Build + fix compile errors iteratively; assert `ai` stays clean**

Run: `go build ./... 2>&1 | head -50`
Fix remaining `RunJob`/`JobLabel`/`AIPort`/`BlockServices.AI` references until clean.
Run: `go list -f '{{.Imports}}' sieve/sieve/ai | grep -x sieve/sieve/block || echo "OK: ai does not import block"`
Expected: `OK: ai does not import block`.

- [ ] **Step 8: Port + run processor tests**

Port each processor test from `RunJob` to `DescribeJob`: assert the returned `ProcessorJob.Category`/`Label`, and that calling `job.Apply(fakeResult, blk)` produces the expected `blk.Attrs` (confidence-gate cases move onto `Apply`, using `lang` for heuristics). Assert the backend is called ONLY inside `Work`. Update `NewCodeBlockProcessor(...)` etc. to the new 2-arg signature.

Run: `go test ./sieve/block/... ./sieve/editor/... -v`
Expected: PASS.

- [ ] **Step 9: Full suite under race + build**

Run: `go test ./... && go test ./sieve/services/... ./sieve/editor/... -race`
Expected: PASS.

- [ ] **Step 10: Commit (single green commit for B4a+B4b+B4c)**

```bash
git add sieve/block/ sieve/editor/editor_service.go sieve/service_provider.go
git commit -m "feat(block,editor): invert processors to DescribeJob; route block jobs through the engine

BlockProcessor.RunJob/JobLabel -> DescribeJob returning a ProcessorJob.
AI processors import ai directly and hold *ai.AIService; block.AIPort and
BlockServices.AI deleted. EditorService.RunJob describes the job and
submits via submitBlockJob (engine drives the tracker); the attr-diff +
shadow merge is unchanged. ai still never imports block."
```

---

## Task B5: Frontend dual-listen bridge + `/api/jobs` route (safe cutover)

> Lands BEFORE the backend stops emitting `ai:job-*` (Phase C), so the status bar never goes dark. After this task the frontend understands BOTH the legacy events and `jobs:changed`.

**Files:**
- Modify: `requesthandlers/ai_handler.go` (`RegisterPaths` `:33`, beside `active-jobs` `:39`)
- Modify: `frontend/src/static/ai/ai-actions.js` (`loadActiveJobs :97`, add a `jobs:changed` listener)
- Modify: `frontend/src/static/base/fenced-block-base.js` (`:116-141`)
- Modify: `frontend/src/index.html` (SSE relay divs `:45-46`)
- Test: `frontend` vitest for any pure JS extracted

**Interfaces:**
- Consumes: `JobTracker.ServeJobs` (`job_tracker.go:143`) → `{active:[...],queued:[...]}`; the `jobs:changed` SSE payload (same shape).
- Produces: `/api/jobs` route; a frontend that renders from `jobs:changed` while still tolerating `ai:job-*`.

- [ ] **Step 1: Route `/api/jobs`**

In `requesthandlers/ai_handler.go` `RegisterPaths` (beside `:39`):

```go
	r.Get("/api/jobs", func(w http.ResponseWriter, r *http.Request) { h.JobTracker.ServeJobs(w, r) })
```

Build: `go build ./...`.

- [ ] **Step 2: Add a `jobs:changed` consumer in `ai-actions.js`**

Add a `sse:jobs:changed` listener that rebuilds `activeJobs` from `payload.active` and stores `payload.queued`, keeping the existing `setEvaluating` spinners. Keep the legacy `ai:job-started`/`ai:job-ended` handlers for now (both update the same store — idempotent). Add near `:60-79`:

```js
document.body.addEventListener('sse:jobs:changed', (e) => {
  let payload; try { payload = JSON.parse(e.detail.data); } catch { return; }
  applyJobsSnapshot(payload); // set activeJobs from payload.active; store payload.queued; drive spinners
});
```

Add `applyJobsSnapshot(payload)` (replace `activeJobs` from `payload.active` keyed by `jobId`, drive `setEvaluating` per active `docId`, keep `payload.queued`, then `updateStatusBar()`). Add a `jobs:changed` SSE relay div in `index.html` (mirror `:45-46`).

- [ ] **Step 3: Seed from `/api/jobs`**

Change `loadActiveJobs` (`ai-actions.js:97-111`) to `fetch('/api/jobs')` reading `data.active` (+ `data.queued`). Update the `fenced-block-base.js` module-load seed (`:118`) to read `data.active` into `_activeJobIds`.

- [ ] **Step 4: vitest for extracted logic**

If `applyJobsSnapshot`/queued-tracking is extracted into a pure module, add a vitest asserting `{active:[{jobId,docId}],queued:[{jobId}]}` produces the right map + queued list. Run: `cd frontend && npx vitest run`. Expected: PASS.

- [ ] **Step 5: `node --check` + build + in-app smoke**

Run: `node --check frontend/src/static/ai/ai-actions.js && node --check frontend/src/static/base/fenced-block-base.js && go build ./...`
In-app (WebKitGTK): trigger a code-block detect; confirm the spinner appears/clears (now driven by `jobs:changed`) and a queued job (submit several at once) shows. `index.html` changes need a `.go` touch/`wails dev` restart to re-embed.

- [ ] **Step 6: Commit**

```bash
git add requesthandlers/ai_handler.go frontend/src/static/ai/ai-actions.js frontend/src/static/base/fenced-block-base.js frontend/src/index.html
git commit -m "feat(frontend): dual-listen jobs:changed + /api/jobs bridge (two lists)

Status bar renders from jobs:changed/{active,queued} while still
tolerating legacy ai:job-*, so the Phase C rename cannot leave the UI
dark. /api/jobs routed to the existing ServeJobs."
```

---

## Task B6: `EditorService` owns document jobs; `AIService` goes sync-only; close-all folds into the engine

**Files:**
- Modify: `sieve/editor/editor_service.go` (add document-lifecycle entries; import `sieve/sieve/ai`; add `SetAI`)
- Modify: `sieve/ai/ai_service.go` (delete `EvaluateOnClose :61`, `runCloseFiling :71`, `fileOneOnClose :97`, `closeFilingLimit :33`, `fileOnClose :37`, `closeFilingConcurrency :53`)
- Delete: `sieve/ai/close_filing_test.go` (its two concurrency assertions are already covered by the engine's per-category cap test)
- Modify: `requesthandlers/note_handler.go` (`handleTabsClose :193→:212`, `handleTabsCloseAll :150→:159`) → call `EditorService`, not `AI.EvaluateOnClose`
- Modify: `handlers.go` (`sp.Editor.SetAI(sp.AI)` beside `SetEngine`)
- Test: `sieve/editor/editor_document_jobs_test.go`

**Interfaces:**
- Consumes: `ai.AIService.EvaluateAndFileDoc(id, fileAfter, allowDiscard) (FilingOutcome, error)` (`ai_service.go:107`, already sync); `services.JobEngine`/`JobDescriptor`; `block.CategoryAI`.
- Produces: `EditorService.SetAI(*ai.AIService)`, `CloseAllAndFile(ids []string)`, `CloseDocument(id string)`, `FileDocument(id string)`, `KeepAndFile(uuid string)`, `UpdateMetadata(id string)` — each submits a document `JobDescriptor` (Work calls the sync AIService method).
- Note: this makes `editor → ai` real (the reason the package was lifted above `ai`). Verify `services`/`block` still do NOT import `editor`.

- [ ] **Step 1: Give EditorService the AIService (post-construction)**

Add field `ai *ai.AIService` and `func (es *EditorService) SetAI(a *ai.AIService) { es.ai = a }` beside `SetEngine`. Wire `sp.Editor.SetAI(sp.AI)` in `handlers.go` beside `SetEngine`. Add `import "sieve/sieve/ai"` to `editor_service.go`.

> Naming: the existing `EditorService.CloseAll()` (no args, `:399`) is the library-switch flush-all — do NOT overload it. The new filing entry is `CloseAllAndFile(ids []string)`.

- [ ] **Step 2: Write the failing document-jobs test**

Create `sieve/editor/editor_document_jobs_test.go`. Inject a real `JobEngine` with `"ai"` pool = 2 and a fake filing seam; assert `CloseAllAndFile(ids)` files every id exactly once AND bounds concurrency to the pool (porting `close_filing_test.go`'s two assertions onto the engine path). Reuse the existing `ai` test seam (the `RunCLI` fake) to construct a real `AIService`; introduce a provider-owned `ai.AIService` interface ONLY if the real service cannot be built in an `editor` test (prefer reuse — YAGNI). Sketch:

```go
func TestEditorService_CloseAllAndFile_filesEveryDocOnceBoundedByPool(t *testing.T) {
	// engine ai pool = 2; es.SetEngine(engine); es.SetAI(fakeAI) where fakeAI records
	// ids + tracks peak concurrency (sleep in the fake). es.CloseAllAndFile([]string{"a","b","c","d","e"}).
	// wait; assert each id filed exactly once AND 2 <= peak <= 2.
}
```

- [ ] **Step 3: Run it — verify failure**

Run: `go test ./sieve/editor/ -run TestEditorService_CloseAllAndFile -v`
Expected: FAIL — `CloseAllAndFile`/`SetAI` undefined.

- [ ] **Step 4: Implement the document-lifecycle entries**

Each builds a `JobDescriptor` per doc and submits to `es.engine` (bounded by the `"ai"` pool). Example:

```go
// CloseAllAndFile evaluates + files each closing document on the ai worker pool.
// Replaces AIService.EvaluateOnClose/runCloseFiling (the local semaphore folds
// into the engine's ai pool). Every open doc is still evaluated on close.
func (es *EditorService) CloseAllAndFile(ids []string) {
	for _, id := range ids {
		id := id
		es.engine.Submit(services.JobDescriptor{
			Category: block.CategoryAI,
			Meta:     services.JobInfo{JobID: "file:" + id, Label: "Filing…", DocID: id},
			Work:     func() (any, error) { return es.ai.EvaluateAndFileDoc(id, true, true) },
			OnError:  func(err error) { /* log; filing failure is non-fatal */ },
		})
	}
}
```

Implement `CloseDocument(id)` (flush then submit one filing descriptor), `FileDocument(id)`, `KeepAndFile(uuid)`, `UpdateMetadata(id)` analogously, each `Work` calling the matching **existing** sync `AIService` method (filing → `EvaluateAndFileDoc`; metadata → the current metadata method). Do NOT add new AIService logic.

- [ ] **Step 5: Delete the AIService concurrency seam**

Remove from `ai_service.go`: `EvaluateOnClose` (`:61`), `runCloseFiling` (`:71`), `fileOneOnClose` (`:97`), fields `closeFilingLimit` (`:33`), `fileOnClose` (`:37`), const `closeFilingConcurrency` (`:53`). Delete `sieve/ai/close_filing_test.go`. `EvaluateAndFileDoc` stays. Build `go build ./sieve/ai/...`; fix unused imports.

- [ ] **Step 6: Make the HTTP handlers thin**

In `requesthandlers/note_handler.go`: `handleTabsClose` (`:193`) — replace `AI.EvaluateOnClose(id)` (`:212`) with `Editor.CloseDocument(id)`. `handleTabsCloseAll` (`:150`) — replace `AI.EvaluateOnClose(closing...)` (`:159`) with `Editor.CloseAllAndFile(closing)`. Keep the WS-disconnect `Editor.Close` (flush) as-is.

- [ ] **Step 7: Tests + race + build + layering**

Run: `go test ./sieve/editor/ -run TestEditorService_CloseAllAndFile -race -v` → PASS.
Run: `go test ./... && go test ./sieve/services/... ./sieve/editor/... -race` → PASS.
Run: `go list -deps sieve/sieve/editor | grep -x sieve/sieve/ai` → prints it (editor now imports ai, intended).
Run: `go list -deps sieve/sieve/services | grep -x sieve/sieve/editor || echo OK` → `OK` (no cycle).

- [ ] **Step 8: In-app smoke — close-all files everything**

Open several unfiled docs, Close All; confirm each is filed (regression stays fixed), concurrency is bounded (queue shows when >`worker_pools["ai"]` fire), no unbounded CLIs.

- [ ] **Step 9: Commit**

```bash
git add sieve/editor/ sieve/ai/ai_service.go requesthandlers/note_handler.go handlers.go
git rm sieve/ai/close_filing_test.go
git commit -m "feat(editor,ai): EditorService owns document filing jobs; AIService goes sync-only

Close/close-all filing moves from AIService.EvaluateOnClose (local
semaphore) into EditorService document entries submitted to the engine's
ai pool; AIService keeps only synchronous EvaluateAndFileDoc et al. HTTP
handlers become thin pass-throughs. editor now imports ai; no cycle.
Regression (every doc filed on close) preserved."
```

---

## PHASE C — Retire legacy events/routes/bindings; finish the two-list status bar

## Task C1: Retire the legacy `ai:job-*` writers; finish the two-list render

**Files:**
- Modify: `sieve/services/job_tracker.go` (`Start :28/:42`, `End :39/:62`)
- Modify: `requesthandlers/ai_handler.go` (`emitJobStarted :21`, `emitJobEnded :27`, callers in `evaluateAndFile :88-89`)
- Modify: `frontend/src/static/ai/ai-actions.js` (drop legacy listeners `:60-79`; finalize two-list `updateStatusBar`)
- Modify: `frontend/src/static/base/fenced-block-base.js` (`:123-126`)
- Modify: `frontend/src/index.html` (remove `ai:job-*` relay divs `:45-46`)

- [ ] **Step 1: Confirm the engine is the only writer path**

Run: `grep -rn "\.Start(\|\.End(" --include=*.go sieve/ requesthandlers/ | grep -i job`
Expected: the only remaining tracker `Start`/`End` callers are `ai_handler.emitJob*`. If others exist, convert them to the engine path first.

- [ ] **Step 2: Remove `emitJobStarted`/`emitJobEnded` + caller**

Delete `emitJobStarted` (`:21`), `emitJobEnded` (`:27`), and the `evaluateAndFile` progress calls (`:88-89`). If `evaluateAndFile` (the `/api/ai` filing path) is fully superseded by B6, delete the dead handler too — confirm no frontend caller (grep `frontend/src` for its route). Otherwise leave it but drop the tracker writes. **(Flagged open decision — see self-review.)**

- [ ] **Step 3: Delete `JobTracker.Start`/`End` + legacy events**

Remove `Start` (`:28`), `End` (`:39`) and the `ai:job-started`/`ai:job-ended` broadcasts from `job_tracker.go`. Keep `Enqueue`/`Activate`/`Finish`/`Queued`/`Active`/`ServeJobs`. Delete any `job_tracker_test.go` test asserting the legacy events; keep the queued/active lifecycle tests.

- [ ] **Step 4: Drop the frontend legacy listeners; finalize two lists**

In `ai-actions.js`, delete the `sse:ai:job-started`/`ended` handlers (`:60-79`) — `applyJobsSnapshot` is now the sole driver. Finalize `updateStatusBar` (`:8-29`) to render TWO sections: **Active** (spinners, `spinTab`/`docId`) and **Queued** (count + labels from `payload.queued`). In `fenced-block-base.js`, replace its `sse:ai:job-*` handlers (`:123-126`) with a single `sse:jobs:changed` handler updating `_activeJobIds` from `payload.active`. Remove the `ai:job-*` relay divs from `index.html` (`:45-46`).

- [ ] **Step 5: Tests + checks + in-app**

Run: `go test ./... && cd frontend && npx vitest run && cd ..` → PASS.
Run: `grep -rn "ai:job-started\|ai:job-ended" --include=*.go --include=*.js --include=*.html . || echo "no legacy event refs remain"` → `no legacy event refs remain`.
Run: `node --check frontend/src/static/ai/ai-actions.js && node --check frontend/src/static/base/fenced-block-base.js`.
In-app: Active + Queued both render; spinners still track tabs; nothing regresses under many jobs.

- [ ] **Step 6: Commit**

```bash
git add sieve/services/job_tracker.go sieve/services/job_tracker_test.go requesthandlers/ai_handler.go frontend/src/static/ai/ai-actions.js frontend/src/static/base/fenced-block-base.js frontend/src/index.html
git commit -m "refactor(jobs): retire legacy ai:job-* writers; engine is the sole tracker writer

Deletes JobTracker.Start/End + ai:job-started/ended, ai_handler emitJob*,
and the frontend legacy listeners. Status bar renders Active + Queued
from jobs:changed only."
```

---

## Task C2: Dead-code removal (`refine-language`, superseded Wails bindings, legacy jobs route)

**Files:**
- Modify: `requesthandlers/ai_handler.go` (route `/api/ai/refine-language` `:38`, `handleRefineLanguage :132-145`, `refineLanguageRequest :128`; route `/api/ai/active-jobs` `:39`)
- Modify: `sieve/services/job_tracker.go` (`ServeActiveJobs :70` + its dead nil-guard, if now unrouted)
- Modify: `app.go` (`DescribeImage :522`, `RefineLanguage :534` bindings)

- [ ] **Step 1: Confirm each is dead**

Run: `grep -rn "refine-language\|active-jobs\|RefineLanguage\|DescribeImage" frontend/src`
Expected: NO hits for `refine-language`, `active-jobs`, `App.RefineLanguage`, `App.DescribeImage` (B5 moved the seed to `/api/jobs`). If `active-jobs` still appears, finish the B5 migration first.

- [ ] **Step 2: Remove the dead HTTP route + handler**

Delete from `ai_handler.go`: the `/api/ai/refine-language` route (`:38`), `handleRefineLanguage` (`:132-145`), `refineLanguageRequest` (`:128`). Delete the `/api/ai/active-jobs` route (`:39`) and — if `ServeActiveJobs` (`job_tracker.go:70`) is now unrouted — delete it and its dead nil-guard (noted in the foundation review).

- [ ] **Step 3: Remove the superseded Wails bindings**

Delete `App.DescribeImage` (`app.go:522`) and `App.RefineLanguage` (`app.go:534`). If `frontend/wailsjs` bindings are checked in and generated, regenerate via the project's generator; do not hand-edit generated files. (Per CLAUDE.md there is no npm build step — confirm how bindings are produced before regenerating.)

- [ ] **Step 4: Build + full suite + grep clean**

Run: `go build ./... && go test ./...` → PASS.
Run: `grep -rn "refine-language\|ServeActiveJobs\|handleRefineLanguage" --include=*.go . || echo clean` → `clean`.

- [ ] **Step 5: Commit**

```bash
git add requesthandlers/ai_handler.go sieve/services/job_tracker.go app.go frontend/
git commit -m "chore: remove dead AI routes and superseded Wails bindings

Deletes /api/ai/refine-language (+handler+req struct), the now-unrouted
/api/ai/active-jobs + ServeActiveJobs, and the unused app.go
DescribeImage/RefineLanguage bindings. All verified caller-free."
```

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-06-30-async-ai-job-queue-design.md`):
- Declarative jobs (`block.ProcessorJob`, `DescribeJob`) → B2 (type) + B4 (inversion).
- Framework Apply→finish, finish-exactly-once → B2 (`submitBlockJob` on `EditorService`, not a separate `JobRunner` — the spec's `JobRunner` type is deliberately NOT built; its one caller and block-specific shape made it an unjustified indirection, and the wrap belongs on the type that owns the block/attr-diff data).
- One communal engine as sole tracker writer → B3 (wire) + B4c (block path) + B6 (document path) + C1 (retire legacy writers).
- `AIService` synchronous & blind (no categories/engine) → B6 (delete `EvaluateOnClose`/`runCloseFiling`); `CategoryAI` kept OUT of `ai` (in `block`).
- `EditorService` owns document jobs → B6.
- `block.AIPort` deleted; `ai` doesn't import `block`; processors import `ai` → B4b (+ `go list` assertion B4 Step 7).
- Close-all folds into the `"ai"` pool; regression preserved → B6.
- `worker_pools` setting → B1; root wiring → B3.
- Status bar two lists + `jobs:changed`/`/api/jobs`, dual-listen bridge → B5 + C1.
- Name generalisation `ai:job-*`→`jobs:changed`, `/api/ai/active-jobs`→`/api/jobs` → B5 + C1 + C2.
- Dead code → C2.
- `Category` opacity, no enum, producer-owned constant → `block.CategoryAI` (B2) + Global Constraints; engine unchanged.
- Testing strategy → B2, B4 Step 8, B6 Step 2.

**Deviations from the spec (deliberate, with rationale):**
1. **No `JobRunner` type** — folded into `EditorService.submitBlockJob`. The spec placed `JobRunner` "low in services for non-editor producers," but the only cited non-editor producer (the Ask panel) submits a raw descriptor with no block `Apply`, so it uses `engine.Submit` directly; document jobs likewise. With one real caller and block-specific shape, a separate type was premature indirection, and the wrap manipulates `EditorService`-owned data — so it belongs there per "behaviour on the owning type."
2. **`CategoryAI` lives in `block`, not `ai`** — the spec put it "near AIService," but `ai` is the blind brain and is not the submitter; the submitters (`block/processors`, `editor`) share `block`, where `ProcessorJob.Category` already lives.

**Placeholder scan:** the AI-processor `DescribeJob` bodies (B4b) and document entries (B6) instruct the implementer to port EXACT current attr keys/conditionals from cited `file:line` ranges — deliberate (the current code is the source of truth the implementer must read), not a placeholder. Every framework-novel unit (ProcessorJob, submitBlockJob, wiring, dispatch, bridge) has complete code.

**Type consistency:** `block.ProcessorJob{Category,Label,Work,Apply}` used identically in B2 (def), B4 (producers), and B2/B4c (`submitBlockJob`). `submitBlockJob(job, meta, blk, onDone)` matches its definition and its B4c call. `EditorService` setters (`SetJobs`/`SetEngine`/`SetAI`) are all post-construction — no test-constructor churn. `CloseAllAndFile(ids)` avoids clashing with the existing `CloseAll()`.

**Open decisions flagged for implementer/reviewer** (do not silently resolve): (1) whether `evaluateAndFile` (the `/api/ai` filing HTTP path) is fully superseded by B6 and deletable in C1, or must remain — depends on whether any non-tab-close caller uses it (grep at C1 Step 2); (2) whether the B6 test reuses the existing `RunCLI` fake or introduces a provider-owned `ai.AIService` interface — prefer reuse (spec YAGNI), escalate only if the real `AIService` cannot be constructed in an `editor`-package test.
