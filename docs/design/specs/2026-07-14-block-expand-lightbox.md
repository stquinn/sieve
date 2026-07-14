# Block Expand Lightbox — `expandable` as a declared block capability

**Status:** Draft
**Tracked:** #35
**Date:** 2026-07-14
**Future direction:** `docs/design/brainstorm-smart-code-blocks.md` — the same
overlay shell is the intended home for a later "focus mode" (code editing,
log tailing, running-program output). That mode is explicitly OUT of this
spec's scope; see §Future directions.

## Problem

Large diagrams are unusable. Mermaid renders an SVG that CSS squeezes to the
editor column (`.diagram-block__render svg { max-width: 100% }`), so a
2000px-wide flowchart is crushed into ~700px and its labels become
unreadably small. There is no zoom, no pan, no fullscreen view. Images share
the same `max-width: 100%` cap, and their resize handle only makes them
*smaller* than the column — never larger.

## Decision

Two changes, one capability seam:

1. **`expandable` becomes a declared block capability** — a new
   `interactionPolicy` flag paired with a renderer callback, following the
   existing `modEnterTogglesMode` + `onModEnter` pattern. The framework
   (`sieve-block-extension.js`) wires all affordances; adopting renderers
   write zero wiring. Diagram and smart-image adopt in this change.
2. **Inline diagram render becomes readable** — mermaid `useMaxWidth: false`
   (natural-size SVG) + `.diagram-block__render { overflow: auto;
   max-height: 60vh }`. Large diagrams are readable in-flow via scrolling;
   the lightbox is the "see it all" view. Small diagrams look identical.

Rejected alternatives: inline pan/zoom inside the block (wheel fights page
scroll, drag fights PM selection, and the block is a letterbox anyway);
native Fullscreen API (`requestFullscreen()` is unreliable in Wails v2's
WKWebView, and a window-filling overlay is visually identical in a desktop
app).

## The capability contract

A block kind opts in with two declarations on its renderer:

- `interactionPolicy: { expandable: true }` — new flag in `DEFAULT_POLICY`
  (`interaction-policy.js`), default `false`.
- `getExpandContent(node, dom)` → `{ element, title, mode }` or `null`.
  `null` means "nothing to expand right now" (diagram in edit mode, image
  still processing). `element` is a DOM element the lightbox will host —
  NOT a media-type union, so future content kinds need no contract change.
  `mode` today has one value, `'media'`, which activates the pan/zoom
  controller; a future `'live'` mode (focus mode) will skip it.

For any kind declaring `expandable`, the framework provides:

1. **Context-menu item** — "Expand" appended alongside the universal
   Ask AI / Explain / Delete items; omitted when `getExpandContent`
   returns `null`.
2. **Double-click** on the block's render surface opens the lightbox.
3. **Header expand button** injected when the block has a `headerProvider`
   (diagram gets it next to Edit/Render). Smart-image has no header — it
   gets gestures 1–2 only; retrofitting header chrome onto images is out
   of scope.

## The lightbox component

`frontend/src/static/ui/media-lightbox.js` — per
`docs/how-to-idiomatic-js.md`: real ES classes, `#private` fields, JSDoc
public contracts, `// @ts-check`. One lazily-created instance appended to
`document.body`. Internally two layers:

- **Overlay shell** (reused by every future mode): window-filling fixed
  overlay, dimmed backdrop, title bar, toolbar slot, Esc / backdrop-click /
  × close, focus capture on open and restore-to-editor on close.
- **Media controller** (`mode: 'media'` only): pan/zoom via
  `transform: translate() scale()` on a content wrapper. Opens at
  fit-to-window; wheel zooms around the cursor (clamped ~10%–1000%); drag
  pans; double-click toggles fit ↔ 100%; toolbar − / zoom% / + / Fit /
  100%. Static content only — live/editable surfaces must never receive a
  CSS transform.

Hand-rolled — no library, no npm dependency.

### Adopters in this change

- **Diagram**: hands over a clone of its already-rendered SVG (vector —
  scales losslessly). `getExpandContent` returns `null` in edit mode.
- **Smart-image**: hands over an `<img>` with its resolved `src`. Returns
  `null` while the asset job is PENDING/DISPATCHED or errored.

## Architecture notes

- **Pure view-layer JS, no Go round-trip.** The mermaid SVG exists only
  client-side, and pan/zoom is presentation state, not app logic — the same
  category as the existing image resize drag. This is a conscious call
  against the Go-as-controller direction: nothing here is a dialog with
  decisions or state Go should own. Zoom/pan state is ephemeral — NOT
  persisted to block attrs.
- **Contract doc updated in the same change.**
  `docs/editor-interaction-contract.md` gains: the `expandable` policy row,
  the double-click-to-expand gesture, and Esc-closes-overlay. No new
  in-editor keyboard chords — the policy extension's key handling is
  untouched.

## Future directions (recorded, not built)

`brainstorm-smart-code-blocks.md` sketches code blocks as executable
surfaces (run output, servers, logs). The intended UX for "focus on this
block" is this overlay shell with a `mode: 'live'` content mode: the block
declares `expandable`, returns its focused surface, and the shell provides
backdrop/close/focus management while skipping pan/zoom. The hard problem
deferred with it: an expanded *editable* surface means two live views of one
PM node — state-syncing that deserves its own design when that work becomes
real. Nothing in this spec's contract forecloses it; nothing in this spec's
scope implements it.

## Verification

`tsc --noEmit` over the new `@ts-check` file; drive `wails dev` with a large
flowchart and a large image — confirm inline scroll readability, all three
open gestures, zoom/pan/fit behaviour, Esc restore-to-editor, and that
edit-mode diagrams / pending images offer no expand.
