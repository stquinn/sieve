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
- **No big-bang rewrite.** Migration is a **staged cutover sequenced for testability** (§11), not an all-at-once switch — but also **not** a strangler pattern (no live dual-path, no backward-compat shims; see §11).
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
| **Storage** (Store seam) | on-disk / DB | **markdown + handle markers** — bijection to the block list (see §3.1) |
| **Wire** (server↔frontend) | the block list + block ops | **Sieve-native envelope**: `{ id, kind, content, children? }`; prose `content` = **markdown string** |
| **Editor-internal** (one frontend) | what TipTap happens to use | ProseMirror doc — converted at the frontend's own boundary, **never transported or stored** |

Rationale (from fork #3): ProseMirror is the internal data structure of *one* frontend, not a format. Making PM-JSON the wire or storage format would couple the whole system to a frontend library — backwards from the architecture direction (multiple frontends behind a Go server + Store). A future non-PM frontend converts markdown → its own editor at *its* boundary; the wire stays neutral. Prose `content` travels as a **markdown string** (debuggable, consistent with markdown storage) rather than a portable inline AST.

### 3.1 Handle markers (on-disk addressability)

Every block carries a stable handle, persisted on disk so the reference graph survives reopen. Two persistence forms, by kind:

- **Fenced blocks** (code, diagram, ai, container, …) — the handle is the `id:` field already in the YAML body. Unchanged.
- **Prose blocks** — the handle is a **leading HTML-comment marker on its own line**, immediately above the block it labels:

  ```
  <!--s:pr-3f9a-->
  The gateway validates the token.
  ```

**Marker rules:**
- **`s:` is a sentinel namespace** so the strip pass recognises the comment as a Sieve handle (regex `<!--s:([\w-]+)-->`), distinct from any user-authored HTML comment.
- **The handle value is `kindprefix-hex`** per `GenerateBlockID` (`processor_registry.go`) — e.g. prose → `pr-3f9a`. The kind prefix is a **cosmetic birth-time hint only**: resolution treats handles as **opaque** (§7), and all handles — prose markers and fenced `id:`s — share **one global namespace**, so a ref resolves to whichever block answers to the handle regardless of kind (and the prefix may go stale after a kind-flip — accepted).
- **Pairing:** a marker line belongs to the block **immediately below it**. This aligns with the §7 churn rules — on split the head keeps its leading marker (keeps id) and a fresh marker is inserted above the tail (tail mints); on merge the tail's marker is deleted and its id folds into the head's handle-set.
- **HTML comment is chosen** because it is invisible in *every* downstream markdown renderer (graceful degradation even without stripping) and goldmark treats it as a raw-HTML node (a stray marker cannot corrupt parsing).

**Bypass goldmark — handle markers are NOT parsed as markdown.** They are processed by a deterministic **strip-from-editor / re-attach-on-save** line pass (the frontmatter pattern, CLAUDE.md), operating **only on prose spans** between fenced blocks. The id is never lost: it is **hidden in the editor view, retained in the block model, and always written back to disk.** This avoids inline-parser false positives (a user typing `{foo}`), and because the pass never touches fenced-block interiors, a marker pasted inside a code block cannot be corrupted. A *separate* export operation may strip handles entirely for sharing — that never touches canonical storage.

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

## 11. Migration — staged cutover (Go-testable core first)

This is a **one-time, internal cutover**, not a live system being incrementally replaced. Sieve is a single-user desktop app on a feature branch: there is no production traffic to route, and **no need to keep the old and new serialization paths coexisting**. So this is explicitly **not a strangler pattern** — there are **no backward-compatibility shims** keeping the old frontend alive against the new backend, because we never ship an intermediate state. We complete the cutover before running live.

The staging exists purely to **sequence the work for testability and bisectable failures**, front-loading the part that is cheapest to verify (the serialization core, proven by Go round-trip tests — precedent: `columnrow_serializer`).

**Per-stage bar:** the build compiles and the relevant tests pass. Intermediate stages need **not** leave the app fully runnable end-to-end; the app becomes runnable again at the frontend cutover (Stage D) and stays so thereafter.

**Order (each de-risks the next):**
- **Stage A — Backend block model + serialization spine.** Block-list/tree types in Go; per-kind `BlockProcessor`; markdown → block-list and block-list → markdown, **proven in isolation by Go round-trip tests before any wiring.** The hardest-to-get-right, easiest-to-test part goes first.
- **Stage B — Universal handles.** Assign `{id=}` handles to all blocks (prose included), hidden in the editor (frontmatter-style strip on load / re-attach on save), stripped on export. Proves the markdown↔block-list bijection. Go-tested.
- **Stage C — Wire protocol.** Block ops over WS (`create/update/delete/reorder/move`); the Sieve-native envelope; the prose **transaction observer** + debounce.
- **Stage D — Native frontend.** `BlockAnchor` transparent container; per-kind NodeViews driven by the block list; retire the JS *document-level* serializer (keep per-block inline only). **App runnable end-to-end again from here.**
- **Stage E — Containers/tree + columns.** By-value containers; reframed `column-row`; **retire `blockRef`** onto the new container.
- **Stage F — Lenses + search.** Layout/lineage projections; server-side tree search.

The implementation plan bite-sizes each stage just-in-time as its predecessor lands.

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
- **Non-runnable intermediate stages** — because we drop backward-compat shims (§11), the app is not runnable end-to-end between Stage A and Stage D, so UI/integration problems surface only at the frontend cutover. Mitigate with strong Go round-trip coverage on the serialization core, small stages, and reaching the runnable Stage D promptly.
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
