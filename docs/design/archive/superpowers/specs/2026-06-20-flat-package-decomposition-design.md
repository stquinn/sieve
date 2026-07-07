> **STATUS: DONE** — shipped; 6-package Go DAG (2026-06-28) + JS static/ regrouped into 6 subfolders (2026-06-29). Archived 2026-07-07.

# S-A: Flat-package decomposition (Go) — design

**Date:** 2026-06-20
**Tech-debt item:** S-A (`docs/TECH-DEBT.md`)
**Branch:** `feature/refactor_editor_layout`
**Status:** design approved; ready for an implementation plan.

## Goal

Break the single flat Go package `sieve/` (45 production + 37 test files, ~14k lines, everything-calls-everything) into a small set of cohesive packages with an enforced, acyclic import DAG. This is the structural fix for the "wheat from chaff" sprawl — once domain ownership exists, behaviour stops leaking into free functions and the directory listing becomes readable. Tests move **with** the code they exercise, which is what fixes the "37 test files in one dir" problem.

## Scope (deliberate boundaries)

**In scope:**
- The **Go** decomposition only.
- A **purely structural, behaviour-preserving** refactor: move files, invert one dependency (`BlockServices` → port interfaces), and the single mechanical fix that the port boundary *forces* (the `AI.state` leak, below). The invariant is **green before == green after the whole refactor** — same `go build ./...`, `go vet ./...`, and test results at the end as at the start. No logic changes (beyond the forced `AI.state` fix).

**Build discipline (per user direction):** the tree does **not** need to compile or the app to run at every intermediate step. It is fine to break the build mid-move and reconverge once the moves are complete. **No transient workarounds, back-compat shims, or temporary adapters** to keep things green during the cutover — make the real move and fix the fallout. The only hard gate is the **end state**: full build, vet, and suite green.

**Explicitly out of scope (each its own later effort):**
- The JS `frontend/src/static/` regroup (independent follow-up; mirroring JS folders does not depend on the Go split).
- Single-source-of-truth / retiring `mdModeBuffer` as authoritative (a *behavioural* change — needs its own gates).
- Any AI-backend abstraction (a `Backend`/provider interface to make a future API-based backend a drop-in). Nothing is set in stone there yet, so we **silo the AI files only** and defer the interface. `cli.go` simply lives in `ai/` as the natural future swap point.
- Stage E / Stage F and any logic change beyond the `AI.state`→`State` fix.

## The blocker (why this couldn't be done earlier)

`BlockServices` (`processor_registry.go:139`) holds **concrete** service pointers:

```go
type BlockServices struct {
    AI          *AIService
    Documents   *DocumentService
    Assets      *AssetService
    Jobs        *JobTracker
    LinkPreview *LinkPreviewService
    State       *StateService
}
```

Processors are constructed with `BlockServices` and call back into these services. So any attempt to extract a `block/` package puts the block model on one side and the services on the other, while each needs the other — an unavoidable `service ↔ processor` import cycle. The deserialization-codec + ShadowDocument-consolidation refactors (done this era) carved the seams (`DocumentCodec`, the narrow `ProcessorRegistry` interface, block ops as `ShadowDocument` methods); inverting `BlockServices` is the last seam.

## The cycle-break: port interfaces (dependency inversion)

`block/` defines narrow **port interfaces** for exactly what processors need from services. `BlockServices` becomes a struct of those ports. The concrete services in `services/` and `ai/` *implement* the ports; the composition root wires them in. `block/` then imports **no** service code.

The port surface is small and was read off real call sites (every `p.svc.X.Method(...)` in the processors):

```go
// Defined in block/ (the core owns the contract its processors depend on).
// Return types resolve to domain/ so block/ can name them without importing services.
type DocumentsPort interface {
    LoadByUUID(uuid string) (domain.Document, error)
    Save(d domain.Document) (domain.Document, error)
}
type AssetsPort interface {
    Save(category store.Category, parentContext, assetID string, data []byte) (*domain.ImageAsset, error)
}
type StatePort interface { LoadSettings() domain.Settings }
type LinkPreviewPort interface {
    FetchTitle(targetURL string) string
    FetchFull(targetURL string) domain.LinkPreviewResult
}
type AIPort interface {  // signatures indicative — pinned to exact existing AIService methods at plan time
    RunExplain(content, history, questionCtx, uuid string) error
    RunAsk(content, history, questionCtx, uuid string) error
    RefineLanguage(source, lang, method string) (string, error)
    DescribeImage(uuid, src, blockID string) error
    RunWebClip(uuid, blockID, source, mode, content string) error
}

type BlockServices struct {
    AI          AIPort
    Documents   DocumentsPort
    Assets      AssetsPort
    State       StatePort
    LinkPreview LinkPreviewPort
}
```

> The `Documents`/`Assets`/`State`/`LinkPreview` signatures above are the **verified** existing signatures (`DocumentService.Save` returns `(Document, error)`; `AssetService.Save` returns `(*ImageAsset, error)`; `FetchFull` returns `LinkPreviewResult`; `FetchTitle`/`FetchFull` return no error). `AIPort`'s are indicative and pinned at plan time. The concrete services already satisfy these — no behaviour change. `Jobs` (`*JobTracker`) is **not** a port: no processor calls it; it stays a concrete `services/` concern used by `EditorService`.
>
> **Consequence — port return types live in `domain/`.** Because the ports name `domain.Document`, `domain.Settings`, `*domain.ImageAsset`, and `domain.LinkPreviewResult`, those data types must sit in the leaf. `Document`/`Settings`/`ImageAsset` already go to `domain/`. `LinkPreviewResult` (today in `link_preview_service.go`) takes the same split as `FilingRecommendation`: the **type** moves to `domain/`, the `LinkPreviewService` **logic** stays in `services/`.

**The one forced fix:** `web_clip_processor.go:153` reaches through a private field — `p.svc.AI.state.LoadSettings().Model`. With `AI` now an interface, that field is invisible. WebClip already has a `State` port available (LogProcessor uses `State.LoadSettings()`), so it becomes `p.svc.State.LoadSettings().Model`. Behaviour identical; the boundary just makes the existing leak illegal.

## Target package structure

```
                    store/   fencedblock/        (existing, unchanged)
                       ↑          ↑
   domain/  Document, Buffer, Note, DocumentMeta, ImageAsset,
            Session, Settings, Categories,
            FilingRecommendation, LinkPreviewResult       ── leaf; imports store/
                       ↑
   block/   SieveBlock, DocumentCodec, RegionScanner, registry,
            BlockProcessor iface, PORTS (+ BlockServices),
            ShadowDocument, handle_gc, markdown_parser,
            columnrow_serializer, context_provider,
            block_anchor, frontend_block, shared_patterns  ── imports domain/, store/, fencedblock/
              ↑                        ↑
   block/processors/            services/   DocumentService, AssetService,
     9 processors +               StateService, JobTracker,
     language_heuristics          LinkPreviewService, LibraryService,
        │                         EditorService
        │                        ↑   ↖
        │                        │     ai/   AIService, cli (RunCLI), prompts,
        │                        │           eval-pipeline, image_localise,
        │                        │           ImageDesc  → implements AIPort
        ↑                        ↑     ↑
   sieve/ (root)  service_provider (composition: wires ai.AIService as the
                  AIPort, registers processors) + http glue + theme + handlers
```

Import directions (all one-way; the whole graph is acyclic):
- `domain/` → `store/` only.
- `block/` → `domain/`, `store/`, `fencedblock/`. **Never** imports services, ai, or processors. (Concrete processors are *registered into* the registry at composition time; the registry exposes only the `BlockProcessor` interface, so `block/` never imports `block/processors/`. A child package importing its parent is normal Go.)
- `block/processors/` → `block/`, `domain/`.
- `services/` → `block/`, `domain/`, `store/`. **Never** imports `ai/` (EditorService dispatches AI work through the `AIPort` interface in `block/`, never the concrete AIService).
- `ai/` → `block/`, `services/`, `domain/`, `store/`. One direction; `services/` does not import back.
- `sieve/` (root) → everything; it is the composition root and the only place concrete types are wired to ports + processors registered.

### Why `ai/` is its own package and why `FilingRecommendation` is **not** in it

`ai/` (AIService + the CLI subprocess + filing pipeline + prompts) is a genuine subsystem, and siloing it gives the headroom for a future API-based backend without touching the rest. But `AIService` holds a concrete `*DocumentService`, and `DocumentService.UpdateAiMetadata` (`document_service.go:138`) takes a `*FilingRecommendation`. If `FilingRecommendation` lived in `ai/`, then `services/` would import `ai/` while `ai/` imports `services/` — a new cycle. Resolution: the shared **data type** `FilingRecommendation` lives in `domain/` (the leaf both already import); the AI **behaviour** (`EvaluateAndFileDoc` and friends) lives in `ai/`. Type in the leaf, logic in the subsystem.

## File-assignment table

| Current file | Target package | Note |
|---|---|---|
| `sieve_block.go` | `block/` | SieveBlock model + accessors |
| `document_codec.go` | `block/` | DocumentCodec + ProcessorRegistry iface |
| `region_scanner.go` | `block/` | Region / RegionScanner |
| `shadow_document.go` | `block/` | ShadowDocument + block ops (methods) |
| `processor_registry.go` | `block/` | registry, BlockProcessor iface, **ports + BlockServices** |
| `handle_gc.go` | `block/` | collectHandles / gcRefs / gcAliases |
| `markdown_parser.go` | `block/` | goldmark gate + custom AST nodes |
| `columnrow_serializer.go` | `block/` | ColumnRow/Column shape-1 (de)serialization |
| `context_provider.go` | `block/` | ContextProvider registry + BuildContextForID |
| `block_anchor.go` | `block/` | BlockAnchorProvider |
| `frontend_block.go` | `block/` | FrontendBlock wire projection |
| `shared_patterns.go` | `block/` | shared fence regexes |
| `ai_block_processor.go` | `block/processors/` | uses AIPort |
| `code_processor.go` | `block/processors/` | uses AIPort |
| `diagram_processor.go` | `block/processors/` | no services |
| `log_processor.go` | `block/processors/` | State, Documents, Assets ports |
| `prose_processor.go` | `block/processors/` | no services |
| `smart_image_processor.go` | `block/processors/` | AI, Documents, Assets ports |
| `smart_link_processor.go` | `block/processors/` | LinkPreview port |
| `smart_card_processor.go` | `block/processors/` | LinkPreview, Documents, Assets ports |
| `web_clip_processor.go` | `block/processors/` | AI, Documents, **State** (was AI.state leak) |
| `language_heuristics.go` | `block/processors/` | code-block language heuristics |
| `document.go` | `domain/` | Document interface |
| `buffer.go` | `domain/` | Buffer |
| `note.go` | `domain/` | Note |
| `document_meta.go` | `domain/` | DocumentMeta |
| `image_asset.go` | `domain/` | ImageAsset |
| `categories.go` | `domain/` | Category constants (KindNote etc.) |
| `session.go` | `domain/` | Session/Tab/Window |
| `settings.go` | `domain/` | Settings |
| `eval.go` (split) | `domain/` + `ai/` | `FilingRecommendation` → `domain/`; `ImageDesc` + `detectContentType`/`extractJSONFallback` → `ai/` |
| `document_service.go` | `services/` | leaf service |
| `asset_service.go` | `services/` | leaf service |
| `state_service.go` | `services/` | leaf service |
| `job_tracker.go` | `services/` | JobTracker (not a port) |
| `link_preview_service.go` (split) | `domain/` + `services/` | `LinkPreviewResult` type → `domain/`; `LinkPreviewService` logic → `services/` (implements LinkPreviewPort) |
| `library_service.go` | `services/` | LibraryService |
| `editor_service.go` | `services/` | EditorService (holds codec + BlockServices) |
| `ai_service.go` | `ai/` | AIService; implements AIPort |
| `cli.go` | `ai/` | RunCLI; future backend swap point |
| `prompts.go` | `ai/` | PromptService (only AIService + composition use it) |
| `image_localise.go` | `ai/` | called only by ai_service |
| `service_provider.go` | `sieve/` (root) | composition: wire ports, register processors |
| `theme.go` | `sieve/` (root) | UI theming (handlers) |

> The exact home of a couple of borderline helpers (e.g. whether `language_heuristics.go` or `shared_patterns.go` is cleaner one notch up or down) is a plan-time detail; it does not change the DAG. The plan resolves each as its package is extracted, guided by "does moving it keep imports one-way."

Test files move with the production file they exercise (the codec/registry/processor tests land in `block/` and `block/processors/`; service/session tests in `services/`/`domain/`). This is the concrete cure for the test-file sprawl.

## Implementation ordering (leaf-first; converge to green, no per-step shims)

Leaf-first is the order of least friction — extracting lower layers first means each later move lands against packages that already exist — but per the build discipline above, intermediate steps need **not** compile. Do the real moves; reconverge at the end. Commit at natural checkpoints (a clean, building checkpoint is preferable when one falls out for free, but is not required mid-cutover).

1. **Invert `BlockServices` → ports, in place** (still one package). Define the port interfaces; retype `BlockServices` fields; fix the `web_clip` `AI.state`→`State` leak. No files move yet. This removes the cycle blocker and *does* land green on its own — a sensible first commit.
2. **Extract `domain/`** — the leaf persistent types + `FilingRecommendation` (split from `eval.go`).
3. **Extract `block/`** — model + codec + scanner + registry + ports + shadow + parser + columnrow + context/anchor + frontend_block + shared_patterns, with their tests. Imports `domain/`.
4. **Extract `block/processors/`** — the 9 processors + `language_heuristics` + their tests. Imports `block/`, `domain/`.
5. **Extract `services/`** — Document/Asset/State/Jobs/LinkPreview/Library/Editor + tests.
6. **Extract `ai/`** — AIService + cli + prompts + image_localise + eval pipeline + tests; implements `AIPort`.
7. Root (`sieve/`) is what remains: `service_provider` (composition) + http glue + theme. Wire every concrete service to its port and register every processor.

**End-state gate:** full `go build ./...`, `go vet ./...`, `go test ./...` green; the import DAG acyclic and matching the diagram; race-clean on editor/block paths. No Co-Authored-By trailer on commits. If a move can only be made green by adding a back-import (e.g. `block/` importing `services/`), the boundary is wrong — re-cut it; never paper over with a shim.

## Verification (end-state)

- End state: `go build ./...`, `go vet ./...`, `go test ./...` green (pre-existing `-skip TestHandleBlockUpdate_notifySendsSnapshotUnderLock` flake allowed). Intermediate steps may be red — that is expected and allowed.
- The import DAG is acyclic and matches the diagram. The Go compiler/`go vet` is the enforcement — any cycle is a hard build failure, so a clean final build *is* the proof.
- Race-clean on the editor/block paths as today.
- No behaviour change is expected anywhere; the test suite is the safety net. If a test needs editing beyond an import-path / package-qualifier change (or relocating with its production file), that is a red flag the move stopped being mechanical — investigate before proceeding.

## Risks & mitigations

- **Hidden back-import surfaces late.** Mitigated by leaf-first ordering; Go's own cycle detection is the hard gate at the end-state build. A surfaced back-import means the boundary is wrong — re-cut it (the design's DAG is the target), never shim around it.
- **Unexported helpers used across would-be boundaries** (e.g. `mdParser`, `newSieveBlock`, `serializeFencedBlock`) must become exported or stay together. The plan exports the minimum necessary and keeps tightly-coupled helpers in the same package rather than over-splitting.
- **Test helpers shared across packages** (e.g. `RegisterProcessor(&CodeBlockProcessor{})` in tests now spanning `block/` and `block/processors/`). Resolve by exporting the registration API (already exported) and importing the concrete processor in the test, or a small `blocktest` helper if needed — decided at plan time.
- **Scope creep into behaviour.** Held off by the explicit out-of-scope list; the only non-mechanical change is the forced `AI.state` fix.
```
