# Editor Layout Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the editor pane into a consistent, rock-solid layout engine on ProseMirror/TipTap — uniform per-block chrome, block-level selection/clipboard, drag-reorder, manual columns, and a gutter lineage rail — delivered in stages but planned as one coherent arc.

**Architecture:** ProseMirror stays the document/layout substrate (CodeMirror only nested in code surfaces, later). A new decoration-based `BlockChrome` extension gives every top-level node a uniform gutter cell + drag handle without touching the schema. A new proper **container node** (`column-row`/`column`) fixes the leaf-only defect and supersedes the legacy `blockRef` anchor. Columns serialize as a `` ```column-row `` Sieve YAML fence (Shape 1, verbatim scalar prose). The gutter rail renders the existing `ref`-chain graph first (no reconciler), with live dirty-glow later.

**Tech Stack:** Wails v2 + Go + chi + HTMX, TipTap 3.x (`@tiptap/core`, `@tiptap/pm` for ProseMirror primitives), vanilla JS extensions augmenting `window.TipTap`, esbuild bundling, js-yaml. No React. No new npm deps in this plan.

**Spec:** [`docs/superpowers/specs/2026-06-11-editor-layout-engine-design.md`](../specs/2026-06-11-editor-layout-engine-design.md) · **Illustrations:** [`specs/assets/2026-06-11-editor-layout/index.html`](../specs/assets/2026-06-11-editor-layout/index.html)

**Testing convention (agreed):** the repo has 28 Go tests and **no JS test harness**, and a "discuss new npm deps first" rule. So: **Go tests** for logic that lives or can live Go-side (serialization, payload assembly, parse round-trips); **explicit manual `wails dev` protocols** for ProseMirror UI. Each UI task ships a numbered manual protocol with expected observations. No vitest/Playwright.

---

## Fidelity note (read before executing)

This plan commits to **all** stages, but fidelity is front-loaded honestly:

- **Stage 1** — fully bite-sized, execution-ready now (real code + manual protocols).
- **Stage 2** — bite-sized for the Go-testable serialization core; UI tasks outlined against Stage 1's output.
- **Stages 3 / 4a / 4b** — roadmapped: file maps, interfaces, task outlines, exit criteria, dependencies. **Bite-size each just-in-time** when its predecessor lands, because exact code depends on what earlier stages create (and Stage 4b couples to the separate reconciler project, spec §11). Writing exact code for them now would be fabrication.

Each stage produces working, shippable software on its own.

---

## File map (whole arc)

| File | Responsibility | Stage |
|---|---|---|
| `frontend/src/static/block-chrome.js` *(new)* | Decoration-based per-node chrome (gutter cell + drag handle) + drag-reorder ProseMirror plugin | 1 |
| `frontend/src/static/block-selection.js` *(new)* | Click/shift-click whole-block selection; snap-at-atom helper | 1 |
| `frontend/src/static/editor.css` | Chrome rail/handle styles, gap-cursor styling, selection ring | 1, 3, 4a |
| `frontend/src/static/editor.js` | Register new extensions; extend `handleCopy` for multi-block `sieve/<kind>`; wire selection | 1, 2 |
| `frontend/src/static/extensions.js` | Expose new extensions on `window.TipTap`; column-row container node | 1, 2, 3 |
| `frontend/src/index.html` | `<script>` tags for new static modules | 1, 3 |
| `frontend/src/static/clipboard.js` *(new)* | Multi-block clipboard slice → `sieve/<kind>` payload assembly; paste reconstruct | 1, 2 |
| `sieve/columnrow_serializer.go` *(new)* | Serialize/parse `column-row` fence ↔ shadow-doc; Shape 1, scalar prose, inner-fence nesting | 2 |
| `sieve/columnrow_serializer_test.go` *(new)* | Go round-trip tests incl. multi-level nesting spike | 2 |
| `frontend/src/static/column-row-renderer.js` *(new)* | `column-row` NodeView: cells, resize grab-handle, drop-zones | 3 |
| `frontend/src/static/lineage-gutter.js` *(new)* | Read `ref` chains → draw gutter bracket-chains (v0) | 4a |
| `frontend/src/static/doc-map.js` *(new)* | Structural document map rail | 4b |

---

## Stage 1 — Chrome + reorder + leaf-world substrate

**Goal:** every top-level node shows a uniform gutter cell + hover drag handle; you can drag-reorder blocks; the gap cursor always lets you place the caret; clicking a handle selects a whole block (shift-click a range); copying a block (or several) puts a `sieve/<kind>` payload on the clipboard. No schema change.

**Exit criteria:**
- Hovering any top-level block reveals a drag handle + persistent gutter cell.
- Dragging the handle reorders the block; a drop indicator shows the target.
- Caret can be placed above/below/between island blocks (gap cursor visible).
- Click-handle selects the whole block (visible ring); shift-click extends to a block range.
- Copying selected block(s) and pasting back into Sieve reconstructs them; pasting into a plain text field yields markdown.

### Task 1.1: Scaffold the `BlockChrome` extension and register it

**Files:**
- Create: `frontend/src/static/block-chrome.js`
- Modify: `frontend/src/static/extensions.js` (expose on `window.TipTap`)
- Modify: `frontend/src/index.html` (script tag)
- Modify: `frontend/src/static/editor.js:135-149` (add to extensions list)

- [ ] **Step 1: Create the extension skeleton** — a TipTap `Extension` adding one ProseMirror plugin that, for now, logs each top-level node range. Establishes the plugin wiring before any decoration work.

```js
// frontend/src/static/block-chrome.js
// Depends on window.TipTap (vendor/tiptap.js) loaded first.
;(function () {
  'use strict'
  var T = window.TipTap
  var Extension = T.Extension
  var PMState = T.pmState || (window.TipTap.pmState)        // @tiptap/pm/state re-export
  var PMView  = T.pmView  || (window.TipTap.pmView)         // @tiptap/pm/view
  // Fallback: TipTap 3 re-exports PM primitives on the bundle. If these are
  // undefined, expose them from tiptap-bundle-entry.js (see Step 4 note).
  var Plugin = PMState.Plugin
  var PluginKey = PMState.PluginKey

  var blockChromeKey = new PluginKey('blockChrome')

  var BlockChrome = Extension.create({
    name: 'blockChrome',
    addProseMirrorPlugins: function () {
      return [
        new Plugin({
          key: blockChromeKey,
          view: function () {
            return { update: function () {} }
          },
        }),
      ]
    },
  })

  T.BlockChrome = BlockChrome
})()
```

- [ ] **Step 2: Confirm PM primitives are reachable.** TipTap bundles `@tiptap/pm`. Check `vendor/tiptap.js` exposes `Plugin`/`Decoration`. Run:

```bash
grep -n "Decoration\|PluginKey\|DecorationSet" frontend/src/static/vendor/tiptap.js | head
```
Expected: matches present (bundle includes prosemirror-view/state). If `T.pmState`/`T.pmView` are **not** exposed, add explicit re-exports in `frontend/tiptap-bundle-entry.js` (`export { Plugin, PluginKey } from '@tiptap/pm/state'; export { Decoration, DecorationSet } from '@tiptap/pm/view'`) and rebuild with `npm run bundle:tiptap`. Note this in the commit.

- [ ] **Step 3: Register the extension.** In `editor.js`, add `T.BlockChrome` to the `extensions: [...]` array (near line 138, after `T.BlockNode`):

```js
        T.BlockNode,
        T.BlockChrome,
```

- [ ] **Step 4: Add the script tag.** In `frontend/src/index.html`, alongside the other static module tags, before `editor.js`:

```html
<script src="/static/block-chrome.js"></script>
```

- [ ] **Step 5: Manual verify.**

Run: `wails dev`
Protocol:
1. Open any note. Open devtools console.
2. Confirm no errors mentioning `block-chrome` or `Plugin`.
3. Type `window.TipTap.BlockChrome` in console → expect a defined object.
Expected: editor loads normally; extension registered.

- [ ] **Step 6: Commit.**

```bash
git add frontend/src/static/block-chrome.js frontend/src/static/extensions.js frontend/src/index.html frontend/src/static/editor.js
git commit -m "Scaffold BlockChrome extension (no-op plugin wiring)"
```

### Task 1.2: Render the gutter cell + drag handle as decorations

**Files:**
- Modify: `frontend/src/static/block-chrome.js`

- [ ] **Step 1: Build a decoration set over top-level nodes.** Replace the no-op plugin with one that, in `props.decorations`, walks the doc's **direct children** and adds, per top-level node, a `Decoration.widget` at the node's start position rendering the handle + gutter cell DOM. (Widget decorations don't alter the document, satisfying "chrome via decorations, not schema".)

```js
var Decoration = PMView.Decoration
var DecorationSet = PMView.DecorationSet

function buildDecorations(doc) {
  var decos = []
  doc.forEach(function (node, offset) {
    var pos = offset           // position just before this top-level node
    decos.push(Decoration.widget(pos + 1, function () {
      var wrap = document.createElement('div')
      wrap.className = 'block-chrome'
      wrap.setAttribute('contenteditable', 'false')
      var handle = document.createElement('span')
      handle.className = 'block-chrome-handle'
      handle.setAttribute('draggable', 'true')
      handle.textContent = '⠷'         // ⠷ braille drag dots
      var rail = document.createElement('span')
      rail.className = 'block-chrome-rail'
      wrap.appendChild(handle)
      wrap.appendChild(rail)
      return wrap
    }, { side: -1, key: 'chrome-' + pos }))
  })
  return DecorationSet.create(doc, decos)
}
```
Wire it: `new Plugin({ key: blockChromeKey, props: { decorations: function (state) { return buildDecorations(state.doc) } } })`.

- [ ] **Step 2: Manual verify chrome appears.**

Run: `wails dev`
Protocol:
1. Open a note with a heading, a paragraph, and a code/diagram block.
2. Confirm a small handle + rail appears at the left of **each** top-level block.
3. Confirm typing in a paragraph is unaffected (chrome is `contenteditable=false`).
Expected: uniform chrome on every top-level node; prose still editable.

- [ ] **Step 3: Commit.**

```bash
git add frontend/src/static/block-chrome.js
git commit -m "BlockChrome: render gutter cell + drag handle as widget decorations"
```

### Task 1.3: Style the chrome (hover-reveal handle, persistent rail)

**Files:**
- Modify: `frontend/src/static/editor.css`

- [ ] **Step 1: Add chrome styles.** Position the chrome in a left gutter; handle hidden until the block (or editor) is hovered; rail faint and persistent (it is the lineage rail's home in 4a).

```css
/* Block chrome (Stage 1) */
.editor-panel { --chrome-w: 28px; }
.ProseMirror { position: relative; padding-left: var(--chrome-w); }
.block-chrome { position: absolute; left: calc(-1 * var(--chrome-w)); width: var(--chrome-w);
  display: flex; align-items: flex-start; gap: 2px; user-select: none; }
.block-chrome-handle { opacity: 0; cursor: grab; color: var(--theme-muted);
  font-size: 12px; line-height: 1.4; transition: opacity .1s; }
.ProseMirror:hover .block-chrome-handle,
.block-chrome:hover .block-chrome-handle { opacity: .6; }
.block-chrome-handle:hover { opacity: 1 !important; }
.block-chrome-rail { width: 3px; align-self: stretch; border-radius: 2px;
  background: transparent; }
.block-chrome:hover .block-chrome-rail { background: rgba(120,140,255,.22); }
```

- [ ] **Step 2: Manual verify.**

Run: `wails dev`
Protocol:
1. Handle is hidden until you hover the editor / a block, then fades in.
2. Content text is not pushed around when chrome toggles (it lives in the gutter).
3. Cursor over the handle shows `grab`.
Expected: clean hover-reveal; no layout shift.

- [ ] **Step 3: Commit.**

```bash
git add frontend/src/static/editor.css
git commit -m "BlockChrome: hover-reveal handle + persistent gutter rail styles"
```

### Task 1.4: Drag-reorder a block via its handle

**Files:**
- Modify: `frontend/src/static/block-chrome.js`

- [ ] **Step 1: Implement drag-reorder.** On the handle, set `dragstart` to select the whole top-level node (NodeSelection) and seed the drag with its serialized slice; on the plugin add a `handleDrop`/`drop` that computes the target top-level boundary via `view.posAtCoords` and moves the node with a single transaction. Use ProseMirror's built-in drag where possible: setting `draggable` + a NodeSelection lets PM move the node; we add a drop indicator.

```js
// inside the widget handle creation (Task 1.2), capture pos via closure:
handle.addEventListener('mousedown', function () {
  var tr = view.state.tr.setSelection(
    PMState.NodeSelection.create(view.state.doc, pos))
  view.dispatch(tr); view.focus()
})
// PM moves a NodeSelection on native drag automatically when draggable=true.
```
Add a drop-indicator decoration computed in `props.decorations` from a plugin-state position updated on `dragover` (store target boundary in plugin state via `apply`). Keep the indicator a 2px line decoration at the nearest top-level boundary.

> Engineer note: this is the trickiest Stage-1 task. If the native NodeSelection drag proves unreliable for atom blocks, fall back to a manual implementation **in a single transaction** — critical for undo integrity (separate delete + insert transactions need two Mod+Z and can flash invalid intermediate doc states). On `dragstart` store `pos`; on `drop` compute the target top-level boundary, then **map the insert position through the delete** (the target shifts left by `nodeSize` if it was after `from`):
> ```js
> var node = view.state.doc.nodeAt(from)
> var tr = view.state.tr.delete(from, from + node.nodeSize)
> var insertAt = tr.mapping.map(targetPos)   // map through the delete — do NOT use raw targetPos
> tr.insert(insertAt, node)
> view.dispatch(tr)
> ```
> Both the native and manual approaches are acceptable; verify undo restores order in a **single** Mod+Z (protocol below).

- [ ] **Step 2: Manual verify reorder.**

Run: `wails dev`
Protocol:
1. Create three paragraphs A, B, C.
2. Drag B's handle below C. Expect order A, C, B; a drop line shows before release.
3. Drag a diagram/code block above a paragraph. Expect it moves as one unit.
4. Undo (Mod+Z) restores order.
Expected: blocks reorder cleanly; atoms move whole; undo works.

- [ ] **Step 3: Commit.**

```bash
git add frontend/src/static/block-chrome.js
git commit -m "BlockChrome: drag-reorder top-level blocks via the handle"
```

### Task 1.5: Gap cursor — confirm enabled and style it

**Files:**
- Modify: `frontend/src/static/editor.js` (only if Gapcursor is disabled)
- Modify: `frontend/src/static/editor.css`

- [ ] **Step 1: Confirm StarterKit ships Gapcursor.** TipTap 3 StarterKit includes Gapcursor by default. Verify:

```bash
grep -n "gapcursor\|Gapcursor\|gapCursor" frontend/src/static/vendor/tiptap.js | head
```
Expected: present. If StarterKit is configured to disable it, re-enable in `editor.js:136` (`StarterKit.configure({ ..., gapcursor: true })`).

- [ ] **Step 2: Style the gap cursor** so it's visible next to island blocks:

```css
.ProseMirror-gapcursor { z-index: 30; }            /* keep it above island NodeViews */
.ProseMirror-gapcursor:after { border-top: 2px solid var(--theme-accent, #5b7cff); width: 60%; }
```
> Explicitly verify the cursor is reachable **above the first** block, **below the last** block, and **between two adjacent island blocks** — these are where it tends to collapse invisibly.

- [ ] **Step 3: Manual verify.**

Run: `wails dev`
Protocol:
1. Put a diagram block as the last node. Press Down/→ past it.
2. Expect a blinking gap cursor below the block; typing creates a new paragraph there.
3. Place a block as the first node; press Up/← above it — gap cursor appears above.
Expected: caret can always be placed around island blocks.

- [ ] **Step 4: Commit.**

```bash
git add frontend/src/static/editor.js frontend/src/static/editor.css
git commit -m "Stage 1: confirm + style gap cursor around island blocks"
```

### Task 1.6: Whole-block selection (click handle, shift-click range)

**Files:**
- Create: `frontend/src/static/block-selection.js`
- Modify: `frontend/src/index.html`, `frontend/src/static/editor.js` (register), `frontend/src/static/editor.css` (selection ring)

- [ ] **Step 1: Implement handle-click selection.** Click a handle → `NodeSelection` on that top-level node. Shift-click another handle → a `TextSelection` spanning from the first node's start to the second node's end (a block range; ProseMirror renders it as a multi-node selection). Expose a small extension `T.BlockSelection` with a `view` plugin, or extend `block-chrome.js`'s handle to dispatch the selection (already seeded in Task 1.4 Step 1; here add shift-range).

```js
handle.addEventListener('click', function (e) {
  e.preventDefault()
  if (e.shiftKey && lastSelectedPos != null) {
    var from = Math.min(lastSelectedPos, pos)
    var toNode = view.state.doc.nodeAt(Math.max(lastSelectedPos, pos))
    var to = Math.max(lastSelectedPos, pos) + (toNode ? toNode.nodeSize : 1)
    view.dispatch(view.state.tr.setSelection(
      PMState.TextSelection.create(view.state.doc, from, to)))
  } else {
    lastSelectedPos = pos
    view.dispatch(view.state.tr.setSelection(
      PMState.NodeSelection.create(view.state.doc, pos)))
  }
  view.focus()
})
```

- [ ] **Step 2: Selection ring CSS.**

```css
.ProseMirror .ProseMirror-selectednode { outline: 2px solid var(--theme-accent, #5b7cff);
  outline-offset: 2px; border-radius: 4px; }
```

- [ ] **Step 3: Manual verify.**

Run: `wails dev`
Protocol:
1. Click a paragraph's handle → whole paragraph shows a selection ring.
2. Click a diagram's handle → whole block selected (ring around the island).
3. Click block A's handle, shift-click block C's handle → A–C selected.
4. Press Backspace on a node-selected block → it deletes as one unit; undo restores.
Expected: predictable whole-block selection; shift extends a range.

- [ ] **Step 4: Commit.**

```bash
git add frontend/src/static/block-selection.js frontend/src/index.html frontend/src/static/editor.js frontend/src/static/editor.css
git commit -m "Stage 1: whole-block selection via handle (click + shift-range)"
```

### Task 1.7: Multi-block `sieve/<kind>` clipboard

**Files:**
- Create: `frontend/src/static/clipboard.js`
- Modify: `frontend/src/static/editor.js` (the `copy` handler near `editorProps.handleDOMEvents.copy`, currently editor.js:167; and `handleSmartPaste`, editor.js:997)

- [ ] **Step 1: Assemble a multi-block payload on copy.** Today a single sieve block emits `sieve/<kind>` with its `serialisedForm` (sieve-block-extension.js:228). Generalize: when the selection spans one or more top-level nodes, build a clipboard payload that concatenates each node's authoritative form — sieve blocks → `serialisedForm`; prose/native → markdown via the existing `tiptap-markdown` serializer. Put three flavours on the event: `text/plain` (markdown), `text/html` (`toDOM`), and `sieve/slice` (a JSON array of `{kind, serialisedForm}` for rich reconstruct).

```js
// clipboard.js — exposes window.SieveClipboard.buildCopyPayload(view)
;(function () {
  'use strict'
  function buildCopyPayload(view) {
    var sel = view.state.selection, parts = [], markdown = []
    view.state.doc.nodesBetween(sel.from, sel.to, function (node, pos) {
      if (pos < sel.from || node.isText) return
      if (node.type.name.indexOf('sieve-') === 0) {
        parts.push({ kind: node.attrs.kind, serialisedForm: node.attrs.serialisedForm })
        markdown.push(node.attrs.serialisedForm || '')
        return false
      }
      return undefined
    })
    // prose fallback markdown via the editor's markdown storage:
    var md = view.dom.editor ? view.dom.editor.storage.markdown.getMarkdown() : markdown.join('\n\n')
    return { slice: parts, markdown: md }
  }
  window.SieveClipboard = { buildCopyPayload: buildCopyPayload }
})()
```

- [ ] **Step 2: Wire copy.** In `editor.js` `handleDOMEvents.copy`, after the existing image branch, when the selection contains sieve blocks, call `window.SieveClipboard.buildCopyPayload`, then `event.clipboardData.setData('sieve/slice', JSON.stringify(payload.slice))`, `setData('text/plain', payload.markdown)`, and `preventDefault()`.

- [ ] **Step 3: Wire paste.** In `handleSmartPaste` (editor.js:997), add a branch before the ai-block branch: if `event.clipboardData.getData('sieve/slice')` is non-empty, parse it and `insertContent` each block (`{ type: 'sieve-'+kind, attrs: { serialisedForm, ... } }`), `preventDefault()`. Fall through to existing markdown paste otherwise.

- [ ] **Step 4: Manual verify.**

Run: `wails dev`
Protocol:
1. Select a single diagram block (handle-click), Copy, paste in a new note → diagram reconstructs.
2. Select a paragraph + a code block (shift-range), Copy, paste into the same doc → both reappear in order.
3. Copy a block, paste into an external plain-text editor → you get markdown (the fence), not `[object]`.
Expected: rich reconstruct inside Sieve; markdown degrade outside.

- [ ] **Step 5: Commit.**

```bash
git add frontend/src/static/clipboard.js frontend/src/index.html frontend/src/static/editor.js
git commit -m "Stage 1: multi-block sieve/<kind> clipboard (copy + paste reconstruct)"
```

---

## Stage 2 — Container substrate + column-row serialization

**Goal:** introduce the first proper container node and its robust serialization; refine selection to traverse containers; unlock copy/paste for prose-shaped blocks. This is the lever that also lets `blockRef` be retired later (spec §4).

**Dependencies:** Stage 1 (chrome, selection, clipboard). **Exit criteria:** a `column-row` node round-trips to a `` ```column-row `` fence (Shape 1) through Go with verbatim scalar prose and 2-level nesting; selection traverses into a container; existing leaf blocks unaffected.

### Go-testable core (bite-sized now)

- ✅ **Task 2.1 — `column-row` serializer (Go).** **DONE.** Created `sieve/columnrow_serializer.go`: `SerializeColumnRow(cr ColumnRow) (string, error)` and `ParseColumnRow(fenceBody string) (ColumnRow, error)` implementing Shape 1 (string child = verbatim markdown scalar; single-key map = Sieve Block via `Child.MarshalYAML`/`UnmarshalYAML`; `widths`, `columns:[{children:[]}]`). Reuses `fencedblock.SerializeYaml` + recursive `forceLiteralStyle` — no hand-rolled YAML. *Deviations from outline:* (1) the in-memory type is `ColumnRow`/`Column`/`Child`, not the placeholder `ShadowNode`; (2) `SerializeColumnRow` returns `(string, error)` (matches `SerializeBlock`'s error convention) rather than bare `string`. Fence wrapping stays at the caller/InjectBlocks seam (Stage 2 UI).
- ✅ **Task 2.2 — Round-trip tests (Go).** **DONE.** `sieve/columnrow_serializer_test.go`: prose-only, prose-is-scalar-not-map, prose + diagram child (Shape-1 lift/lower), widths, multiline-prose literal style, and **the spike** (`TestColumnRow_NestedScalarComposesUnderNesting`): a diagram child with multiline scalars at YAML depths 4 and 5, raw-output assertion (no `\n` escaping; every deep scalar line indented ≥ 4 for fence safety), plus Serialize→Parse→Serialize byte-stability. **Spec §7 spike RESOLVED:** `forceLiteralStyle`'s recursion composes under nesting — deep multiline scalars emit as `|-` literal with structural indent a multiple of 4 (content may add its own indentation on top, so the real invariant is "≥ 4", not "exactly multiple of 4" — the over-strict assertion was corrected during the cycle). Run: `go test ./sieve/ -run ColumnRow -v`.

> These two tasks are full TDD (write failing Go test → implement → green), and they de-risk the serialization before any UI. **Both complete; full suite green.**

### UI tasks (outline — bite-size against Stage 1 output)

- **Task 2.3 — `column-row`/`column` nodes** in `extensions.js`: `Node.create` with `content: 'column+'` / `content: 'block+'`, real `contentDOM`, group `block`. Follow the `BlockNode`/`blockRef` *shape* (contentDOM) but **not** its `[!…]` serializer — markdown storage delegates to the Go fence via `serialisedForm`, like sieve blocks.
- **Task 2.4 — selection refinement** in `block-selection.js`: crossing into a container → native traversal; crossing an atom → snap (the rule from spec §5). Manual protocol: select text from a paragraph into a column's prose (traverses); select across a diagram (snaps).
- **Task 2.5 — leaf→container conversion guardrail:** verify diagram/code/image still behave as atoms (regression protocol).

---

## Stage 3 — Columns (the 2D layer)

**Goal:** authorable columns with resize + three creation gestures. **Dependencies:** Stage 2 container + serializer. **Exit criteria:** create a 2-col row, place a diagram beside prose, drag the divider to resize (widths persist), all three creation gestures work, depth cap = 1 enforced.

- **Task 3.1 — `column-row-renderer.js` NodeView:** render columns side-by-side from `widths`; a draggable divider updates `widths` live and writes it to the node attr.
- **Task 3.2 — Gesture B (insert/slash):** command inserting an empty 2/3-col row; fill cells. *(Built first — shared drop-into-cell plumbing.)*
- **Task 3.3 — Gesture A (drag-to-edge):** extend `block-chrome.js` drop logic — dropping a handle onto a block's left/right edge fuses a column-row (reuses 3.2's cell insert).
- **Task 3.4 — Gesture C (select→group):** command turning a block-range selection into a column-row.
- **Task 3.5 — Depth-cap policy:** block create/drop when it would nest a column-row in a column (gesture-level guard, not schema).
- **Task 3.6 — Cement linearise rung:** export transform flattening a column-row to linear markdown for 2D-incapable destinations (Go-testable; extend `columnrow_serializer.go`).

---

## Stage 4a — Lineage rail v0 (ref-chain graph, no reconciler)

**Goal:** draw the gutter graph of linked blocks from existing `ref` data. **Dependencies:** Stage 1 gutter only. **Exit criteria:** a block with a `ref` shows a bracket-chain to each referenced block; hover highlights neighbours; sparse-but-correct.

- **Task 4a.1 — `lineage-gutter.js`:** read each block's `ref` attr (comma-separated IDs; cf. `ai-block-renderer.js:31`), resolve IDs → positions, draw bracket-chain decorations in the Stage-1 rail. Reuse the existing anchor/highlight visual language (spec §8, memory `project_block_anchor_lineage`) — do not invent a parallel one.
- **Task 4a.2 — hover/select emphasis:** on hover/select of a block, brighten its immediate chain, dim deeper (the hybrid model). Manual protocol with an AI block referencing a code block.
- **Task 4a.3 — performance:** rebuild the decoration set only on doc/selection change; verify smooth on a large doc.

---

## Stage 4b — Lineage live + document map (gated on reconciler)

**Goal:** dirty-glow propagation + the structural document map. **Dependencies:** the reconciler / reference-graph project (brainstorm 2 §3–4) — **do not start before it lands** (spec §11). **Exit criteria:** editing a source glows its stale consumers (incl. off-screen, in the map); the doc-map shows flavour cells + viewport + click-to-jump.

- **Task 4b.1 — dirty propagation hook:** subscribe to reconciler dirty-set events; add always-on glow to stale blocks in the gutter.
- **Task 4b.2 — `doc-map.js`:** structural map rail — one flavour-coloured cell per block, column-rows as adjacent cells, off-screen dirty-glow, viewport box, click-to-jump. **Build the structural map, not a text minimap** (spec §8 / illustration A.4).
- **Task 4b.3 — three-zoom consistency:** ensure word-anchor (micro) ↔ gutter chain (meso) ↔ map cell (macro) share one visual language.

---

## Self-review

- **Spec coverage:** §2 substrate (no-switch, honored throughout) ✓; §3 unit-of-layout → Tasks 1.1–1.3 ✓; §4 container defect + blockRef succession → Stage 2 + Task 2.3 note ✓; §5 interaction substrate → Tasks 1.4–1.7, 2.4 ✓; §6 columns → Stage 3 ✓; §7 serialization (Shape 1, scalar prose, spike) → Tasks 2.1–2.2 ✓; §8 lineage (3-zoom, hybrid) → Stage 4a/4b ✓; §9 cement → Task 3.6 + 4b ✓; §10 staging → mirrored ✓; §13 forward-compat (wiring mode) → noted as Stage 3 drop-disambiguation seam (Task 3.3) and out-of-scope wiring ✓.
- **Placeholder scan:** Stage 1 steps carry real code + commands. Stages 2–4 are explicitly *outlines to bite-size just-in-time* (declared in the Fidelity note), not hidden placeholders.
- **Type/name consistency:** `sieve/slice` clipboard type, `block-chrome.js`/`block-selection.js`/`clipboard.js` filenames, `column-row`/`column` node names, `SerializeColumnRow`/`ParseColumnRow` used consistently across tasks.
- **Known risk carried forward:** Task 1.4 (drag-reorder) is the highest-risk Stage-1 item; it ships a primary approach + a documented fallback. Task 2.2 resolves the only spec-flagged open spike (multi-level YAML nesting) before any column UI.
