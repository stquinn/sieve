# S-A Flat-Package Decomposition (Go) — Implementation Plan

> **STATUS: DONE** — shipped; Go 6-package DAG (2026-06-28) + `frontend/src/static/` regrouped into 6 subfolders (2026-06-29); TECH-DEBT S-A retired (see TECH-DEBT.md). Archived 2026-07-07.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Break the flat `sieve/` Go package (45 prod + 37 test files, one namespace) into a cohesive, acyclic package DAG — `domain/ ← block/ ← {block/processors/, services/} ← root`, with `ai/ → {block/, services/, domain/}` — by inverting `BlockServices` to port interfaces and moving files leaf-first.

**Architecture:** Dependency inversion breaks the `service ↔ processor` cycle: `block/` owns narrow port *interfaces* (`AIPort`, `DocumentsPort`, `AssetsPort`, `StatePort`, `LinkPreviewPort`); `BlockServices` becomes a struct of ports; concrete services implement them; the composition root wires them. Then files move leaf-first into new packages. **This is a behaviour-preserving, compiler-guided refactor** — the existing test suite is the regression net; no new behaviour tests are written.

**Tech Stack:** Go (module `sieve`; package dir `sieve/` imports as `sieve/sieve`). New packages: `sieve/sieve/domain`, `sieve/sieve/block`, `sieve/sieve/block/processors`, `sieve/sieve/services`, `sieve/sieve/ai`.

**Spec:** [`docs/design/archive/specs/2026-06-20-flat-package-decomposition-design.md`](../specs/2026-06-20-flat-package-decomposition-design.md) — read it first (DAG, port surface, full file-assignment table).

## Global Constraints

- **No behaviour change.** The only non-mechanical edit in the whole plan is the forced `web_clip_processor.go` `p.svc.AI.state.LoadSettings()` → `p.svc.State.LoadSettings()` fix (Task 1). Everything else is move + re-qualify + export.
- **No transient workarounds / back-compat shims / temporary adapters.** Per user direction, the tree need NOT build at every intermediate step — break it freely and reconverge. If a move only goes green by adding a back-import (e.g. `block/` importing `services/`), the boundary is wrong — re-cut it, never shim. (In practice each task below *can* land green by fully updating references; aim for that, but it is not a hard per-task gate.)
- **End-state gate:** `go build ./...`, `go vet ./...`, and `go test ./...` all green (the pre-existing `-skip TestHandleBlockUpdate_notifySendsSnapshotUnderLock` TempDir flake is allowed); import DAG acyclic (the compiler enforces this — any cycle is a hard build failure); race-clean on editor/block paths.
- **No Co-Authored-By trailer** on any commit (memory `feedback_no_coauthor`).
- **Tests move WITH their production file.** A codec test lands in `block/`, a processor test in `block/processors/`, a service test in `services/`, etc. This is the cure for the 37-test-file sprawl.
- **Verify subagent work yourself** (memory): after each task, confirm ground truth with your own `git log` / `go build` / `go test` — do not trust a subagent's narration. Do NOT use the "Principal Developer"/"Principal Java Developer" agents (they describe tool calls without executing them).

---

## The refactor mechanic (read once; applies to every move task)

Moving a file into a new package in Go is the same loop every time:

1. **Create the package dir** and move the files in. Change each moved file's `package sieve` clause to `package <newpkg>`.
2. **Add the import** of the new package wherever the symbols are now used, and **re-qualify** references: a symbol `X` that moved to `domain` becomes `domain.X` in every other package; within `domain` it stays bare `X`.
3. **Export what crosses the boundary.** Any *unexported* symbol that a moved file needs from a package it now sits outside (or that an outside package now needs from the moved file) must be capitalized. This is a pure rename — capitalize the identifier and update every reference in the module. **The compiler tells you the exact set:** `undefined: x` / `cannot refer to unexported name pkg.x`. Seed sets are listed per task; treat any additional compiler-flagged symbol the same way.
4. **`go build ./...`** — fix every reported reference until it compiles.
5. **`go test ./...`** — the existing suite must pass unchanged. **If a test needs more than an import-path / package-qualifier edit (or relocating with its file), STOP** — the move stopped being mechanical; investigate before continuing.
6. **Commit.**

Test files that move: update their `package` clause too. A test that exercises unexported internals must move into the same package as the code it tests (white-box) — that co-location is the goal, not a problem.

External consumers outside `sieve/` (≈21 files: `app.go`, `app_types.go`, `config.go`, `main.go`, `handlers.go`, `requesthandlers/*.go`, plus repo-root `config_test.go`) reference `sieve.X` for many symbols that are moving (`sieve.Tab`, `sieve.SieveBlock`, `sieve.Settings`, `sieve.DocumentService`, `sieve.ImageDesc`, …). Each move task must re-qualify these too — the compiler lists them.

---

## Task 1: Invert `BlockServices` to port interfaces (in place)

No files move. Define the ports, retype `BlockServices`, fix the one forced leak. This removes the cycle blocker and lands fully green — a clean first commit.

**Files:**
- Modify: `sieve/processor_registry.go` (BlockServices + new port interfaces)
- Modify: `sieve/web_clip_processor.go:153` (the `AI.state` leak)
- Modify: `sieve/service_provider.go` (BlockServices construction — already passes the concrete pointers, which now satisfy the interfaces; verify)
- Create: `sieve/ports.go` (the five port interfaces + compile-time satisfaction assertions)

**Interfaces produced** (consumed by Tasks 3–6):
- `AIPort`, `DocumentsPort`, `AssetsPort`, `StatePort`, `LinkPreviewPort` — interfaces in package `sieve` (they migrate to `block/` in Task 3).
- `BlockServices` — struct whose fields are those interface types (was concrete pointers).

- [ ] **Step 1: Write the port interfaces using the VERIFIED existing signatures.** Create `sieve/ports.go`:

```go
package sieve

// Port interfaces are the contract processors depend on. Concrete services
// implement them; the composition root wires them into BlockServices. This is
// the dependency inversion that lets block/ own the contract without importing
// any service. Signatures below match the existing concrete methods exactly.

type DocumentsPort interface {
	LoadByUUID(uuid string) (Document, error)
	Save(d Document) (Document, error)
}

type AssetsPort interface {
	Save(category store.Category, parentContext, assetID string, data []byte) (*ImageAsset, error)
}

type StatePort interface {
	LoadSettings() Settings
}

type LinkPreviewPort interface {
	FetchTitle(targetURL string) string
	FetchFull(targetURL string) LinkPreviewResult
}

type AIPort interface {
	RunExplain(content, history, questionCtx, uuid string) error
	RunAsk(content, history, questionCtx, uuid string) error
	RefineLanguage(source, lang, method string) (string, error)
	DescribeImage(uuid, src, blockID string) error
	RunWebClip(uuid, blockID, source, mode, content string) error
}

// Compile-time proof the concrete services satisfy the ports.
var (
	_ DocumentsPort   = (*DocumentService)(nil)
	_ AssetsPort      = (*AssetService)(nil)
	_ StatePort       = (*StateService)(nil)
	_ LinkPreviewPort = (*LinkPreviewService)(nil)
	_ AIPort          = (*AIService)(nil)
)
```

Add `"sieve/sieve/store"` (or the existing store import path used in `processor_registry.go`) to the imports if not already present.

- [ ] **Step 2: Build — let the compiler verify the concrete services satisfy the ports.**

Run: `go build ./sieve/`
Expected: if a port signature is wrong, the `var _ Port = (*Concrete)(nil)` line fails with a precise mismatch. Fix the interface to match the concrete method (the AI signatures are the only unverified ones — adjust to the real `ai_service.go` methods). Repeat until it builds.

- [ ] **Step 3: Retype `BlockServices` fields to the interfaces.** In `sieve/processor_registry.go`, change:

```go
type BlockServices struct {
	AI          AIPort
	Documents   DocumentsPort
	Assets      AssetsPort
	Jobs        *JobTracker
	LinkPreview LinkPreviewPort
	State       StatePort
}
```

(`Jobs` stays a concrete `*JobTracker` — no processor calls it; it is not a port.)

- [ ] **Step 4: Fix the forced `AI.state` leak.** In `sieve/web_clip_processor.go:153`, change `p.svc.AI.state.LoadSettings().Model` to `p.svc.State.LoadSettings().Model`. (`AI` is now an interface; the private `state` field is invisible. WebClip already has the `State` port.)

- [ ] **Step 5: Build the whole module + run the full suite.**

Run: `go build ./... && go vet ./... && go test ./... -skip TestHandleBlockUpdate_notifySendsSnapshotUnderLock`
Expected: all green. `service_provider.go` already constructs `BlockServices` with the concrete pointers, which now satisfy the interfaces — no change needed there (confirm).

- [ ] **Step 6: Commit.**

```bash
git add sieve/ports.go sieve/processor_registry.go sieve/web_clip_processor.go
git commit -m "S-A: invert BlockServices to port interfaces; fix web-clip AI.state leak"
```

---

## Task 2: Extract `domain/` (leaf persistent types)

Move the leaf types nothing depends inward on. Includes two type/logic splits.

**Files:**
- Create: `sieve/domain/` and move into it (set `package domain`):
  `document.go`, `buffer.go`, `note.go`, `document_meta.go`, `image_asset.go`, `categories.go`, `session.go`, `settings.go`
- Split `sieve/eval.go`: move the **data types** `FilingRecommendation` AND `ImageDesc` → `sieve/domain/filing.go` (`package domain`). Both are port return types referenced by `block/`'s ports (`AIPort.DescribeImage` returns `ImageDesc`; `DocumentService.UpdateAiMetadata` takes `*FilingRecommendation`), so they MUST sit in the leaf. Leave the helpers `detectContentType`, `extractJSONFallback` in `sieve/eval.go` for now (they go to `ai/` in Task 6).
- Split `sieve/link_preview_service.go`: move the `LinkPreviewResult` type → `sieve/domain/link_preview.go` (`package domain`); leave `LinkPreviewService` (the logic) in place for now (goes to `services/` in Task 5).
- Move the matching tests: `buffer_test.go`, `categories_test.go` (the one in `sieve/`), `session_test.go`, and any `document_*`/`settings` tests → `sieve/domain/` (set `package domain`).

**Interfaces produced:** `domain.Document`, `domain.Buffer`, `domain.Note`, `domain.DocumentMeta`, `domain.ImageAsset`, `domain.Settings`, `domain.Session`, `domain.Tab`, `domain.Window`, `domain.Category`/`domain.LibraryCategory`/`domain.WorkingCopy`/`domain.State`, `domain.KindNote`/`domain.KindBuffer`, `domain.CustomLogParser`, `domain.FilingRecommendation`, `domain.LinkPreviewResult`. (Whatever is currently exported keeps its name, now `domain`-qualified.)

- [ ] **Step 1: Create `sieve/domain/`, move the files, set `package domain`.** Move the 8 whole files + the two split-out type files listed above.

- [ ] **Step 2: Export any unexported symbol these types need from each other or that the rest of the module needs.** Most are already exported. The ports in `sieve/ports.go` (Task 1) reference `Document`/`Settings`/`ImageAsset`/`LinkPreviewResult` — those are now `domain.*`, so `ports.go` (still `package sieve`) imports `sieve/sieve/domain` and qualifies them. (`ports.go` moves to `block/` in Task 3; for now it lives in `sieve` and references `domain.*`.)

- [ ] **Step 3: Re-qualify module-wide via the compiler.**

Run: `go build ./...`
Loop: for every `undefined: Document` / `undefined: Settings` / etc., add `import "sieve/sieve/domain"` and prefix with `domain.`. This spans the `sieve` package itself AND the external consumers (`app.go`, `requesthandlers/*.go`, repo-root `config.go`/`config_test.go`, etc.). Repeat until it builds.

- [ ] **Step 4: Run the full suite.**

Run: `go vet ./... && go test ./... -skip TestHandleBlockUpdate_notifySendsSnapshotUnderLock`
Expected: green. Any test needing more than a package-qualifier/import edit → STOP and investigate.

- [ ] **Step 5: Commit.**

```bash
git add -A
git commit -m "S-A: extract domain/ (persistent leaf types; split FilingRecommendation + LinkPreviewResult)"
```

---

## Task 3: Extract `block/` (model + codec + scanner + registry + ports)

The big move. `block/` imports `domain/`, `store/`, `fencedblock/` — and nothing else internal. Processors/services/ai are still in root and reference `block/`'s already-exported API; the only *new* export the move forces is the block constructor `NewSieveBlock` (see Step 2 — the audit showed the other suspected symbols are intra-`block/` or processor-local).

**Files (move into `sieve/block/`, set `package block`):**
`sieve_block.go`, `document_codec.go`, `region_scanner.go`, `shadow_document.go`, `processor_registry.go`, `ports.go` (from Task 1), `handle_gc.go`, `markdown_parser.go`, `columnrow_serializer.go`, `context_provider.go`, `block_anchor.go`, `frontend_block.go`, `shared_patterns.go`, plus `block_document.go` if still present (the `DocBlock`/`BlockDoc`/`ParseBlockDoc`/`SerializeBlockDoc` spine).

**Tests (move with them, set `package block`):**
`processor_registry_test.go`, `document_codec_test.go`, `region_scanner_test.go`, `block_document_test.go`, `block_*_test.go` (accessors/identity/op/tree), `derive_markdown_test.go`, `fixture_roundtrip_test.go`, `handle_anchor_test.go`, `handle_gc_test.go`, `shadow_getblock_test.go`, `columnrow_serializer_test.go`, `markdown_parser_test.go`, `markdown_parser_promote_test.go`, `frontend_block_test.go`, `context_provider_test.go`.

> Note: `processor_serialize_test.go` / `processor_deserialize_test.go` / the per-processor `*_processor_test.go` exercise the concrete processors — they move with the processors in Task 4, NOT here. If they reference unexported `block/` helpers, those helpers get exported in this task (Step 2).

**Interfaces produced:** `block.SieveBlock`, `block.DocumentCodec`, `block.ProcessorRegistry`, `block.BlockProcessor`, `block.BlockServices`, `block.AIPort`/`block.DocumentsPort`/`block.AssetsPort`/`block.StatePort`/`block.LinkPreviewPort`, `block.RegisterProcessor`/`block.GetProcessor`/`block.UnregisterProcessor`, `block.Region`/`block.RegionScanner`, `block.ShadowDocument`, `block.JobContext`, `block.BlockMode`/`block.BlockModeBlock`/…, `block.ContentEntry`, `block.FrontendBlock`, `block.DetectExtractions`, `block.GenerateBlockID`/`block.GenerateBlockIDFor`, `block.FencedSerializer`/`block.FencedDeserializer`/`block.InlineSerializer`/`block.InlineDeserializer`, `block.BlockLifecycleListener`, plus the newly-exported helpers from Step 2.

- [ ] **Step 1: Create `sieve/block/`, move the production + test files, set `package block`.**

- [ ] **Step 2: Export ONLY the legitimate cross-boundary symbols — scrutinize, don't reflexively capitalize.** Block creation legitimately happens in exactly three places: `EditorService`/`ShadowDocument`, processor `Deserialize` (the deserialization-is-a-processor-concern design — each processor mints blocks of its own kind on read-back), and tests. The audit (below) shows the real processor→block surface is a **single** symbol:
  - `newSieveBlock` → `NewSieveBlock` — the canonical block constructor, called by `ProseProcessor.Deserialize` (`prose_processor.go:125,137`). This is the intended Deserialize contract; export it.

  The other previously-suspected symbols do **NOT** cross into `block/processors/` and must **NOT** be exported:
  - `mdParser`, `sieveBlockNode` — used only by `block_anchor.go` (a ContextProvider, **in `block/`**) → intra-package, no export.
  - `deriveMarkdown` — used only by `block_anchor.go` + `context_provider.go` (**both in `block/`**) → intra-package, no export.
  - `scanProseRegion` — a private helper **defined inside `prose_processor.go`** → moves with the file, no export.

  Then `go build ./...`. If the compiler flags any *further* symbol with `cannot refer to unexported name block.x`, **treat it as a design question first** (per the "who creates/touches blocks?" test): is this caller legitimately doing this, or is the responsibility misplaced? Export only if the call is legitimate (Deserialize, or a genuine read accessor); otherwise the boundary or the caller is wrong — fix that, don't widen `block/`'s surface to accommodate a smell.

- [ ] **Step 3: Re-qualify module-wide.**

Run: `go build ./...`
Loop: add `import "sieve/sieve/block"` and prefix moved symbols with `block.` everywhere (root `sieve` package files for processors/services/ai/composition, AND external consumers using `sieve.SieveBlock`/`sieve.FrontendBlock`/`sieve.ContentEntry`/`sieve.DetectExtractions`/`sieve.BlockLifecycleListener`/`sieve.ExtractionCandidate`). Repeat until built.

- [ ] **Step 4: Confirm `block/` imports nothing internal except `domain/`.**

Run: `go list -deps sieve/sieve/block | grep '^sieve/sieve/' || true`
Expected: only `sieve/sieve/domain`, `sieve/sieve/store`, `sieve/sieve/fencedblock` (and their own deps). If `sieve/sieve/services` or `.../ai` or `.../block/processors` appears, a back-import sneaked in — find and remove it (the boundary is wrong; do not shim).

- [ ] **Step 5: Run the full suite.**

Run: `go vet ./... && go test ./... -skip TestHandleBlockUpdate_notifySendsSnapshotUnderLock`
Expected: green.

- [ ] **Step 6: Commit.**

```bash
git add -A
git commit -m "S-A: extract block/ (model, codec, scanner, registry, ports) leaf-first"
```

---

## Task 4: Extract `block/processors/` (the 9 concrete processors)

Now that `block/` exports everything they need, the processors move cleanly. They import `block/` (ports, registry, model) and `domain/` (Document/Settings type checks).

**Files (move into `sieve/block/processors/`, set `package processors`):**
`ai_block_processor.go`, `code_processor.go`, `diagram_processor.go`, `log_processor.go`, `prose_processor.go`, `smart_image_processor.go`, `smart_link_processor.go`, `smart_card_processor.go`, `web_clip_processor.go`, `language_heuristics.go`.

**Tests (move with them, set `package processors`):**
`ai_block_processor_test.go`, `code_processor_test.go`, `diagram_processor_test.go`, `log_processor_test.go`, `prose_processor_test.go`, `smart_image_processor_test.go`, `smart_link_processor_test.go`, `smart_card_processor_test.go`, `processor_serialize_test.go`, `processor_deserialize_test.go`, `language_heuristics_test.go` (if present).

**Interfaces produced:** `processors.AIBlockProcessor`, `processors.CodeBlockProcessor`, `processors.DiagramProcessor`, `processors.LogProcessor`, `processors.ProseProcessor`, `processors.SmartImageProcessor`, `processors.SmartLinkProcessor`, `processors.SmartCardProcessor`, `processors.WebClipBlockProcessor` (and their `NewXxxProcessor(block.BlockServices)` constructors). These are consumed only by the composition root (`service_provider.go`).

- [ ] **Step 1: Create `sieve/block/processors/`, move the files, set `package processors`.** Each processor's references to `block`-owned symbols become `block.X`; `domain` types become `domain.X`. Their `p.svc` field is `block.BlockServices`.

- [ ] **Step 2: Re-qualify + update the composition root.**

Run: `go build ./...`
Loop: in `service_provider.go` (root) the `RegisterProcessor("code", &CodeBlockProcessor{...})` calls become `block.RegisterProcessor("code", &processors.CodeBlockProcessor{...})` (or via their constructors). Import `sieve/sieve/block/processors`. Any test in `block/` that constructed a concrete processor (e.g. `&CodeBlockProcessor{}` for the parse gate) now needs `processors.CodeBlockProcessor` — but that would make `block/` test import `processors`, which imports `block/`: a **test-only** import cycle. Resolve by either (a) keeping a minimal fake `BlockProcessor` in the `block/` test instead of the real `CodeBlockProcessor`, or (b) moving that specific test to `block/processors/`. Prefer (a) for pure registry/codec tests (they only need *a* block-mode processor for the gate). Decide per test; do not add a production back-import.

- [ ] **Step 3: Confirm no production back-import.**

Run: `go list -deps sieve/sieve/block | grep 'block/processors' || echo OK`
Expected: `OK` (block/ must NOT import processors/ in production code).

- [ ] **Step 4: Full suite.**

Run: `go vet ./... && go test ./... -skip TestHandleBlockUpdate_notifySendsSnapshotUnderLock`
Expected: green.

- [ ] **Step 5: Commit.**

```bash
git add -A
git commit -m "S-A: extract block/processors/ (9 concrete processors + tests)"
```

---

## Task 5: Extract `services/` (Document, Asset, State, Jobs, LinkPreview, Library, Editor)

**Files (move into `sieve/services/`, set `package services`):**
`document_service.go`, `asset_service.go`, `state_service.go`, `job_tracker.go`, `link_preview_service.go` (the `LinkPreviewService` logic — `LinkPreviewResult` already moved to `domain/` in Task 2), `library_service.go`, `editor_service.go`.

**Tests (move with them, set `package services`):**
`document_service_test.go`, `editor_service_test.go`, `editor_service_promote_test.go`, `link_preview_service_test.go`, and any `state`/`job`/`library` service tests.

**Interfaces produced:** `services.DocumentService`, `services.AssetService`, `services.StateService`, `services.JobTracker`, `services.LinkPreviewService`, `services.LibraryService` (+ `services.NewLibraryService`/`services.LibraryRecorder`/`services.LibraryDisplayName`), `services.EditorService`. These implement the `block/` ports and are consumed by the root + `ai/`.

- [ ] **Step 1: Create `sieve/services/`, move the files, set `package services`.** `EditorService` references `block.DocumentCodec`/`block.ShadowDocument`/`block.BlockServices`/`block.GetProcessor` → `block.*`; `DocumentService.UpdateAiMetadata` references `*domain.FilingRecommendation` → `domain.*`.

- [ ] **Step 2: Export anything cross-boundary + re-qualify.**

Run: `go build ./...`
Loop: external consumers using `sieve.DocumentService`/`sieve.StateService`/`sieve.LibraryService`/`sieve.JobTracker`/`sieve.NewJobTracker`/`sieve.NewLibraryService` → `services.*` (import `sieve/sieve/services`). The composition root wires these concrete services into `block.BlockServices` ports. Repeat until built.

- [ ] **Step 3: Confirm `services/` does NOT import `ai/` and `block/` does NOT import `services/`.**

Run: `go list -deps sieve/sieve/services | grep -E 'sieve/sieve/ai' || echo OK-no-ai`
Run: `go list -deps sieve/sieve/block | grep -E 'sieve/sieve/services' || echo OK-no-services`
Expected: both `OK-…` (EditorService reaches AI only through the `block.AIPort` interface).

- [ ] **Step 4: Full suite.**

Run: `go vet ./... && go test ./... -skip TestHandleBlockUpdate_notifySendsSnapshotUnderLock`
Expected: green.

- [ ] **Step 5: Commit.**

```bash
git add -A
git commit -m "S-A: extract services/ (document, asset, state, jobs, link-preview, library, editor)"
```

---

## Task 6: Extract `ai/` (AIService + cli + prompts + eval pipeline + image-localise)

**Files (move into `sieve/ai/`, set `package ai`):**
`ai_service.go`, `cli.go`, `prompts.go`, `image_localise.go`, and the remainder of `eval.go` (`detectContentType`, `extractJSONFallback` helpers — the `FilingRecommendation` and `ImageDesc` types already left for `domain/` in Task 2). Rename the eval remainder file to `sieve/ai/eval.go`.

**Tests (move with them, set `package ai`):**
`prompts_test.go`, `image_localise_test.go`, any `ai_service`/`cli`/`eval` tests. (`ai_block_processor_test.go` is a *processor* test — it stays in `block/processors/` from Task 4.)

**Interfaces produced:** `ai.AIService` (+ `ai.NewAIService`), `ai.PromptService` (+ `ai.PromptEntry`), `ai.RunCLI`, `ai.ImageDesc`. `ai.AIService` implements `block.AIPort`; `ai.PromptService` is consumed by `NewAIService` + the composition root.

- [ ] **Step 1: Create `sieve/ai/`, move the files, set `package ai`.** `AIService` references `*services.DocumentService`, `*services.StateService`, `ai.PromptService` → so `ai/` imports `services/`, `domain/`, `block/` (to satisfy `block.AIPort`). `NewAIService(state *services.StateService, prompts *PromptService, documents *services.DocumentService, …)`.

- [ ] **Step 2: Export + re-qualify.**

Run: `go build ./...`
Loop: external consumers using `sieve.ImageDesc`/`sieve.PromptService`/`sieve.PromptEntry` → `ai.*`. The composition root constructs `ai.NewAIService(...)` and wires it as the `block.AIPort` in `BlockServices`. Repeat until built.

- [ ] **Step 3: Confirm `services/` still does NOT import `ai/` (one-directional).**

Run: `go list -deps sieve/sieve/services | grep 'sieve/sieve/ai' || echo OK-no-ai`
Expected: `OK-no-ai`.

- [ ] **Step 4: Full suite.**

Run: `go vet ./... && go test ./... -skip TestHandleBlockUpdate_notifySendsSnapshotUnderLock`
Expected: green.

- [ ] **Step 5: Commit.**

```bash
git add -A
git commit -m "S-A: extract ai/ (AIService, cli, prompts, eval pipeline, image-localise)"
```

---

## Task 7: Settle the root + final verification

What remains in `sieve/` (`package sieve`) should be just the composition root + utilities: `service_provider.go` (wires concrete services → ports, registers processors), `theme.go`, `eval.go` is gone, `shared_patterns.go` is gone (moved). Confirm the root is coherent and the whole module is green + acyclic.

**Files:**
- Modify: `sieve/service_provider.go` — confirm it imports `block/`, `block/processors/`, `services/`, `ai/`, `domain/` and is the single wiring point.
- Verify: nothing left in `sieve/` (root package) that belongs in a sub-package.

- [ ] **Step 1: Inventory the root package — confirm only composition + utils remain.**

Run: `ls sieve/*.go | grep -v _test.go`
Expected: a short list — `service_provider.go`, `theme.go`, and any genuinely cross-cutting glue. If a domain/block/service/ai file is still here, it was missed — move it (repeat the mechanic) before proceeding.

- [ ] **Step 2: Full end-state gate.**

Run: `go build ./... && go vet ./... && go test ./... -skip TestHandleBlockUpdate_notifySendsSnapshotUnderLock`
Expected: all green.

- [ ] **Step 3: Prove the DAG is acyclic and matches the design.**

Run:
```bash
for p in domain block block/processors services ai; do
  echo "== sieve/sieve/$p deps (internal) =="
  go list -deps sieve/sieve/$p | grep '^sieve/sieve/' | grep -v "sieve/sieve/$p\$"
done
```
Expected, per the spec DAG: `domain` → (none internal); `block` → `domain`; `block/processors` → `block`, `domain`; `services` → `block`, `domain`; `ai` → `block`, `services`, `domain`. No `services`→`ai`, no `block`→`services`/`ai`/`processors`. The build succeeding already guarantees acyclicity; this step documents the shape.

- [ ] **Step 4: Race check on the editor/block paths.**

Run: `go test -race ./sieve/... -skip TestHandleBlockUpdate_notifySendsSnapshotUnderLock`
Expected: race-clean (matches the pre-refactor baseline).

- [ ] **Step 5: Commit any final root tidy.**

```bash
git add -A
git commit -m "S-A: settle root package (composition + utils); decomposition complete"
```

---

## Task 8: Update CLAUDE.md + docs to the new layout

The decomposition changes the project's mental map — the "Key File Locations" table and the architecture paragraph must reflect the package boundaries (per user request).

**Files:**
- Modify: `CLAUDE.md` (Key File Locations table; Architecture-in-one-paragraph)
- Modify: `docs/TECH-DEBT.md` (mark S-A's Go half done; the JS `static/` half remains)
- Modify: `docs/design/archive/plans/2026-06-17-block-document-model.md` (Progress/handoff log + NEXT: Go decomposition done; JS regroup + single-source-of-truth still open; Stage E next)

- [ ] **Step 1: Update the CLAUDE.md "Key File Locations" table** to point at the new packages, e.g.:
  - All services (DI container) → `sieve/service_provider.go` (composition root) wiring `sieve/services/`, `sieve/ai/`
  - Block model + codec + registry → `sieve/block/`
  - Block processors → `sieve/block/processors/`
  - Persistent domain types (Document/Session/Settings/Categories) → `sieve/domain/`
  - Update the one-paragraph architecture to describe `domain ← block ← {processors, services} ← root`, `ai → {block, services, domain}`, and the port-interface seam.

- [ ] **Step 2: Update `docs/TECH-DEBT.md` S-A** — Go decomposition retired; note the JS `static/` regroup + single-source-of-truth (retire `mdModeBuffer`) remain as the open follow-ups.

- [ ] **Step 3: Update the block-model plan handoff log + NEXT** — record the Go package split as done; next is the JS mirror, then Stage E.

- [ ] **Step 4: Commit.**

```bash
git add CLAUDE.md docs/TECH-DEBT.md docs/design/archive/plans/2026-06-17-block-document-model.md
git commit -m "Docs: reflect S-A Go package decomposition (domain/block/processors/services/ai)"
```

---

## Self-review

- **Spec coverage:** cycle-break via ports → Task 1 ✓; `domain/` leaf incl. FilingRecommendation + LinkPreviewResult splits → Task 2 ✓; `block/` (model+codec+scanner+registry+ports+shared_patterns) → Task 3 ✓; `block/processors/` + language_heuristics → Task 4 ✓; `services/` → Task 5 ✓; `ai/` incl. cli/prompts/eval-pipeline/image_localise → Task 6 ✓; root composition + utils → Task 7 ✓; CLAUDE.md/docs (user-requested) → Task 8 ✓. Out-of-scope items (JS regroup, mdModeBuffer/SSoT, AI-backend interface, Stage E/F) are explicitly NOT tasked. ✓
- **Placeholder scan:** the per-task export sets are seeded with the verified cross-boundary symbols and the rest is a *precisely described* compiler-driven loop (`undefined:` / `cannot refer to unexported name` → capitalize + update refs) — appropriate for a mechanical refactor, not a hidden placeholder. No "TBD"/"handle edge cases"/"similar to Task N". ✓
- **Type consistency:** port names (`AIPort`/`DocumentsPort`/`AssetsPort`/`StatePort`/`LinkPreviewPort`) and verified signatures are identical across Task 1 (definition) and Tasks 3/5/6 (consumption); package names (`domain`/`block`/`processors`/`services`/`ai`) and import paths (`sieve/sieve/<pkg>`) are consistent throughout. `Jobs` is consistently a concrete `*JobTracker`, never a port. ✓
- **Known risk carried:** the `block/` test-gate using a real `CodeBlockProcessor` would create a test-only `block → processors` cycle after Task 4 — Task 4 Step 2 calls this out and resolves it (fake processor or relocate the test), not papered over.
