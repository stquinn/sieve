> **STATUS: DONE** — shipped; commit d6724e6. Archived 2026-07-07.

# Block-ID Hover Readout — Design

**Date:** 2026-06-28
**Status:** Approved, pending implementation
**Type:** Dev/debug affordance

## Goal

Hovering any block in the editor — prose or Sieve — shows a subtle `kind · id`
readout in the status bar. This is a developer/debug affordance: nearly every
recent defect (data-loss #1, AI-targeting, extraction) is reasoned about in
terms of block ids, so being able to hover and read "this is `prose · pr-3f2a`"
while debugging is directly useful.

**Index is deliberately NOT in the readout.** The gutter already renders a
line number for every top-level block (prose and Sieve alike) — `i + 1` over
the doc's direct children (`block-chrome.js`). That number sitting beside the
hovered block already gives the block's position, so duplicating it in JS would
mean reaching into the live PM doc on every hover for no new information.
Caveat the developer should keep in mind: the gutter is **1-based** while the
backend's `msg.index` is **0-based** (gutter "line 5" = backend index 4). If
that off-by-one ever needs to be eliminated, revisit — out of scope for now.

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

The feature is too small to warrant a new module. It is the same shape as the
existing character-count readout, which lives in exactly two places:

- **Producer:** `dispatchStats()` inside `editor.js` (computes, dispatches the
  `editor:stats` CustomEvent on editor update).
- **Consumer:** the `editor:stats` handler in `index.html` (writes
  `.status-bar__stats`).

The hover readout follows the same split — putting it anywhere else would be the
asymmetry we want to avoid (its twin already lives in `editor.js`).

### 1. Producer — in `editor.js`, beside the Stats section

When the editor mounts, attach one delegated `mouseover` and one `mouseout`
listener to the editor container (`editor.js` already owns the container at
mount; the char-count fires on *update*, so this is the one new wrinkle — a DOM
listener rather than an update hook).

- On `mouseover`: `e.target.closest('[data-id]')`.
  - If none → fire clear (see below).
  - Else read (pure DOM, no PM doc access):
    - `id = el.dataset.id`
    - `kind = el.dataset.kind || 'prose'`
  - Fire `document.dispatchEvent(new CustomEvent('editor:blockhover',
    { detail: { id: id, kind: kind } }))`.
- On `mouseout` that leaves the editor container (or lands on a non-block) →
  fire `editor:blockhover` with `{ detail: null }` to clear.

`mouseover` fires on element entry (not per-pixel like `mousemove`), so no
throttling is needed.

### 2. Consumer — status-bar slot + handler in `index.html`

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
  slot.textContent = d.kind + ' · ' + d.id;
});
```

## Edge cases

- **Nested blocks:** `closest('[data-id]')` returns the innermost block element,
  which is the correct "what am I over" answer. The gutter line number still
  reflects the enclosing top-level block — fine for a debug tool.
- **Leaving the editor:** `mouseout` clears the slot so a stale id never lingers.

## Testing

The whole feature is UI glue — a delegated DOM listener and a status-bar text
swap, with no pure logic to unit-test (the index lookup that would have needed
a vitest test was cut). Manual verification in the actual WebKitGTK app, per the
project testing strategy (the Playwright browser harness is a separate future
spec): hover a prose block → `prose · pr-xxxx`; hover each Sieve kind →
`<kind> · <id>`; move off into whitespace → readout clears.

## Out of scope (YAGNI)

- Settings/toggle or debug-flag gating.
- Showing block labels, anchor lineage, or any backend-derived metadata.
- Sanitising id formats for end users — this is explicitly a dev affordance.
