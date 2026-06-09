# Sieve Block Selection & Copy — Architecture Design

**Date:** 2026-06-09  
**Status:** Approved for implementation  
**Branch:** feature/diagram_block (or new branch)

---

## Problem

Sieve blocks use `atom: true` in the ProseMirror schema. This causes ProseMirror to set
`contentEditable="false"` on each block's wrapper DOM element. WebKit's `caretRangeFromPoint()`
returns `null` over `contentEditable="false"` elements, so mouse drag selection cannot cross block
boundaries. Copy of text that spans blocks is broken. The editor does not feel like an editor.

Workarounds were added (mousemove selection extension, mouseup re-apply via `T._sieveDragSel`,
`.sieve-in-selection` CSS class) but these compensate for the symptom, not the cause.

---

## Goals

1. Mouse drag and keyboard selection flows through sieve blocks natively
2. Cmd+C copies content that spans blocks — baseline: the serialised markdown fence (ground truth)
3. Sieve block content remains non-editable for display-only block kinds (AI, web-clip, smart-card)
4. Editable blocks (code, diagram) continue to work exactly as before
5. No changes to Go, YAML, WS protocol, or any Go-side block processors
6. Doors remain open for future block kinds that need richer content models (`block*`)

---

## What Does Not Change

- **Go side** — block processors, `fencedblock.Serialize`, WS protocol, `block-attrs-updated`,
  `insert-block`, `retry-block-job`. Zero changes.
- **`fenced-block-base.js`** — `renderMarkdown`, `applyHighlighting`, `isJobStale`, `isJobActive`,
  SSE event tracking. Zero changes.
- **Block registration** — `T.registerSieveRenderer('kind', Renderer)` unchanged.
- **Context menu framework** — AI context, extract, promote, retry. Unchanged.
- **Markdown parse/serialise pipeline** — fence parser creates `sieve-*` nodes; serialiser replays
  `serialisedForm` verbatim. Unchanged.
- **Block kinds** — web-clip, ai-block, code, diagram, smart-card, smart-link. All stay.

---

## Root Cause & Fix

`atom: true` is the root cause. It was set to protect block content from accidental editing, but that
protection is already provided by `stopEvent` (blocks keyboard input) and `ignoreMutation` (ignores
any rogue DOM mutations). `atom: true` was an overcorrection that solved a problem already solved by
other mechanisms, while breaking selection as a side effect.

**The fix:** set `atom: false` as a framework invariant. ProseMirror no longer forces
`contentEditable="false"` on block wrapper elements. Selection and keyboard navigation flow through
blocks natively.

A companion change is required: renderers currently set `dom.contentEditable = 'false'` manually on
their NodeView DOM. This must be removed — otherwise the renderer undoes what the framework fix
achieves.

---

## Schema Changes

### `atom` — removed from `nodeConfig`, hardcoded `false` in framework

`atom` is no longer a per-renderer choice. It is always `false`. Renderers that currently declare
`atom: true` in `nodeConfig` simply drop it.

```js
// Before
nodeConfig: { atom: true, selectable: true, draggable: false }

// After
nodeConfig: { selectable: true, draggable: false }
```

### `content` — added to `nodeConfig`, default empty

Each renderer can declare a content model for its node type. This keeps future doors open without
requiring any current change.

```js
// Current blocks (default — no managed content)
nodeConfig: { selectable: true, draggable: false }
// content defaults to '' (leaf node, no ProseMirror-managed children)

// Future opt-in (e.g. a block that stores YAML as traversable text)
nodeConfig: { selectable: true, draggable: false, content: 'text*' }

// Future opt-in (e.g. a smart-table with TipTap-managed children)
nodeConfig: { selectable: true, draggable: false, content: 'block*' }
```

The factory in `sieve-block-extension.js` passes `cfg.content` through to the TipTap node schema.
No renderer needs to change today; the field exists when a future block needs it.

### Updated framework defaults

```js
var DEFAULT_NODE_CONFIG = {
  // atom removed — always false, never per-renderer
  selectable: true,
  draggable:  true,
  group:      'block',
  inline:     false,
  content:    '',      // leaf by default; override with 'text*' or 'block*' as needed
}
```

---

## Renderer Interface Changes

The NodeView lifecycle (`update`, `stopEvent`, `ignoreMutation`) moves into the framework.
Renderers no longer implement or return these. Renderers that need custom behaviour declare it as
named overrides on the renderer object — the framework calls them if present.

### `makeNodeView(node, editor)` → `makeWidget(attrs, editor)`

The renderer returns a DOM element only — not a NodeView object. The framework owns the NodeView
wrapper.

```js
// Before
makeNodeView: function(node, editor) {
  var dom = document.createElement('div')
  dom.contentEditable = 'false'          // ← REMOVE
  // ... render content ...
  return {
    dom: dom,
    contentDOM: null,
    update: function(updatedNode) { ... },
    ignoreMutation: function() { return true },
    stopEvent: function(e) { ... },
  }
}

// After
makeWidget: function(attrs, editor) {
  var dom = document.createElement('div')
  // No contentEditable = 'false'
  // ... render content using attrs (not node.attrs) ...
  return dom
}
```

The signature changes from `(node, editor)` to `(attrs, editor)`. Renderers receive the plain attrs
object rather than the full ProseMirror node. This removes the TipTap node type from the renderer's
surface — renderers work with data, not with ProseMirror internals.

### `updateWidget(dom, attrs, editor)` — optional

Called by the framework when the node's attrs change (i.e. on `block-attrs-updated`). The renderer
patches the existing DOM in place. If absent, the framework re-calls `makeWidget` and replaces the
inner content.

```js
updateWidget: function(dom, attrs, editor) {
  // patch dom in place — e.g. update spinner → content, update status badge, etc.
}
```

### `toClipboardText(attrs)` — optional, future

Returns a human-readable plain text or markdown string for the `text/plain` + `text/html` clipboard
payload (option C from the design discussion). Not implemented in this migration — the slot is
defined so future renderers can opt in. Baseline copy (option A — the serialised markdown fence) is
provided automatically by the markdown serialiser and requires no renderer code.

### `stopEvent(event)` — optional override

The framework provides a universal default. Renderers override only when their block needs custom
keyboard handling (e.g. code, diagram blocks that receive keyboard input into a textarea).

```js
// Framework default (display-only blocks get this automatically):
stopEvent: function(event) {
  // Allow: navigation (arrows, Home, End, PgUp/Dn), selection (Shift+arrow),
  //        system shortcuts (Ctrl/Cmd+C, Ctrl/Cmd+Z, Ctrl/Cmd+A)
  if (event.metaKey || event.ctrlKey) return false
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',
       'Home','End','PageUp','PageDown'].includes(event.key)) return false
  // Block: character input, Backspace, Delete, paste, cut
  return ['keydown','keyup','keypress','input','cut','paste'].includes(event.type)
}

// Editable block override (code, diagram — placed on the renderer object):
stopEvent: function(event) {
  // pass everything to the textarea
  return false
}
```

---

## Framework Changes (`sieve-block-extension.js`)

### `createSieveNode` — schema

- Remove `atom: cfg.atom` → hardcode `atom: false`
- Add `content: cfg.content || ''` to the node schema

### `createSieveNode` — NodeView

The NodeView factory now owns the full lifecycle. It calls the renderer for DOM creation and
optional updates; it provides universal `stopEvent` and `ignoreMutation`.

```js
addNodeView() {
  return function({ node, editor, getPos }) {
    var wrapper = document.createElement(cfg.inline ? 'span' : 'div')

    function buildContent(attrs) {
      wrapper.innerHTML = ''
      wrapper.appendChild(renderer.makeWidget(attrs, editor))
    }

    buildContent(node.attrs)

    // attach context menu (unchanged from current implementation)
    wrapper.addEventListener('contextmenu', /* ... existing handler ... */)

    return {
      dom: wrapper,
      contentDOM: null,
      update: function(updatedNode) {
        if (updatedNode.type.name !== nodeName) return false
        if (renderer.updateWidget) {
          renderer.updateWidget(wrapper.firstChild, updatedNode.attrs, editor)
        } else {
          buildContent(updatedNode.attrs)
        }
        return true
      },
      ignoreMutation: function() { return true },
      stopEvent: renderer.stopEvent
        ? function(e) { return renderer.stopEvent(e) }
        : defaultStopEvent,
    }
  }
}
```

### Remove selection hacks

The following code is deleted entirely — it exists only because of `atom: true` and is no longer
needed:

- `mousemove` listener on each NodeView's `dom` (selection extension during drag)
- `document.addEventListener('mouseup', ...)` (re-applies `T._sieveDragSel` after ProseMirror reset)
- `T._sieveDragSel` global state
- `.sieve-in-selection` CSS class manipulation in `editor.js`

---

## Copy / Paste

### Baseline A (ships with this migration)

ProseMirror's markdown serialiser replays `node.attrs.serialisedForm` verbatim for each sieve node
in the selection. This is unchanged from the current behaviour — it works correctly now that
selection spans blocks. No renderer changes needed.

Paste back into Sieve: TipTap parses the HTML clipboard payload and reconstructs nodes from
`data-*` attributes. Unchanged.

### Option C (future, per renderer)

When `renderer.toClipboardText(attrs)` is defined, a `copy` DOM event handler in the framework
adds a `text/plain` payload with the human-readable content and optionally a `text/html` payload
with rendered content. This is a follow-on implementation — the interface slot is declared now.

---

## Protection Against Accidental Block Editing

With `atom: false` and no `contentEditable="false"` on the wrapper, three mechanisms protect
display-only block content:

1. **`stopEvent`** (framework default) — blocks all character input, Backspace, Delete, paste, cut
   when the browser considers focus to be inside the block. Navigation and selection keys are
   explicitly allowed through.
2. **`ignoreMutation`** — any rogue DOM mutation (browser spellcheck, drag-and-drop, etc.) is
   ignored. ProseMirror's document state (the YAML attrs) is always authoritative; the next
   `updateWidget` call restores the DOM.
3. **ProseMirror click handling** — clicks on NodeView `dom` elements with no `contentDOM` are
   mapped to the nearest boundary position (before/after the node). The cursor lands adjacent to
   the block, not inside it.

Editable blocks (code, diagram) override `stopEvent` to allow keyboard input into their textarea.
This is an opt-in on the renderer, not a framework default.

---

## Migration Checklist (per renderer)

For each renderer file (`web-clip-renderer.js`, `ai-block-renderer.js`, `code-renderer.js`,
`diagram-renderer.js`, `smart-card-renderer.js`, `smart-link-renderer.js`, `smart-image-renderer.js`):

- [ ] Remove `atom: true` from `nodeConfig`
- [ ] Remove `dom.contentEditable = 'false'` from NodeView DOM construction
- [ ] Rename `makeNodeView` → `makeWidget`
- [ ] Change signature: `(node, editor)` → `(attrs, editor)`, update all `node.attrs.X` → `attrs.X`
- [ ] Remove `update`, `ignoreMutation`, `stopEvent` from the NodeView return object
- [ ] For editable blocks (code, diagram): add `stopEvent: function(e) { return false }` directly
  on the renderer object (not in the NodeView return)
- [ ] Smoke test: selection drag across the block, Cmd+C, paste, right-click context menu

`sieve-block-extension.js`:
- [ ] `createSieveNode`: hardcode `atom: false`, add `content: cfg.content || ''`
- [ ] `DEFAULT_NODE_CONFIG`: remove `atom`, add `content: ''`
- [ ] NodeView factory: implement framework-owned `update`, `stopEvent`, `ignoreMutation`
- [ ] Delete `mousemove` selection hack
- [ ] Delete `document.addEventListener('mouseup', ...)` re-apply hack
- [ ] Delete `T._sieveDragSel`

`editor.js`:
- [ ] Remove `.sieve-in-selection` class manipulation

`editor.css`:
- [ ] Remove `.sieve-in-selection` style rule (if present)

`docs/how-to-sieve-block-framework.md`:
- [ ] Update renderer template: `makeWidget`, new signature, no NodeView return shape
- [ ] Update `nodeConfig` table: remove `atom`, add `content`
- [ ] Update silent failure modes table

---

## What This Does Not Change

- The block lifecycle (PENDING → DISPATCHED → COMPLETE) is unchanged
- `block-attrs-updated` WS handler is unchanged — it updates node attrs via a TipTap command,
  which triggers the NodeView's `update` callback (now framework-owned, calls `updateWidget`)
- SSE job tracking (`ai:job-started`, `ai:job-ended`) is unchanged
- The fence parser (markdownit rules) is unchanged
- The markdown serialiser (`addStorage().markdown.serialize`) is unchanged
- Go processors, YAML format, `fencedblock.Serialize` — all unchanged

---

## Open Questions

None — all design decisions were resolved during the design session.

The `toClipboardText` slot is intentionally left unimplemented. Per-renderer clipboard text is a
follow-on feature once selection and copy baseline are shipped and validated.
