# Block Expand Lightbox — `expandable` as a declared block capability

> **STATUS: DONE** — shipped and merged to `main` (merge `6c08a59`, 2026-07-15);
> #35 closed. As-built deltas from hands-on Chrome/WebKit validation (recorded on
> #35): lightbox opens fit-to-window with **free zoom** (panzoom `contain` removed);
> diagram **promotes its live SVG** (borrow-and-restore) rather than a stripped
> clone; affordance gating is **capability-based** (render mode), not async-SVG
> presence; lightbox uses a **solid** `--theme-bg` background; inline diagram is a
> **fit-to-column overview**. Follow-up beyond this spec: inline **Ctrl+wheel/drag**
> pan/zoom on the diagram render pane (the spec had rejected inline pan/zoom; the
> lightbox made a Ctrl-gated in-place version worthwhile) — its WebKit fix is
> `contain: layout paint` on the render pane (isolates the contentEditable repaint
> without a `will-change` raster layer). Archived 2026-07-15.

**Status:** Active (unparked 2026-07-15) — epic #31 (workspace/editor
component model) has landed, so the surfaces this capability wires into now
exist in their final shape. Seam names below are reconciled to the post-#31
tree: the Enter/chord dispatch that used to live in `editor.js` is now
`WysiwygSurface`'s `editorProps.handleKeyDown` (`editor/surfaces/wysiwyg-surface.js`)
plus the interaction-policy extension (`editor/interaction-policy.js`), which
already threads the parent Editor as `#host` — exactly the handle the expand
chord needs. The app-wide keyboard-shortcut taxonomy is tracked separately in
#39; this spec adopts its `Mod+Alt` = appearance/view tier for the expand chord.
**Tracked:** #35 (taxonomy: #39)
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
2. **Keyboard chord** — Mod+Alt+E expands the block at the caret stop /
   node selection, wired in the interaction-policy extension (per the
   contract, per-renderer key handling is forbidden). `Mod+Alt` is the
   appearance/view tier (#39); E = Expand. It is NOT a ProseMirror/TipTap
   binding (headings occupy Mod+Alt+`<digit>`, not letters), so there is
   nothing to fight — no pre-core interception, no core-keymap collision.
   NOTE: #35 does NOT rebind the diagram render toggle (it stays Mod+Enter);
   moving it to Mod+Alt+Enter is part of the taxonomy work in #39.
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
- **Media controller** (`mode: 'media'` only): pan/zoom driven by
  **`@panzoom/panzoom`** (timmywil) — a vendored, zero-dependency, MIT,
  CSS-transform pan/zoom lib that operates on any element (raster `<img>`,
  cloned SVG via its built-in `isSVG` handling, or future DOM). The
  controller owns policy, the lib owns the transform math:
  `Panzoom(content, { minScale ≈ 0.1, maxScale ≈ 10, startScale: <fit> })`;
  `parent.addEventListener('wheel', pz.zoomWithWheel)` gives cursor-anchored
  wheel zoom for free; drag-pan is built in; the toolbar (− / zoom% / + /
  Fit / 100%) calls `pz.zoomIn/zoomOut/reset` and reads `pz.getScale()` for
  the % readout; double-click toggles fit ↔ 100% via `pz.zoom()`. Opens at
  fit-to-window (`startScale` computed from the element's natural size vs
  the viewport). Static content only — live/editable surfaces must never
  receive a CSS transform, so the lib is instantiated for `mode:'media'`
  only and never touches a `live` surface.

**Dependency note (approved 2026-07-15).** The overlay shell is hand-rolled
(it is the reuse seam; every gallery-lightbox library wants to own it and
impose its own chrome — wrong shape). Only the fiddly, easy-to-get-wrong
part — cursor-anchored zoom + pinch + clamping — is delegated to
`@panzoom/panzoom`. It is vendored into `frontend/src/static/vendor/`
alongside the existing mermaid / js-yaml / htmx vendored libs (consistent
with the no-runtime-npm pattern); the exact ESM-import vs UMD-global
mechanism is a plan detail. Gallery libs (PhotoSwipe/GLightbox/Fancybox)
were rejected: they are image-URL *gallery* engines whose zoom does not
apply to hosted inline SVG or future terminal DOM, and Fancybox carries a
commercial licence.

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
  the Mod+Alt+E expand chord (policy-extension-owned, like the rest of the
  chord family; appearance tier per #39), and Esc-closes-overlay.

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
open gestures (header button, context menu, Mod+Alt+E), zoom/pan/fit
behaviour, Esc restore-to-editor, that double-click in the editor does NOT
expand (selection is undisturbed), and that edit-mode diagrams / pending
images offer no expand.
