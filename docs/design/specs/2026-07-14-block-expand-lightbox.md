# Block Expand Lightbox — `expandable` as a declared block capability

**Status:** Parked (user decision 2026-07-14) — detailed design and
implementation deferred until epic #31 (workspace/editor component model)
lands, since the capability wiring targets the exact surfaces #31 reshapes
(policy extension, block chrome, `editor.js` seams). Direction and
decisions in this spec stand; revisit the seam names against the post-#31
landscape before planning.
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
2. **Keyboard chord** — Shift+Mod+Enter expands the block at the caret
   stop / node selection, wired in the interaction-policy extension (per
   the contract, per-renderer key handling is forbidden). Sits beside
   Mod+Enter = mode toggle in the chord family.
3. **Header expand button** injected when the block has a `headerProvider`
   (diagram gets it next to Edit/Render). Smart-image has no header — it
   gets gestures 1–2 only; retrofitting header chrome onto images is out
   of scope.

Double-click-to-expand was considered and REJECTED (user decision
2026-07-14): in ProseMirror a click is NodeSelection and a double-click
starts text/word selection, so dblclick-to-expand misfires against
selection constantly, especially on images.

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
  the Shift+Mod+Enter expand chord (policy-extension-owned, like the rest
  of the chord family), and Esc-closes-overlay.

## Future directions (recorded, not built)

`brainstorm-smart-code-blocks.md` sketches code blocks as executable
surfaces (run output, servers, terminals, logs). The intended UX for
"focus on this block" is VALIDATED (2026-07-14), with the vehicle decided
by **where the surface's state lives**:

- **Backend-state surfaces** (log tail, running-program output, terminal —
  source of truth is Go: a process stream, PTY, SSE): this overlay shell
  with a future `mode: 'live'` that skips the pan/zoom controller. Input
  and all — a terminal's keystrokes route to Go, not to PM, so hosting it
  in the overlay creates no sync problem. The block declares `expandable`
  and returns its focused surface; the shell provides backdrop / close /
  focus management.
- **PM-document-state surfaces** (an editable code block, where the content
  IS the document): the overlay is the WRONG vehicle — reparenting the
  live NodeView out of `view.dom` breaks ProseMirror event routing, and a
  second synced editor view is the two-live-views problem. Editable focus
  instead expands IN PLACE: CSS the existing `.sieve-block` to
  `position: fixed; inset: 0` with a backdrop while it stays in the editor
  DOM — one view, zero sync, undo intact, the interaction policy still
  owns the keys. It shares the shell's *conventions* (backdrop, Esc, focus
  restore), not its DOM hosting.

Post-Wails-v3 (migration already decided), a separate native window is a
further option for long-running program dashboards. Nothing in this spec's
contract forecloses any of this; nothing in this spec's scope implements it.

## Verification

`tsc --noEmit` over the new `@ts-check` file; drive `wails dev` with a large
flowchart and a large image — confirm inline scroll readability, all three
open gestures (header button, context menu, Shift+Mod+Enter), zoom/pan/fit
behaviour, Esc restore-to-editor, that double-click in the editor does NOT
expand (selection is undisturbed), and that edit-mode diagrams / pending
images offer no expand.
