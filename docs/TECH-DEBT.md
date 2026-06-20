# Tech Debt Register

Current-era items. React-migration debt was retired with Phase 9 (React removal complete).
Phase 10 retiring: X-B (`window.sieve*` globals — remaining are Wails-bound or structural seams), P-B (PENDING stale detection — moved to `fenced-block-base.js` `isJobActive`), P-C (`serializeWebClipYaml` indent — fixed to 4-space), X-A (`<style>` re-injection — moved to `settings.css`).
Each entry records what the debt is, why it was deferred, and what retires it.

---

## P-A: OS file drag-and-drop not implemented

**What:** Dragging files from the OS file manager onto the Sieve window does nothing. Wails `DragAndDrop` config and an `OnFileDrop` Go handler are needed.

**Why deferred:** Separate feature; no blocking dependency.

**Retires when:** Implemented as a follow-on feature.

## B-A: Prose block ids are frontend-minted, not backend-authoritative

**What:** New prose blocks get their durable `blockId` minted on the **frontend** (`prose-block.js` `mintProseId` in the `blockId` minting plugin, via `mintActions`), then sent on `create-block`. Every **structured** Sieve Block instead gets its id from the **backend** (`GenerateBlockIDFor`, e.g. `EditorService.CreateBlock`) — the backend is the sole id authority and the frontend only ever receives the id. Prose is therefore inconsistent with the rest of the block model: the frontend invents a durable identity that should originate in Go.

**Why deferred (2026-06-19, user decision):** The backend-authoritative path for *native* prose needs an async `create-block` → mint → ack round-trip plus a per-node "pending" state (so the debounced observer doesn't double-create a node whose id is in flight). That state machine lands in the highest-churn area of the editor (two prior reverts). Mid-arc on a long, high-risk migration, the pragmatic call was to keep the frontend-mint model (which is synchronous and already working) and record the inconsistency here. `ApplyOp` create-block already mints server-side when the id is absent, so the backend is a correct floor regardless.

**Retires when:** D-r.4's frontend mint is replaced by a backend-authoritative flow: `create-block` carries content + index + a transient correlation **token** (not a durable id) and marks the node pending; `HandleBlockOp` mints the id and the WS layer acks `{token → blockId}` back via `writeMsg`; the frontend applies the backend's id (a backend-sourced attribute update) and clears pending; the observer skips pending nodes. The `splitBlock` duplicate is then handled by **clearing** the copied id (reuse `mintActions` detection) so the new half becomes id-less → `create-block`, rather than re-minting locally.

## B-B: AI ref chain resolves to `doc`; answer blocks split the target (native-prose targeting) — ✅ RETIRED 2026-06-19 (D-r.7)

**RETIRED:** Fixed by D-r.7 (commits "D-r.7 (1/3)…(3/3)" on `feature/refactor_editor_layout`), implementing the approved spec via TDD. (1) prose identity unified `blockId` → `id` (PM-attr layer only; disk markers carry the value, round-trip untouched). (2) `resolveAiTarget` keys on node *character* — `isFlowingText`(paragraph/heading) → `doc`; every other top-level node (unit) or NodeSelection → that block by id; non-empty TextSelection → `==` + ref chain of every crossed top-level block (`topLevelIdsBetween`). (3) one `blockInsertPos(state,isInline)` (inline → caret, NodeSelection → after node, else `$to.after(1)`) replaces the scattered `sieveInsertPos = selection.to` and the old `aiInsertPos`; all six additive create sites route through `captureInsertPos`/`kindIsInline`. `applyTargetHighlight` dropped the `blockRef` wrap (just applies `==`). vitest: `prose-identity` (4), `ai-target` (20), `block-insert-pos` (6) all green; in-app CDP gate confirmed answers land after the block (no split) and a selection refs its block id (not `doc`). The `blockRef` node-type retirement remains Stage E. **B-A (frontend-minted prose ids) is still open.**

<details><summary>Original defect (historical)</summary>

**What:** The AI targeting/insert layer (`ai-target.js` `resolveAiTarget`/`findBlockTarget`/`aiInsertPos`, `extensions.js` `buildAiContext`/`applyTargetHighlight`) predates the node-granular prose pivot. It recognizes a block only when the node is `blockRef` or `sieve-*` and reads `attrs.id`. Native prose is now a top-level node carrying `attrs.blockId`, so: (1) a **text selection** in prose refs `doc` instead of the block(s) it crosses (`resolveAiTarget`'s selection branch returns no id → `buildAiContext` falls to `'doc'`), and (2) `aiInsertPos` finds no `blockRef`/`sieve-*` ancestor → returns the caret → the Ask/Explain answer **splits** the target paragraph instead of landing as a sibling after it. (Originally recorded as the `project_ai_targeting_blockref_defect` memory.)

**Why deferred:** Block-level addressing needed prose ids, which only landed with D-r.4 minting; doing the rewire before that would have been built on sand.

**Retires when:** The **approved design** [`docs/superpowers/specs/2026-06-19-unified-block-targeting-design.md`](superpowers/specs/2026-06-19-unified-block-targeting-design.md) is implemented (folded into the block-document-model plan as task set **D-r.7**): unify the prose identity attr `blockId` → `id`; resolve targets by node *character* (NodeSelection/unit → that block by id, TextSelection → `==` + ref chain of every crossed block, bare caret in flowing text → `doc`); and route every additive block insert through one `blockInsertPos` (inline → caret, block → after the enclosing top-level node) so answers never split.

</details>

## B-C: ShadowDocument uniform-block refactor — ✅ RETIRED 2026-06-19

**What it was:** `ShadowDocument` carried a `Markdown string` and a `Blocks map[string]*SieveBlock` that **excluded prose** (`syncBlocksView`: `if b.Kind != KindProse`) and exposed blocks via raw map / `Attrs["..."]` access — contradicting the committed model ("everything is a block, addressed by id; kind matters only at render/serialise").

**Resolved by** the bite-sized plan [`docs/superpowers/plans/2026-06-19-shadowdoc-uniform-block-refactor.md`](superpowers/plans/2026-06-19-shadowdoc-uniform-block-refactor.md) (one commit per step, app runnable + green throughout — no big-bang):
1. ✅ `getBlock(id)` / `findBlockIn` is the sole accessor; the `Blocks map` + `syncBlocksView` are deleted (all readers on the tree).
2. ✅ The `Markdown` field is gone — whole-doc markdown is derived on demand (`deriveMarkdown`, mode-aware); markdown-mode keeps a scoped `mdModeBuffer`. Closed the D-r.5 `id=="doc"` drift bug.
3. ✅ Prose body lives in `Attrs["content"]` (typed `Content()` accessor) — prose is a `SieveBlock` like every kind; the bespoke `Content` field is gone. Typed accessors (`Source/Ref/Status/StringAttr`) replace brittle casts (spec #5).
4. ✅ `Children` removed (a block is a leaf; containers are Stage E). `BlockDoc` wrapper collapsed — `ShadowDocument.Blocks []SieveBlock` directly. `DocBlock` merged into `SieveBlock` (one in-memory block type).
5. ✅ Wire shape unified (B-E): prose body in `attrs.content`, `FrontendBlock.Content` dropped; JS reads via `proseContent()`.

**Spun off:**
- ✅ **B-F (DONE 2026-06-19)** — lock-free `DocView{UUID, Mode, mdModeBuffer, Blocks []SieveBlock}` snapshot for the job/context boundary. `JobContext.Doc` and `ContextProvider.BuildContext` / `BuildContextForID` take `DocView` (no mutex), built from the live `ShadowDocument` at dispatch. `go vet ./sieve/` is now copylocks-clean. (NOT "fixed" by passing `*ShadowDocument` — that would leak the live mutable cell into the concurrent `RunJob`; the copy is deliberate isolation.)
- ⬜ **B-G** (open, needs WebKit by-eye) — retire `serialisedForm` from the wire (old markdown-model hangover; client renders structured kinds from `attrs` alone) → then `FrontendBlock == SieveBlock + json tags`, delete it and serialise `[]SieveBlock` straight to the wire. Copy/paste round-trips on-demand (serialize the fence from attrs AT COPY TIME), not shipped every load.

## B-D: AI chain-active bracket doesn't render on native prose blocks

**What:** The persistent AI-chain affordance (`block-ref-active`, the curved left-rail bracket toggled by `ai-block-renderer.js` `applyChain` when you focus/hover an AI block) renders only on **structured** blocks — its CSS is gated on `.block-node` / `.image-block` / `.code-block-wrapper` / `.sieve-block--*`. A **native prose** block is `<p class="block-with-chrome" data-id>`, which none of those match, so the class is added (the comma ref chain IS split correctly) but paints nothing. Verified: `block-ref-active` on such a `<p>` → `border-left: 0 none`, `::after content: none`.

**Why deferred (2026-06-19):** Outside D-r.7's locked scope (identity/targeting/insert); folded into the ShadowDoc-refactor work as an adjacent "uniform block" visual fix.

**Retires when:** The persistent bracket is driven through the SAME `.block-chrome-rail` the ephemeral `block-ai-target` glow already uses (`ai-target-decoration.js` + `editor.css:2628`), so prose and structured share one visual language (per `project_block_anchor_lineage`). Verify by eye in WebKitGTK. Detail in the ShadowDoc-refactor spec ("folded-in follow-up").

## S-A: Flat-package decomposition — no internal boundaries (Go `sieve/` AND JS `static/`)

**Go half — DONE (2026-06-20).** `sieve/` is now 6 cohesive packages, acyclic, full suite + `-race` green: `domain ← block ← {block/processors, services} ← ai ← root`. Cycle broken via `block`-owned port interfaces (`AIPort`/`DocumentsPort`/`AssetsPort`/`StatePort`/`LinkPreviewPort`); `BlockServices` is now a struct of ports. Plan `docs/superpowers/plans/2026-06-20-flat-package-decomposition.md`, spec `…/specs/2026-06-20-flat-package-decomposition-design.md`. Along the way: ShadowDocument now owns its data+mutex (EditorService never touches `shadow.mu`); registry owns paste-matching (`FirstPasteMatch`); a latent `FrontendBlocks` data race fixed (`SnapshotBlocks` deep-copies Attrs). **Still OPEN:** (1) the **JS `static/` regroup** (mirror the Go packages — untouched); (2) **single-source-of-truth** fold-in (retire `mdModeBuffer` as authoritative; markdown mode reparses into Blocks via the codec — deferred, not done); (3) the **no-loose-functions backlog** (free funcs still in `block/` codec/parser + `ai/eval`, see CLAUDE.md Design Principles). The original problem statement below is retained for the remaining (JS) half.

**What:** Both the Go backend package and the JS frontend folder are flat dumping grounds with no internal boundaries, so it is hard to see wheat from chaff and coupling is uncontrolled.
- **Go `sieve/`** — one package, ~40 production + ~37 test files (~14k lines). Block model, codec, processors, editor service, AI service, library service, prompts, sessions all share one namespace; everything can call everything. Every audit finding this era (`block_serde.go`, `block_op.go`, `frontend_block.go`, `DocView`/`mdModeBuffer`, the test-file sprawl) is one symptom of this: no domain ownership → behaviour leaks into free functions and the directory listing is unreadable.
- **JS `frontend/src/static/`** — the same shape: `editor.js` + a flat pile of `*-renderer.js` / `*-block.js` / `block-*.js` / `ai-*.js` with no grouping.

**Why deferred (2026-06-19, user-flagged):** The deserialization-is-a-processor-concern + ShadowDocument-consolidation refactors had to land first — they carved the seams (`DocumentCodec`, the narrow `ProcessorRegistry`, block ops as `ShadowDocument` methods) a `block/` package needs. Decomposition is a deliberate, leaf-first effort, NOT a bolt-on; doing it mid-feature would churn. The concrete blocker to a clean Go split: `BlockServices` (`processor_registry.go`) holds **concrete** `*AIService`/`*DocumentService`/`*AssetService` pointers → a `service ↔ processor` import cycle. Until that's interfaces, Go rejects the split.

**Retires when:** Decompose leaf-first into a small number of cohesive packages (NOT Java-style package-per-concept; aim ~4–5). Go: make `BlockServices` an interface owned by the core, then extract `sieve/block/` (SieveBlock model + DocumentCodec + RegionScanner + processor registry + their tests) — the tests move WITH their code, which is what fixes the "37 test files in one dir" sprawl — then `sieve/processors/`, leaving `services/` + the composition root. JS: group the block/editor/AI modules into folders mirroring the Go packages. Related cleanup to fold in: single-source-of-truth (retire `mdModeBuffer` as authoritative; markdown mode reparses into `Blocks` via the codec). Memories: `project_package_layout_direction`, `project_single_source_of_truth_blocks`; aligns with `project_architecture_direction` (Go server + S3 + web/mobile).

## S-B: `DocumentCodec.Deserialize` prose fallback is confusing (user-flagged 2026-06-20)

**What:** The codec's prose handling (`block/document_codec.go` `Deserialize` + `firstAcceptor` + `flushProse`) reads as over-explicit and confused the user. `ProseProcessor.Accepts()` returns `true` unconditionally and prose IS registered, yet `firstAcceptor` deliberately SKIPS prose (`if p.Mode()==BlockModeProse { continue }`) and unclaimed regions accumulate in `pending` for an explicit `flushProse`. Two real reasons (not redundancy): (1) **coalescing** — consecutive unclaimed regions are concatenated into ONE prose run so a stray fence survives verbatim inside flowing prose and `scanProseRegion` segments correctly; per-region prose-as-last-acceptor would fragment at every fence boundary. (2) **order-independence** — prose `Accepts→true` would hijack regions ahead of structured processors if it were in the accept loop, so skipping it guarantees structured-first regardless of registration order.

**Why it's debt:** the mechanism is correct but reads as a smell; it's a clarity/naming problem, not a behaviour bug. **Retires when:** clarified — better names/comments, or restructure so the "prose is the terminal coalescing mop-up" intent is obvious without tracing. Candidate when applying the no-loose-functions principle (attach `scanProseRegion`/`flushProse` logic to `ProseProcessor`/`DocumentCodec` as named methods). Low priority.
