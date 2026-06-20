# Sieve Block Document Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pivot Sieve from "markdown is the model" to "blocks are the model" — a uniform, ordered, addressable block tree where markdown is a storage serialization produced by one backend spine, delivered as a staged cutover (Go-testable core first).

**Architecture:** A new ordered `BlockDoc` tree of `DocBlock`s replaces the flat `markdown + map[id]*SieveBlock` pair. A single backend serialization spine (`ParseBlockDoc` / `SerializeBlockDoc`) round-trips the tree against markdown, retiring the `InjectBlocks` byte-splice (markdown_parser.go:321) and, later, the JS document-level serializer. Prose travels as markdown content per block; ProseMirror stays confined to the frontend; the Store seam owns persistence. Migration is a one-time internal cutover (NOT strangler) — no backward-compat shims; intermediate stages need only compile + pass tests, and the app is runnable end-to-end again from Stage D.

**Tech Stack:** Wails v2 + Go + chi + HTMX; goldmark (markdown AST), `gopkg.in/yaml.v3`, the existing `sieve/fencedblock` literal-style YAML machinery; TipTap/ProseMirror (frontend only). No React. No new npm deps.

**Spec:** [`docs/superpowers/specs/2026-06-17-block-document-model-design.md`](../specs/2026-06-17-block-document-model-design.md)

---

## Progress / handoff log

- **Stage A — COMPLETE** (2026-06-17). All four tasks (A1–A4) implemented via TDD; checkboxes ticked below. New files: `sieve/block_document.go`, `sieve/block_document_test.go`. `go test ./sieve/ -run BlockDoc` green; full `go test ./...` green (no regressions, nothing wired into the app yet). Commits: `Block model: DocBlock/BlockDoc types…` → `…round-trip stability test (mixed doc incl column-row)`.
- **Stage B — COMPLETE** (2026-06-17). Tasks B.1–B.4 implemented and passing, including stacked alias marker support for merged prose blocks on serialize/deserialize to ensure referential survival across reopens.
- **Stages C–F — ATTEMPTED BIG-BANG, REVERTED** (2026-06-17). An attempt implemented C–F as a single uncommitted big-bang cutover *without* the plan's mandated TDD / just-in-time bite-sizing / runnable checkpoints. It produced thousands of runtime errors across multiple subsystems (per-keystroke block creation via `ensureSieveBlockAnchorsAndIds` re-wrapping a trailing bare paragraph; `requestAnimationFrame(syncSieveChrome)` firing after EditorView destroy → `nodeDOM` null `descAt`; PM decoration/view desync → `Index N out of range`; `ws timeout: flush` on document switch; doc loading with an unwrapped trailing paragraph). Reproduced deterministically via headless-Chrome CDP against the dev server (typing `abc` grew the doc 8→11 top-level blocks). **Reverted** to the committed Stage A/B baseline (`8c72ca6`). The full attempt is preserved on branch **`wip/block-model-cf-attempt1`** (commit `0293f26`). Salvageable-for-reference Go pieces: `BlockDoc.CreateBlock/UpdateBlockContentAndAttrs/MoveBlock`, the `block-op` WS envelope (`ws_handler.go` + `EditorService.HandleBlockOp`), and `sieve/block_index.go` (+ test). The rotten core is the frontend per-keystroke observer in `editor.js` (+467/−22, zero tests) — do NOT cherry-pick it; redo with TDD.
- **Stage C — Go side COMPLETE** (2026-06-17). C.2a/C.1/C.2b/C.2c done (see Stage C below). The block-op envelope + `HandleBlockOp` + `ApplyOp` + flush-through-spine all landed and are tested. The app stays runnable via the `doc-update` bridge.
- **Stage D — partially done, then PIVOTED** (2026-06-18 → 2026-06-19). D.1/D.2/D.3 landed (prose-renderer `sieve-prose`, `block-render.js`, `computeBlockSync` observer, `frontend_block.go`) but with prose as **one `content:'block+'` block per prose run** → "1 doc == 1 prose block" coarseness (a whole run like `1\n\n2\n\n34\n\n5` serializes under one id). **The 2026-06-18 node-granular spec + its split/merge keymap attempt churned and were reverted** (`b069bde`). **New design (2026-06-19, locked):** [`docs/superpowers/specs/2026-06-19-node-granular-prose-blocks-design.md`](../specs/2026-06-19-node-granular-prose-blocks-design.md) — node-granular via **native ProseMirror, NO keymap**. **A `kind:prose` block is one top-level TipTap node of ANY type** (paragraph/heading/ol/ul/task-list/table/blockquote/…), tagged with a `blockId` global attr, `content` = that node's arbitrary markdown. NOT a textblock; NOT restricted to paragraphs. Retire the custom `sieve-prose` `block+` container (the "one DIV swallows the run" bug). `nested-prose` (a code-created `block+` tree) is deferred. The **full paired `<!--s:ID-->…<!--/s:ID-->` delimiters already implemented stay** (granularity changes, format does not). **D.4's keymap + `splitHandles`/`mergeHandles`/`Aliases` alias-union are CUT.**
- **Stage D node-granular redo — D-r.2+D-r.3+D-r.4 DONE** (2026-06-19). Native top-level nodes ARE the blocks (`blockId` global attr); `sieve-prose` container + `prose-renderer.js` retired; per-node load render + markered save round-trip + **per-node frontend minting → create-block per node** all verified in-app (CDP) + on disk (PM's N nodes == N delimited blocks). Latent baseline bug fixed via `seedBaseline`. Two extra refinements landed this session: (a) prose formalized as a first-class **block kind** in a shared registry (`block-kinds.js`/`prose-block.js`) so it is symmetric with structured kinds (differ only by a `native` flag); (b) Go **block-id discipline** — a `newDocBlock` factory mints at construction + a serialize-time guard refuses to persist an id-less block.
- **Tech debt B-A** (`docs/TECH-DEBT.md`): prose ids are frontend-minted, not backend-authoritative like structured blocks. Deferred by user decision (2026-06-19); retire via a `create-block`→mint→ack round-trip.
- **Stage D — D-r.5 DONE** (2026-06-19). Prose `doc-update` fallback retired: `computeBlockSync` treats an id-less prose node as pending (skip, no fallback); the fallback survives only for structured-block edits + markdown mode. vitest 72 green; CDP gate confirmed a prose-only session emits only block-ops, zero `doc-update`. See D-r.5 below.
- **AI targeting rewire — designed, deferred to D-r.7** (2026-06-19). User reported the AI ref chain resolves to `doc` and Ask/Explain answers split the target block. Root-caused (the targeting layer keys on legacy `blockRef`/`sieve-*`+`attrs.id`, not native prose's top-level-node+`blockId`). Approved design spec `docs/superpowers/specs/2026-06-19-unified-block-targeting-design.md` + tech-debt **B-B**. Recorded as plan task **D-r.7** to pick up at the appropriate point; NOT implemented now.
- **Stage D — D-r.6 DONE** (2026-06-19). Regression sweep all green in WebKitGTK (CDP): free-flow typing (no churn), cross-paragraph selection (0 errors), sieve-block copy/paste (duplicates clean; pre-existing duplicate-id observation), tab-switch (0 `nodeDOM`/`descAt`), reopen byte-stable with full paired delimiters, multi-paragraph paste → N delimited blocks. Zero console errors. **Stage D node-granular prose is COMPLETE** (D-r.2→D-r.6); D-r.7 (AI targeting) is designed + deferred.
- **Stage D — D-r.7 DONE** (2026-06-19). Unified block identity + AI targeting (retires tech-debt **B-B**). 3 TDD commits (`D-r.7 (1/3)…(3/3)`): (1) prose `blockId`→`id` (PM-attr layer only; disk markers carry the value → round-trip untouched); (2) `resolveAiTarget` keys on node *character* (`isFlowingText`=paragraph/heading→`doc`; unit/NodeSelection→block by id; non-empty TextSelection→`==`+ref chain of every crossed top-level block via `topLevelIdsBetween`; stays pure); `buildAiContext` reads `t.ref`; `applyTargetHighlight` just applies `==` (no `blockRef` wrap); `describeTarget` gives readable Ask-panel header nouns; (3) one `blockInsertPos(state,isInline)` (inline→caret, NodeSelection→after node, else `$to.after(1)`) folds in `aiInsertPos` and replaces the scattered `sieveInsertPos=selection.to` at all six additive create sites (via `captureInsertPos`/`kindIsInline`) — **the Ask-AI paragraph-split bug is fixed**. 87 vitest green (`prose-identity`+rewritten `ai-target`+`block-insert-pos`); `go build` clean; in-app CDP gate PASS (answer after the block, selection refs its block id, 0 console errors). `blockRef` node-type retirement stays Stage E.
- **Post-D-r.7 stopgap DONE** (2026-06-19). D-r.7's uniform AI targeting exposed the Go side still half in "markdown is the model": `ShadowDocument.Blocks` excludes prose, so a prose ref chain (`pr-1,pr-2`) gathered no prompt context. Stopgap (commit "Go stopgap: AI ref chains resolve prose blocks (getBlock seam)"): added `ShadowDocument.getBlock(id)` (uniform accessor over the block tree, Blocks-map fallback), routed `BuildContextForID` + `expandAIBlockRefs` through it, snapshotted `Doc` into the AI job context. TDD (`shadow_getblock_test.go`); full Go + 87 vitest green. First brick of the **ShadowDoc refactor** (tech-debt **B-C**).
- **ShadowDoc uniform-block refactor (B-C) — COMPLETE** (2026-06-19; tech-debt B-C ✅ RETIRED). ONE `SieveBlock` type (DocBlock merged in), payload in `Attrs`, `ShadowDocument.Blocks []SieveBlock` held directly, markdown derived on demand, lock-free `DocView` snapshot (B-F). See `docs/TECH-DEBT.md` B-C and memory `project_shadowdoc_uniform_block_refactor`.
- **Serialization is a processor concern — DONE** (2026-06-19). `BlockProcessor.Serialize` is ON the interface; `FencedSerializer` (shared YAML) + `ProseProcessor` (owns `<!--s:ID-->` markers) + the save spine just walks blocks and asks each — no kind-switch. The Stage B-D parallel free-function spine (the root cause of ~6 sessions of friction) is deleted. Memory `project_serialization_is_a_processor_concern`.
- **Deserialization is a processor concern — DONE** (2026-06-19; the mirror of serialization). Sub-plan [`docs/superpowers/plans/2026-06-19-deserialization-documentcodec.md`](2026-06-19-deserialization-documentcodec.md), 9 tasks TDD + reviewed. A `DocumentCodec` **service** owns both directions over an injected `ProcessorRegistry`; a kind-blind `RegionScanner` splits markdown into regions; every processor gained `Accepts`/`Deserialize`; the registry is the SOLE authority on structured kinds (no YAML-id heuristic, no kind-awareness in the codec); unsupported kinds (e.g. `column-row` until Stage E) coalesce to prose, text preserved verbatim. The dead `scanBlocks` parallel parser is gone — round-trip tests run through the production codec. Memory `project_deserialization_processor_concern`. Spec `docs/brainstorm-deserialization-is-a-processor-concern.md` + `docs/superpowers/specs/2026-06-19-deserialization-documentcodec-design.md`.
- **Ownership cleanups (audit-driven, same session) — DONE** (2026-06-19). `block_serde.go` eliminated (serialization rehomed onto `DocumentCodec`; dead `split/merge` rules + handle shims deleted). Block ops are **methods on `ShadowDocument`** in `shadow_document.go` (`ApplyOp`/`findBlock`/`removeBlock`/`insertBlockAt` — called on the document, not free functions); `block_op.go` gone; `ShadowDocument` + its methods moved out of `editor_service.go`. The `diskBlocks` **dual-source-of-truth bug fixed**: a closed-doc job update now opens a **transient `ShadowDocument`** (one update path), and the transient open skips stuck-job recovery (`recoverStuck=false`) so it neither churns nor races the Close. Branch green (build/vet/suite/race). Commits `f071369`…`f42fb66` on `feature/refactor_editor_layout`.
- **Captured as tech debt this session:** **S-A** (flat-package decomposition — Go `sieve/` AND JS `static/`; `docs/TECH-DEBT.md`). The whole audit (`block_serde`/`block_op`/`frontend_block`/`DocView`/test-sprawl) is one root cause: no package boundaries. Blocker to the Go split = `BlockServices` holding concrete service pointers (service↔processor import cycle). Memories `project_package_layout_direction`, `project_single_source_of_truth_blocks`.
- **S-A GO DECOMPOSITION — DONE (2026-06-20).** `sieve/` flat package → 6 cohesive packages, acyclic DAG `domain ← block ← {block/processors, services} ← ai ← root`, full suite + `-race` green. Cycle broken via `block`-owned port interfaces (`BlockServices` is now a struct of ports). Plan `docs/superpowers/plans/2026-06-20-flat-package-decomposition.md` + spec `…/specs/2026-06-20-flat-package-decomposition-design.md`. 9 commits (`c0a3c62`…`5b535f3`). Side wins: **ShadowDocument owns its data+mutex** (EditorService orchestrates via exported methods, never touches `shadow.mu`); registry owns paste-matching (`FirstPasteMatch`); latent `FrontendBlocks` data race fixed (`SnapshotBlocks` deep-copies Attrs). New **design principle** recorded in CLAUDE.md + memory `feedback_no_loose_functions` (no free functions; behaviour on the owning type — the loose-symbol sprawl is what made this hard). STILL OPEN from S-A: JS `static/` regroup; single-source-of-truth (`mdModeBuffer`); the no-loose-functions backlog (`block/` codec/parser free funcs). New tech-debt **S-B** (codec prose-fallback clarity, user-flagged). Memories: `feedback_no_loose_functions`, `project_package_layout_direction`.
- **Stage E DESCOPED + block anchors RETIRED — DONE (2026-06-20).** Stage E (containers/columns) was **descoped** as speculative ("columns are layout, not a thinking-tool need"); SieveBlock stays a **LEAF**. The Item/ContainerProcessor design (capability-interface discrimination) is **recorded-only** for if/when *nesting* actually pulls — do NOT build it. Shipped instead: removed dead column-row/column code; **retired block anchors** (`[!block]`/`blockRef`) now that native prose carries its own id (D-r.7). Promote-to-Doc → **Transform-to-Prose** (new primitive `ShadowDocument.ReplaceBlock`; legacy `[!block]` upgrades on read in `scanProseRegion`; targets replicated via `ProseProcessor.BuildContext` ==highlight== → "Specifically regarding"). Deleted `block_anchor.go`, the goldmark `[!block]` parser/node + `==target-highlight` inline parser, the frontend `blockRef` node. Fixed prose ref-chain hover glow via a `refChain` PM decoration (classList doesn't stick on native PM nodes → memory `project_pm_native_node_classlist_gotcha`). 8 commits `13ed16e`…`f853b11`.
- **Processor-owned segmentation — DONE (2026-06-20; tech-debt S-B ✅ RETIRED).** Completed the SerDes trilogy: **segmentation is now a processor concern** too. `Shape()` `(head,tail)` rides on the `BlockProcessor` SerDes surface (free via embedded `FencedDeserializer{Kind}`/`ProseProcessor`); a single custom goldmark block parser recognises every registered shape as an opaque raw span; `RegionScanner` walks it; `DocumentCodec.Deserialize` collapsed to first-acceptor-wins with prose sorted last (`orderedProseLast`) — `firstAcceptor`-exclusion + `flushProse` coalescing DELETED. Fixed an all-prose regression (codec must collect shapes from the LIVE registry per scan — it's wired before processors register). Spec/plan `…2026-06-20-processor-owned-segmentation*`. Reviewed ("merge with fixes" — applied). Commits `88f7238`…`76c2cc1`. Memory `feedback_prefer_uniform_patterns` (don't split a common pattern into type-like categories).
- **AI ref-chain geometric walk — DONE (2026-06-20).** `AIBlockProcessor.RunJob` resolves chains by **geometry, not position**: `resolveChain` walks the point-to-point ref graph from the action block — a node WITH a ref is interior→THREAD (recurse), a node with NO ref is a leaf→TARGET (the terminal MANY); `doc` is a leaf; seen-guard for cycles; thread oldest-first. Retired one-level `expandAIBlockRefs` + the position-based content/history split. Fixes the multi-block-selection mis-split and the deep-chain unreachable-source bug (the frontend already stores direct point-to-point refs, not flattened). Commit `be0a17d`.
- **AIContext framework — DONE (2026-06-20).** `ContextProvider.BuildContext` returns a structured `block.AIContext{NodeIDs, Content, Tags}` instead of a pre-formatted string. `MergeContexts` composes a collection (a MANY) into one — NodeIDs concat, Content append, `Tag.Values` union (deduped), never fusing atoms; `String` renders one `NODE ID:` header + content + each trailer tag (empty values skipped). Fixes multi-target prompt legibility (one merged id header + one `Specifically regarding`, so an LLM maps a THREAD `QUESTION ABOUT` to the target). Prose focus highlights became a mergeable trailer Tag; renderers (smart-image ALT/Summary, web-clip URL/Title) emit metadata as tags. Migrated all 9 `BuildContext` implementers. Spec `…2026-06-20-aicontext-collection-merge-design.md`. Commits `daa34ad`, `f357dfb`.
- **Data-loss guard — DONE (2026-06-20).** `flushShadow` refuses to overwrite a **non-empty** doc with **empty** content — an empty derive (failed `codec.Serialize` → `deriveMarkdown` returns "", or a transient empty markdown-mode buffer) was wiping files. Regression test reproduces the wipe. **ROOT CAUSE of the empty derive still OPEN** (needs an in-app repro log: `"serialize block doc failed"` vs the new `"REFUSED empty overwrite"`). Commit `b7dd63e`.
- **Single-source-of-truth (`mdModeBuffer`) — ✅ RESOLVED-BY-INVESTIGATION (2026-06-20).** The framing was wrong: markdown mode is breakglass and **verbatim-buffer save is CORRECT** (save must be independent of a potentially-faulty block tree). `DocView` is read-only, job-creation-time prompt context (write-back is a live delta-merge), so a stale snapshot is correct by design. Only real gap: per-block reads against the frozen tree in markdown mode → added a `SnapshotForJob` markdown-mode coherence guard. Tech-debt `SoT` section. Commits `abf8390`, `17c34c9`. Memory `project_single_source_of_truth_blocks` updated.
- **E-1 (embed-in-document broken) — DISCOVERED + RECORDED (2026-06-20), NOT BUILT.** "Embed in document" loses the block's id for **multi-node** content: Go creates one prose block with the original id, but the frontend renders `kind:prose` as native node-granular nodes → the one block fragments into N fresh `pr-` ids → ref chains break + the frontend posts a lossy mutation **on load** (backend-owns-data violation). Single-node embeds work. **Fix is the already-designed deferred `kind:"nested-prose"`** (2026-06-19 node-granular spec): an actor-created, never-keyboard-split `content:'block+'` container under one backend id, `<!--s:ID kind=nested-prose-->` on disk. Decision locked: container (id survives load+edit), NOT unpack-on-edit (loses id). **Related to B-A** (same root: frontend invents identity). Tech-debt **E-1**.
- **NEXT:** **Stage E is descoped** and **Stage F is descoped for now** (its search half spun out to [`docs/design-block-search.md`](../../design-block-search.md) — *enabled by, not part of* this delivery; its lens half is reconciler-gated). So the core pivot (Stages A–D) + consolidation **is the delivery**, and it's done and running. The remaining **block-model-delivery** frontier is just: (1) **`nested-prose` / E-1** — the embed fix, design ready; (2) **B-A** (backend-authoritative prose ids: token→mint→ack, frontend never mints, load never mutates) — the *foundational* debt that also retires E-1's root and the "roundtrips don't roundtrip" / load-mutates class. STILL OPEN debt (not blocking delivery): **B-D** (chain-active bracket on native prose), **B-G** (retire `serialisedForm` → collapse `FrontendBlock`), JS `static/` regroup, the no-loose-functions backlog, and the data-loss ROOT CAUSE (guard in place; needs a repro log). **Residual Stage-E cleanup** (deletes, not a stage): the legacy goldmark `sieveBlockParser`/`FindBlockByID` still used off the codec path. **CLEANUP CANDIDATES:** `render-exact-shadow.test.js` + `proseidentity-loop.test.js` pin retired designs; the `sieve-block-paste` duplicate-id (`handleSmartPaste` keeps source id).

---

## Fidelity note (read before executing)

This plan commits to the full pivot but front-loads fidelity honestly, per spec §11:

- **Stage A** — fully bite-sized, execution-ready now (real Go code + TDD steps). It is the Go-testable serialization core, built in isolation and **not wired into the running app** — zero behavior change on completion.
- **Stages B–F** — roadmapped: file maps, interfaces, task outlines, exit criteria, dependencies. **Bite-size each just-in-time** when its predecessor lands, because exact code depends on what earlier stages create (and Stage F's live lineage couples to the separate reconciler project, spec §13). Writing exact code for them now would be fabrication.

Each stage compiles and passes its tests on its own; the app becomes runnable end-to-end again at Stage D.

---

## Scope note

The spec's stages are **sequential, not independent subsystems** — each builds on the prior (model → handles → wire → native frontend → containers → lenses). This is therefore **one plan with staged fidelity**, mirroring the precedent `2026-06-11-editor-layout-engine.md` plan, rather than separate per-subsystem plans.

---

## File map (whole arc)

| File | Responsibility | Stage |
|---|---|---|
| `sieve/block_document.go` *(new)* | `DocBlock` / `BlockDoc` types; `ParseBlockDoc` / `SerializeBlockDoc` serialization spine | A |
| `sieve/block_document_test.go` *(new)* | Go round-trip tests for the spine | A |
| `sieve/block_document.go` | Per-paragraph prose split; `{id=}` handle attach/strip; bijection | B |
| `sieve/handle_anchor.go` *(new)* | `{id=}` anchor parse/emit on prose (goldmark inline or pre/post pass) | B |
| `sieve/editor_service.go` | Swap `ShadowDocument` flush from `InjectBlocks` to the spine; handle-set + ref GC | B, C |
| `ws_handler.go` / `sse.go` (verify path) | Block-op envelope over WS (`create/update/delete/reorder/move`) | C |
| `frontend/src/static/editor.js` | Prose transaction observer → debounced per-node ops; consume block list; mint `blockId` on first sync | C, D |
| `frontend/src/static/prose-renderer.js` | `kind:prose` block: flip `content:'block+'` → **textblock** (native Enter-split, no keymap); paired-delimiter `markdownSerialize` already done | D (2026-06-19) |
| `frontend/src/static/block-render.js` / `block-sync.js` | per-node load render; `computeBlockSync` per-node diff (already built) | D |
| `sieve/block_document.go` | By-value container expansion (`column-row` → `DocBlock.Children`) | E |
| `frontend/src/static/column-row-renderer.js` *(from layout plan)* | container NodeView | E |
| `sieve/block_index.go` *(new)* | server-side tree search + structured-facet index | F |
| `frontend/src/static/lineage-gutter.js` / `doc-map.js` *(from layout plan)* | lineage lenses | F |

---

## Stage A — Backend block model + serialization spine

**Goal:** an ordered `BlockDoc` tree and a single spine that round-trips it against markdown, proven by Go tests in isolation. **No wiring into the app** — `ShadowDocument`/`InjectBlocks` are untouched this stage.

**Scope boundary (deliberate):** Stage A handles **prose runs** (verbatim markdown between top-level fenced blocks) + **top-level structured fenced blocks**. The `DocBlock.Children` tree *type* exists but is not yet populated — `column-row` is round-tripped as an opaque structured block (its by-value child expansion lands in Stage E, and is already separately proven by `columnrow_serializer_test.go`). Per-paragraph prose granularity + `{id=}` handles land in Stage B. This keeps the core spine small and fully testable.

**Exit criteria:**
- `ParseBlockDoc(md)` yields an ordered `BlockDoc`: one `DocBlock{Kind:"prose"}` per prose run, one structured `DocBlock{ID,Kind,Attrs}` per top-level fence.
- `SerializeBlockDoc(doc)` reproduces canonical markdown.
- `serialize → parse → serialize` is byte-stable on a mixed document including a `column-row` fence.
- `go test ./sieve/ -run BlockDoc` is green; the rest of the suite is unaffected.

### Task A1: `DocBlock` / `BlockDoc` types

**Files:**
- Create: `sieve/block_document.go`

- [x] **Step 1: Create the types and kind constants.**

```go
package sieve

// DocBlock is a node in the unified, ordered block tree (spec §2). It supersedes
// the flat map[id]*SieveBlock model for serialization. Which payload field is
// meaningful depends on Kind:
//   - prose kinds      → Content holds verbatim markdown; Attrs/Children nil
//   - structured kinds → Attrs holds the fenced YAML payload; Content ""; Children nil
//   - container kinds  → Children holds the subtree; Attrs may hold layout (e.g. widths)
//
// ID is the block's primary handle. In Stage A prose blocks have an empty ID
// (positional); Stage B assigns universal {id=} handles.
type DocBlock struct {
	ID       string
	Kind     string
	Content  string
	Attrs    map[string]interface{}
	Children []DocBlock
}

// BlockDoc is an ordered list of top-level blocks — a tree wherever containers
// nest Children. It is the in-memory form the serialization spine round-trips
// against markdown.
type BlockDoc struct {
	Blocks []DocBlock
}

// Reserved kinds that are not registered BlockProcessors.
const (
	KindProse     = "prose"
	KindColumnRow = "column-row"
	KindColumn    = "column"
)
```

- [x] **Step 2: Verify it compiles.**

Run: `go build ./sieve/`
Expected: no output (success). No name collisions (`DocBlock`/`BlockDoc`/`KindProse` are new).

- [x] **Step 3: Commit.**

```bash
git add sieve/block_document.go
git commit -m "Block model: DocBlock/BlockDoc types + kind constants"
```

### Task A2: `SerializeBlockDoc` (registry-free fence serialization)

**Files:**
- Modify: `sieve/block_document.go`
- Create: `sieve/block_document_test.go`

- [x] **Step 1: Write the failing test.**

```go
package sieve

import "testing"

func TestSerializeBlockDoc_ProseAndFence(t *testing.T) {
	doc := BlockDoc{Blocks: []DocBlock{
		{Kind: KindProse, Content: "Hello."},
		{ID: "co-1", Kind: "code", Attrs: map[string]interface{}{
			"id":     "co-1",
			"source": "x = 1",
		}},
	}}
	got, err := SerializeBlockDoc(doc)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	want := "Hello.\n\n```code\nid: co-1\nsource: x = 1\n```"
	if got != want {
		t.Fatalf("serialize mismatch:\n got: %q\nwant: %q", got, want)
	}
}
```

- [x] **Step 2: Run it to confirm it fails.**

Run: `go test ./sieve/ -run TestSerializeBlockDoc_ProseAndFence -v`
Expected: FAIL — `undefined: SerializeBlockDoc`.

- [x] **Step 3: Implement `SerializeBlockDoc` + `serializeFencedBlock`.** Add to `sieve/block_document.go` (and add `"strings"` and `"sieve/sieve/fencedblock"` to imports):

```go
// SerializeBlockDoc assembles markdown from the block tree — the single
// serialization spine that replaces InjectBlocks (markdown_parser.go:321).
// Prose blocks emit their verbatim Content; structured blocks emit a fenced
// YAML block. Blocks are joined by a blank line (canonical spacing).
func SerializeBlockDoc(doc BlockDoc) (string, error) {
	parts := make([]string, 0, len(doc.Blocks))
	for _, b := range doc.Blocks {
		if b.Kind == KindProse {
			parts = append(parts, b.Content)
			continue
		}
		s, err := serializeFencedBlock(b)
		if err != nil {
			return "", err
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, "\n\n"), nil
}

// serializeFencedBlock renders any block-mode kind as ```kind\n<yaml>\n```
// using the shared literal-style machinery — registry-free, so it serializes
// code, diagram, column-row, etc. uniformly without needing a BlockProcessor.
func serializeFencedBlock(b DocBlock) (string, error) {
	body, err := fencedblock.SerializeYaml(b.Attrs)
	if err != nil {
		return "", err
	}
	return "```" + b.Kind + "\n" + body + "\n```", nil
}
```

- [x] **Step 4: Run the test to confirm it passes.**

Run: `go test ./sieve/ -run TestSerializeBlockDoc_ProseAndFence -v`
Expected: PASS.

- [x] **Step 5: Commit.**

```bash
git add sieve/block_document.go sieve/block_document_test.go
git commit -m "Block spine: SerializeBlockDoc (registry-free fence serialization)"
```

### Task A3: `ParseBlockDoc` (top-level segmentation)

**Files:**
- Modify: `sieve/block_document.go`, `sieve/block_document_test.go`

- [x] **Step 1: Write the failing test.** Parsing recognizes a fence only if a block-mode processor is registered for its kind (the existing goldmark gate), so register the real `CodeBlockProcessor` exactly as `markdown_parser_test.go:77` does.

```go
func TestParseBlockDoc_ProseAndFence(t *testing.T) {
	RegisterProcessor("code", &CodeBlockProcessor{})
	t.Cleanup(func() { UnregisterProcessor("code") })

	md := "Hello.\n\n```code\nid: co-1\nsource: x = 1\n```\n\nWorld."
	doc, err := ParseBlockDoc(md)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(doc.Blocks) != 3 {
		t.Fatalf("want 3 blocks, got %d: %+v", len(doc.Blocks), doc.Blocks)
	}
	if doc.Blocks[0].Kind != KindProse || doc.Blocks[0].Content != "Hello." {
		t.Fatalf("block 0: %+v", doc.Blocks[0])
	}
	if doc.Blocks[1].Kind != "code" || doc.Blocks[1].ID != "co-1" {
		t.Fatalf("block 1: %+v", doc.Blocks[1])
	}
	if doc.Blocks[2].Kind != KindProse || doc.Blocks[2].Content != "World." {
		t.Fatalf("block 2: %+v", doc.Blocks[2])
	}
}
```

- [x] **Step 2: Run it to confirm it fails.**

Run: `go test ./sieve/ -run TestParseBlockDoc_ProseAndFence -v`
Expected: FAIL — `undefined: ParseBlockDoc`.

- [x] **Step 3: Implement `ParseBlockDoc`.** Add to `sieve/block_document.go` (add `"github.com/yuin/goldmark/text"` to imports; `mdParser`, `sieveBlockNode` are already in-package from `markdown_parser.go`):

```go
// ParseBlockDoc parses markdown into an ordered BlockDoc. Only TOP-LEVEL fenced
// Sieve blocks (direct children of the document root) become structured
// DocBlocks; everything between them — prose, headings, lists, and (Stage A)
// legacy block-anchor regions — becomes one verbatim prose DocBlock per run.
// Per-paragraph granularity and {id=} handles arrive in Stage B; container
// child expansion arrives in Stage E.
func ParseBlockDoc(markdown string) (BlockDoc, error) {
	source := []byte(markdown)
	root := mdParser().Parser().Parse(text.NewReader(source))

	var out BlockDoc
	cursor := 0

	emitProse := func(end int) {
		if end <= cursor {
			return
		}
		raw := strings.Trim(string(source[cursor:end]), "\n")
		if strings.TrimSpace(raw) != "" {
			out.Blocks = append(out.Blocks, DocBlock{Kind: KindProse, Content: raw})
		}
	}

	for n := root.FirstChild(); n != nil; n = n.NextSibling() {
		sn, ok := n.(*sieveBlockNode)
		if !ok {
			continue // prose/anchor: absorbed into the surrounding run
		}
		emitProse(sn.StartByte())
		out.Blocks = append(out.Blocks, DocBlock{
			ID:    sn.SieveBlock.ID,
			Kind:  sn.SieveBlock.Kind,
			Attrs: sn.SieveBlock.Attrs,
		})
		cursor = sn.EndByte()
	}
	emitProse(len(source))
	return out, nil
}
```

- [x] **Step 4: Run the test to confirm it passes.**

Run: `go test ./sieve/ -run TestParseBlockDoc_ProseAndFence -v`
Expected: PASS.

- [x] **Step 5: Commit.**

```bash
git add sieve/block_document.go sieve/block_document_test.go
git commit -m "Block spine: ParseBlockDoc (top-level prose/fence segmentation)"
```

### Task A4: Round-trip stability (incl. a `column-row` fence)

**Files:**
- Modify: `sieve/block_document_test.go`

- [x] **Step 1: Write the round-trip test.** Build a mixed doc programmatically (so we never hand-write YAML), serialize → parse → serialize, and assert byte-stability + structure. `column-row` is exercised as an opaque structured block (Stage A scope).

```go
func TestBlockDoc_RoundTripStable(t *testing.T) {
	RegisterProcessor("code", &CodeBlockProcessor{})
	t.Cleanup(func() { UnregisterProcessor("code") })
	RegisterProcessor("column-row", &CodeBlockProcessor{}) // any block-mode processor suffices for the parse gate
	t.Cleanup(func() { UnregisterProcessor("column-row") })

	doc := BlockDoc{Blocks: []DocBlock{
		{Kind: KindProse, Content: "# Title\n\nIntro prose."},
		{ID: "co-1", Kind: "code", Attrs: map[string]interface{}{"id": "co-1", "source": "x = 1"}},
		{Kind: KindProse, Content: "Between."},
		{ID: "cr-1", Kind: KindColumnRow, Attrs: map[string]interface{}{"id": "cr-1", "widths": []interface{}{0.5, 0.5}}},
		{Kind: KindProse, Content: "Tail."},
	}}

	md1, err := SerializeBlockDoc(doc)
	if err != nil {
		t.Fatalf("serialize 1: %v", err)
	}
	parsed, err := ParseBlockDoc(md1)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(parsed.Blocks) != len(doc.Blocks) {
		t.Fatalf("block count drift: want %d got %d", len(doc.Blocks), len(parsed.Blocks))
	}
	md2, err := SerializeBlockDoc(parsed)
	if err != nil {
		t.Fatalf("serialize 2: %v", err)
	}
	if md1 != md2 {
		t.Fatalf("round-trip not stable:\n md1: %q\n md2: %q", md1, md2)
	}
}
```

- [x] **Step 2: Run it.**

Run: `go test ./sieve/ -run TestBlockDoc_RoundTripStable -v`
Expected: PASS. If it fails on the `column-row` block, confirm the parse gate sees a registered block-mode processor for `column-row` (the test registers one).

- [x] **Step 3: Run the whole stage + full suite (no regressions).**

Run: `go test ./sieve/ -run BlockDoc -v && go test ./...`
Expected: Stage A tests PASS; the pre-existing suite stays green (Stage A wires nothing).

- [x] **Step 4: Commit.**

```bash
git add sieve/block_document_test.go
git commit -m "Block spine: round-trip stability test (mixed doc incl column-row)"
```

---

## Stage B — Universal handles + bijection (roadmap)

**Goal:** every block — prose included — carries a stable `{id=}` handle, hidden in the editor and stripped on export, making markdown ↔ `BlockDoc` a lossless bijection. Refine prose from coarse runs to per-paragraph blocks keyed by handle.

**Dependencies:** Stage A. **Exit criteria:** parse→serialize preserves prose handles; a prose block edited in isolation keeps its handle; handle-set union on merge and fresh mint on split are implemented + Go-tested; anchors never reach the editor (strip-on-load / re-attach-on-save).

**Marker decision (locked — spec §3.1):** prose handle = a **leading own-line HTML comment** `<!--s:KIND-hex-->` (e.g. `<!--s:pr-3f9a-->`), handle value via `GenerateBlockID` (kind prefix is a cosmetic hint; resolution is opaque, one global namespace). **Bypass goldmark** — a deterministic strip-from-editor / re-attach-on-save line pass operating **only on prose spans** (fenced blocks keep `id:` in YAML). Marker pairs to the block immediately below it. The id is hidden in the editor but always written back to disk.

**Files & interfaces (bite-size when starting):**
- `sieve/handle_anchor.go` — marker strip/emit (NOT a goldmark parser). `stripHandles(markdown) (clean string, []handleAt)` where `handleAt = {handle string; blockIndex int}` pairs each `<!--s:…-->` to the prose block below it via regex `<!--s:([\w-]+)-->`; `attachHandles(BlockDoc) string` re-prepends a marker line above each prose block carrying an `ID`. Confine to prose spans (use the spine's top-level segmentation; never touch fenced-block byte ranges).
- `sieve/block_document.go` — split prose runs into per-top-level-node `DocBlock`s (needs the deferred goldmark top-level byte-range helper); carry `ID` on prose blocks from the strip map.
- Handle-set type: extend `DocBlock` with `Aliases []string` (absorbed handles); implement `mergeHandles` (union tail into head) / `splitHandles` (head keeps, tail mints via `GenerateBlockID`) per spec §7 + the "next save strips dangling refs" GC.

**Task outline:**
- B.1 prose per-paragraph segmentation (needs the goldmark top-level byte-range helper deferred from Stage A) + tests.
- B.2 `{id=}` anchor attach/strip + bijection round-trip tests.
- B.3 handle-set (`Aliases`) + merge-union / split-mint + undo-stable handle assignment tests.
- B.4 ref GC: strip non-resolving refs on serialize; tests.

### Bite-sized (2026-06-17)

**Segmentation tactic decided during bite-sizing:** the deferred "goldmark top-level byte-range helper" is NOT used. Empirically, goldmark `Lines()` excludes a fenced code block's ``` fences and panics on inline nodes, so AST spans corrupt regular code blocks inside prose. Instead, per-paragraph segmentation uses a **fence-aware blank-line splitter** (`splitProseRun`) over each prose run (the spine already isolates prose runs between Sieve fences via byte cursor). ``` / `~~~` regions are atomic. **Accepted fidelity cost:** blank-line-separated content (loose lists, multi-para list items) splits into separate prose blocks — each still byte-verbatim; tight lists stay one block.

- [x] **B.1** `splitProseRun` (fence-aware) + `ParseBlockDoc` emits one prose `DocBlock` per paragraph; update round-trip test for per-paragraph counts. Tests: `TestSplitProseRun*`, `TestParseBlockDoc_PerParagraph`.
- [x] **B.2** `sieve/handle_anchor.go`: `stripHandles(md) (clean, []handleAt{handle,offset})` + `attachHandles(BlockDoc) string`; `ParseBlockDocWithHandles` / `SerializeBlockDocWithHandles`; marker = own-line `<!--s:HANDLE-->` (regex `^\s*<!--s:([\w-]+)-->\s*$`), paired to the block whose clean-byte start equals the marker's next-line offset. Bijection round-trip tests (handles preserved; isolated edit keeps handle).
- [x] **B.3** `DocBlock.Aliases []string`; `splitHandles(head) (head, tail)` (head keeps id+aliases, tail mints `GenerateBlockID("prose")`); `mergeHandles(head, tail) head` (head unions tail's id+aliases into Aliases). Pure funcs, table-tested incl. undo-stability (split→merge restores exact set).
- [x] **B.4** `gcRefs(refs, resolvable) []string` (drop non-resolving outgoing refs) + `gcAliases(doc)` drops aliases nothing in the doc references. Pure transforms, tested. (Wiring to a live ref-producer lands in Stage E/F; here they are proven as pure functions per spec §7.)

---

## Stage C — Wire protocol (block ops over WS) (roadmap)

**Goal:** replace document-level save with block ops; introduce the Sieve-native envelope and the prose transaction observer.

**Dependencies:** Stages A–B. **Exit criteria:** `ShadowDocument` flush goes through `SerializeBlockDoc` (retiring `InjectBlocks` at editor_service.go:134 and :675); `create/update/delete/reorder/move` ops round-trip; prose edits emit debounced `update-block {uuid, blockId, content}`.

**Files & interfaces (bite-size when starting):**
- `sieve/editor_service.go` — replace `InjectBlocks(s.Markdown, s.Blocks)` with the spine over a `BlockDoc`; `ShadowDocument` holds a `BlockDoc` (or a thin adapter during the cutover).
- WS handler (verify current path via `ws_handler.go` / `sse.go`) — block-op message schema `{op, uuid, blockId, kind, content, attrs, index}`.
- `frontend/src/static/editor.js` — transaction observer: map changed range → owning block handle → debounced `update-block`; detect split (`create-block` + mint) / merge (`delete-block` + union).

**Task outline:** C.1 spine into flush (Go); C.2 block-op schema + handler (Go, table-tested); C.3 transaction observer (JS, manual `wails dev` protocol); C.4 split/merge → ops (JS + Go handle rules).

### Bite-sized (2026-06-17, redo)

**Lesson from the reverted attempt:** the JS observer was the rotten core (per-keystroke whole-tree diff, random ID minting, doc-mutation inside `onUpdate`, rAF-after-destroy). Build and prove the backend contract in Go FIRST, keep the JS thin, and TDD every Go task. Do NOT cherry-pick `editor.js` from `wip/block-model-cf-attempt1`.

- [x] **C.2a** `sieve/block_op.go`: `BlockOp` type + `(*BlockDoc).ApplyOp` — pure create/update/delete/move transforms (top-level + nested), table-tested. Commit `fd25ae9`.
- [x] **C.1** Flush spine: `ShadowDocument` holds an authoritative `BlockDoc`; `contentForSave` goes through `SerializeBlockDocWithHandles`; `InjectBlocks` retired (both callers migrated, function deleted). `Blocks` map is now a derived view (Attrs aliased). Disk-direct job-update path migrated too. Existing tests migrated to the new model. Commit `97ee848`. **Plus** a fixture round-trip test on the user's real blockRef+ai-block doc (no content loss, stable serialization) — commit after `cf21072`.
- [x] **C.2b** `EditorService.HandleBlockOp(uuid, op)` applies an op to the open `ShadowDocument`'s Doc + re-debounces. TDD against a live `EditorService` + in-memory store. Commit `cf21072`.
- [x] **C.2c** WS routing: `ws_handler.go` decodes `{type:"block-op", op:{…}}` → `HandleBlockOp` with an error envelope; wire-contract decode test pins the JSON field names. Commit `cf21072`.

**Go side of Stage C is complete and tested.** The app still round-trips through the existing `doc-update` path (full markdown → Go reparses to Doc → serializes Doc on save), which keeps it runnable. Nothing in the frontend emits block-ops yet.

- [x] **C.3 — thin observer landed in Stage D.3** (`computeBlockSync` + `onUpdate`-marks-dirty + `syncDocument`). Per-node `update-block` works; the remaining per-node granularity (many prose blocks, not one per run) is the **2026-06-19 node-granular textblock redo under Stage D**.
- [ ] ~~**C.4** Enter→`create-block`+mint; Backspace→`delete-block`+alias-union.~~ **SUPERSEDED: no keymap, no alias-union. Split/merge are native ProseMirror; identity is a `blockId` minted on first sync. See Stage D "Bite-sized (2026-06-19)" D-r.4.**

---

## Stage D — Native frontend (roadmap) — **app runnable end-to-end again from here**

**Goal:** frontend renders from the block list; `BlockAnchor` transparent `contentDOM` container (blockRef successor); retire the JS document-level serializer (keep per-block inline markdown↔PM only).

**Dependencies:** Stage C. **Exit criteria:** open/edit/save a real note end-to-end through block ops; free-flow prose typing + cross-paragraph selection intact (regression vs editor-layout Stage 1); per-kind render modes (atoms vs transparent PM nodes) correct.

**Files & interfaces (bite-size when starting):**
- `frontend/src/static/block-anchor-view.js` — transparent container NodeView with real `contentDOM` (PM selection traverses).
- `frontend/src/static/editor.js` — drive NodeViews from the block list; remove the document-level `tiptap-markdown` serialize path; keep per-block inline conversion.

**Task outline:** D.1 BlockAnchor view; D.2 block-list → editor render; D.3 remove document-level JS serializer; D.4 end-to-end manual protocol + selection/copy-paste regression (reuse editor-layout Stage 1 protocols).

### Bite-sized (2026-06-18, redo)

**Anti-patterns that broke the reverted attempt — forbidden here:**
- ❌ Mutating the doc inside `onUpdate` (the per-keystroke `ensureSieveBlockAnchorsAndIds` re-wrapper minted IDs every keystroke → "new line per char"). Block identity must come from the LOADED structure, fixed at load, not patched on every transaction.
- ❌ Whole-tree re-diff on every keystroke. The observer maps only the *changed range* to its owning anchor.
- ❌ `requestAnimationFrame`/`setTimeout` callbacks that call `view.nodeDOM`/`view.state` without a `view.isDestroyed`/docView guard (caused the `nodeDOM → descAt null` flood on tab-switch).

**Verification gate (every task):** the headless CDP harness (`/tmp/cdp_probe2.mjs`) must show: editor mounts, **zero** console errors on load, and after typing N chars the **top-level block count is unchanged** (prose edits never create blocks). A note must be open — see the open-note helper note below.

**Ordering keeps the app runnable** (it currently works via the doc-update bridge; each task is additive until D.3):

- [x] **D.1** `block-anchor-renderer.js` (fresh): transparent `contentDOM` container for prose — `content:'block+'`, `defining:true`, not atom, not draggable; `parseHTML` for `div[data-type="sieve-block-anchor"]`; NodeView `update` returns true only for same type. Registered via `registerSieveRenderer('block-anchor', …)`; script tag after `diagram-renderer.js`. Additive. **Verified via CDP** (`/tmp/cdp_d1.mjs`): registers in `getSieveNodes`, schema accepts it, zero console errors. Commit `0a4d607`.
- [x] **D.2** Render from the block list. Server: `editor_handler` sends `blocks` ([]FrontendBlock) in WYSIWYG load (`sieve/frontend_block.go` `BlockDocToFrontendBlocks`, TDD `frontend_block_test.go`). Client: pure `buildBlocksHTML(blocks, mdRender)` in new `block-render.js` (TDD `frontend/test/block-render.test.js`, 7 cases) builds document HTML (prose → `<div data-type=sieve-block-anchor data-id> <rendered-markdown> </div>`; structured → its `serialisedForm` fence → per-kind fence rule → `data-*` div). `mountWysiwyg(el, uuid, body, blocks)` renders it via the DOMParser-replace path (the proven syncMd pattern) instead of `setContent` — bypasses the markdownit re-parse, reuses each node's `parseHTML`, NO manual ProseMirror JSON. Added a transparent `markdownSerialize` hook to `createSieveNode`; block-anchor supplies one that emits prose children + re-prepends `<!--s:ID-->` handle markers (byte-matching `SerializeBlockDocWithHandles`) so doc-update round-trips. **Gate (manual eyeball — CDP harness unavailable in this env):** real note renders all blocks; code + smart-image round-trip losslessly to disk; stable on edit (no per-keystroke block churn); markdown toggle intact. Handle-less prose renders with empty `data-id` (identity minting deferred to D.4, per design). `go test ./sieve/` + vitest 29/29 green.
- [x] **D.3** Thin observer (replaces doc-update as the *primary* path). `onUpdate` no longer serializes the whole doc per keystroke — it only marks dirty + arms a debounce; the debounced `syncDocument` diffs top-level blocks (`block-sync.js` pure `computeBlockSync`, TDD 7 cases) and emits granular `block-op {uuid, op:{update-block, blockId, content}}` for changed PROSE anchors. **Deliberate deviation:** `doc-update` is KEPT as a fallback (not removed) for cases granular ops can't yet express — no-id prose (identity minting is D.4), a top-level structure change (split/merge — D.4), or a structured-block edit (Go's structured update-block contract is parsed `Attrs`, which the client can't faithfully build from the fence string). This keeps fresh notes lossless and the app runnable; full `doc-update` removal lands once D.4 mints prose ids. `flushSave`/tab-switch/mode-toggle flush the pending sync via `docSyncFlush`; markdown mode keeps its raw `doc-update`. **Also fixed a latent D.1 bug uncovered here:** block-anchor inherits `serialisedForm` from `BASE_ATTRS`, so `isSieveNode()` routed it to block-chrome's Strategy B, which repopulated a `.block-chrome-host` *inside* the editable anchor every frame; lacking `ignoreMutation`, ProseMirror reconciled those chrome writes and recreated the NodeView in a tight loop (~100% CPU, 141k creations idle, severe typing lag — worse in the WebKitGTK app than Chrome). Added the `ignoreMutation: m => !contentDOM.contains(m.target)` guard every other content-bearing sieve block already carries; loop dead (creations now == prose-block count, flat while idle/typing). **Gate (manual eyeball — CDP unavailable):** typing snappy, anchor count stable, save round-trips; `go test ./sieve/` + vitest 36/36 green.
- [ ] ~~**D.4** Split (Enter at block boundary) → `create-block` + minted handle; merge (Backspace) → `delete-block` + alias-union, via `splitHandles`/`mergeHandles`.~~ **SUPERSEDED by the 2026-06-19 node-granular textblock redo below — no keymap, no alias-union. Do NOT implement this version.**
- [ ] ~~**D.5** Regression sweep via CDP.~~ **Folded into the 2026-06-19 redo's final regression task (D-r.6).**

### Bite-sized (2026-06-19, node-granular redo: native nodes + blockId attr) — supersedes D.4/D.5

**Spec:** [`docs/superpowers/specs/2026-06-19-node-granular-prose-blocks-design.md`](../specs/2026-06-19-node-granular-prose-blocks-design.md). **Read it before executing.**

**The pivot in one line:** today a prose *run* is ONE `content:'block+'` `sieve-prose` block (coarse: `1\n\n2\n\n34\n\n5` under one id). Make **each top-level TipTap node — of ANY type (paragraph, heading, ol/ul/task-list, table, blockquote, …) — its own `kind:prose` block**, tagged with a `blockId` global attr, `content` = that node's markdown. TipTap creates/splits/merges nodes natively — **no keymap, no `splitHandles`/`mergeHandles`/`Aliases`.** A `prose` block carries arbitrary markdown; we never restrict or look inside it.

**REUSED as-is (do not rewrite):**
- Go `scanProseRegion` / `ParseBlockDoc` / `SerializeBlockDocWithHandles` — paired-delimiter parse/serialize. **The full delimited block format (`<!--s:ID-->…<!--/s:ID-->`, open = id + aliases, close = id) stays unchanged.**
- `sieve/frontend_block.go` `BlockDocToFrontendBlocks`.
- `editor.js` observer *skeleton*: `onUpdate` marks dirty + arms debounce (read-only); `syncDocument` → `computeBlockSync`; `docSyncFlush` on tab-switch/save.

**CHANGED (the custom `sieve-prose` node is RETIRED — typed prose is native nodes, so these can't be reused verbatim):**
- **Identity = `blockId` global attr** via `addGlobalAttributes` on native top-level node types. It `renderHTML`s to `data-id` / `parseHTML`s from it; the **durable identity lives in the markers**, the attr is only the in-editor carrier (attrs don't survive markdown).
- **Per-node serialization** — reuse the paired-delimiter *format* from `prose-renderer.js` `markdownSerialize`, but generalize it to wrap **every top-level native node's** markdown, not the one custom container. (`prose-renderer.js` itself is retired for typed prose.)
- **Triples builder (`editor.js:200`)** — currently keys on the `sieve-prose` node; change it to read `blockId` + serialized markdown from each **native** top-level node.
- **`computeBlockSync`** — the diff shape is right, but it must additionally treat a **duplicate** `blockId` as "needs minting" (today it only flags *empty* id → fallback). See D-r.4.
- **`ignoreMutation`** — was needed because block-chrome injected hosts inside the *custom* editable prose node; native paragraphs/lists aren't sieve nodes, so block-chrome's Strategy B shouldn't target them — **verify** during D-r.2 that no recreation loop appears (the WebKit perf gate catches it).

**Anti-patterns (unchanged, still forbidden):** no doc mutation in `onUpdate`; no whole-tree re-diff per keystroke; no `rAF`/`setTimeout` calling `view.nodeDOM`/`view.state` without an `isDestroyed` guard.

**Verification gates.** Representation is already decided (D-r.1 RESULT below), so the first build is D-r.2+D-r.3. **In-app WebKitGTK gates** (per `project_test_perf_in_wails_app`; and/or the CDP harness `/tmp/cdp_probe2.mjs` + open-note helper below): editor mounts, **zero** console errors, typing within a node emits `update-block` and does **not** change the top-level block count, and **Enter creates exactly one new delimited block** on disk.

**D-r.1 RESULT (decided 2026-06-19 by the user):** representation is **"any single top-level native TipTap node = one `kind:prose` block"** (NOT a custom `inline*` textblock). Retire the custom `sieve-prose` `block+` container; the blocks are TipTap's native nodes (`paragraph`/`heading`/`bulletList`/`orderedList`/`taskList`/`table`/`blockquote`/…), each tagged with a `blockId` global attr, `content` = its markdown. No spike needed — this is settled; tasks below build it.

- [x] **D-r.2 + D-r.3 — Make top-level native nodes the blocks AND render per-node on load, TOGETHER, TDD.** (2026-06-19) DONE. `blockId` is a global attr (`extensions.js` `T.BlockId` via `addGlobalAttributes` on paragraph/heading/blockquote/lists/table/image/hr/codeBlock); doc schema widened `sieveBlock+` → `(block | sieveBlock)+`; the custom `sieve-prose` `block+` container + `prose-renderer.js` + the per-keystroke `ProseIdentity` minter/trailing-surface plugin are **retired** (gap cursor handles caret-after-atom natively). `block-render.js` emits a prose block's bare native markdown (no wrapper); `renderBlocksIntoEditor` stamps the loaded id onto the first native element (`data-id`) and pushes every parsed top-level node; `topBlockTriple` reads native nodes (`blockId` + clean `serializeNode` markdown). New save-direction module `prose-markers.js` `wrapProseBlock(id, content)`; new `wysiwygMarkdown(ed)` in `editor.js` wraps each top-level native node in paired delimiters (routes all 4 `getMarkdown` call sites). Go needed no change — `scanProseRegion` keeps undelimited runs as one block, and markdownit splits a multi-paragraph block into N native nodes at render. **Latent observer bug found + fixed via the in-app gate:** `seedBlockCache` routed through `computeBlockSync(...,null)`, whose pending-empty filter dropped a loaded empty-but-id'd block from the baseline → first edit fired a duplicate `create-block` (two blocks, one id on disk). Added `seedBaseline()` (block-sync.js) that seeds every id'd server block unconditionally; TDD'd. vitest 59 green (block-render rewritten native; new prose-markers + seedBaseline tests; schema-design pins the new `(block|sieveBlock)+` design). **In-app WebKit gate (CDP @ :34115, `/tmp/cdp_dr2_render.mjs`):** a rich markered doc loads as heading+2 paragraphs(separate)+bulletList(ONE)+sieve-code+blockquote(ONE), each carrying its blockId, **zero console errors**; save direction round-trips byte-identically to the markered disk format. (The "Enter → one delimited block on disk" assertion needs minting → folded into D-r.4.) Commit pending.
- [x] **D-r.4 — Mint blockId on first sync (handle the split-DUPLICATE) + per-node ops end-to-end, TDD.** (2026-06-19) DONE via the **frontend-mint** model (the spec's "mint on first sync"). Pure `mintActions(ids)` (`block-sync.js`, TDD): returns the indices needing a fresh id — empty OR already-seen (the `splitBlock` attr-copy trap: Enter copies the node's attrs so the new half is born with the original's id; first occurrence keeps it, the duplicate is re-minted). The minting plugin lives in `prose-block.js`'s `blockId` extension as an `appendTransaction` (NOT `onUpdate`): history-excluded, runaway-guarded, only FILLS ids (creates no nodes) → convergent. **In-app WebKit gate (CDP `/tmp/cdp_dr4.mjs`, throwaway note):** typing `A`⏎`B`⏎`C` → 3 native paragraphs, 3 UNIQUE blockIds, exactly 3 `create-block` ops (one per node), no empty ids, no fallback, zero console errors; **on disk: 3 paired-delimited blocks, one per node** (PM's N nodes == N blocks). `computeBlockSync` needed no dedup change — the plugin guarantees unique ids before the diff runs. vitest 70 green. **⚠️ Architecture note (user 2026-06-19):** frontend-minting durable ids is INCONSISTENT with backend-authoritative structured blocks; recorded as **tech debt B-A** (`docs/TECH-DEBT.md`) — retire by moving to a `create-block`→mint→ack round-trip. Kept frontend-mint pragmatically (synchronous, working, lowest mid-arc risk).
- [x] **D-r.5 — Retire the prose `doc-update` fallback.** (2026-06-19) DONE. `computeBlockSync` no longer returns `mode:'fallback'` for an id-less PROSE node — it treats it as a **pending editing surface** (the minting plugin fills its id before the next sync) and SKIPS it while still emitting granular ops for the addressable prose blocks. The fallback now fires ONLY for (a) a structured-block edit (Go's structured `update-block` takes parsed `Attrs` the client can't rebuild from a fence) and (b) markdown mode (its own raw `doc-update`, outside `syncDocument`). The id-less guard that remains is structured-only and purely defensive. `syncDocument` needed no logic change (it just stopped seeing `fallback` for prose); comments in `block-sync.js`/`editor.js` updated. **vitest (TDD):** added `skips an id-less prose node (pending) instead of falling back`, `a prose-only edit session never produces a doc-update fallback`, `still falls back for an id-less STRUCTURED block (defensive)`; 72 green. **In-app WebKit gate (CDP `/tmp/cdp_dr5.mjs`, throwaway note, deleted after):** prose-only session (type `A`⏎`B`⏎`C`, then edit the first paragraph) → WS stream = 3 `create-block` + 1 `update-block`, **zero `doc-update`**, zero console errors. Commit pending.
- [x] **D-r.6 — Regression sweep (real app + CDP).** (2026-06-19) DONE — all six checks green in the WebKitGTK app (CDP @ :34115, throwaway notes, deleted after; harnesses `/tmp/cdp_dr6*.mjs`). (1) **Free-flow typing across paragraphs** — `A`⏎`B`⏎`C` → 3 nodes, 3 `create-block`; extending a paragraph adds **no** block (no churn). (2) **Cross-paragraph selection** — `setTextSelection` spanning 3 paragraphs → **0** errors (no `descAt`/`nodeDOM`). (3) **Copy/paste of a sieve block** — insert a `sieve-code` block, NodeSelect → Ctrl+C → Ctrl+V → duplicates to 2 blocks, 0 errors. *(Observation: the paste keeps the source `id` (`co-test`×2) — a duplicate-id in `handleSmartPaste`, untouched by the prose work, pre-existing; follow-up, not a D-r regression.)* (4) **Tab-switch** — open a 2nd note then back → **0** `nodeDOM`/`descAt`/`isDestroyed`/out-of-range errors. (5) **Reopen byte-stable** — flush (switch-away forces it; autosave debounce is 30s) → disk is 6 full **paired** blocks `<!--s:ID-->\n…\n<!--/s:ID-->` (6 open + 6 close markers); reopen + re-flush → byte-identical. (6) **Multi-paragraph paste → N delimited blocks** — real Ctrl+V of `P1\n\nP2\n\nP3` → 3 new nodes → **exactly 3** `create-block`, 3 unique ids → 3 new paired-delimited blocks on disk. **Zero console errors/exceptions across every harness.** No code changes (verification only).

- [x] **D-r.7 — Unified block identity + AI targeting (retires tech-debt B-B).** **(2026-06-19) DONE** via TDD across 3 commits (`D-r.7 (1/3)…(3/3)`). (1) **Identity** — prose `blockId` → `id` (PM-attr layer only: global attr keyed `id`, `renderHTML`→`data-id`/`parseHTML`←`data-id`, no literal `id=`; mint plugin + `topBlockTriple` + `wysiwygMarkdown` read `node.attrs.id`; disk markers carry the value → round-trip untouched). (2) **Targeting** — `resolveAiTarget` keys on `isFlowingText`(paragraph/heading → `doc`); every other top-level node (unit) or **NodeSelection** → that block by id; non-empty **TextSelection** → `==` + ref chain of EVERY top-level block crossed (`topLevelIdsBetween`, in doc order); `topLevelForCaret` bridges DOM-anchored units + doc-level gaps; stays PURE. `buildAiContext` reads `t.ref`; `applyTargetHighlight` dropped the `blockRef` wrap (just `==`); old `findBlockTarget`/`aiInsertPos`/`isTargetName` removed. **Label** (`describeTarget`) maps each unit kind to a readable Ask-panel header noun (per user note). (3) **Insert** — one `blockInsertPos(state,isInline)` (inline→caret, NodeSelection→`sel.to`, else `$to.after(1)`); `editor.js` gains `captureInsertPos`+`kindIsInline`; all six additive create sites (`sieve:create-block`, `capture-insert-pos`, `doCreateSmartCard`, `doInternalize`, smart-paste, `runAiJob`) route through it; in-place conversion/extraction + explicit-position pastes untouched. **Tests:** vitest `prose-identity`(4)+`ai-target`(20, rewritten)+`block-insert-pos`(6, ex-`ai-insert-pos`); fixture extended with native node types carrying `id`; schema-design pinned to `id`. **87 vitest green; `go build ./...` clean.** **In-app gate (CDP `/tmp/cdp_dr7.mjs`, throwaway note, deleted after, headless Chrome → dev server :34115):** caret mid-paragraph → answer inserts at `$to.after(1)` (after the block, NOT the caret) → original block intact + answer as sibling (the user-reported split is gone); selection → `ref` = that block's id (not `doc`); zero console errors. `blockRef` node-type retirement stays Stage E. **Tech-debt B-B retired; B-A (frontend-minted prose ids) still open.** **Approved design (do NOT re-litigate):** [`docs/superpowers/specs/2026-06-19-unified-block-targeting-design.md`](../specs/2026-06-19-unified-block-targeting-design.md). Unblocked by D-r.4 minting; independent of containers (Stage E), so it can land any time after D-r.6 — **pick up at the appropriate point**. Three pieces: (1) **identity** — unify the prose identity attr `blockId` → `id` (PM-attr layer only; disk markers carry the value, round-trip untouched; `topBlockTriple` collapses to one branch); (2) **targeting** — `resolveAiTarget` keyed on node *character*: NodeSelection/unit (blockquote, code, list, table, image, hr, `sieve-*`) → that block by id; non-empty TextSelection → `==` highlight + ref chain of **every top-level block crossed**; bare caret in flowing text (`paragraph`/`heading`) → `doc`. `applyTargetHighlight` drops the `blockRef` wrap (block already has an id) and just applies `==`; (3) **insert** — one `blockInsertPos(state, isInline)` helper (inline → caret; block → `$to.after(1)`, after the enclosing top-level node) replaces the scattered `sieveInsertPos = selection.to` defaults and folds in `aiInsertPos`, so answers never split. In-place conversion/extraction unaffected; `blockRef` node-type retirement stays Stage E. TDD (vitest + real PM schema) per the spec's Testing section; gate in WebKitGTK.

**Open-note helper (for the CDP gate):** the editor mounts on `#tiptap-mount[data-uuid]` via `initEditor` → `GET /api/editor/load?uuid=`. A fresh headless session has no active tab, so the harness must first open a note (create one through the app's note API or click a real note item) before `window.__tiptap` exists. Capture the chosen uuid + open sequence in the harness so the D-r.2–D-r.6 gates are reproducible.

---

## Stage E — Containers / tree + columns (roadmap)

**Goal:** populate `DocBlock.Children` by-value; reframe `column-row` as a real subtree; retire legacy `blockRef`.

**Dependencies:** Stages A–D. **Exit criteria:** a `column-row` round-trips as a `DocBlock` with `Children` (not opaque Attrs); columns render side-by-side; `blockRef` removed; search/serialize traverse the tree.

**Files & interfaces (bite-size when starting):**
- `sieve/block_document.go` — `columnRowToDocBlock` / `docBlockToColumnRow` lift/lower between `ColumnRow`/`Column`/`Child` (columnrow_serializer.go) and `DocBlock.Children`; `ParseBlockDoc`/`SerializeBlockDoc` descend containers.
- `frontend/src/static/column-row-renderer.js` (from the editor-layout plan, Stage 3) — container NodeView on the new substrate.
- Remove `blockRef` / `[!block]` parser (markdown_parser.go:382-549) once columns prove the container.

**Task outline:** E.1 container lift/lower + recursive spine + tests; E.2 column NodeView; E.3 retire blockRef; E.4 tree-aware traversal.

---

## Stage F — Lenses + server-side search (roadmap)

> **SPUN OUT (2026-06-20):** the **search half** (F.1/F.2 — server-side block-level + facet search) is its own idea now, [`docs/design-block-search.md`](../../design-block-search.md). It is **enabled by** the block model, **not part of** delivering it; Library search already covers the doc-level need. The **lens half** (F.3/F.4 — lineage rail, doc-map, dirty-glow) stays a roadmap note here, gated on the reconciler project (spec §13). Neither is on the block-model delivery's critical path.

**Goal:** layout/lineage projections over the id-graph; server-side search that traverses the tree and can query structured facets (handle/kind/refs), not just full text (spec §10).

**Dependencies:** Stages A–E; **live lineage / dirty-glow couples to the separate reconciler project (spec §13) — do not start that part before it lands.**

**Files & interfaces (bite-size when starting):**
- `sieve/block_index.go` — walk the `BlockDoc` tree → full-text + facet index (handle, kind, ref edges).
- `frontend/src/static/lineage-gutter.js` / `doc-map.js` (from editor-layout plan, Stage 4) — render lineage as read-only lenses.

**Task outline:** F.1 tree search index (Go, tested); F.2 facet queries; F.3 lineage rail v0 (ref-chain, no reconciler); F.4 live lineage + doc map (gated on reconciler).

---

## Self-review

- **Spec coverage:** §2 model → A1 ✓; §3 three layers (markdown storage / Sieve envelope wire / PM internal) → A spine + C envelope ✓; §4 block ops → C ✓; §5 per-kind render mode → D ✓; §6 one serialization spine (retire InjectBlocks/JS split) → A3/A4 + C.1 + D.3 ✓; §7 handles/refs (merge-union, split-mint, GC) → B.3/B.4 ✓; §8 by-value containers → E ✓; §9 lenses → F ✓; §10 server-side tree search + facets → F.1/F.2 ✓; §11 staged cutover (Go core first, runnable from D) → stage order ✓; §12 reframes layout-engine (Stage 1 stands; columns/lineage as structure+lenses) → E/F reuse layout plan files ✓; §13 reconciler coupling deferred → F.4 gated ✓.
- **Placeholder scan:** Stage A carries real code + exact commands + expected output. Stages B–F are explicitly *roadmap outlines to bite-size just-in-time* (declared in the Fidelity note), with file maps, interfaces, exit criteria, and dependencies — not hidden placeholders.
- **Type/name consistency:** `DocBlock`/`BlockDoc`, `KindProse`/`KindColumnRow`/`KindColumn`, `ParseBlockDoc`/`SerializeBlockDoc`/`serializeFencedBlock` used consistently; confirmed no collisions with existing `Document`/`SieveBlock`/`KindBuffer` names. Reuses existing `fencedblock.SerializeYaml`, `mdParser`, `sieveBlockNode`, `RegisterProcessor`/`UnregisterProcessor`, `&CodeBlockProcessor{}` test convention.
- **Known risk carried forward:** the goldmark top-level prose byte-range helper (per-paragraph segmentation) is deferred from Stage A to Stage B.1 — Stage A intentionally uses coarse prose runs to keep the core spine robust and fully testable. Stage A wires nothing, so the running app is unaffected until Stage D.
