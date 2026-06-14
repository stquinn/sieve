# Brainstorm — Sieve Document Model: Blocks, Lenses, and the Store

**Status:** Brainstorm / thinking-in-progress — **NOT a committed design.** (2026-06-14)
**Origin:** Began as the Stage 2 `column-row` serialization work ([editor-layout-engine spec](superpowers/specs/2026-06-11-editor-layout-engine-design.md) / [plan](superpowers/plans/2026-06-11-editor-layout-engine.md)) and expanded into a re-examination of what a Sieve *document* fundamentally is.
**Companions:** [brainstorm-blocks-all-the-way-up](brainstorm-blocks-all-the-way-up.md), the architecture direction (Go server + Store + web/mobile frontends). This brainstorm **reframes** the layout-engine spec's container/lineage/layout framing.

---

## TL;DR

Sieve is not a markdown editor; it is a **store of addressable, composable blocks**. Markdown is a *storage/export serialization*, not the model. Every block — prose included — is a first-class `{ id, kind, content }` with optional `children` (containers) and `sidecar` metadata. **Serialization is a per-`BlockProcessor` concern**; the frontend renders blocks natively and need never touch markdown. Structure (columns, containers) makes the block list a **tree**; references / layout / lineage are **projections (lenses)** over the block id-graph.

---

## How we got here (the reasoning chain)

1. Columns (Stage 2) forced *"where does layout live?"* — inline `widths` felt like CSS leaking into content.
2. → three concerns: **data** / **structure** / **style**. Style must not live in the document.
3. → the real fear: *"the document is becoming a WYSIWYG UI in markdown."* A known failure mode.
4. → first resolution: make everything addressable by id; layout becomes a **map** (a lens), `{ id → position }`.
5. → *"every node is a mini-doc"*; chains / trees / graphs are all edge-topologies over the same addressable blocks; markdown is just one traversal.
6. → markdown is **running out of road** as the *internal* model; it's an export.
7. → counter: to the backend a block is just like a code block (opaque fenced region + id, spliced by `InjectBlocks`) — *"maybe markdown holds."*
8. → **the fork:** is a paragraph a *block* or *fluid text*? **Answer: a block whose `content` is prose.**
9. → light `{id=…}` anchors give **universal addressability** with bounded, hidden noise → **markdown ↔ block-list becomes a lossless bijection.**
10. → coherence demands **no pseudo-blocks**: ONE model (the block list); serialization is a **`BlockProcessor`** concern; `InjectBlocks` splice + JS `tiptap-markdown` consolidate into one backend spine.
11. → frontend goes **native** (blocks + block-ops over WS); markdown becomes pure storage; the **Store seam** owns the persistence format.
12. → embed / promote / cement / extract unify as **id-preserving block converts**; **render-mode** and **data-liveness** are orthogonal; **sidecar** metadata keeps "baked" blocks live + referenceable.
13. → columns: a container is a block ⇒ **the list becomes a tree**; render + search must traverse it. *(Back to the root of the thread.)*

---

## The model

- **Block:** `{ id, kind, content, children? }`. Uniform. **No pseudo-blocks.** `content` can be *rich prose* (e.g. a table) — structured enough to carry the data, so **no separate sidecar is needed.**
- **Kinds:** prose/`BlockAnchor`, heading, code, diagram, ai, card, web-clip, … and **container** (`column-row` / `column` — the `blockRef` successor).
- **ShadowDoc:** an *ordered list* of blocks that becomes a **tree** wherever containers nest children.
- **Identity = `id`.** Stable across edits, conversions, and moves. **Incoming references survive any transform.**

---

## Serialization — a `BlockProcessor` concern

Each processor owns how its block persists:

- prose → `content + {id=…}` (a new `BlockModeProse`)
- structured (code/diagram/ai/…) → fence (as today)
- container → nested children (**open:** by-value vs by-reference — see below)

`EditorService` walks the (tree of) blocks and asks each processor to serialize. **Markdown *emerges*** from this — it is not a canonical string to splice into.

**Retires** today's split-brain: `InjectBlocks` byte-splicing (Go) **and** the frontend `tiptap-markdown` serialization (JS) collapse into **one backend serialization spine**. (cf. `project_native_codeblock_serialization` — the split this resolves.)

---

## Addressability

- **Runtime:** every node carries an id from creation (free; makes Ask/Explain/AI-chains uniform). *This is new — distinct from today's explicit, sparse block anchors.*
- **Persistent:** light `{id=…}` anchors on text blocks; `id:` in YAML for fenced blocks. **Hidden in the editor** (frontmatter-style strip on load / re-attach on save) and **stripped on export**, so the only noise lives in the on-disk source — one light token per text block.
- This is what makes **markdown ↔ block-list a lossless bijection.** (External edits that drop/alter anchors are a degraded mode: such blocks are treated as new.)

---

## Frontend decoupling

- The frontend receives a **block list** and sends **block ops** (create / update / delete / reorder / move); it renders blocks via NodeViews.
- **`BlockAnchor`** = the prose/container renderer: a **transparent container** with a real `contentDOM` (so PM selection traverses it — *not* an opaque island), the proper successor to legacy `blockRef`.
- **Sync trigger nuance:** prose edits are continuous main-editor PM transactions (not discrete widget edits like a diagram box), so the change hook is a **transaction observer** mapping a changed range → its owning block id → debounced `update-block`. Same `{uuid, blockId, content}` payload; finer-grained trigger.
- **Going fully native** requires the block `content` to travel as a **native representation** (PM-JSON or a portable AST), *not* markdown. Then PM never parses/serializes markdown; the markdown↔native conversion moves to the prose `BlockProcessor` at the storage boundary, and **any frontend can plug in.**

---

## Store (more powerful as a consequence)

- The Store serializes the block list; **markdown is one format** among JSON / DB rows / S3.
- The **Store seam** (already a "load-bearing boundary") owns persistence, decoupled from both the model and the frontend.
- A future DB move becomes a **Store-implementation swap**, not a rewrite.

---

## Operations — id-preserving converts

- **Embed / flip:** change a block's **render mode** (rich-UI → prose) while keeping id + data + edges. Reversible-ish. The "flip" primitive across scales.
- **Extract / sprout:** prose → typed block (fan-out / pre-wired child).
- **Hard cement:** deliberately **freeze the value and drop the edges** — the strong, permanent commit.

**No sidecar — the prose is the single source of truth.** Because we control the rendering, the prose form can be *rich enough* to carry the data (a table renders as a markdown table). "Bake into the doc" flips render mode to prose; the block is **recreatable from that prose** via the existing Smart Paste / `PasteMatch` pipeline — *embed is the inverse of paste over one representation*, so there is nothing to drift out of sync. A baked table still feeds downstream consumers: they re-derive its structure by parsing the prose (the same paste-match machinery). *"I have what I need from the rich UI — render it as content; I never said stop using the data elsewhere."*

**Reversibility class:** a kind flips *reversibly* iff its prose is paste-recreatable (table, code, card-from-url). Kinds with hidden non-prose state (e.g. an AI block's prompt/refs) flip **one-way** — that flip *is* the hard cement.

---

## Lenses

- **Projections over the block id-graph:** **layout** (`id → position`), **lineage** (`id → id` refs), **export** (per-destination render).
- One content; many lenses. **Display never lives in the document — only in a lens.** That is the structural wall that stops "document → UI."

---

## Columns / containers → the list becomes a tree (return to the root)

A `column-row` is a **block** that **encloses children** ⇒ the ShadowDoc is no longer flat; it is a **tree**.

Consequences:
- **Render** is recursive *for free* — it's just nested `contentDOM`: a container NodeView exposes a `contentDOM`, PM places children inside it natively, and a child container has its own `contentDOM`. No recursive-render code to write. (Search / serialization traversal is the *separate* backend job of walking the tree.)
- **Search / indexing must traverse the tree** — full-text descends *into* container children, not a flat scan.
- **Block ops generalize:** reorder → move-into / move-out-of / reorder-within container. Move **preserves id**.
- **Depth cap** (spec §6: depth = 1 for v1) keeps the tree shallow — a gesture policy, not a schema limit.

**Open fork — container children by-value vs by-reference:**
- *By-value:* children nested in the container's serialized form. Self-contained; structure-in-doc SNR is localized; the tree is literal in storage.
- *By-reference:* container holds child ids; children stay flat + top-level addressable; the tree is containment edges. Cleaner flat store, but linear reading-order vs the tree must be reconciled.

Provisionally accepted: the **structure-in-doc tradeoff** — a column *is* serialized as a block. By-value vs by-reference is still open.

---

## What this resolves

- **document-vs-UI** — content = blocks; display = lenses; the wall is structural.
- **SNR** — light, hidden ids; prose serializes near-bare.
- **split-brain serialization** — one backend `BlockProcessor` spine.
- **embed / promote / cement / extract** — one id-preserving convert.
- **DB migration** — a Store swap, not a rewrite.

---

## Open questions / forks (still thinking)

1. **Timing / staging:** interim on-demand-ids on markdown (status quo+) vs commit to the coherent block-list model now.
2. **Wire format:** native (full decoupling) vs markdown-string (frontend stays coupled; smaller step).
3. **Canonical content representation:** PM-JSON (ties to ProseMirror) vs portable AST (any frontend).
4. **Container children:** by-value vs by-reference.
5. **Reversibility per kind:** which kinds are reversibly-flippable (prose is paste-recreatable) vs one-way-cement (hidden non-prose state)? *(Sidecar dropped — prose is the sole source of truth, round-tripped via Smart Paste / `PasteMatch`.)*
6. **ID churn rules:** split mints a new id on the tail; merge keeps the head; verify undo + reference integrity.
7. **Backend markdown↔native converter:** port `tiptap-markdown` to Go vs run it headless.
8. **Search over tree + lenses:** how search interacts with containers and (later) the reference graph.

---

## Relationship to current work

- The **Stage 2 column-row work is paused.** The uncommitted simplification (no bespoke serializer; generic-map path; relocated fence-safety test in `fencedblock`) is *consistent* with this direction and could land, but whether columns ship as a fenced content-block *now* depends on fork #1 (timing).
- This brainstorm **reframes the editor-layout-engine spec:** containers, lineage, and layout are not three subsystems — they are structure and projections over **one addressable block model**.
