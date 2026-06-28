# Block-ID Hover Readout — Design

**Date:** 2026-06-28
**Status:** Approved, pending implementation
**Type:** Dev/debug affordance

## Goal

Hovering any block in the editor — prose or Sieve — shows a subtle
`kind · id · index` readout in the status bar. This is a developer/debug
affordance: nearly every recent defect (data-loss #1, AI-targeting, extraction)
is reasoned about in terms of block ids and top-level indices, so being able to
hover and read "this is `prose · pr-3f2a · 4`" while debugging is directly
useful.

Always-on and dim. No settings, no toggle, no backend. If it ever feels noisy
it can be gated behind a debug flag later (explicitly out of scope now).

## Why a uniform mechanism

Both block types already carry their identity the same way in the DOM, so there
is no prose-vs-Sieve branching:

- **Prose:** native PM nodes render `data-id` + class `block-node`
  (`prose-block.js`, the `blockId` global attribute). No `data-kind`.
- **Sieve:** NodeView host renders `data-id` **and** `data-kind`
  (`sieve-block-extension.js`).

A single `[data-id]` selector covers both. Kind is `el.dataset.kind || 'prose'`
— Sieve blocks declare their kind; prose blocks are kind-less in the DOM and so
are implicitly prose.

This reuses the established pattern already in the codebase: an editor-side
CustomEvent feeding a status-bar slot, exactly like `editor:stats` →
`.status-bar__stats`.

## Components

### 1. `blockIndexOf(doc, blockId)` — new pure helper

Location: `frontend/src/static/block-position.js`, beside `blockIndexAfter`.

Returns the **top-level** block index of the node whose `attrs.id === blockId`,
or `-1` if no top-level child matches. Differs from the existing
`blockIndexAfter` only in returning `i` rather than `i + 1`.

```js
// blockIndexOf(doc, blockId): the top-level block index of the node whose
// attrs.id === blockId; -1 if no DIRECT child of doc matches.
export function blockIndexOf(doc, blockId) {
  if (!blockId) return -1
  for (var i = 0; i < doc.childCount; i++) {
    var child = doc.child(i)
    if (child.attrs && child.attrs.id === blockId) return i
  }
  return -1
}
```

Exposed on `window.TipTap` alongside the other position helpers. Pure and
unit-testable without the editor.

### 2. `block-hover-id.js` — new module

Location: `frontend/src/static/block-hover-id.js`. Loaded as a `<script>` in
`index.html` next to the other static JS modules.

- Attaches one delegated `mouseover` and one `mouseout` listener on
  `#editor-container`.
- On `mouseover`: `e.target.closest('[data-id]')`.
  - If none → fire clear (see below).
  - Else read:
    - `id = el.dataset.id`
    - `kind = el.dataset.kind || 'prose'`
    - `index = (window.__tiptap && window.__tiptap.state)
        ? window.TipTap.blockIndexOf(window.__tiptap.state.doc, id) : -1`
  - Fire `document.dispatchEvent(new CustomEvent('editor:blockhover',
    { detail: { id: id, kind: kind, index: index } }))`.
- On `mouseout` that leaves the editor container (or lands on a non-block) →
  fire `editor:blockhover` with `{ detail: null }` to clear.

`mouseover` fires on element entry (not per-pixel like `mousemove`), so no
throttling is needed.

### 3. Status-bar slot + handler

`frontend/src/index.html`:

- Add `<div class="status-bar__blockid"></div>` inside `.status-bar__right`,
  **before** `.status-bar__stats`. Styled dim + monospace:
  `color: var(--theme-muted)` and `font-family: var(--theme-monoFont)`,
  small font size, right margin to separate from stats.
- Add a handler mirroring the `editor:stats` handler:

```js
document.addEventListener('editor:blockhover', function (e) {
  var slot = document.querySelector('.status-bar__blockid');
  if (!slot) return;
  var d = e.detail;
  if (!d) { slot.textContent = ''; return; }
  var idx = (d.index != null && d.index >= 0) ? ' · ' + d.index : '';
  slot.textContent = d.kind + ' · ' + d.id + idx;
});
```

When `blockIndexOf` returns `-1` (nested block id, or not found) the index is
omitted — the readout degrades to `kind · id`.

## Edge cases

- **Nested blocks:** `closest('[data-id]')` returns the innermost block element,
  which is the correct "what am I over" answer. `blockIndexOf` only matches
  top-level children, so a nested id yields `-1` → readout shows `kind · id`
  with no index. Acceptable for a debug tool.
- **No editor / empty doc:** `window.__tiptap` is null between loads → index
  resolves to `-1`; the readout still shows `kind · id` if a stray `[data-id]`
  is hovered, otherwise stays cleared.
- **Leaving the editor:** `mouseout` clears the slot so a stale id never lingers.

## Testing

- **`blockIndexOf`:** vitest unit tests alongside the existing `block-position`
  tests — found at index 0 / middle / last, not-found → `-1`, empty id → `-1`,
  nested-only id → `-1`.
- **Hover wiring + status-bar rendering:** UI glue; manual verification in the
  actual WebKitGTK app (per the project testing strategy — the Playwright
  browser harness is a separate future spec).

## Out of scope (YAGNI)

- Settings/toggle or debug-flag gating.
- Showing block labels, anchor lineage, or any backend-derived metadata.
- Sanitising id formats for end users — this is explicitly a dev affordance.
