// @ts-check
// smart-image-renderer.styles.js — SmartImageRenderer's stylesheet, a sibling
// module per the styles-file-geography convention (docs/design/specs/2026-07-20-block-renderer-extraction.md,
// "Styles file geography"): a renderer file starts with its class — behaviour
// first, never a CSS wall — so any sheet over ~30 lines lives in its own
// `<kind>-renderer.styles.js` sibling module, imported into the class's
// `static styles`. This module is renderer-internal — nothing outside
// smart-image-renderer.js imports it.
//
// Carried from editor.css's former `.node-image`/`.image-block`/`.image-resizer`
// rules (moved here in the same change per the spec — style carriage is never
// a separate pass). `.node-image`/`.image-block`/`.image-resizer` were
// confirmed exclusive to this kind before moving (no native TipTap Image
// extension uses `.node-image`; it renders with a DIFFERENT class,
// `editor-image` — see wysiwyg-surface.js). Two rules were a shared selector
// LIST with prose's `.block-node` and the native-codeblock's
// `.code-block-wrapper` (chain-highlight ready-state + the ref-active glow) —
// only THIS kind's `.image-block` selector was extracted, the same surgical
// split ai-block-renderer.styles.js did for its `::selection` entry; the
// `.block-node`/`.code-block-wrapper` half of those rules stays in editor.css
// (prose/native-codeblock are out of scope for this epic).
//
// The status badge (`.smart-image-status*`) REPLACES the old inline
// `element.style.cssText = '...'` + per-state `badge.style.background/color`
// assignments with real CSS classes — the same DOM-out-of-JS-inline-styles
// upgrade LogRenderer's Explore table made at its own migration. Deliberate,
// noted exception to the house "no hardcoded colour literals" rule: the
// pending/error scrims keep literal white (`#fff`) badge TEXT over a
// deliberately dark/red overlay — an image-overlay convention (video-player-
// style captions) that intentionally reads the same regardless of the active
// app theme, unlike every other themed chip in this app. The overlay
// BACKGROUNDS themselves are expressed as `color-mix` scrims against
// `--theme-bgDark`/`--theme-accentRed` rather than the original hardcoded
// `rgba(0,0,0,.55)`/`rgba(180,0,0,.75)`.

export const smartImageStyles = /* css */ `
  /* Fix ghost selection bars in WebKit around images */
  .node-image,
  .node-image * {
    user-select: none !important;
    -webkit-user-select: none !important;
  }

  .node-image::selection,
  .node-image *::selection {
    background: transparent !important;
  }

  .node-image {
    position: relative;
  }

  div.node-image.ProseMirror-selectednode {
    outline: none !important;
    box-shadow: none !important;
  }

  /* Premium image tooltip (data-tooltip attribute set by SmartImageRenderer#update) */
  .node-image[data-tooltip]::after {
    content: attr(data-tooltip);
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%) scale(0.95);
    background: color-mix(in srgb, var(--theme-bgDark) 92%, transparent);
    color: var(--theme-text);
    padding: 10px 16px;
    border-radius: 8px;
    font-size: 11px;
    line-height: 1.5;
    white-space: pre-wrap;
    max-width: 80%;
    width: max-content;
    z-index: 10000;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s ease, transform 0.15s ease;
    border: 1px solid color-mix(in srgb, var(--theme-text) 10%, transparent);
    box-shadow: 0 10px 30px color-mix(in srgb, var(--theme-bgDark) 60%, transparent);
    text-align: center;
  }

  .node-image[data-tooltip]:hover::after {
    opacity: 0.9;
    transform: translate(-50%, -50%) scale(1);
  }

  /* This kind's own copy of the "block target node" ready-state (shared with
     prose's .block-node and the native-codeblock's .code-block-wrapper in
     editor.css — see this file's header for the surgical split) */
  .image-block {
    border-radius: 8px;
    transition: background-color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
    border-left: 3px solid transparent;
    padding: 4px 6px;
    position: relative;
    line-height: 0;
  }

  .image-block.block-ref-active {
    background-color: color-mix(in srgb, var(--theme-accentPrimary) 8%, transparent) !important;
    border-left-color: var(--theme-accentPrimary) !important;
  }

  .image-block img {
    border-radius: 4px;
    box-shadow: 0 0 0 1px var(--theme-aiBlockBorder);
    transition: box-shadow 0.2s ease;
  }

  .image-block:hover img {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-accentPrimary) 60%, var(--theme-aiBlockBorder)),
                0 4px 20px color-mix(in srgb, var(--theme-bgDark) 25%, transparent);
  }

  .image-block.ProseMirror-selectednode img {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--theme-accentPrimary) 25%, transparent),
                0 0 0 2px var(--theme-accentPrimary),
                0 8px 30px color-mix(in srgb, var(--theme-bgDark) 45%, transparent) !important;
  }

  .image-resizer {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 12px;
    height: 12px;
    background: var(--theme-accentPrimary);
    border: 1px solid var(--theme-bg);
    border-radius: 2px;
    cursor: nwse-resize;
    opacity: 0;
    transition: opacity 0.2s ease;
    z-index: 10;
  }

  .image-block:hover .image-resizer,
  .image-block.ProseMirror-selectednode .image-resizer {
    opacity: 1;
  }

  /* ── Status badge (Processing… / error) ─────────────────────────────── */

  .smart-image-status {
    position: absolute;
    top: 6px;
    left: 6px;
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
    pointer-events: none;
    display: none;
  }

  .smart-image-status--pending,
  .smart-image-status--error {
    display: block;
    /* Deliberate exception to the theme-var-only house rule — see file header. */
    color: #fff;
  }

  .smart-image-status--pending {
    background: color-mix(in srgb, var(--theme-bgDark) 55%, transparent);
  }

  .smart-image-status--error {
    background: color-mix(in srgb, var(--theme-accentRed) 75%, transparent);
  }
`
