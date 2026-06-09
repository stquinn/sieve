# Sieve Block Selection — Corrected Design (v2)

**Date:** 2026-06-09  
**Status:** Approved for implementation  
**Supersedes:** `2026-06-09-sieve-block-selection-design.md`

---

## Why the Previous Plan Failed

The v1 spec removed `contentEditable="false"` from block wrappers and set `atom: false`. The
intention was correct — blocks should not fight ProseMirror's selection machinery. But the
implementation relied on `stopEvent` to prevent editing, which is insufficient.

`stopEvent` tells **ProseMirror** to ignore an event. It does not tell the **browser** to stop
inserting text. The browser's `beforeinput` pipeline fires independently, inserts characters into
the rendered DOM, and `ignoreMutation: true` silently hides the damage from ProseMirror. The block
DOM becomes visually corrupted without ProseMirror knowing.

The missing piece: **`beforeinput.preventDefault()`**.

---

## Root Cause of Selection Breakage

`contentEditable="false"` on block wrapper elements causes WebKit's `caretRangeFromPoint()` to
return `null` over those elements. ProseMirror uses this to track the drag endpoint during mouse
selection. When it returns `null`, the selection stops at the block boundary.

This is a WebKit-specific browser constraint. The only fix is to not have `contentEditable="false"`
on elements that selection must traverse.

---

## The Fix

Two changes in concert:

**1. `atom: false` — framework invariant**

`atom: true` was set to protect block content from editing, but that protection already exists via
`stopEvent` and `ignoreMutation`. `atom: true` is an overcorrection that additionally causes
ProseMirror to treat blocks as opaque units, breaking cursor navigation and selection.

Set `atom: false` as a hardcoded framework invariant in `createSieveNode`. Remove it from
`DEFAULT_NODE_CONFIG` and all renderer `nodeConfig` objects.

**2. `beforeinput.preventDefault()` — browser edit prevention**

In the framework NodeView constructor, immediately after creating the wrapper `dom` element, add:

```js
dom.addEventListener('beforeinput', function(e) { e.preventDefault() })
```

`beforeinput` fires before the browser inserts or deletes any content: typing, paste, cut,
drag-drop, IME composition, autocorrect. Calling `preventDefault()` stops all of these. It does
**not** fire for navigation (arrow keys, Home, End, selection extension) — those are unaffected.

This replaces `contentEditable="false"` as the edit-protection mechanism.

**3. Remove `contentEditable="false"` from all renderer `dom` elements**

Each renderer currently sets `dom.contentEditable = 'false'` manually. This must be removed.
Without it, WebKit's `caretRangeFromPoint()` works over the block DOM, and mouse drag selection
flows through blocks natively.

---

## What Does Not Change

- **Renderer interface** — `makeNodeView(node, editor)` signature unchanged. No `makeWidget`
  migration in this plan. That is a separate follow-on refactor.
- **Renderer rendering logic** — how cards look, what they render, all unchanged.
- **`nodeConfig`** — only `atom: true` is removed. `selectable`, `draggable`, `group`, `inline`
  are all unchanged.
- **`stopEvent`** — still present on each renderer's NodeView return. Still needed to prevent
  ProseMirror from routing keyboard events into blocks.
- **`ignoreMutation`** — still present. Belt-and-suspenders against any rogue DOM change.
- **Context menu** — unchanged.
- **Go side** — zero changes.
- **Markdown serialiser / fence parser** — zero changes.
- **`.sieve-in-selection` CSS and `onSelectionUpdate` handler** — kept. This provides visual
  selection highlight on blocks (needed because `::selection` CSS doesn't apply to NodeView DOM).
  It is correct behaviour and should not be removed.

---

## Protection After the Fix

With `contentEditable="false"` removed, three mechanisms protect block content:

1. **`beforeinput.preventDefault()`** (new, in framework) — stops the browser inserting or
   deleting content via any input pathway.
2. **`stopEvent`** (existing, per renderer) — stops ProseMirror routing keyboard events into the
   block. Prevents ProseMirror-level edits.
3. **`ignoreMutation: true`** (existing, per renderer) — ignores any rogue DOM mutations that
   slip through. ProseMirror's document state is always authoritative.

Editable blocks (code, diagram) already override `stopEvent` to pass events through to their
textarea. The `beforeinput` listener on their outer `dom` element will also need to be absent or
suppressed — this is handled by not attaching it when `renderer.editable === true` (or by the
editable renderer calling `dom.removeEventListener` for `beforeinput`).

Actually simpler: editable blocks (code, diagram) set their `stopEvent` to return `false`
(pass-through). We can use that same flag: if `renderer.editable`, skip the `beforeinput`
listener. Or: the textarea inside code/diagram blocks captures `beforeinput` first (inner
element wins), so the outer listener does not need special handling for them.

---

## Files Changed

| File | Change |
|------|--------|
| `frontend/src/static/sieve-block-extension.js` | `atom: false` hardcoded; `beforeinput` listener added to NodeView wrapper |
| `frontend/src/static/web-clip-renderer.js` | Remove `dom.contentEditable = 'false'`; remove `atom: true` from `nodeConfig` |
| `frontend/src/static/ai-block-renderer.js` | Same |
| `frontend/src/static/smart-card-renderer.js` | Same |
| `frontend/src/static/smart-link-renderer.js` | Same |
| `frontend/src/static/smart-image-renderer.js` | Same |
| `frontend/src/static/code-renderer.js` | Remove `atom: true` from `nodeConfig`; remove outer `dom.contentEditable = 'false'` only |
| `frontend/src/static/diagram-renderer.js` | Same as code |

`editor.js` and `editor.css`: **do not change** `.sieve-in-selection` — it is correct behaviour.

---

## Migration Checklist

### `sieve-block-extension.js`
- [ ] `DEFAULT_NODE_CONFIG`: remove `atom` field entirely
- [ ] `createSieveNode`: change `atom: cfg.atom` → `atom: false`
- [ ] Framework NodeView: add `dom.addEventListener('beforeinput', function(e) { e.preventDefault() })` immediately after `var wrapper = document.createElement(tag)`
- [ ] Delete the `mousemove` drag-selection listener (lines that extend `T._sieveDragSel`)
- [ ] Delete the `document.addEventListener('mouseup', ...)` re-apply hack
- [ ] Delete `T._sieveDragSel` references

### Per renderer (`web-clip`, `ai-block`, `smart-card`, `smart-link`, `smart-image`)
- [ ] Remove `atom: true` from `nodeConfig`
- [ ] Remove `dom.contentEditable = 'false'` from `makeNodeView`

### Editable blocks (`code-renderer.js`, `diagram-renderer.js`)
- [ ] Remove `atom: true` from `nodeConfig`
- [ ] Remove the outermost `dom.contentEditable = 'false'` only
- [ ] Leave inner `contentEditable="false"` on header/gutter sub-elements untouched

### Smoke test (per block kind after each renderer change)
- [ ] Mouse drag from text above block → through block → text below: selection spans block
- [ ] Shift+Arrow from adjacent text: selection extends through block
- [ ] Cmd+C on multi-block selection: clipboard contains serialised markdown fences
- [ ] Click inside block: no text cursor visible inside block content; cursor lands adjacent
- [ ] Type while block is in view: no characters inserted into block DOM
- [ ] Right-click: context menu appears
- [ ] Block re-renders correctly on `block-attrs-updated`

---

## Open Questions

None. `beforeinput.preventDefault()` is well-supported across all modern browsers including
WebKit. It covers all text insertion pathways. Navigation is unaffected.
