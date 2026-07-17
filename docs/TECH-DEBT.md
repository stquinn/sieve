# Tech Debt Register

Current-era items. React-migration debt was retired with Phase 9 (React removal complete).
Phase 10 retiring: X-B (`window.sieve*` globals — remaining are Wails-bound or structural seams), P-B (PENDING stale detection — moved to `fenced-block-base.js` `isJobActive`), P-C (`serializeWebClipYaml` indent — fixed to 4-space), X-A (`<style>` re-injection — moved to `settings.css`).
Each entry records what the debt is, why it was deferred, and what retires it.

---

## E-1: "Embed in document" (promote-to-prose) is broken — multi-node embeds fragment and lose their id — ✅ RESOLVED 2026-06-21

**RESOLVED** (user-verified in-app) — but NOT via the `kind:nested-prose` design below. The fix is simpler and content-derived: a multi-node prose block renders as ONE chrome-less, editable `content:'block+'` container node (`proseGroup`, `frontend/src/static/prose-group.js`), chosen by the **renderer's own parse count** in `renderBlocksIntoEditor` (`proseBlockNodes`: 1 top-level node → native, >1 → one container carrying the id). No new on-disk `kind`, no flag — the wire kind stays `prose`; the container is a pure frontend rendering of a multi-node prose block. Because it is one top-level node with the backend's id, the mint plugin never re-mints it. `proseGroup` is `isNativeProseNodeName` so it flows through every existing prose path (save/chain/identity) with zero bridge code; its markdown serialize is transparent (children only, Go owns the markers). **It does NOT depend on B-A** — backend-authoritative by construction (the id comes from the backend block and is never invented). Commits: `77ad7ae` (node + mapper), `cd6c66d` (wire-in + `softReloadContent` block-list render). Note: the *embed re-render* path (`block-promoted` → `softReloadContent`) was also fixed to render the block list, not a flat `setContent` re-parse. B-A (typed-prose frontend mint) remains separately open.

**What (historical):** Embedding a structured block (e.g. an `ai-block`) into the document via "Embed in document" / Promote-to-Prose is **broken for multi-node content**, which is the common case. `EditorService.PromoteBlock` correctly creates ONE prose block carrying the original id (e.g. `ai-d63e`) with the block's `MarkdownRepresentation` as content (Go is right; the test passes; `scanProseRegion` keeps the delimited block whole). But that representation is multi-node markdown (e.g. `### question\n\n<answer>` = heading + paragraph), and the **frontend** renders `kind:prose` as **native top-level nodes (D-r.7 node-granular)** — so the one backend block is parsed into N native nodes, the mint plugin gives each a fresh `pr-…` id, and the next sync persists N separate blocks. **The original id is destroyed and any AI ref chain pointing at it breaks.** Observed live: embedding `ai-d63e` produced `pr-12ed` + `pr-ca6d`, no `ai-d63e`. It also violates "the backend owns the data" — the frontend silently posts back a lossy mutation *on load*, with no user interaction (the mint plugin fires on the `setContent` transaction); roundtrips don't roundtrip.

**Related to B-A (frontend-minted prose ids).** Same root cause: the frontend *invents* block identity instead of honouring the backend's. The actual mechanism that destroys `ai-d63e` here IS B-A's frontend mint plugin — it fires on the split nodes and stamps fresh `pr-…` ids, overwriting the backend's authoritative id. So E-1 is the multi-node-block face of B-A: B-A is "the frontend mints ids for *new typed* prose"; E-1 is "the frontend re-mints ids for a *backend-authored* block it fragmented." A truly backend-authoritative identity flow (B-A's retirement: token→mint→ack, frontend never invents ids, load never mutates) would also prevent E-1's id loss. They should be fixed together, or at least with the same principle.

**Scope:** a SINGLE-node embed works — the finalised content is one native node, maps to one `kind:prose` block, id rides through. Only MULTI-node embeds break.

**Root cause:** there is no editor representation for "one prose block spanning multiple top-level nodes." `kind:prose` = one native top-level node (typed prose, node-granular — *correct, keep it*). A multi-node, actor-created block has no home, so it fragments.

**Retires when:** build the **`kind:"nested-prose"`** kind, which the 2026-06-19 node-granular spec (`docs/design/archive/specs/2026-06-19-node-granular-prose-blocks-design.md`) already designed and deferred ("a code-created prose tree under one id, for a future actor that needs it; kind-in-marker; never keyboard-split"). The embed/rewrite/extract/transform actors are that concrete actor. Concretely: (1) codec supports `<!--s:ID kind=nested-prose-->…<!--/s:ID-->` (open-tag kind on serialize/parse); (2) a transparent never-split container NodeView on the frontend (`content:'block+'`, one `data-id`, no chrome) renders a `nested-prose` block as ONE node → edits emit `update-block`, never split → the id is immortal; (3) `PromoteBlock` (and later rewrite/extract/transform) emits `kind:nested-prose`. `nested-prose` is actor/backend-created, so its id is backend-minted from birth — it sidesteps **B-A** (the typed-prose frontend-mint, still separately open). Decision locked 2026-06-20: container (id survives load + edit), NOT unpack-on-edit (loses the id). A near-term partial mitigation (independent of the kind work): the frontend must not post a mutation as a side-effect of *loading* backend data — honour the existing `aiReloadInProgress` flag in the mint/sync so a load is read-only.

## P-A: OS file drag-and-drop not implemented

**What:** Dragging files from the OS file manager onto the Sieve window does nothing. Wails `DragAndDrop` config and an `OnFileDrop` Go handler are needed.

**Why deferred:** Separate feature; no blocking dependency.

**Retires when:** Implemented as a follow-on feature.

## B-A: Prose block ids are frontend-minted, not backend-authoritative — ✅ RESOLVED 2026-06-30 (user-verified in-app)

**RESOLVED** via the pinned `token → mint → ack` round-trip on `feature/backend-authoritative-prose-id` (rebased onto post-F-A `main`, commits ~`650b566..5936e3f`). The frontend no longer invents durable identity: the identity plugin stamps a TRANSIENT `tok-…` token (never a durable id) on each real top-level prose block; the observer sends `create-block` with the token and NO blockId; Go mints the durable id (`GenerateBlockIDFor`) and echoes the token on the `insert-block` ack; the frontend applies the backend id (tracked, history-excluded `setNodeMarkup`) and clears the token; the observer skips in-flight (pending) tokens and pins their baseline so a flight-edit is not lost; `splitBlock` CLEARS the copied id/token (never re-mints). `mintProseId`/`mintActions` retired (`dedupeActions` is the split defense). This also enforces **E-1's root principle** (identity never invented on the frontend) for typed prose. Structural empty paragraphs sync through the SAME create path (a structural blank is a real block; only the trailing editing surface stays bare). The `proseidentity-loop.test.js` rewrite landed here (cross-ref **C-T**). Notable fixes found in in-app smoke: block-node padding now keys on `id||token` (no reflow when the id acks); and **proseGroup carries the transient `token` attr** so a SPLIT multi-node block is not orphaned (the data-loss bug — proseGroup held an id but not a token, so the stamp was dropped). Backend remains the document source of truth; a LOAD never posts a mutation.

**What (historical):** New prose blocks got their durable `blockId` minted on the **frontend** (`prose-block.js` `mintProseId` in the `blockId` minting plugin, via `mintActions`), then sent on `create-block`. Every **structured** Sieve Block instead gets its id from the **backend** (`GenerateBlockIDFor`, e.g. `EditorService.CreateBlock`) — the backend is the sole id authority and the frontend only ever receives the id. Prose is therefore inconsistent with the rest of the block model: the frontend invents a durable identity that should originate in Go.

**Why deferred (2026-06-19, user decision):** The backend-authoritative path for *native* prose needs an async `create-block` → mint → ack round-trip plus a per-node "pending" state (so the debounced observer doesn't double-create a node whose id is in flight). That state machine lands in the highest-churn area of the editor (two prior reverts). Mid-arc on a long, high-risk migration, the pragmatic call was to keep the frontend-mint model (which is synchronous and already working) and record the inconsistency here. `ApplyOp` create-block already mints server-side when the id is absent, so the backend is a correct floor regardless.

**Retires when:** D-r.4's frontend mint is replaced by a backend-authoritative flow: `create-block` carries content + index + a transient correlation **token** (not a durable id) and marks the node pending; `HandleBlockOp` mints the id and the WS layer acks `{token → blockId}` back via `writeMsg`; the frontend applies the backend's id (a backend-sourced attribute update) and clears pending; the observer skips pending nodes. The `splitBlock` duplicate is then handled by **clearing** the copied id (reuse `mintActions` detection) so the new half becomes id-less → `create-block`, rather than re-minting locally.

**Related: E-1** (embed-in-document broken). The same frontend-mint mechanism destroys a *backend-authored* block's id when a multi-node embed fragments — E-1 is the multi-node face of this debt. Retiring B-A (backend-authoritative identity, load never mutates) is the principle that also fixes E-1.

**Progress (2026-06-21 — create convergence).** The positioned single create path B-A's retirement rides now exists: UI-triggered creation (toolbar/AI/extract) emits one `block-op {create-block, kind, attrs, index}` through `HandleBlockOp` (structured → `InitAttrs` + `insertBlockAt(index)` + dispatch + notify; prose → `ApplyOp`). The legacy `create-block` WS message + `handleCreateBlock` + the `SetBlock`-append second path are **retired** — fixing a positioning regression (blocks appended to the end of Go's tree after the doc-update fallback was removed). What remains for B-A is purely the prose **id authority** (the `token → mint → ack` round-trip); positioning + the op envelope are done.

## B-B: AI ref chain resolves to `doc`; answer blocks split the target (native-prose targeting) — ✅ RETIRED 2026-06-19 (D-r.7)

**RETIRED:** Fixed by D-r.7 (commits "D-r.7 (1/3)…(3/3)" on `feature/refactor_editor_layout`), implementing the approved spec via TDD. (1) prose identity unified `blockId` → `id` (PM-attr layer only; disk markers carry the value, round-trip untouched). (2) `resolveAiTarget` keys on node *character* — `isFlowingText`(paragraph/heading) → `doc`; every other top-level node (unit) or NodeSelection → that block by id; non-empty TextSelection → `==` + ref chain of every crossed top-level block (`topLevelIdsBetween`). (3) one `blockInsertPos(state,isInline)` (inline → caret, NodeSelection → after node, else `$to.after(1)`) replaces the scattered `sieveInsertPos = selection.to` and the old `aiInsertPos`; all six additive create sites route through `captureInsertPos`/`kindIsInline`. `applyTargetHighlight` dropped the `blockRef` wrap (just applies `==`). vitest: `prose-identity` (4), `ai-target` (20), `block-insert-pos` (6) all green; in-app CDP gate confirmed answers land after the block (no split) and a selection refs its block id (not `doc`). The `blockRef` node-type retirement remains Stage E. **B-A (frontend-minted prose ids) is still open.**

<details><summary>Original defect (historical)</summary>

**What:** The AI targeting/insert layer (`ai-target.js` `resolveAiTarget`/`findBlockTarget`/`aiInsertPos`, `extensions.js` `buildAiContext`/`applyTargetHighlight`) predates the node-granular prose pivot. It recognizes a block only when the node is `blockRef` or `sieve-*` and reads `attrs.id`. Native prose is now a top-level node carrying `attrs.blockId`, so: (1) a **text selection** in prose refs `doc` instead of the block(s) it crosses (`resolveAiTarget`'s selection branch returns no id → `buildAiContext` falls to `'doc'`), and (2) `aiInsertPos` finds no `blockRef`/`sieve-*` ancestor → returns the caret → the Ask/Explain answer **splits** the target paragraph instead of landing as a sibling after it. (Originally recorded as the `project_ai_targeting_blockref_defect` memory.)

**Why deferred:** Block-level addressing needed prose ids, which only landed with D-r.4 minting; doing the rewire before that would have been built on sand.

**Retires when:** The **approved design** [`docs/design/archive/specs/2026-06-19-unified-block-targeting-design.md`](archive/specs/2026-06-19-unified-block-targeting-design.md) is implemented (folded into the block-document-model plan as task set **D-r.7**): unify the prose identity attr `blockId` → `id`; resolve targets by node *character* (NodeSelection/unit → that block by id, TextSelection → `==` + ref chain of every crossed block, bare caret in flowing text → `doc`); and route every additive block insert through one `blockInsertPos` (inline → caret, block → after the enclosing top-level node) so answers never split.

</details>

## B-C: ShadowDocument uniform-block refactor — ✅ RETIRED 2026-06-19

**What it was:** `ShadowDocument` carried a `Markdown string` and a `Blocks map[string]*SieveBlock` that **excluded prose** (`syncBlocksView`: `if b.Kind != KindProse`) and exposed blocks via raw map / `Attrs["..."]` access — contradicting the committed model ("everything is a block, addressed by id; kind matters only at render/serialise").

**Resolved by** the bite-sized plan [`docs/design/archive/plans/2026-06-19-shadowdoc-uniform-block-refactor.md`](archive/plans/2026-06-19-shadowdoc-uniform-block-refactor.md) (one commit per step, app runnable + green throughout — no big-bang):
1. ✅ `getBlock(id)` / `findBlockIn` is the sole accessor; the `Blocks map` + `syncBlocksView` are deleted (all readers on the tree).
2. ✅ The `Markdown` field is gone — whole-doc markdown is derived on demand (`deriveMarkdown`, mode-aware); markdown-mode keeps a scoped `mdModeBuffer`. Closed the D-r.5 `id=="doc"` drift bug.
3. ✅ Prose body lives in `Attrs["content"]` (typed `Content()` accessor) — prose is a `SieveBlock` like every kind; the bespoke `Content` field is gone. Typed accessors (`Source/Ref/Status/StringAttr`) replace brittle casts (spec #5).
4. ✅ `Children` removed (a block is a leaf; containers are Stage E). `BlockDoc` wrapper collapsed — `ShadowDocument.Blocks []SieveBlock` directly. `DocBlock` merged into `SieveBlock` (one in-memory block type).
5. ✅ Wire shape unified (B-E): prose body in `attrs.content`, `FrontendBlock.Content` dropped; JS reads via `proseContent()`.

**Spun off:**
- ✅ **B-F (DONE 2026-06-19)** — lock-free `DocView{UUID, Mode, mdModeBuffer, Blocks []SieveBlock}` snapshot for the job/context boundary. `JobContext.Doc` and `ContextProvider.BuildContext` / `BuildContextForID` take `DocView` (no mutex), built from the live `ShadowDocument` at dispatch. `go vet ./sieve/` is now copylocks-clean. (NOT "fixed" by passing `*ShadowDocument` — that would leak the live mutable cell into the concurrent `RunJob`; the copy is deliberate isolation.)
- ✅ **B-G — RETIRED (2026-06-21).** `serialisedForm` is gone from the wire AND the frontend. Go owns all markdown (derived from the tree at the disk / markdown-mode boundary only — `ContentForSave`/`EnterMarkdown`); the client renders structured kinds from `attrs` alone. Removed: `FrontendBlock.SerialisedForm` + its `serializeFencedBlock` call; the `serialisedForm` node attr + `data-serialised-form`; `BlockLifecycleListener` no longer carries it (`OnBlockCreated` now carries `markdown` = the block's fence, used ONLY by the breakglass markdown-mode buffer). The structured change-signature became an attrs-hash (`JSON.stringify(attrs)`); `buildSieveBlockHTML`/`renderText` build from attrs/text, not a fence. **Also retired the WYSIWYG `wysiwygMarkdown` + `doc-update` fallback** (F-A's first half): `computeBlockSync` is fallback-free — structured create/change emit nothing (own channels), structured **delete** is a kind-agnostic `delete-block`. Copy/paste round-trips on-demand: copy emits `sieve/slice` + `sieve/<kind>` (whole block) from attrs, `text/plain`/`text/html` follow the selection. New backend seam `ContentEntry.SieveAttrs()` deserialises a `sieve/<kind>` view. Needs nothing further; `doc-update` survives ONLY as the markdown-mode verbatim path.

## SoT: single-source-of-truth (`mdModeBuffer`) — ✅ RESOLVED-BY-INVESTIGATION 2026-06-20

**The framing was wrong.** The fold-in was stated as "retire `mdModeBuffer` as authoritative; markdown mode reparses into `Blocks` via the codec." Walking it through (user, 2026-06-20) reframed it: **markdown mode is a breakglass/dev convenience, and doc save MUST be independent of a potentially-faulty block tree.** So the verbatim-buffer save (`ContentForSave` returns `mdModeBuffer` raw in markdown mode) is *correct*, not drift — reparse-on-edit (Option A) would canonicalise the user's bytes and churn through invalid intermediate states. Current behaviour is functionally correct; only the code reads unintuitively.

**The only real gap** was per-block reads against the *frozen* tree while in markdown mode. Investigation also confirmed (empirically, all RunJob processors) that `DocView` is **read-only, job-creation-time prompt context** — only `ai_block_processor` even reads it, and only to build the prompt before the long call; results flow back as a delta merged into the LIVE shadow (`RunJob` diffs the block copy → `applyJobUpdate` → `SetBlock`), never through the `DocView`. So a stale snapshot is correct by design.

**Fix (Option C, minimal guard):** `ShadowDocument.SnapshotForJob` derives the `DocView`'s block tree from the authoritative buffer when `Mode=="markdown"`, so a ref chain resolved while a job runs in a breakglass session sees fresh per-block content. Save unaffected (still verbatim). The `DocView` read-only contract is now pinned in its doc comment. Commit `abf8390`; test `TestSnapshotForJob_markdownModeDerivesBlocksFromBuffer`. Memory `project_single_source_of_truth_blocks` updated.

## B-D: AI chain-active bracket doesn't render on native prose blocks

**What:** The persistent AI-chain affordance (`block-ref-active`, the curved left-rail bracket toggled by `ai-block-renderer.js` `applyChain` when you focus/hover an AI block) renders only on **structured** blocks — its CSS is gated on `.block-node` / `.image-block` / `.code-block-wrapper` / `.sieve-block--*`. A **native prose** block is `<p class="block-with-chrome" data-id>`, which none of those match, so the class is added (the comma ref chain IS split correctly) but paints nothing. Verified: `block-ref-active` on such a `<p>` → `border-left: 0 none`, `::after content: none`.

**Why deferred (2026-06-19):** Outside D-r.7's locked scope (identity/targeting/insert); folded into the ShadowDoc-refactor work as an adjacent "uniform block" visual fix.

**Retires when:** The persistent bracket is driven through the SAME `.block-chrome-rail` the ephemeral `block-ai-target` glow already uses (`ai-target-decoration.js` + `editor.css:2628`), so prose and structured share one visual language (per `project_block_anchor_lineage`). Verify by eye in WebKitGTK.

**Superseded 2026-06-29 → folded into U-A (deferred to Stage F re-plan).** Do not patch piecemeal: the whole rail/lineage L&F diverged from the §8 design and is being re-planned as a set. (Live check showed the orange chain affordance *does* now paint on prose; the real problem is design-level, not this gating.) Detail in the ShadowDoc-refactor spec ("folded-in follow-up").

## S-A: Flat-package decomposition — no internal boundaries (Go `sieve/` AND JS `static/`) — ✅ RETIRED 2026-06-29

**Go half — DONE (2026-06-20).** `sieve/` is now 6 cohesive packages, acyclic, full suite + `-race` green: `domain ← block ← {block/processors, services} ← ai ← root`. Cycle broken via `block`-owned port interfaces (`AIPort`/`DocumentsPort`/`AssetsPort`/`StatePort`/`LinkPreviewPort`); `BlockServices` is now a struct of ports. Plan `docs/design/archive/plans/2026-06-20-flat-package-decomposition.md`, spec `docs/design/archive/specs/2026-06-20-flat-package-decomposition-design.md`. Along the way: ShadowDocument now owns its data+mutex (EditorService never touches `shadow.mu`); registry owns paste-matching (`FirstPasteMatch`); a latent `FrontendBlocks` data race fixed (`SnapshotBlocks` deep-copies Attrs).

**JS half — DONE (2026-06-29).** `frontend/src/static/` is now grouped into 6 subfolders mirroring the Go packages: `base/` (leaf helpers + shared base), `block/` (block model + framework + prose-as-block), `processors/` (8 per-kind renderers), `ai/` (AI actions + targeting), `editor/` (core + mechanics + chrome), `ui/` (app shell). 32 files moved via `git mv`; 9 cross-folder ES imports (fenced-block-base importers) updated; all 31 index.html script paths updated; all vitest imports updated. This regroup is **cosmetic** — it tidies paths but adds no encapsulation, because the coupling is the global bus (`window.TipTap` etc.), not the directory layout. The real encapsulation debt is tracked separately as **X-C** below.

**Also DONE:** (2) ✅ **single-source-of-truth** — RESOLVED-BY-INVESTIGATION 2026-06-20 (see `SoT` section above: the verbatim-buffer save is correct; only added a markdown-mode coherence guard in `SnapshotForJob`); (3) the **no-loose-functions backlog** (free funcs still in `block/` codec/parser + `ai/eval`, see CLAUDE.md Design Principles — still open as a follow-up, not a blocker).

**S-A is now fully retired.** The original problem statement below is retained for historical context.

**What:** Both the Go backend package and the JS frontend folder are flat dumping grounds with no internal boundaries, so it is hard to see wheat from chaff and coupling is uncontrolled.
- **Go `sieve/`** — one package, ~40 production + ~37 test files (~14k lines). Block model, codec, processors, editor service, AI service, library service, prompts, sessions all share one namespace; everything can call everything. Every audit finding this era (`block_serde.go`, `block_op.go`, `frontend_block.go`, `DocView`/`mdModeBuffer`, the test-file sprawl) is one symptom of this: no domain ownership → behaviour leaks into free functions and the directory listing is unreadable.
- **JS `frontend/src/static/`** — the same shape: `editor.js` + a flat pile of `*-renderer.js` / `*-block.js` / `block-*.js` / `ai-*.js` with no grouping.

**Why deferred (2026-06-19, user-flagged):** The deserialization-is-a-processor-concern + ShadowDocument-consolidation refactors had to land first — they carved the seams (`DocumentCodec`, the narrow `ProcessorRegistry`, block ops as `ShadowDocument` methods) a `block/` package needs. Decomposition is a deliberate, leaf-first effort, NOT a bolt-on; doing it mid-feature would churn. The concrete blocker to a clean Go split: `BlockServices` (`processor_registry.go`) holds **concrete** `*AIService`/`*DocumentService`/`*AssetService` pointers → a `service ↔ processor` import cycle. Until that's interfaces, Go rejects the split.

**Retires when:** Decompose leaf-first into a small number of cohesive packages (NOT Java-style package-per-concept; aim ~4–5). Go: make `BlockServices` an interface owned by the core, then extract `sieve/block/` (SieveBlock model + DocumentCodec + RegionScanner + processor registry + their tests) — the tests move WITH their code, which is what fixes the "37 test files in one dir" sprawl — then `sieve/processors/`, leaving `services/` + the composition root. JS: group the block/editor/AI modules into folders mirroring the Go packages. Related cleanup formerly folded in here: single-source-of-truth — now ✅ RESOLVED-BY-INVESTIGATION (see the `SoT` section; the verbatim-buffer save is correct, not drift). Memories: `project_package_layout_direction`, `project_single_source_of_truth_blocks`; aligns with `project_architecture_direction` (Go server + S3 + web/mobile).

## X-C: JS modules couple through a global bus, not imports

**Tracked:** Forgejo #22

**What:** `frontend/src/static` communicates almost entirely through shared mutable globals — `window.TipTap` (~155 refs across files), plus `window.SieveIcons` / `window.SieveAI` / `window.SieveContextMenu` / `window.sieveShowInFiles`. Only ~4 real ES-import edges exist (`fenced-block-base` ×9, `prose-markers`/`block-render`/`block-kinds` ×1 each via `prose-block.js`). `editor.js` has 0 ES imports and ~52 `window.TipTap` references; it is also a ~2143-line god-module IIFE. The 2026-06-29 folder regroup (S-A JS half) is **cosmetic** — it tidies paths but adds no encapsulation, because the coupling is the global bus, not the directory layout.

**Why deferred:** Real fix is a separate epic; the close-out kept the cosmetic foldering and tracked this. The global-bus pattern is also entangled with the load-order dependency management currently done by `<script>` tag ordering in `index.html`.

**Retires when:** The `window.TipTap` / `window.Sieve*` global bus is replaced by explicit ES `import`/`export` modules (boundaries enforced by the import graph), and `editor.js` is decomposed into cohesive, independently-importable units. Aligns with the Go-server + web/mobile direction (a global god-object won't survive a bundler/SSR boundary). User decision 2026-06-29. **Update 2026-07-08:** the epic now exists — Forgejo #31 (Workspace/Editor component model, phases #27–#30) with normative specs (`docs/design/specs/2026-07-08-workspace-editor-component-model.md` + companion) and `docs/how-to-idiomatic-js.md`.

## X-D: Sieve block renderers are duck-typed config bags, not a class hierarchy

**Tracked:** register only (kept OUT of epic #31 by user decision 2026-07-08 — the epic stays scoped to Workspace/Editor to remain manageable).

**What:** The 8 renderers in `frontend/src/static/processors/` are duck-typed config objects (`{ getIcon: function() {…}, … }`) whose required shape is documented nowhere — it is implicit in what `sieve-block-extension.js` calls, learned by reverse-engineering. `fenced-block-base.js` is a base in name only: a grab-bag of free functions (`getLowlight`, `hastToHtml`, `applyHighlighting`) imported piecemeal. There is no `BaseSieveBlockRenderer` to open and understand the family — the readability gap the JS-OOP principle (CLAUDE.md 2026-07-08) exists to close.

**Why deferred:** Epic #31 is deliberately scoped to Workspace/Editor. Renderers live inside the Editor boundary and can be classed after its P2 (input surfaces) without blocking anything; doing it inside the epic would bloat it.

**Retires when:** A class hierarchy mirroring the Go processor side (`BlockProcessor` interface / `FencedSerializer` embed): abstract `BaseSieveBlockRenderer` (NodeView lifecycle, chrome hooks, `interactionPolicy` declaration, attr sync, registration contract) → abstract `FencedBlockRenderer` (YAML replay, highlighting, job/status rendering — `fenced-block-base.js`'s free functions become methods) → 8 concrete classes. Registration via a typed registry method, JSDoc-typed contract per `docs/how-to-idiomatic-js.md`; `docs/how-to-sieve-block-framework.md` rewritten as "extend the class". Note: `smart-link-renderer` is expected to be DELETED under the parked links decision (memory: project-links-decision-parked) — build it last or not at all.

## V-A: "Hide AI blocks" is a frontend CSS lie, not a backend-filtered DocView projection

**What:** `toggleAiBlocks` (Mod+J) hides AI blocks with a **frontend-only CSS visibility toggle** — `#showAiBlocks` state on `AbstractEditor`, mirrored as a `hide-ai-blocks` class on the editor root (`presentSurface` syncs it; `editor.css` does `display:none`). The AI blocks are still in the document, still in the DOM, still round-trip and save — the toggle only stops *painting* them. It works, but it is not structurally correct: a document is entirely blocks, and "show me the doc without AI blocks" should change **what the editor is given**, not apply a visual mask over what it holds. The state is also editor-carried chrome that must be nursed per-instance (it caused the stale-class desync bug patched in P2.C.2).

**The structurally-correct design (user, 2026-07-10):** make it a **filtered DocView projection from the backend**. The authoritative shadow keeps the full block tree; the view *sent to the editor* omits AI blocks (the `DocView` is just a list of blocks — filter the list). The editor then renders exactly what it sees, with **zero editor affordance** — delete `#showAiBlocks` / `toggleAiBlocks` / the CSS sync entirely. Three wins: (1) structurally correct (backend is the document source of truth — the CSS approach is a frontend visual state the backend is blind to); (2) the editor becomes a pure function of the block list it's handed; (3) the filtered view **is export-markdown in editor form** — because the export `BlockFilter` (the caller-passed predicate closure, commit `05c1f8f`) and the editor projection become **one filter, two consumers** (export string + editor view), guaranteed consistent. Mechanically it reuses P2.B's awaited `setMode` pipe (flush → handshake → re-project-and-mount); it's an orthogonal projection axis (WHICH blocks) from mode (HOW rendered), not a third mode. Aligns with the "blocks all the way up" / DocView-as-projection north-star (memory `project_blocks_all_the_way_up`) and belongs in the P3 SelectionModel / consumer thinking (epic #31, issue #29).

**The one real implementation caveat:** the block-sync observer must treat the filtered view as a **projection, not a deletion** — when the editor renders without the AI blocks it must NOT diff "those blocks vanished" into `delete-block` ops against the full shadow. The view needs to carry that it is filtered so whole-doc reconciliation is suppressed and only genuine edits round-trip (the backend knows it sent a filtered view; granular per-block-id ops already can't fabricate deletes for blocks the editor never saw — the risk is any whole-doc absence-diffing path).

**Why deferred:** the CSS toggle works today and is harmless (blocks are never lost — they're just hidden); the correct version needs the P3 projection/consumer machinery and the observer-suppression guard above. Not worth building ahead of the SelectionModel.

**Retires when:** `toggleAiBlocks` becomes a backend filtered-DocView projection request (through the `setMode`-style awaited pipe); export markdown becomes one consumer of the shared block predicate; the frontend `#showAiBlocks` field, `toggleAiBlocks` method, and `hide-ai-blocks` CSS/sync are deleted. Verify: AI blocks hidden in the view still save intact (present in the on-disk doc), and a filtered-view edit round-trips without deleting the hidden blocks.

---

## S-B: `DocumentCodec.Deserialize` prose fallback — ✅ RETIRED 2026-06-20

**Resolved by** processor-owned segmentation (spec `docs/design/archive/specs/2026-06-20-processor-owned-segmentation-design.md`, plan `docs/design/archive/plans/2026-06-20-processor-owned-segmentation.md`). Segmentation became a processor concern: a `Shape()` `(head,tail)` delimiter pair rides on the `BlockProcessor` SerDes surface (free via the embedded `FencedDeserializer{Kind}`/`ProseProcessor`); a single custom goldmark block parser recognises every registered shape as an opaque raw span, so a prose `<!--s:-->` block arrives WHOLE (inner fence not split). `Deserialize` collapsed to first-acceptor-wins with the terminal prose processor sorted last (`orderedProseLast`) — `firstAcceptor` (the prose-exclusion) and `flushProse`/coalescing are DELETED. The coalescing is no longer needed because the scanner delivers maximal units. Standard fences (` ```java `) match no registered shape and stay prose content. Construction-order gotcha fixed along the way (codec collects shapes from the live registry per scan; it is wired before the fenced processors register). Memory `feedback_prefer_uniform_patterns` (don't split common patterns) captured from this work. Follow-up NOT done (out of scope): consolidate the two goldmark parsers + retire `markdown_parser.go`'s legacy `sieveBlockASTTransformer` (Stage E).

<details><summary>Original problem (retained for context)</summary>

**What:** The codec's prose handling (`block/document_codec.go` `Deserialize` + `firstAcceptor` + `flushProse`) read as over-explicit and confused the user. `ProseProcessor.Accepts()` returns `true` unconditionally and prose IS registered, yet `firstAcceptor` deliberately SKIPS prose (`if p.Mode()==BlockModeProse { continue }`) and unclaimed regions accumulate in `pending` for an explicit `flushProse`. Two real reasons (not redundancy): (1) **coalescing** — consecutive unclaimed regions are concatenated into ONE prose run so a stray fence survives verbatim inside flowing prose and `scanProseRegion` segments correctly; per-region prose-as-last-acceptor would fragment at every fence boundary. (2) **order-independence** — prose `Accepts→true` would hijack regions ahead of structured processors if it were in the accept loop, so skipping it guarantees structured-first regardless of registration order.

**Why it was debt:** the mechanism was correct but read as a smell; a clarity problem, not a behaviour bug.

</details>

## F-A: Frontend still owns document-structure-as-markdown on the OUT direction — ✅ RETIRED (B-G, 2026-06-21)

**RETIRED:** Both sub-surfaces are gone.

1. `wysiwygMarkdown` + the `doc-update` fallback in WYSIWYG mode — **retired by B-G (2026-06-21)**: `computeBlockSync` emits only granular `block-op` messages (no whole-doc fallback); `wysiwygMarkdown` and `sendDocUpdate` no longer exist in `editor.js`. The stale comment at `editor.js:569` ("falls back to a whole-document doc-update") is cosmetic and can be removed.

2. Markdown-mode textarea seeded from Go — **already true in every path**: mode-switch sends `enter-markdown` over WS → `EditorService.EnterMarkdown` (`sieve/services/editor_service.go:274`) derives markdown via `ContentForSave()` → `editor:markdown-content` event seeds the textarea (`editor.js:1862–1869`). Soft-reload seeds from `data.body` (`editor.js:1539`). No JS whole-doc serialise occurs.

3. markdownit fence-rules in `sieve-block-extension.js` — still live for the paste/raw-markdown round-trip; `buildBlocksHTML` now uses `buildSieveBlockHTML` from attrs directly (block-render.js), so `serialisedForm` is gone and the fence-rules are no longer the load path (only the paste-reconstruct path).

**Cleanup (done in this F-A close-out):** the `toMarkdown` registry field on `ProseBlock` had no production call site and was removed; three stale comments (`prose-group.js`, `block-chrome.js`, `editor.js`) were fixed in the same cleanup commit.

## T-A: Flaky test — `TestHandleBlockUpdate_notifySendsSnapshotUnderLock` — ✅ RETIRED 2026-07-07

**RETIRED 2026-07-07.** The flake was a shared-harness teardown race, not that one test: `EditorService.DispatchJobIfNeeded` spawned job goroutines UNTRACKED; a completing job's `applyJobUpdate` does `MergeBlock` then `flushShadow`→`Save` into the test's temp `buffers/`; the `waitJobs` helper polled block STATUS, which leaves PENDING/DISPATCHED before the goroutine's Save finishes — so an in-flight Save recreated files during `t.TempDir()` RemoveAll. Fix: `EditorService` gains a `jobsWG sync.WaitGroup` tracking dispatched job goroutines and a `WaitForJobs()` drain seam; `waitJobs` delegates to it; `CloseAll()` now also drains jobs (production improvement — retiring the service, e.g. library switch, can no longer leave a completing job writing against an abandoned store). Verified `-count=30 -race` on the named test and `-count=20 -race` package-wide.

**What (historical):** This `sieve/editor` test (`TestHandleBlockOp_updateNotifySendsMergedSnapshotUnderLock`, `editor_service_test.go`) flakes (~1-in-3) with `TempDir RemoveAll cleanup: ... directory not empty` — a teardown race: a watcher/async writer still touching the test's `buffers/` dir when `t.TempDir()` cleanup runs. It is NOT a logic failure (the assertions pass; only the teardown errors) and is **pre-existing** — it flakes identically on clean `main`/`HEAD` with no relation to any block-model change (verified by stash-test).

**Why deferred:** cosmetic test-infra flake, not a product bug; the suite is otherwise green. **Retires when:** the test stops the watcher / drains async writers before returning (so cleanup has no live handles), or uses a non-`t.TempDir` dir it removes explicitly after quiescing.

## L-A: `renderBlocksIntoEditor` leaves stale content on an empty-blocks reload

**Tracked:** Forgejo #23. The fix is already largely implemented — `frontend/src/static/base/render-empty.js` + `render-empty-reload.test.js`, and `softReloadContent` passes `allowEmpty:true`; #23 is a call-site audit + retirement.

**What:** `renderBlocksIntoEditor` early-returns when the backend block list is empty (`if (!nodes.length) return` — "keep existing content rather than blow away on a transient empty parse"). Since `softReloadContent` and `editor:restore` now render via this path, reloading a doc that has legitimately become **empty** leaves the prior (stale) content on screen instead of clearing it. 

**Why deferred:** an edge case — the live reload triggers (AI resolve, embed promote, version restore) don't empty a document in practice, and the old `setContent("")` behavior wasn't a guaranteed clear either (it rendered one empty paragraph). **Retires when:** `renderBlocksIntoEditor` distinguishes "no blocks parsed (transient/error → keep)" from "the document is genuinely empty (→ clear to one empty paragraph)", e.g. the caller passes an explicit `allowEmpty`/clear intent for a known-good reload.

## D-L: Data-loss root cause (empty-overwrite) — PARKED, guard makes it non-fatal

**What:** A flush occasionally derived **empty** markdown for a **non-empty** document and wiped the file. `flushShadow` now refuses to overwrite a non-empty doc with empty content (commit `b7dd63e`, regression test reproduces the wipe), so it is **non-fatal** — but the ROOT CAUSE (why the derive went empty: a failed `codec.Serialize` → `deriveMarkdown` returns `""`, or a transient empty markdown-mode buffer) was never pinned.

**Why parked (user decision 2026-06-20):** not reproducible on demand; the guard removed the danger. **Retires when:** it recurs and is captured — look for the log line `"serialize block doc failed"` (the failed derive) vs. the guard's `"editor: REFUSED empty overwrite of non-empty doc"`; the first one names the block/codec path that produced empty. Moved here from the (now-archived) block-document-model plan so it isn't lost.

## P-D: Smart paste duplicates the source block id — ✅ RETIRED 2026-06-21 (with C-V)

**RETIRED:** The slice-paste reconstruction is server-side and mints a fresh id per pasted block — `EditorService.HandlePaste` calls `block.GenerateBlockIDFor(matchKind)` (editor_service.go:492), never honouring the copied `id`. So a `sieve-code` copy/paste now yields two distinct ids, not `co-test` ×2. Folded into C-V exactly as predicted.

**Original — What:** Pasting a copied Sieve block kept the **source** block's id, so the document ended with two blocks sharing one id (observed in D-r.6 regression sweep: a `sieve-code` copy/paste produced `co-test` ×2). The duplicate lived in `handleSmartPaste` (frontend) and was independent of the block-model work (pre-existing).

## C-V: `sieve/slice` paste doesn't sync to Go — pasted blocks lost on round-trip — ✅ RETIRED 2026-06-21

**RETIRED:** Slice paste is now reconstructed **server-side**. `handleSmartPaste` (frontend) detects a multi-item `sieve/slice` and POSTs `{uuid, slice, index}` to `/api/editor/paste-slice`; `EditorService.HandlePasteSlice` delegates each item to `HandlePaste(uuid, entries, index+i)`, which runs `block.FirstPasteMatch` + the matched processor's `Transform`, mints a fresh id (`GenerateBlockIDFor`), and inserts positioned via the same `block-op {create-block, kind, attrs, index}` path the toolbar create uses. Go's tree learns of every pasted block, so they survive a Go-sourced reload. Render-back reuses `blockToNodes` (shared with `renderBlocksIntoEditor`) and baselines each server block (`noteServerBlock` → `seedBaseline`) so the observer doesn't double-create the prose ones. **Also retired P-D** (fresh id) in the same change. A copied **mermaid code block** round-trips as code, not a diagram — see C-X. Prose slice items keep their client-first observer sync (`ProseBlock.asContentEntry` → `sieve/prose` + text views).

**Original — What:** Pasting a copied Sieve block reconstructed it **client-side** (`editor.js` `sieve/slice` → `insertContent`) but emitted no `create-block` op, and `computeBlockSync` emits nothing for a structured create — so Go's tree never learned of the block. It survived in-session but vanished on the next Go-sourced render/reload.

## C-X: paste-match must round-trip a copied block as its own kind — ✅ RESOLVED 2026-06-21

**RESOLVED:** A copied **code block whose language is mermaid** was pasted back as a **diagram** — the diagram processor (registered first) greedily claims mermaid source, and `FirstPasteMatch` returned the first general match. Fixed by giving `FirstPasteMatch` a **self-kind pass**: a `sieve/<kind>` view is reclaimed by the processor whose `Kind()` matches it BEFORE the general/upgrade pass (prose still terminal-last). So a copied block round-trips as its own kind; cross-kind "upgrades" (raw mermaid *text* → diagram) only fire in the general pass for content with no `sieve/<kind>` view, and explicit conversion still flows through `DetectExtractions` (extract menu), untouched. PASTE-only — extract is a separate operation. No processor changed (registry policy); because the right processor is *selected*, the upgrading processor's `Transform` is never invoked on the paste. Test: `TestFirstPasteMatch_selfKindBeatsUpgrade`.

## C-Y: keyboard delete of whole sieve blocks — ✅ RESOLVED 2026-06-21

**RESOLVED:** Two reasons a sieve block resisted Backspace/Delete, forcing the context-menu Delete: (1) a **gutter block-range** lives in the `blockChrome` plugin state (a `{from,to}` pair), NOT a PM selection — a PM `TextSelection` snaps off the `contentEditable=false` sieve atoms — so PM's deleteSelection saw only a collapsed caret. Added `blockChrome` `handleKeyDown`: Backspace/Delete over an active block-range `tr.delete`s the exact doc range (a plain text selection still falls through to PM). (2) The **ai-block** NodeView plugin swallowed Backspace/Delete whenever the selection merely *overlapped* the block (its read-only-body guard used `nodesBetween`), so a wholly-selected ai-block couldn't be deleted. Narrowed the guard (`deleteEditsAiBody`): a NodeSelection on the block, or a selection that fully *contains* it, is a whole-block delete (allowed, undoable); only a selection that *partially* overlaps the body — which would edit the read-only response text — is blocked. Enter + typing stay blocked on any overlap (they change text). The caret CAN enter the body (children render as editable text), so the guard remains load-bearing for in-body edits.

## C-W: `block-update` is not yet a `block-op` — ✅ RETIRED 2026-06-24

**RETIRED:** Converged onto `block-op {update-block}` (commit `47525b4`, merged via PR #17, merge commit `02b4ce8`). `HandleBlockOp`'s update case now runs the full uniform pipeline: structured partial-attrs merge + `OnChange` + job dispatch + notify. `handleBlockUpdate` and the `case "block-update"` are removed from `requesthandlers/ws_handler.go`; `sieve:block-update` on the frontend now emits `block-op {op: "update-block"}` instead. `block-op` is now the single granular mutation path (create/update/delete); only `doc-update` (markdown-mode verbatim) remains beside it.

**Original — What:** Structured block edits (`sieve:block-update` → `handleBlockUpdate`) still rode a bespoke WS message that merged partial attrs + ran `OnChange` + dispatched the job + notified — a path parallel to `block-op`. It was the last of the three pre-block-op mutation messages in `ws_handler.go` (`create-block` retired 2026-06-21; `doc-update` legitimately kept as the markdown-mode verbatim path).

## U-A: Editor-layout affordances need a holistic re-look — DEFERRED to a Stage E/F re-brainstorm (2026-06-29)

**Tracked:** Forgejo #24

**Scope (user decision 2026-06-29):** The *whole* Editor Layout affordance set from the 2026-06-11 brainstorm needs to be re-looked at as one body of design work before any of it is implemented — not just the lineage rail. The affordances (`docs/design/specs/assets/2026-06-11-editor-layout/`): per-node chrome (§3 `block-unit`), columns (§6 `columns` → Stage E), the gutter-lineage rail (§8 `gutter-lineage` → Stage F), and the document map (§8 `doc-map` → Stage F). Several shipped partially or diverged in implementation; the design itself is "not landing where we thought." **Leave ALL affordance UI alone during the current close-out; re-brainstorm §8/§3/§6 against what was learned building the block model, then re-plan Stage E/F.** The lineage rail below is the most-diagnosed example of the divergence.

**What (lineage rail — worked example):** The shipped rail affordances do not realise the §8 gutter/lineage design (`docs/design/specs/assets/2026-06-11-editor-layout/gutter-lineage.html`, decision C — Hybrid). That design is ONE coherent gutter language: (1) a faint always-on "participates in lineage" tick in the rail — the `.gut`, `rgba(120,140,255,.22)` — which DID ship as `.block-chrome-rail`; (2) **bracket-chain connectors** drawn in the gutter, spanning a source block down to its consumers on hover/select — the actual ref *edge*, which is the whole point ("references cause spooky-action-at-a-distance; the rail makes it legible"); (3) always-on dirty-glow for stale blocks (safety; gated on the separate reconciler project); plus the doc-map. **Only layer 1 shipped.** What shipped *instead* for active states are two ad-hoc per-block solid left-accents in unrelated colours — orange (`block-ref-active`, AI-chain hover/active) and indigo (`block-ai-target`, the `ctrl+shift+a` jump-to-ASK cue) — a **parallel** visual system, exactly what `project_block_anchor_lineage` warned against. They mark "this block is involved" but never draw the edge/topology.

**Specific defects observed (2026-06-29, in-app):** the indigo jump-to-ASK rail is an imprecise, overlapping blue *blob* — **not** gutter-aligned, does not sit where §8 put it. Likely cause: the line-number column is in the way; the highlight needs to live in the **gap to the LEFT of the line number**, in the gutter. (B-D — chain-bracket gating on prose — folds in here; live check showed the orange chain affordance now paints on prose, so B-D as written is moot.)

**Why deferred:** This is **Stage F** (layout/lineage lenses), already deferred to a future branch. The affordances must be re-planned AS A SET against the §8 design — not patched piecemeal, which would only make the placeholder more uniform without delivering the lineage language. User decision 2026-06-29: **leave all rail/bracket/highlight UI affordances alone during the current close-out.**

**Retires when:** Stage F is planned and built — re-brainstorm §8 against what was learned building the block model, then implement the unified gutter language (participation tick + on-hover bracket-chain connectors, positioned in the gutter gap left of the line number), with dirty-glow following the reconciler project.

## C-T: Stale test files pin retired designs — ✅ RETIRED 2026-07-07

**RETIRED:** 2026-07-07 — resolved by earlier work, verified today. `frontend/test/render-exact-shadow.test.js` was already deleted in commit `d6f6d94` (its concern — exact server-shadow render with synthetic trailing node / proseIdentity delete — retired when TrailingNode was dropped). `frontend/test/proseidentity-loop.test.js` was already rewritten during the B-A close-out and now pins the CURRENT token→mint→ack model (transient `tok-…` stamps, split-copy clears via `dedupeActions`, convergence guard) — verified assertion-by-assertion 2026-07-07; it stays.

**What (historical):** Two vitest files assert behavior of designs that were since retired and should be deleted or rewritten to the current model: `frontend/test/render-exact-shadow.test.js` and `frontend/test/proseidentity-loop.test.js` (they pin pre-node-granular / pre-`proseGroup` expectations). They currently pass but encode obsolete intent.

**Why deferred:** cosmetic/test-hygiene, not a product bug. **Retires when:** each is reviewed against the current block model and deleted (if its concern is now covered elsewhere) or rewritten. Moved here from the archived plan.

## I-A: Interaction-contract deferred items (auto-pair, Playwright matrices)

**Tracked:** Forgejo #21

**What:** (1) Bracket/quote auto-pairing in code blocks — designed as an `autoPair` policy flag on the interaction-policy extension, deferred until it can be proven not to fight PM input rules. (2) The contract matrices in `docs/editor-interaction-contract.md` are the intended test inventory for the planned Playwright browser harness; until it lands they are a manual checklist.

**Why deferred:** Auto-pair is a stretch affordance (spec 2026-07-04); the harness is its own spec (`project_testing_strategy`).

**Retires when:** auto-pair ships behind the policy flag, and the matrices are encoded as Playwright tests.

## I-B: Backspace/Delete at read-only block boundaries can still join via core keymap

**Tracked:** Forgejo #21

**What:** The policy extension consumes editing keys inside `readOnlyText` blocks (log) as a low-priority backstop. Mid-text this is airtight (core keymap commands fail there and fall through), but at block **boundaries** core `joinBackward`/`joinForward` may act before the backstop (they run earlier). Pre-existing edge — the old per-renderer guard had the same ordering.

**Retires when:** boundary cases are pinned in the contract matrix during a conformance pass and, if confirmed, guarded via a `filterTransaction` on the policy extension (transaction-level, ordering-immune) rather than more key handling.

## W-A: wails devserver panics on external-browser WebSocket upgrades (assetdir mode)

**Tracked:** Forgejo #21 documents the constraint.

**What:** `wails dev` in assetdir mode (no external frontend dev server) leaves the devserver's `wsHandler` nil; ANY WebSocket upgrade hitting the external port (`:34115`) panics at `devserver.go:113` (`invalid memory address`, recovered per-connection by echo). The app's own webview is unaffected (it reaches the asset server directly), but **external browsers can never open `/api/ws` through the dev port** — so browser-driven testing (headless Chrome/CDP, the planned Playwright harness) cannot exercise any WS-dependent editor path in dev mode.

**Why deferred:** upstream wails v2.12.0 bug (`internal/frontend/devserver/devserver.go` — `wsHandler` only assigned when a frontenddevserverurl exists). Not fixable in-repo without a go.mod replace/patch.

**Retires when:** wails fixes it (or v3 migration lands — see WAILS-V3-MIGRATION), or we add a go.mod patch. Interim workaround for WS-path testing: in-process Go tests dialing the chi handler directly (see `requesthandlers/ws_takeover_test.go` harness).

## V-B: Tabs render via HTMX templates behind the Workspace API facade, not a self-rendering JSON component

**Tracked:** Forgejo #31 (X-C epic)

**What:** P2.D (2026-07-10) gave the Workspace the correct EXTERNAL posture — `open/newNote/close/closeActiveTab/closeAll/reorder/loadTabs` are the sole front-end entry points for tab mutation and the tabbar render. The INTERNALS still drive the existing server-rendered HTMX templates (`tabbar.html` + OOB `editor.html`) via HTML swaps; `SieveTab` is a passive identity, not a self-rendering component. Intended end-state: a read-only session-tabs JSON endpoint (`LoadSession → RefreshTabStatus → marshal {tabs, activeIdx}`); the Workspace fetches JSON and reconciles `SieveTab` children; each `SieveTab` renders its own element and wires its own handlers; the Workspace owns the strip chrome (`+`, overflow). This collapses stale-tab handling, the `session:changed` refetch, the `data-uuid` scrape, and the OOB editor mount into one model-diff loop, and makes the tabbar the first mover of "components own themselves."

**Why deferred:** de-risking + avoiding scope creep — the API facade (the load-bearing part) lands now behind the proven templates; the render port (~150 lines faithful to `tabbar.html`) + the Go endpoint + the consistency divergence (first JS-rendered component while sidebar/meta/prompts stay HTMX) are a separate phase the facade *enables*.

**Retires when:** the tabs-JSON endpoint + self-rendering `SieveTab` land; callers are untouched (they depend only on the Workspace verbs).

## V-C: `agy` (Antigravity CLI) AI backend returns agentic non-answers

**Tracked:** (unfiled)

**What:** `sieve/ai/cli.go` `buildBaseArgs` invokes the configured AI CLI. For `claude` it passes `--print --no-session-persistence --dangerously-skip-permissions` (a clean one-shot: prompt in via stdin, answer out). For `agy` it passes `--print --dangerously-skip-permissions`, but `agy`'s `--print` is NOT a clean one-shot mode — it runs **agentically** (narrates its own tool calls, `ash cwd=…` banner) and **fixates on the `--dangerously-skip-permissions` flag it was handed**, returning a canned explanation of `agy --dangerously-skip-permissions` / "YOLO mode" instead of answering the prompt. Confirmed live 2026-07-11: the same doc + question yields correct answers under `claude` and permission-flag nonsense under `agy` (two repros, different libraries). The prompt assembly, frontend selection, and SelectionModel are all correct — the TARGET/ACTION in the dump are right; only the CLI backend misbehaves.

**Why deferred:** backend/config, not core Sieve logic; the `claude` backend works today. Needs the correct `agy` non-interactive invocation (likely drop `--dangerously-skip-permissions` for `agy` and/or use its real "answer stdin and exit" flags — cf. the default case's `--prompt "" --yolo --silent`), or `agy` is documented as unsupported.

**Retires when:** the `agy` `buildBaseArgs` case produces clean one-shot answers (or `agy` support is removed). NOTE: a *separate, related* prompt-contamination bug found while diagnosing this — the ACTION entry leaking the ai-block's own prior answer — was FIXED (commit `bc07b89`, `ai_block_processor.go` `qaHeader`), not deferred.

## X-E: Structured-block attr edits use a separate sync channel, not the unified PM-observer — attr changes aren't undoable

**Tracked:** register only (deferred out of P4.F by user decision 2026-07-14 to manage scope — "same behaviour is fine"; P4.F does the de-globalization only, this is the follow-up).

**What:** Sieve (structured) blocks persist attribute changes (mode toggle, resize, dialog save, code/diagram source) through a channel SEPARATE from prose. `block-sync.js` (the PM-observer diff core) DELIBERATELY excludes structured blocks (`block-sync.js:7-12` — it only signatures them for baseline + delete detection, never emits a content/attr op). So structured attrs ride: `ctx.updateAttributes(patch) → editor.applyBlockOps([updateBlockOp(...)]) → Go → render-back 'block-attrs-updated' → surface setNodeMarkup(…, addToHistory:false)`. Two consequences: (1) prose and structured blocks sync through two different mechanisms (the observer vs a direct op) — not the "one uniform mechanism" the codebase prefers ([[feedback_prefer_uniform_patterns]]); (2) because the render-back applies `addToHistory:false`, **structured attribute changes are NOT undoable** (a mode toggle / resize / source edit can't be Ctrl+Z'd), unlike prose edits.

**Why deferred:** P4.F's job is to DELETE editor.js and de-globalize the block capabilities (Option A: `ctx.updateAttributes`/`ctx.retry` become base methods that call the editor DIRECTLY, killing the `sieve:*` global events + handlers — behaviour-identical, not-undoable preserved). Because both capabilities are solved ONCE in the base `ctx`, and every renderer just delegates to it, the sync MECHANISM can evolve behind that stable base API later with ZERO renderer churn. Doing the unification inside P4.F would change block-sync scope + undo semantics + the render-back protocol mid-dissolution — a scope/risk P4.F should not carry.

**Retires when (Option B):** `ctx.updateAttributes(patch)` commits a TRACKED `setNodeMarkup(getPos, …)` transaction, and `block-sync` is extended to sync structured attr-signature changes so prose AND structured ride ONE observer-driven channel. Result: attribute changes become undoable, the two-channel split collapses, and structured blocks become local-authoritative for attrs like prose (Go persists but must stop redundantly rendering them back). Blast radius is contained to the base `ctx` method + `block-sync.js` (NOT the renderers, which keep calling `ctx.updateAttributes`). Investigate the render-back suppression carefully (mirror how prose avoids a Go echo). Related: [[X-D]] (renderer class hierarchy — the base that would host `ctx.updateAttributes` as a real method).

## SEC-A: User prompt-override is a functional and security defect — job instructions are user-editable

**Tracked:** Forgejo #42 (defect). Identified 2026-07-17, brainstorm session.

**What:** The prompt-override feature (PromptEditor) lets a user replace an AI job's **entire prompt template** — including the job instructions and response-format contract. This is a defect on three axes. **Functional:** an override forks generated-output-as-source-of-truth; it silently rots as base prompts evolve, and deleting/garbling the response-format section breaks Go's parsing with no signal to the user. **Security:** it is a self-service prompt-injection surface — a job labelled "Refine language" can be rewritten to do something else entirely while every UI affordance still claims the original purpose; and because prompts carry untrusted content (pasted email threads, fetched web-clips), a user-editable template dissolves the instruction/data boundary that is the injection defence. **Feature:** the one real-world use observed (injecting personal/work context so answers are tailored) never needed template surgery at all — it is user *data*, not instructions.

**The fix mechanism (designed, not built):** the **protocol-role model** — `docs/design/brainstorm-ai-protocol-roles-chats-and-document-kinds.md` §1 ("Protocol roles, not prompts"). The role template is **Go-owned code** (git-versioned, reviewed; the prompt-layer sibling of the #41 containment work): task, schema, obligations, repair loop — never user-editable. User customisation survives as **typed, enrich-only addenda**: strongly-typed objects (Profile, CommsStyle) edited as a **settings tab** (forms over a schema — not free text, not blocks/Things; two hammer-reaches explicitly retracted in design: a free-text "System Prompt Thing" and profile-as-Thing). Roles declare which addendum kinds they accept; the generator renders accepted addenda into clearly-labelled *data* sections (`USER PROFILE (informational):`), never spliced into instructions. **ASK is the one designated free-text slot** — free text is that job's payload, still wrapped by Go-owned scaffolding; the rule everywhere: *users fill slots; they never edit templates.* Transparency replaces overridability: the generated prompt is inspectable read-only per job ("show what was sent").

**Why deferred:** the fix rides the role formalisation (the workbench evaluator is the planned first formal role — same brainstorm §10 sequence); ripping out prompt-override before roles exist would remove the only personalisation mechanism users have.

**Retires when:** the role/addenda model lands: role templates in Go, a typed profile/style settings tab feeding the prompt generator, PromptEditor's template-override retired (its successor is the typed-form settings surface), and per-job prompt inspection available. Verify: no store-resident text can alter a job's instructions or response contract.
