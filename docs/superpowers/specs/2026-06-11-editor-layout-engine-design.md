# Editor-Pane / Layout-Engine Rebuild — Design

**Status:** Design (approved in brainstorm 2026-06-11)
**Companion docs:** [brainstorm-smart-code-blocks-2.md](../../brainstorm-smart-code-blocks-2.md) (the "design spine"), [how-to-intelligent-fenced-blocks.md](../../how-to-intelligent-fenced-blocks.md), [how-to-sieve-block-framework.md](../../how-to-sieve-block-framework.md)

---

## 1. Problem & intent

The editor pane is the next functional gap. Today it is a single TipTap instance (`frontend/src/static/editor.js`) holding a flat, linear ProseMirror document: prose nodes plus a set of custom **leaf** nodes (the Sieve YAML fenced blocks built by `createSieveNode` in `sieve-block-extension.js`). Three things are missing or weak, and they only "fit together" as a set:

1. **Consistency** — prose nodes and fenced-block NodeViews have no shared chrome; the editor feels like two different surfaces.
2. **A rock-solid interaction substrate** — selection / clipboard / drag-reorder are inconsistent ("random") because blocks are opaque islands ProseMirror cannot traverse.
3. **The future the product rides on** — manual columns (a diagram beside its prose) and a reference/lineage rail (making spooky-action-at-a-distance legible), per brainstorm 2 §11.

This document designs all three as **one coherent system**, with a **staged build order** so each stage ships independently. The design does not carve the system into disconnected chunks; staging only decides ship order.

### Goals
- A consistent editor with a single chrome, single handle, single selection unit, single clipboard contract across every top-level block.
- A predictable, block-level interaction substrate (§11: *consistency beats capability*).
- Manual, authorial **columns** as a first-class container.
- A **lineage rail** (gutter + structural document map) that extends the *existing* block-anchor/word-highlight language.

### Non-goals
- **No canvas / auto-layout.** Layout is authorial; the graph is logical; the two stay orthogonal (brainstorm 2 §225–226).
- **No substrate switch.** ProseMirror/TipTap stays (see §2). No React (per CLAUDE.md, Phase 9).
- **No nested columns in v1** (depth cap = 1; see §6).

---

## 2. Substrate decision (settled hypothesis)

We explicitly re-tested "is TipTap still right? (Monaco / CodeMirror?)" and kept it.

| Engine | Document model | Verdict |
|---|---|---|
| **TipTap / ProseMirror** | a **tree** of schema-constrained nodes | **Keep — the substrate.** WYSIWYG "render as you type," embedded islands, containers/columns, block-level ops are all native tree-document work. |
| CodeMirror 6 | sequence of lines (text + decorations) | **Nested only.** Great for code editing *inside* a code-block NodeView, and a candidate to replace the raw-markdown `<textarea>` mode. Not the document. |
| Monaco | text + language services | **Rejected.** IDE-weight, code-first, hostile to embedded interactive widgets. |

The choice maps onto the identity thesis (brainstorm 2 §10): ProseMirror is the prose-first substrate; CodeMirror/Monaco are code-first. Choosing a text engine as the document would invert the thesis. The pain we feel (ragged cross-block selection) is the cost of structure, and the fix is to shift the interaction unit from character to block — *more* ProseMirror, not less.

**Decision:** ProseMirror/TipTap remains the document & layout engine. CodeMirror is adopted only nested inside code surfaces.

---

## 3. The unit of layout

**Every top-level node is a block** (heading, paragraph, list, fenced block, container). Each gets uniform chrome — a gutter cell + a hover drag-handle — applied as **ProseMirror decorations / overlays**, *not* by rewrapping the schema. Prose still flows and selects naturally inside a paragraph; the chrome is the layout engine's consistent grip.

The handle is **both** the drag-grip and the selection-grip — which is why the uniform chrome is load-bearing for the interaction substrate (§5).

Rejected: islands-only (no consistency) and Notion-style "every line a bordered block" (fights free-writing; heaviest schema change).

---

## 4. The container-node foundation (the real defect)

This is the deep enabler hiding behind "columns," and it fixes a present defect: **block ids cannot contain child block ids.**

**Why:** every Sieve node today is a **leaf**. `createSieveNode` (`sieve-block-extension.js:67`) declares no ProseMirror `content` expression; the NodeView sets `view.dom.contentEditable='true'` and then a `beforeinput`→`preventDefault` (line 127) to stop native input. The block carries its whole payload in the `serialisedForm` attr (`BASE_ATTRS`, line 57). PM therefore treats it as an **opaque island** it cannot model — the direct cause of ragged cross-block selection and "random" clipboard behaviour.

**Fix:** introduce **container-shaped** nodes that expose a real `contentDOM` and a `content` schema. From here, the block world has two shapes:

| Shape | Schema | Examples | Selection / clipboard |
|---|---|---|---|
| **Container** | `content: block+` / `sieveColumn+`, real `contentDOM` | `column-row`, `column`, (candidates: callout, AI-prose) | **Native PM** traverses in/across — copy/paste "just works" |
| **Leaf / atom** | no `content`, carries `serialisedForm` | diagram, code, image, smart-card, web-clip | **Block-level `sieve/<kind>` contract** |

Conversion from leaf → container is **per-kind work** (define content schema, expose `contentDOM` instead of the JS-managed editable DOM, serialize children via §6). Done only where content is genuinely prose-shaped — `column`/`column-row` first; `callout`/`AI-prose` are later candidates. **Diagram / code / image deliberately stay atoms.**

**Payoff:** this one substrate piece retires two of the three pains — consistency *and* rock-solid selection — because prose-shaped islands become transparent native structure.

---

## 5. Interaction substrate (the "rock solid" core)

Principle (§11, §227): *a predictable, slightly-limited block-level model beats a powerful character-level one that surprises you.* Do **not** fight ProseMirror for seamless character-level cross-block selection.

**Selection**
- Inside one text block → normal **character** selection (today's free-writing feel, untouched).
- Crossing into a **container** block → **native PM traversal** (select into/across it).
- Crossing a **leaf/atom** block → **snap to whole-block**.
- Click drag-handle / gutter cell → selects that whole block; **shift-click** another → block range.
- **Gap cursor** always available above/below/between island blocks — the caret can never get trapped.

So "snap to whole block" is specifically *"snap at atom boundaries; traverse containers."*

**Clipboard** — generalize the pattern that already exists. `sieve-block-extension.js:228` already emits `{ mimeType: 'sieve/' + node.attrs.kind, content: node.attrs.serialisedForm }`. Extend it:
- From single-block to **multi-block selections and the `column-row` container**.
- `serialisedForm` is authoritative; `text/plain` = markdown and `text/html` = `toDOM` are lossy external fallbacks.
- **Paste** sniffs `sieve/<kind>` → reconstruct via the flavour's parser (refs/cache/flavour intact); else parse html/markdown best-effort.

**Drag-reorder** — the handle drags whole block(s); a drop-indicator shows the insertion line between blocks, or *into a column cell* when hovering a cell. One gesture, three outcomes: reorder / enter column / leave column.

The throughline: **one chrome, one handle, one selection unit, one clipboard contract** — every prose and island block obeys the same rules. That uniformity *is* the "consistent UX feel."

---

## 6. Columns — the 2D layer

A `column-row` is **one container node** in the linear document tree that lays its children horizontally. Its children keep their refs, flavours, cache, and cement behaviour; the reconciler and serialiser don't otherwise notice (brainstorm 2 §226). References may cross a column boundary — layout is visual, the graph is logical, and they need not agree.

**Structure (editor schema):** `column-row` → `column+` → `block+`. The `column-row` is itself a top-level block (so it has its own chrome handle and a `BASE_ATTRS` `id`). Its children are real ProseMirror block nodes (prose + sieve blocks).

**Creation — three gestures over the single container:**
- **(B) Insert / slash** an empty 2/3-column layout, fill cells. *Shared plumbing — built first.*
- **(A) Drag** a block's handle onto another block's left/right edge → fuse into a row. *Reuses B's drop-into-cell + edge-detection. Second.*
- **(C) Select adjacent** blocks → "group into columns." *Nearly free once block-selection exists. Alongside selection.*

**Resize:** a draggable **grab-handle** on the divider updates a `widths: [...]` ratio attr live; widths serialize with the container.

**Depth cap = 1 for v1** (no `column-row` inside a `column`), enforced as **gesture policy** (block the create/drop), *not* a schema restriction. ProseMirror allows the recursion for free; we cap it to preserve legibility (deep nesting is the slide toward a canvas, §225) and to avoid fragile nested serialization. Relaxing the cap later is a one-line knob.

---

## 7. Column serialization — `` ```column-row `` Sieve block (Shape 1)

Columns serialize as a normal Sieve fenced block (kind `column-row`), **not** a `:::`-fenced div and **not** raw HTML. The body is a declarative widget tree.

```column-row
id: cr1
widths: [0.55, 0.45]
columns:
  - children:
      - |
        Every request carries a **bearer token**. The gateway
        checks the cache, then the auth service on a miss.
  - children:
      - diagram:
          id: d1
          source: |
            Client --> Gateway --> Auth
```

**Rules:**
- The `children` array is a **discriminated union**:
  - a **string scalar** = prose, treated as **verbatim standard markdown**, injected through the normal markdown parser. **There is no "prose kind" and no Sieve-markdown dialect** — only Sieve Blocks get special handling (the same JS/Go split as `project_native_codeblock_serialization`).
  - a **single-key map** = a Sieve Block in **Shape 1**: the kind is the map key, properties nested beneath it (`- diagram: { id, source }`). This is a 1:1 translation of the standalone fence (info-string kind → map key; fence body → nested value).
- Parse rule for a child: `typeof item === 'string'` → prose; else `Object.keys(item)[0]` → kind.
- Inner-fence safety uses the existing YAML `|` literal-scalar + `forceLiteralStyle`/indent mechanism (`fencedblock.Serialize`; cf. `project_diagram_block`), so verbatim markdown — including a nested ``` fence — round-trips byte-for-byte.
- In-memory `kind` is a flat `BASE_ATTR`, so serialization does a trivial lift/lower at the boundary (`{kind:'diagram', …}` ↔ `{diagram:{…}}`).

**Why this over `:::` fenced-divs:** consistency. A `column-row` degrades exactly like every other Sieve block (a non-Sieve reader sees a `` ```column-row `` code block), it's one fence convention, it's a single self-contained `serialisedForm` that the existing `InjectBlocks` and `sieve/<kind>` clipboard already handle, and nesting is via unambiguous YAML indentation rather than fragile `::::` colon-escalation. The only thing `:::` did better — free flatten-for-dumb-readers — is moot because Sieve mediates every export anyway (see §9).

> **Open spike (Stage 2):** the inner-fence mechanism is proven for one level (diagram = fenced code in YAML). Columns embed *arbitrary* blocks (including other fenced blocks). Confirm multi-level YAML `|` nesting composes 2–3 deep before banking on it.

---

## 8. Lineage — gutter rail + structural document map (objective 3)

References cause spooky-action-at-a-distance. The lineage system makes it legible and is **one vocabulary at three zoom levels**:

- **micro** — highlighted word/anchor *inside* a block (already exists; `smart-link-renderer.js`).
- **meso** — bracket-chain in the **gutter rail** tying a source to its consumers.
- **macro** — the **structural document map** down the side.

**Crucial constraint:** the gutter rail and map **extend the existing block-anchor/word-highlight visual language — they do not introduce a parallel system** (see memory `project_block_anchor_lineage`).

**Gutter rail — Hybrid visibility:**
- **Always-on:** a faint "participates in lineage" tick, and **dirty-glow** on stale blocks (safety-critical — a consumer whose cached value differs from its source's current output).
- **On hover/select:** full bracket-chains + neighbour highlight; **edited node + immediate neighbours bright, deeper transitive staleness dim** (so it never becomes a "Christmas tree", §107).

**Structural document map (not a minimap):** one cell per block, coloured by flavour, column-rows shown as side-by-side cells, **off-screen dirty-glow** (the "five screens away went stale" signal), faint lineage edges, a viewport box, click-to-jump. It is the macro end of the same lineage vocabulary and depends on flavour + staleness + reconciler — hence Stage 4.

---

## 9. Cement / lens behaviour for layout

Anchors and columns have **opposite lifecycles across the hardening boundary**, which is a further reason they are different mechanisms:

| | Lens (reversible — view/export) | Commit (permanent) |
|---|---|---|
| **Anchors / reference graph** | hidden, live graph intact; reopening re-arms | dropped; values cemented in place |
| **Column layout** | rendered or flattened **per destination** (Confluence keeps it; email flattens); storage untouched | only a *deliberate* linearise-commit removes the container |

So: **anchor visibility is a function of the lens; column survival is a function of the destination.** For the `column-row` flavour, the **cement representation** (brainstorm 2 §120 field 6) defaults to *freeze/survive* (keep the structure), with an optional *linearise* rung (columns → linear) for 2D-incapable destinations.

---

## 10. Staging (build order — each ships independently)

The deep enabler (containers) is isolated; the visible win (chrome/substrate) lands first; objective 3 closes the loop.

- **Stage 1 — Chrome + reorder + leaf-world substrate.** Decoration-based gutter/handle on every top-level node; drag-reorder; gap cursor; snap-at-island selection; generalized `sieve/<kind>` multi-block clipboard. *No schema change.* Immediate, visible "consistent + solid" win, and §11's "do the substrate spike first."
- **Stage 2 — Container substrate (the defect fix).** Container node shape + `contentDOM`; the `` ```column-row `` serialization (Shape 1, scalar prose) + the multi-level YAML `|` safety spike; refined "traverse-containers / snap-atoms" selection. Unlocks copy/paste for prose-shaped blocks.
- **Stage 3 — Columns.** `column-row` NodeView, resize grab-handle, the three creation gestures (B→A→C), depth-cap policy, cement linearise rung.
- **Stage 4 — Lineage rail + document map.** Gutter bracket-chains (hybrid), dirty-glow propagation (couples to the reconciler / reference graph from brainstorm 2), structural document map.

---

## 11. Risks & open questions

- **Multi-level YAML `|` nesting** (§7) — needs a serialization spike in Stage 2 before columns can embed arbitrary blocks reliably.
- **Per-kind container conversion** (§4) — moving a block from leaf to container (`contentDOM`, removing the `beforeinput` guard) must not regress the existing atom blocks; convert conservatively, prose-shaped kinds only.
- **Decoration performance** — chrome on *every* top-level node via decorations must stay cheap on large documents; reuse the decoration set, avoid per-keystroke rebuilds.
- **Clipboard fidelity across the webview / future web frontend** — custom MIME (`sieve/<kind>`) works in the Wails webview today; verify behaviour for the planned web frontend (`project_architecture_direction`).
- **Lineage ↔ reconciler coupling** — Stage 4 dirty-glow depends on the blocks-list reconciler / reference graph (brainstorm 2 §3–4), which is separate, larger work; Stage 4 should not start before that lands.
- **The drag gesture is overloaded** — reorder (§5), column-drop (§6 gesture A), and a *future* wire-into-input-slot (reference-graph authoring, §13) all ride one drag. The disambiguation model must be reserved now (see §13) so layout drags and wiring drags coexist without ambiguity ("am I moving this or wiring it?").
- **Columns vs wiring visual confusion** — columns (visual side-by-side, *layout*) and lineage ports/lines (*logical* wiring) are both "adjacent blocks with connections." Keep the visual languages strictly distinct: columns = container border + divider; lineage = gutter bracket-chains + transient ports. This is the layout/graph orthogonality made visual, and a real legibility risk if the two blur.

---

## 12. Testing notes

- **Selection substrate** gets explicit cases at the rot-points: caret entry/exit around atoms (gap cursor), snap-to-block at atom boundaries, native traversal across containers, shift-click block ranges.
- **Clipboard** round-trip tests: copy/paste single block, multi-block, and a whole `column-row` within Sieve (rich reconstruct) and into an external target (markdown degrade).
- **Serialization** round-trip tests for `` ```column-row ``: scalar prose verbatim fidelity (bold/links/anchors), Shape-1 block children, widths, and the multi-level inner-fence spike.
- **Degradation**: a `column-row` rendered by a non-Sieve markdown reader shows as a code block (consistent with other blocks); the linearise cement path produces clean linear markdown.

---

## 13. Forward-compatibility with reference-graph authoring

New notes in brainstorm 2 §14 design *how a user draws a reference* (creates DAG edges). That belongs to the reconciler / reference-graph project, **not** this layout rebuild — but two of its requirements constrain the layout engine now, so we **reserve room rather than build**:

- **Reserve a drag "wiring mode."** §14's drag-into-field binding and "logic gate" ports piggyback on the block-drag gesture: on drag, compatible **input dropzones** light up and a drop binds an edge (the block then snaps back to its physical position). Our drag-reorder / column-drop (§5–6) must therefore be built with an explicit **mode/disambiguation seam** — e.g. wiring mode is entered only when the dragged block's output type matches an open, **type-gated** input slot, and is otherwise a pure layout drag. Decide the trigger deliberately; never let reorder and wiring collide.
- **Share the gutter geometry.** §14 shows persistent connections as gutter lineage lines (parent right-output → down the margin → child left-input) — the same rail as §8's bracket-chains. Transient **left-input / right-output ports** appear only during wiring mode and recede; the **persistent** lineage lives in the left gutter. One rail; transient ports for authoring only.

**Already-present footholds (keeps this additive, not greenfield):** the context-menu **"Extract as"** triggers + `detect-extractions`, and **friendly names** via `renderer.getFriendlyName` (`sieve-block-extension.js:223`). The **dropdown-first, drag-later** verdict in §14 matches this spec's staging: dropdown binding is independent and low-risk; drag-to-wire sits on top of the Stage 1/3 reorder substrate.

**Fan-in vs fan-out division (the user's §14 caveat):** **sprout** (extract-as → child pre-wired `parent: id`) handles 1→1 and fan-out naturally; **bind** (dropdown / drag-into-slot, type-gated) handles fan-in (many sources → one consumer). The system needs both — they are the two halves of the DAG, not redundant paths.
