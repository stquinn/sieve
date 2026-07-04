# Communal Job Engine & Declarative Block/Document Jobs — Design

> **Status — DESIGN (awaiting review).** Brainstormed 2026-06-30. **Rewritten 2026-06-30** after an extended design review that materially changed the architecture. Supersedes the close-all-local concurrency limiter shipped in the working tree (`AIService.runCloseFiling`/`closeFilingLimit`), which folds into this framework. Successor artifact: an implementation plan under `docs/superpowers/plans/`.
>
> **What changed from the first draft (and why):** the first draft kept `block.AIPort` and a per-subsystem async engine inside `AIService`, fronted by a transitional `BlockingAIPort` sync adapter. Review found three things wrong with that: (1) the `block.AIPort` "port" only existed to break an import cycle that is itself *manufactured* by misfiled language code; (2) requiring each processor to remember to call a completion hook is a footgun, not a framework; (3) a per-subsystem engine cannot express the heterogeneous concurrency the smart-code-blocks roadmap needs once everything funnels through one editor. The redesign extracts the language leaf (killing the cycle), removes the port, inverts processors to **declare** jobs rather than execute them, makes `AIService` a blind synchronous business service, and routes **every** async job through **one communal `JobEngine`** that sizes a worker pool per `Category`. See *Rejected alternatives* for the supersession record.
>
> **Layering revision (cycle resolution).** Because `EditorService` lives in `services` and `ai` already imports `services`, having the editor call `AIService` (to instigate Smart File etc.) would close an `ai ↔ services` cycle. Resolved by **lifting `EditorService` into a new top-level `sieve/editor` package above `ai`** — the orchestrator sits above the things it orchestrates — leaving the general job framework low in `services` and `AIService` unmoved in `ai`. No port. This is folded into Phase 0 of the foundation plan as a pure package move.

## Problem

Every AI operation today spawns its own goroutine that runs a `claude` CLI subprocess synchronously, with **no global limit on concurrency**. Language detection on each code block, Ask/Explain, Describe-Image, Web-Clip, and filing can all fire at once — and "Close All Tabs" (once its filing regression is fixed) would file *N* docs in parallel. Many concurrent CLIs is the immediate risk; the smart-code-blocks roadmap (`docs/brainstorm-smart-code-blocks.md` — reactive DAG recalculation, HTTP blocks, local server sieves, code execution) makes a *general* bounded async-work framework a near-term need, with **different** concurrency appetites per kind of work.

The trigger for this work: a regression where "Close All Tabs" filed *nothing* (it never called the evaluator), while closing tabs one-by-one filed each. The narrow fix (a close-all semaphore) revealed the real, general need: bounded, tracked, async work owned by a framework — not by each caller.

## Goals

- **Bound async work** per *category* of work, enforced once by a framework, with **zero per-caller lifecycle code**.
- **Producer/consumer**: producers submit **job descriptors**; a per-category worker pool consumes them; queues are effectively unbounded (a ~1000 backstop guards runaways). What we configure is the **consumer-side worker count**, never queue depth.
- **Declarative jobs**: a producer *describes* its work (a `Work` closure + how to interpret the result); the **framework** owns submit → track → run → apply → finish. A producer cannot break the lifecycle because it writes none of it.
- **One owner for document-lifecycle AI**: `EditorService` (the server-side embodiment of the editor) instigates the document jobs — Smart File, File-and-Keep, Metadata — because they are consequences of save/close, which it owns. HTTP/WS handlers go thin.
- **`AIService` stays the AI brain, blind to everything else**: it keeps all evaluation/filing/metadata logic, as **synchronous** business methods. It owns no goroutines, no engine, no block knowledge.
- **Generalise job tracking**: `JobTracker` becomes the app-wide async-job registry with **Active and Queued lists**; the engine is its sole writer.

## Non-Goals (explicitly deferred)

- **No queue smarts in v1**: no priority, no cancellation, no coalescing. Per-category FIFO over an effectively-unbounded buffer. (The `Category` seam is where per-category queue *policy* lands later — see *Future seam*.)
- **No live resize**: worker counts are read from settings at construction; a change applies on restart.
- **No backend swap**: `RunCLI`→`RunAPI` remains an orthogonal concern *inside* `AIService`.
- **No smart-code-blocks implementation**: this builds the *framework* those future workloads will submit to, not the workloads.

## Architecture

The package DAG, after Phase 0 (`lang` extracted, `EditorService` lifted to `sieve/editor`):

```
domain, lang  ←  block  ←  {block/processors, services}  ←  ai  ←  editor  ←  root
```

`ai` no longer imports `block` (its only `block` references were the language helpers). `block` never imports `ai`. **`EditorService` lives in a new top-level `sieve/editor` package, above `ai`** — it is the orchestrator that *uses* `services`, `block/processors`, and `ai` to do its job, and is imported by nothing below it. That placement is what lets the editor instigate AI-powered document jobs (Smart File etc.) **without** an `ai ↔ services` cycle: the orchestrator sits above the things it orchestrates. The general job framework (`JobEngine`/`JobTracker`/`JobDescriptor`/`JobRunner`) stays **low in `services`** so any future (non-editor) producer can submit to it without importing the editor; `EditorService` merely holds the root-constructed engine instance. `AIService` stays in `ai`, unmoved.

```
Producers
  ├─ processors (DescribeJob → block.ProcessorJob)              [block jobs]
  └─ editor.EditorService document entries (file/keep/metadata) [document jobs]
        │  both reach the framework via a services.JobDescriptor
        ▼
┌ services.JobRunner — the framework wrap (injected into EditorService) ─────┐
│  • snapshots, builds the Apply→finish closure, sets Meta, picks Category   │
│  • submits to the engine; guarantees finish runs exactly once             │
└────────────────────────────────────────────────────────────────────────────┘
        │ submit(JobDescriptor)
        ▼
┌ services.JobEngine — ONE communal instance ───────────────────────────────┐
│  pools: map[category]*workerPool   (worker count per category, from config)│
│  Submit(JobDescriptor)                                                     │
│   • register QUEUED with JobTracker (reads Meta)                           │
│   • route to pools[desc.Category] (default pool if unset/unknown)          │
│   • a free worker: ACTIVE → run desc.Work() → End → desc.OnFinished/OnError│
│  Treats Category as OPAQUE DATA — no switch, no central enum.              │
└────────────────────────────────────────────────────────────────────────────┘
        │ drives                                   ▲ advertises
        ▼                                           │
┌ services.JobTracker — general registry/advertiser ────────────────────────┐
│  Enqueue/Activate/End · state ∈ {queued, active} · Active()/Queued() lists │
│  broadcast "jobs:changed" · GET /api/jobs · sole writer = the engine       │
└────────────────────────────────────────────────────────────────────────────┘

  ai.AIService — synchronous, blind AI brain (RefineLanguage, EvaluateAndFileDoc,
  metadata, …). Called from inside Work closures. Imports lang + services, NOT block.
```

### Why this layering

- **Language extraction kills the cycle (Phase 0).** `block.language_heuristics.go` is not a block concept — it is a standalone "guess a language" capability used by *both* the code processor and `AIService`. Misfiling it in `block` is the *only* reason `ai` imported `block`. Moving it to a neutral leaf (`sieve/lang`) removes that edge entirely, so `AIService` becomes genuinely blind to blocks.
- **No port.** With the cycle gone, `block.AIPort` has no job: it existed solely to let `block` reach `ai` without importing it. A port that exists only to break a cycle is a smell once the cycle is removed. It is deleted, not replaced. (A provider-owned `ai.AIService` interface for *mocking* is a separate, later decision — there are zero AI mocks today, so it is YAGNI for this pass.)
- **Declarative jobs remove the footgun.** Processors return a descriptor; they never touch lifecycle. The framework owns the `Apply → finish` wrap, so completion is structurally unforgettable. This is the difference between a framework and a convention.
- **`EditorService` owns the document slice — from above.** Save/close are editor operations; filing/keep/metadata are consequences of them. The editor instigates them; the *logic* stays in `AIService`; the *bounding/tracking* is the engine's. `EditorService` lives in `sieve/editor` **above `ai`**, so it can call `AIService` directly with no cycle; it orchestrates via an injected `JobRunner` (which stays low in `services`) so it does not become a god-object. Its supra-`services` position was an artifact of the old `ai → block` edge (now removed); lifting the *orchestrator* up — rather than pushing `AIService` *down* — is the placement fix that dissolves the `ai ↔ services` cycle without any port.
- **One communal engine, worker pool per `Category`.** Once everything funnels through the editor, per-subsystem engine *instances* would just be `EditorService` holding `map[subsystem]*Engine` and routing — identical to one engine holding `map[category]*pool`, with a clumsier API. One engine, one Submit, one tracker relationship, config-driven pools.

#### `Category` is data, not behaviour (staying uniform)

The `Category` on a descriptor is a **producer-side classification** ("what this job *is*"), never an instruction about engine mechanism ("what to *do*"). The engine runs **one** algorithm and keeps one worker pool per category, every pool identical, differing only by a worker count pulled from config. There is **no `switch category` anywhere in the engine** and **no central enum**: category constants live with the submitting subsystem (`ai.CategoryAI = "ai"`, a future `CategoryExec = "exec"` near the exec processor). An unconfigured category runs at the `default` worker count. This is the uniform mechanism (one pool implementation parameterised by data), not the asymmetric type-category smell (different code per type).

### Components

**`sieve/lang`** (new leaf) — language definitions + heuristics.
- *Holds*: `CanonicalLanguages`, `KnownLanguages`, `IsConfident(lang)`, `DetectByHeuristics(source, hint)`, `LooksLikeCode` (everything currently in `block/language_heuristics.go`).
- *Depends on*: stdlib only. Imported by `ai` and `block/processors`; neither knows the other.

**`services.JobEngine`** — the communal producer/consumer engine (one instance, root-constructed).
- *Does*: accepts a `JobDescriptor`, registers it QUEUED with the tracker, routes to the worker pool for its `Category`, runs `Work()` on a free worker, drives the tracker and the descriptor's callbacks on completion. **Sole writer of `JobTracker`.**
- *Interface*: `Submit(JobDescriptor)`. Construction: `NewJobEngine(pools map[string]int, defaultN int, tracker *JobTracker)`.
- *Internals*: `map[category]*workerPool`; each pool = N worker goroutines draining an effectively-unbounded channel (~1000 cap as a runaway backstop). Pools created lazily from config; unknown category → default pool.
- *Treats `Category` as opaque*. No knowledge of "ai"/"exec"/etc.

**`services.JobDescriptor`** — the generic unit the engine consumes.
- `{ Category string; Meta JobInfo; Work func() (any, error); OnFinished func(result any); OnError func(err error) }`.
- *Depends on*: nothing (leaf type in `services`).

**`block.ProcessorJob`** — the block-level descriptor a processor returns.
- `{ Category string; Label string; Work func() (any, error); Apply func(result any, blk *block.SieveBlock) }`. `Work == nil` ⇒ no async work; the framework runs `Apply` synchronously and finishes.
- *Depends on*: `block` only.

**`services.JobRunner`** — the framework wrap (injected into `EditorService`).
- *Does*: for a block job, takes the `ProcessorJob` + the `attrsBefore` snapshot, builds a `JobDescriptor` whose `OnFinished` runs `Apply(result, blkCopy)` then the **finish** closure (the attr-diff + `applyJobUpdate` that today lives after `processor.RunJob` returns), and whose `OnError` runs finish with the error. For a document job, `EditorService` builds the `JobDescriptor` directly. Either way `JobRunner.Submit` guarantees finish-exactly-once.
- *Depends on*: `JobEngine`, `block` (for `ProcessorJob`/`SieveBlock`). *Lives in `services`* (low, general); the editor imports and uses it.

**`services.JobTracker`** (generalised) — the advertiser.
- `JobInfo` gains `State string` (`"queued"|"active"`) and optional `Category string`; keeps `JobID/Label/DocID/SpinTab`.
- Methods: `Enqueue(JobInfo)`, `Activate(id)`, `End(id)` (each broadcasts `jobs:changed`); `Active()`/`Queued()` ordered list accessors; `ServeJobs` → `GET /api/jobs` returns `{active:[...], queued:[...]}`.
- *Depends on*: nothing. Owns no policy.

**`ai.AIService`** (synchronous, blind) — the AI brain, unchanged in responsibility.
- Keeps **all** logic: `RefineLanguage(source, currentLang, method) (string, error)`, `EvaluateAndFileDoc(id, fileAfter, allowDiscard) (FilingOutcome, error)`, File-and-Keep, Metadata, Describe-Image, Web-Clip, Ask/Explain — as ordinary synchronous methods.
- Owns **no** engine, **no** goroutines, **no** block types, **no** `JobTracker`. Imports `lang`, `services` (data types), `domain`, `store`. **Stays in `ai`, unmoved** — it is a peer business service that the existing `ai → services` edge already lets reach persistence; the editor reaches *it* from above (`editor → ai`), so nothing about `AIService`'s location changes.
- The tier-Dumb gate stays here: a Dumb-tier `RefineLanguage` returns `("", nil)` (callers already tolerate `""`); filing entries check tier before building a descriptor.

**`editor.EditorService`** (lifted to the new top-level `sieve/editor` package, above `ai`) — the server-side editor; the document-job owner.
- *Lives in `sieve/editor`* precisely so it can import `ai` and call `AIService` directly without an `ai ↔ services` cycle (it sits above both `ai` and `services`). Imported only by root/handlers; nothing below it depends on it (verified: no peer in `services` and nothing in `ai`/`block` references it).
- Owns the injected `JobRunner`. Runs block jobs by calling `processor.DescribeJob(jctx)` and handing the result to the runner. Exposes the document-lifecycle entries that instigate document jobs: `CloseDocument(id)`, `CloseAll(ids)`, `FileDocument(id)`, `KeepAndFile(uuid)`, `UpdateMetadata(id)` — each builds a `JobDescriptor` whose `Work` calls the matching synchronous `AIService` method.
- HTTP/WS handlers become thin pass-throughs to these methods.

### Data flow — a code block's language detection (representative)

1. `EditorService.runJob` snapshots `attrsBefore`, calls `processor.DescribeJob(jctx)`.
2. `CodeBlockProcessor.DescribeJob` returns a `ProcessorJob{ Category: ai.CategoryAI, Label: "Refining language…", Work: func() (any,error) { return p.svc.AI.RefineLanguage(source, cur, method) }, Apply: <confidence-gate mutation> }`.
3. `JobRunner` builds a `JobDescriptor` (Meta from `Label`+`uuid`+`blockID`; `OnFinished` = `Apply` then `finish`; `OnError` = `finish(err)`) and submits to the engine.
4. Engine registers QUEUED (tracker → `jobs:changed` → status bar). A free `"ai"`-pool worker: ACTIVE, runs `Work` (the CLI via sync `AIService`), then `End` + `OnFinished`.
5. `OnFinished` runs `Apply(lang, blkCopy)` (the confidence gate mutates `blkCopy.Attrs` exactly as today, including `delete(…, "hint")`), then `finish(nil)` runs the attr-diff and `applyJobUpdate` → shadow merge → WS `update-block`.

The processor wrote no lifecycle code; the framework guaranteed the merge and the tracker-end.

### Configuration

- New setting `worker_pools map[string]int` (e.g. `{"default":4,"ai":3,"exec":8,"http":32}`) in `settings.json` / `domain.Settings`. Values are **worker counts** (consumer-side pool size), not queue depths. The engine reads it at construction; a category with no entry uses `default` (itself defaulting to a small constant if absent). Live resize is a non-goal.
- The legacy `ai_max_parallel` idea from the first draft is subsumed by `worker_pools["ai"]` (default **3**, min **1**).

### Status bar (frontend)

- `ai-actions.js` renders **two lists** — Active and Queued — sourced from `jobs:changed` SSE + `GET /api/jobs` (seed on load). Active items keep the existing per-tab spinner (`spinTab`/`docId`), now populated from `Meta` the producer supplied.
- `fenced-block-base.js` and `index.html` relay wiring updated to the generalised event/endpoint names.

### Cleanup folded into this work

- **Tracker consolidation.** The two current `JobTracker` writers retire: `editor_service.go`'s `jobs.Start/End` around `RunJob` and `ai_handler.go`'s `emitJobStarted/emitJobEnded`. The engine becomes the sole writer (via `Meta`).
- **Dead code.** Remove `/api/ai/refine-language` route + `handleRefineLanguage` + `refineLanguageRequest` (zero real callers). Remove the superseded `app.go` `DescribeImage`/`RefineLanguage` Wails bindings.
- **Name generalisation.** `ai:job-started`/`ai:job-ended` → `jobs:changed`; `/api/ai/active-jobs` → `/api/jobs`.
- **Close-all folds in.** Retire the working-tree local limiter (`AIService.closeFilingLimit`/`runCloseFiling`/`fileOnClose` seam + `close_filing_test.go`'s concurrency assertions). `EditorService.CloseAll` submits per-doc filing as descriptors, bounded by the `"ai"` worker pool. The **regression fix is preserved** (every open doc is still evaluated on close).

## Completeness bar (exit criteria)

By the end of this work, **every AI call site produces a descriptor for the communal engine; nothing runs a CLI outside the engine.**

- Block jobs (code/image/web-clip/ai-block) → `DescribeJob` → `JobRunner`.
- Document jobs (file/keep/metadata/close/close-all) → `EditorService` entries → `JobRunner`.
- Non-document AI (e.g. the ambient Ask AI panel) submits to the **same** engine even if it is not a document method — its completion pushes an answer to the panel rather than mutating a doc. The invariant is "one engine," not "every call is an `EditorService` method."
- `block.AIPort` deleted; `ai` does not import `block`; `AIService` exposes only synchronous methods; both legacy `JobTracker` writers removed.

## Error handling

- **Rejection / Dumb tier**: producers gate before submitting (or `AIService` returns a no-op result); no phantom tracker entry.
- **Backend error**: `Work` returns an error → engine calls `End` + `OnError` → framework `finish(err)` sets `BlockStatusError`/`TIMEOUT` exactly as today.
- **Worker panic**: a worker recovers panics, treats them as `OnError`, and keeps consuming; one bad job never kills a pool.
- **Finish-exactly-once**: the framework owns the wrap; a descriptor's terminal path runs once whether the work was async, synchronous (`Work == nil`), or errored.
- **Concurrency**: `applyJobUpdate` now runs on a worker goroutine. This is not a new hazard — today every AI op already calls it from its own goroutine concurrently; the engine merely *bounds* that concurrency.

## Testing strategy (seam-based)

- **`JobEngine`** (white-box, `services`): inject fake `Work` fns — assert per-category peak concurrency ≤ configured worker count, independence across categories, every job runs once, rough FIFO within a category, worker-panic isolation. (The existing `close_filing_test.go` concurrency assertions migrate here.)
- **`JobRunner`** (white-box): assert `Apply` runs before `finish`, finish-exactly-once across success/error/`Work==nil`, and that the attr-diff matches the pre-refactor output for a representative mutation (`+language`, `+detectionMethod`, `-hint`).
- **`JobTracker`** (white-box): `Enqueue/Activate/End` transitions, ordered `Active()`/`Queued()`, `jobs:changed` payload, `/api/jobs` JSON.
- **Processors** (`block/processors`): `DescribeJob` returns the right `Category`/`Work`/`Apply` and never calls a backend directly; `Apply` preserves the confidence-gate logic (port the existing `code_processor_test.go` cases onto the descriptor shape, using `lang` for heuristics).
- **`AIService`** (`ai`): unchanged synchronous behaviour; tests construct it as today.
- **Frontend**: existing vitest scope unchanged; status-bar list rendering verified in-app (Chrome-driven, per the session's CDP harness).

## Future seam

`Category` is also the extension point for the smart-code-blocks roadmap (`docs/brainstorm-smart-code-blocks.md`). High-concurrency workloads (HTTP blocks `"http"`, code execution `"exec"`, reactive-DAG recalculation `"dag"`) declare their own category and get their own worker count with no engine change. When the DAG cascade later needs *queue policy* (priority, or coalescing a stale recalc superseded by a fresh upstream change), that becomes a per-category strategy swap ("category `dag` uses a coalescing queue") — keyed off the same `Category`, still with no central type-switch. v1 ships per-category worker counts + FIFO only.

## Rejected alternatives

- **Keep `block.AIPort` (the port).** Rejected. The port existed only to break the `block`↔`ai` cycle. That cycle is *manufactured* by `language_heuristics.go` living in `block`; extracting `lang` removes the edge, leaving the port a one-implementor abstraction that duplicates `AIService`'s signatures for no consumer benefit (no AI mock exists; processor tests already construct the real `AIService`). A mocking interface, if ever needed, is provider-owned (`ai.AIService`/`DefaultAIService`) and is a separate, later, YAGNI-gated decision — not a port.
- **`BlockingAIPort` transitional sync adapter.** Rejected. It existed to make an async engine look synchronous so processors needn't change. Inverting processors to *declarative* descriptors removes the reason for it entirely; it would be throwaway scaffolding that also forced the metadata-routing compromise of the first draft.
- **Processor calls a completion hook in its own callback.** Rejected. Correctness would depend on every processor author repeating a `Finish` call; one omission silently breaks rendering/tracking. A framework whose contract can be silently broken is a convention. The descriptor inversion moves the wrap into framework code that runs once for everyone.
- **Per-subsystem engine instances (first-draft design).** Superseded. It was correct *while each subsystem owned its own execution path*. The `EditorService` consolidation changed the premise: everything now submits through one editor-owned framework, so per-subsystem instances reduce to `map[subsystem]*Engine` routing — functionally identical to one engine with `map[category]*pool`, but with a clumsier API and a split tracker relationship. One communal engine with per-`Category` worker pools is the same capability with one Submit and one tracker writer.
- **Singleton engine + `JobType` enum with per-type code.** Still rejected — but note the distinction from the chosen design. The smell is an engine that *switches on* the type (different code per kind) and a *central enum* every new kind must edit. The chosen design has neither: `Category` is opaque data the engine routes on via a config map, and category constants are owned by the submitting subsystems. Same uniform mechanism, no behavioural branching.
- **Resolve the `ai ↔ services` cycle by pushing `AIService` down / inverting with a port.** Rejected. With `EditorService` in `services` and `ai → services` already present, the editor calling `AIService` closes a cycle. Two fixes were considered: (a) move `AIService` *down* into `services` so the call is intra-package, or (b) keep `ai` separate and depend on a `services`-owned filing interface that `AIService` implements. (a) drags a large business service plus its CLI/prompt plumbing into `services` and conflates altitudes; (b) re-introduces exactly the consumer-owned port this design spent its budget removing, just relocated to the `services↔ai` seam. The chosen fix instead **lifts the orchestrator up**: `EditorService` moves to a new top-level `sieve/editor` package above `ai`. An orchestrator that *uses* services + processors + AI belongs above all three; once it sits there, the call points downward and no cycle or port exists. This is the same move as the `lang` extraction — fix the *placement* of the misfiled thing rather than insert an abstraction. (The general job framework deliberately does **not** ride up with the editor — it stays low in `services` so non-editor producers can submit without importing the editor.)

## Self-review

- **Placeholders**: none. Every component has a stated responsibility, interface, and dependencies.
- **Internal consistency**: layering matches the post-Phase-0 DAG (`lang`/`domain` leaves; engine/tracker/runner in `services`; `AIService` blind in `ai`; `EditorService` in `sieve/editor` above `ai`; no `block.AIPort`); the bound is enforced by routing all async work through the one engine; the footgun is removed by the descriptor inversion; heterogeneous concurrency is expressed by per-`Category` worker pools without a type-switch; the `ai ↔ services` cycle is avoided by the editor's altitude, not a port.
- **Scope**: one cohesive feature, sizable. Natural phasing for the plan: **(0)** repackaging — extract `sieve/lang` **and** lift `EditorService` into `sieve/editor` (both pure package moves, no behaviour change); **(A)** `JobEngine` + generalised `JobTracker` + tests; **(B)** delete `block.AIPort`, processors → `DescribeJob`/`ProcessorJob`, `JobRunner`, `EditorService` document entries, close-all fold, both tracker-writers retired; **(C)** status bar + rename + dead-code removal. Phase 0 must land first — it is what makes the rest clean. **Plan split:** Phase 0 + A ship as the foundation plan (`docs/superpowers/plans/2026-06-30-job-engine-foundation.md`); Phase B/C as a follow-up plan written once the foundation lands. Note Phase 0 now also pre-creates `sieve/editor`, so the Phase-B document entries have a home.
- **Ambiguity**: the only genuine one — whether to introduce a provider-owned `ai.AIService` mocking interface now — is resolved as *not now* (no mocks exist; YAGNI), to be revisited when `RunAPI` or the first real AI mock arrives.
