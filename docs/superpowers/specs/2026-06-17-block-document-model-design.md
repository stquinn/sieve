# Sieve Block Document Model — Design

**Status:** Design (approved in brainstorm 2026-06-17)
**Supersedes/derives-from:** [brainstorm-block-document-model](../../brainstorm-block-document-model.md) (promoted from brainstorm to committed design)
**Reframes:** [editor-layout-engine spec](2026-06-11-editor-layout-engine-design.md) / [plan](../plans/2026-06-11-editor-layout-engine.md) — containers, lineage, and layout become **structure + projections over one block model**, not three subsystems.
**Companions:** [brainstorm-blocks-all-the-way-up](../../brainstorm-blocks-all-the-way-up.md); the architecture direction (Go server + Store + web/mobile frontends).

---

## 1. Problem & intent

Sieve currently treats **markdown as the model**. The frontend (TipTap/ProseMirror) parses and serializes markdown; the backend splices fenced Sieve blocks into that markdown via `InjectBlocks`. This produces a **split-brain serialization** (Go `InjectBlocks` byte-splicing *and* JS `tiptap-markdown` document serialization, cf. memory `project_native_codeblock_serialization`), makes addressability sparse and ad-hoc (explicit block anchors only), and — as the Stage 2 `column-row` work surfaced — pushes layout/structure concerns into the markdown string, drifting toward "the document is a WYSIWYG UI in markdown."

This design commits to the resolution reached in the brainstorm: **Sieve is a store of addressable, composable blocks. Markdown is a serialization, not the model.** Every block — prose included — is a first-class `{ id, kind, content }` with optional `children` (containers). Serialization is a per-`BlockProcessor` concern. The frontend renders blocks natively and sends block ops; markdown becomes the on-disk storage format behind the Store seam.

### Goals
- **One model:** a uniform block list that becomes a tree where containers nest children. No pseudo-blocks.
- **One backend serialization spine:** retire the `InjectBlocks` / JS-document-serializer split.
- **Universal addressability:** every block carries an opaque handle; markdown ↔ block-list is a lossless bijection.
- **Frontend decoupling:** the frontend consumes a block list and emits block ops; ProseMirror is an internal detail of one frontend, never a transport or storage format.
- **Layout/lineage as lenses:** display lives in projections over the id-graph, never in the document.

### Non-goals
- **No new editor substrate.** ProseMirror/TipTap remains the frontend editor (spec §2 of the layout-engine spec stands). No React.
- **No enforced referential integrity.** Refs are best-effort pointers (resolve-or-null); see §7.
- **No big-bang rewrite.** Migration is strangler/seam-first (§9).
- **No sidecar metadata.** Prose is rich enough to be the single source of truth; baked blocks are recreatable from their prose via the existing Smart Paste / `PasteMatch` pipeline.

---

## 2. The model

A **block** is `{ id, kind, content, children? }`:

- **id** — an opaque **handle** (see §7). A block may answer to a *set* of handles.
- **kind** — `prose`, `heading`, `code`, `diagram`, `ai`, `card`, `web-clip`, …, and **container** (`column-row` / `column`, the `blockRef` successor).
- **content** — kind-specific. For prose it is rich text; for structured kinds it is the structured payload (as today).
- **children** — present only on containers; this is what turns the ordered block **list** into a **tree**.

**Identity = handle**, stable across edits, conversions, and moves. The block list is an *ordered* list that is a *tree* wherever containers nest children.

---

## 3. Three layers (strictly separated)

The central architectural rule: **storage, wire, and editor-internal representations are three different things, and ProseMirror appears only in the third.**

| Layer | What it is | Format |
|---|---|---|
| **Storage** (Store seam) | on-disk / DB | **markdown + `{id=}` anchors** — bijection to the block list |
| **Wire** (server↔frontend) | the block list + block ops | **Sieve-native envelope**: `{ id, kind, content, children? }`; prose `content` = **markdown string** |
| **Editor-internal** (one frontend) | what TipTap happens to use | ProseMirror doc — converted at the frontend's own boundary, **never transported or stored** |

Rationale (from fork #3): ProseMirror is the internal data structure of *one* frontend, not a format. Making PM-JSON the wire or storage format would couple the whole system to a frontend library — backwards from the architecture direction (multiple frontends behind a Go server + Store). A future non-PM frontend converts markdown → its own editor at *its* boundary; the wire stays neutral. Prose `content` travels as a **markdown string** (debuggable, consistent with markdown storage) rather than a portable inline AST.

---

## 4. Everything is a block op

There is **no document-level save path**. All mutation is block ops over the websocket:

- `create-block`, `update-block`, `delete-block`, `reorder` (within parent), `move` (into / out of a container — **preserves handle**).

Prose editing is **`update-block` like any other kind** — the same `{ uuid, blockId, content }` payload a code block emits. The difference is only the **trigger granularity**:

- **Structured/atom blocks** (code, diagram, image) are discrete widgets → an explicit edit emits one `update-block`.
- **Prose blocks** are continuous text in the shared editor → a **transaction observer** maps a changed range → its owning block handle → **debounced** `update-block`.

So the *contract* is uniform across kinds; the *trigger* differs because prose is continuous and structured blocks are discrete.

---

## 5. Per-kind render mode (orthogonal to data)

The data model is uniform; the **render/edit mode is a per-kind concern**, independent of how the block is stored or transported:

| Render mode | Kinds | PM shape | Editing surface |
|---|---|---|---|
| **Atom** | image, diagram, code | opaque NodeView island | isolated (own widget/editor) |
| **Transparent PM nodes** | prose, heading, list | real PM nodes with text children + marks | **shared** continuous editor |

**Prose is rendered as proper PM nodes** in one continuous document — *not* a grid of isolated mini-editors. "Block-ness" for prose is a **routing/addressing layer over the shared editing surface**: the transaction observer attributes a changed range to its owning handle. This preserves free-flow typing and cross-paragraph selection (the property the layout-engine spec §5 and the selection/copy-paste refactor protect). The prose/container renderer is **`BlockAnchor`** — a transparent container with a real `contentDOM` (PM selection traverses it), the proper successor to the legacy `blockRef`.

---

## 6. One backend serialization spine

Each kind owns a **`BlockProcessor`** that serializes/parses its block:

- prose → `content + {id=}` anchor (a new `BlockModeProse`)
- structured (code/diagram/ai/…) → fenced block (as today)
- container → nested children **by-value** (§8)

`EditorService` walks the (tree of) blocks and asks each processor to serialize; **markdown emerges** from this — it is not a canonical string to splice into. This **collapses the split-brain**: `InjectBlocks` byte-splicing (Go) and the JS *document-level* serializer fold into **one backend spine**.

**Fork #7 resolved:** the only markdown↔native conversion remaining client-side is **per-block inline** prose rendering (`tiptap-markdown` scoped to a single block's content). It no longer competes over document structure, so there is **no need to port `tiptap-markdown` to Go**.

---

## 7. Handles, not identities (refs are best-effort pointers)

An `{id=}` anchor is an **opaque handle** — a pointer label with no inherent meaning. Consequences:

- A block **answers to a set of handles** (normally one; more after merges).
- A **ref** is just an outgoing handle-pointer. There may be more than one. **Resolution, not referential integrity**: a ref resolves (handle found in the index) or it doesn't (dangling). No constraint blocks a dangling ref.

**Two lists, both best-effort:**

| | What it is | On merge | GC rule |
|---|---|---|---|
| **handle-set** (incoming) | the labels a block answers to | **union** | drop a handle once nothing points to it |
| **ref list** (outgoing) | the pointers this block consumes | union + dedup | **next save strips refs that don't resolve** |

**ID churn rules (fork #6):**
- **Split** (Enter mid-block): the **head keeps all its handles**; the **tail mints one fresh handle**.
- **Merge** (Backspace at start): the surviving **head unions the tail's handle-set** — it now answers to both. Every existing `ref` to the tail still resolves, **with zero referrer rewriting** (purely local; works even when referrers live in unloaded docs or external files). This **supersedes** any "re-point all referrers" approach.
- **Undo** must restore the exact prior handle assignment (split+undo leaves no stray handle; merge+undo resurrects the dropped handle).
- **GC on save:** dangling outgoing refs are stripped; alias handles nothing points to are dropped. Dangling refs surface as stale/broken in the lineage rail before GC. (Consistent with the brainstorm's "external edits that drop anchors = degraded mode.")

Mechanically, the transaction observer detects a new top-level node lacking a handle (split → mint + `create-block`) and a vanished handle (merge → union into head + `delete-block`), alongside the `update-block`.

---

## 8. Containers → the list becomes a tree (by-value)

A `column-row` is a **block that encloses children**, so the block list is a **tree** wherever containers nest. **Fork #4 resolved: by-value.** A container's children serialize **nested inline** in its fenced form (the Shape-1 serialization: prose children as verbatim scalar, structured children as single-key maps), proven fence-safe at depth by `forceLiteralStyle` (`sieve/columnrow_serializer_test.go`). This is the only option consistent with markdown-as-canonical-storage (the file still reads top-to-bottom).

By-value does **not** cost addressability: every block carries a handle whether nested or top-level; the parser descends the tree and emits every block into the id-graph; refs (by handle, may cross container boundaries) resolve against the whole tree.

Consequences:
- **Render is recursive for free** — nested `contentDOM`; no recursive-render code to write.
- **Block ops generalize:** reorder → move-into / move-out-of / reorder-within; move **preserves handle**.
- **Depth cap = 1 for v1** — a gesture policy, not a schema limit (layout-engine spec §6).

---

## 9. Lenses

Layout, lineage, and export are **read-only projections over the block id-graph**:
- **layout** — `id → position`
- **lineage** — `id → id` refs
- **export** — per-destination render

**Display never lives in the document — only in a lens.** This is the structural wall that stops "document → UI." One content; many lenses.

---

## 10. Search (server-side, over the tree)

Because the backend owns the block list, **search/indexing runs server-side and traverses the block tree** (descends into container children; a flat markdown scan would miss nested blocks). Lenses do not affect search.

**Affordance to preserve (not build now):** a server-side index over the block list can query **structured facets** — handle, `kind`, ref edges, staleness — not just full text. No immediate use case, but the index should not be designed as text-only, so these stay cheap to add later.

---

## 11. Migration — strangler / seam-first (one spec, staged plan)

This is a large pivot delivered as **independently-verified seams**, never leaving the app broken between stages. The load-bearing **Store seam** does the heavy lifting; the existing `columnrow_serializer` (Go round-trip tested) is the precedent.

- **Stage A — Backend block model + serialization spine.** Block-list/tree types in Go; per-kind `BlockProcessor`; parse markdown → block-list and serialize block-list → markdown *behind the existing markdown interface*. Go round-trip tests. **Frontend unchanged.**
- **Stage B — Universal handles.** Assign `{id=}` handles to all blocks (prose included), hidden in the editor (frontmatter-style strip on load / re-attach on save), stripped on export. Proves the markdown↔block-list bijection. Still behind the existing interface.
- **Stage C — Wire protocol.** Block ops over WS (`create/update/delete/reorder/move`); the Sieve-native envelope; the prose **transaction observer** + debounce. Frontend begins consuming the block list.
- **Stage D — Native frontend.** `BlockAnchor` transparent container; per-kind NodeViews driven by the block list; retire the JS *document-level* serializer (keep per-block inline only).
- **Stage E — Containers/tree + columns.** By-value containers; reframed `column-row`; **retire `blockRef`** onto the new container.
- **Stage F — Lenses + search.** Layout/lineage projections; server-side tree search.

Each stage produces working, shippable software. The implementation plan bite-sizes each stage just-in-time as its predecessor lands.

---

## 12. Relationship to the editor-layout-engine spec

This design **reframes** [2026-06-11-editor-layout-engine-design.md](2026-06-11-editor-layout-engine-design.md):

- **Stage 1 of the layout engine stands** (chrome, reorder, gap cursor, leaf-world clipboard, the selection/copy-paste refactor) — it is substrate this design builds on, not invalidated.
- **Layout-engine Stage 2 (container substrate) is absorbed here** as §6/§8. The standalone `columnrow_serializer` work becomes the precedent for the general `BlockProcessor` spine.
- **Layout-engine Stages 3 (columns) and 4 (lineage)** re-express as **structure + lenses** over this model (§8/§9) rather than separate subsystems.
- The cross-cutting outcome — **retiring `blockRef`** — lands in Stage E here.

After this pivot, the remaining layout-engine work (columns UI, lineage rail) resumes on the block-model foundation.

---

## 13. Risks & open questions

- **Transaction-observer correctness** — mapping continuous PM transactions to per-block `update-block` ops (range → owning handle, debounce, split/merge detection) is the trickiest new mechanism. Needs careful manual protocols (no JS test harness) plus Go-side round-trip coverage for the serialization it feeds.
- **Undo integrity across handle churn** — split/merge must round-trip handles through undo without orphaning or duplicating. Explicit test cases.
- **Migration seam discipline** — Stages A/B must stay strictly behind the existing markdown interface so the frontend keeps working; resist leaking the new model forward before Stage C.
- **Bijection edge cases** — external edits that drop/alter `{id=}` anchors are a degraded mode (treated as new blocks); document the behavior, don't fight it.
- **Clipboard/wire fidelity across the future web frontend** — the Sieve-native envelope must carry enough to reconstruct blocks on a non-PM frontend (architecture direction).
- **Reconciler coupling (deferred)** — live lineage / dirty-glow (layout-engine Stage 4b) still depends on the separate reconciler/reference-graph project; out of scope here.

---

## 14. Testing notes

- **Serialization spine** — Go round-trip tests per `BlockProcessor`: prose+anchor, each structured kind, by-value containers at depth (extend the existing `columnrow_serializer_test.go` pattern). Bijection: markdown → block-list → markdown is byte-stable.
- **Handle churn** — split mints tail handle; merge unions into head and preserves ref resolution; undo restores exact assignment; GC strips dangling refs/handles on save.
- **Wire/block-ops** — create/update/delete/reorder/move round-trip; move preserves handle across container boundaries.
- **Prose transaction observer** — manual `wails dev` protocols: typing emits debounced `update-block` for the right handle; split/merge emit the right create/delete; free-flow selection across paragraphs intact.
- **Degradation** — a container rendered by a non-Sieve markdown reader shows as a fenced block; external anchor-dropping treated as new blocks.
