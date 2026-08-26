// @ts-check
// SmartImageRenderer's stylesheet. Renderer-internal.
//
// Deliberate, noted exception to the house "no hardcoded colour literals" rule:
// the pending/error scrims keep literal white (`#fff`) badge TEXT over a
// deliberately dark/red overlay — an image-overlay convention (video-player-style
// captions) that intentionally reads the same whatever the active app theme is.
// The overlay BACKGROUNDS are color-mix scrims against --theme-bgDark and
// --theme-accentRed.

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

  /* Hugs the image, and is what the absolutely-positioned overlay chrome (resize
     handle, status badge) anchors to — so they sit on the IMAGE's corner rather
     than out at the edge of the full-width block root. Shrink-to-fit lives here,
     not on the root: the root must stay a normal full-width block so the image's
     own max-width:100% has a definite container to resolve against. */
  .smart-image-frame {
    position: relative;
    display: inline-block;
    max-width: 100%;
  }

  div.node-image.ProseMirror-selectednode {
    outline: none !important;
    box-shadow: none !important;
  }

  /* ── Description strap (#73) ─────────────────────────────────────────────
     Muted, small, tracked, behind a left rule — CHROME, never prose, so nothing
     about it invites a caret the atom NodeView cannot give it. Shown only when
     the persisted showSummary attribute is set. */
  .smart-image-summary {
    display: none;
    margin-top: 6px;
    padding-left: 10px;
    max-width: 46rem;
    border-left: 2px solid color-mix(in srgb, var(--theme-text) 18%, transparent);
    color: color-mix(in srgb, var(--theme-text) 62%, transparent);
    font-size: calc(var(--doc-size) * 0.8);
    line-height: 1.5;
    font-style: italic;
  }

  .smart-image-summary--shown { display: block; }

  /* SELECTABLE, unlike the rest of this block. The blanket rule at the top of
     this sheet kills selection across .node-image * to stop WebKit painting
     ghost selection bars around images — but the strap is text a reader will
     want to copy. Scoping the exception HERE, in the SAME sheet as the blanket
     rule, is what makes it deterministic: two classes deep out-specifies it and
     there is no cross-stylesheet injection order to lose to. */
  .node-image .smart-image-summary {
    user-select: text !important;
    -webkit-user-select: text !important;
  }

  .node-image .smart-image-summary::selection {
    background: color-mix(in srgb, var(--theme-accentPrimary) 40%, transparent) !important;
  }

  /* The hover description tooltip that used to live here was REMOVED by #73: it
     rendered dead-centre over the image at 80% width and ~90% opacity with no
     delay, so reaching for the image blotted out the thing it described. Failure
     text now lives only on the status badge. */

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
    /* Smallest chrome tier — was 10px. */
    font-size: calc(var(--doc-size) * 0.7);
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
