// @ts-check
// web-clip-renderer.styles.js — WebClipRenderer's stylesheet, a sibling
// module per the styles-file-geography convention (docs/design/archive/specs/2026-07-20-block-renderer-extraction.md,
// "Styles file geography"): a renderer file starts with its class — behaviour
// first, never a CSS wall — so any sheet over ~30 lines lives in its own
// `<kind>-renderer.styles.js` sibling module, imported into the class's
// `static styles`. This module is renderer-internal — nothing outside
// web-clip-renderer.js imports it.
//
// Carried verbatim from editor.css's former `.web-clip-block`/`.web-clip-block__*`
// rule set (moved here in the same change per the spec — style carriage is
// never a separate pass), PLUS the `.web-clip-block__badge::selection` entry
// this kind owned in editor.css's shared selector-reset list at the top of the
// file (only THIS kind's selector moved — the sibling kinds' selectors stay in
// editor.css until THEY migrate, same restraint rule ai-block-renderer.styles.js
// followed for `.ai-block__badge::selection`).
//
// `.sieve-block__heading` (the title/divider region) is DELIBERATELY NOT
// here — framework-owned chrome rendered by sieve-block-extension.js's
// titleProvider slot, shared by any kind declaring one (ai-block already
// established this restraint rule).
//
// Two changes versus the old rule set (house rule: no hardcoded colour
// literals): the hover/selected box-shadows' rgba(0,0,0,.25)/rgba(0,0,0,.45)
// become color-mix() against --theme-bgDark, matching the conversion every
// other migrated kind's stylesheet already established for the identical
// unconverted-rgba idiom.

export const webClipStyles = /* css */ `
  /* Guard the \`hidden\` IDL property/attribute WebClipRenderer#update toggles
     (spinner/icon/label/status/link/retry — see web-clip-renderer.js's
     mount-once/patch-on-update section): several of those elements ALSO carry
     an explicit \`display\` value below (e.g. .web-clip-block__retry's
     display:block, .web-clip-block__spinner's display:inline-block) at the
     SAME specificity as the UA stylesheet's \`[hidden] { display: none }\`
     rule — without this override, source order lets the explicit display win
     and the element stays visible despite hidden=true. Found live during the
     Phase 4 (#47) migration's manual app validation, not caught by the
     bare-page unit tests (happy-dom does apply \`[hidden]\`, but the test
     assertions checked the IDL property, not actual visibility).  */
  .web-clip-block [hidden] {
    display: none !important;
  }

  .web-clip-block {
    border: 1px solid var(--theme-aiBlockBorder);
    border-radius: 8px;
    background: var(--theme-aiBlockBg);
    margin-top: 1.5rem;
    margin-bottom: 2rem;
    padding: 1.25rem 1.5rem;
    position: relative;
    transition: border-color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
    user-select: text;
    -webkit-user-select: text;
  }

  .web-clip-block:hover {
    border-color: color-mix(in srgb, var(--theme-accentCyan) 60%, var(--theme-aiBlockBorder));
    background: color-mix(in srgb, var(--theme-accentCyan) 2%, var(--theme-aiBlockBg));
    box-shadow: 0 4px 20px color-mix(in srgb, var(--theme-bgDark) 25%, transparent);
  }

  .web-clip-block.ProseMirror-selectednode,
  .web-clip-block.sieve-block--focused {
    border-color: var(--theme-accentCyan) !important;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--theme-accentCyan) 25%, transparent),
                0 8px 30px color-mix(in srgb, var(--theme-bgDark) 45%, transparent) !important;
    background: color-mix(in srgb, var(--theme-accentCyan) 5%, var(--theme-aiBlockBg)) !important;
    outline: none !important;
  }

  .web-clip-block.web-clip-block--chain-active {
    border-color: color-mix(in srgb, var(--theme-accentCyan) 30%, var(--theme-aiBlockBorder)) !important;
    background: color-mix(in srgb, var(--theme-accentCyan) 4%, var(--theme-aiBlockBg));
  }

  .web-clip-block.web-clip-block--chain-active::after {
    content: '';
    position: absolute;
    inset: -1px;
    border-radius: 8px;
    border-left: 3px solid var(--theme-accentCyan);
    pointer-events: none;
    z-index: 5;
  }

  .web-clip-block__header {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 10px;
    /* Secondary/meta tier (see editor.css's .tiptap comment) — was 12px. */
    font-size: calc(var(--doc-size) * 0.75);
  }

  .web-clip-block__badge {
    position: absolute;
    top: -9px;
    left: 12px;
    background: var(--theme-bg);
    padding: 0 6px;
    /* Smallest chrome tier (badges/chips) — was 10px. */
    font-size: calc(var(--doc-size) * 0.7);
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--theme-accentCyan);
    font-family: var(--theme-monoFont);
    text-transform: uppercase;
    border: 1px solid var(--theme-border2);
    border-radius: 4px;
    z-index: 10;
    user-select: none;
    -webkit-user-select: none;
  }

  .web-clip-block__badge::selection {
    background: transparent;
    color: inherit;
  }

  .web-clip-block__status {
    /* Secondary/meta tier — was 12px. */
    font-size: calc(var(--doc-size) * 0.75);
    font-weight: 600;
    color: var(--theme-accentCyan);
  }

  .web-clip-block__source-link {
    /* Smallest chrome tier — was 11px. */
    font-size: calc(var(--doc-size) * 0.7);
    color: var(--theme-accentCyan);
    opacity: 0.75;
    text-decoration: none;
    word-break: break-all;
  }
  .web-clip-block__source-link:hover { opacity: 1; text-decoration: underline; }

  .web-clip-block__label {
    /* Secondary/meta tier — was 12px. */
    font-size: calc(var(--doc-size) * 0.75);
    color: var(--theme-textDim);
  }

  .web-clip-block__icon {
    /* Code tier (see .tiptap comment) — was 13px. */
    font-size: calc(var(--doc-size) * 0.85);
    margin-right: 4px;
  }
  .web-clip-block__icon--warn { color: var(--theme-accentOrange); }
  .web-clip-block__icon--error { color: var(--theme-accentRed); }

  .web-clip-block__spinner {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 2px solid color-mix(in srgb, var(--theme-accentCyan) 30%, transparent);
    border-top-color: var(--theme-accentCyan);
    border-radius: 50%;
    animation: wc-spin 0.8s linear infinite;
    margin-right: 6px;
    vertical-align: middle;
    flex-shrink: 0;
  }

  @keyframes wc-spin {
    to { transform: rotate(360deg); }
  }

  .web-clip-block__retry {
    display: block;
    margin-top: 8px;
    background: none;
    border: 1px solid var(--theme-border2);
    border-radius: 4px;
    color: var(--theme-textDim);
    cursor: pointer;
    /* Smallest chrome tier — was 11px. */
    font-size: calc(var(--doc-size) * 0.7);
    padding: 3px 10px;
  }
  .web-clip-block__retry:hover {
    border-color: var(--theme-accentCyan);
    color: var(--theme-accentCyan);
  }

  /* Reset tiptap defaults for the internal web-clip content renderer (it is a
     real PM-owned contentDOM carrying the .tiptap class — without this it
     inherits the editor's min-height:100vh + chrome padding and the panel
     becomes huge). */
  .web-clip-block .tiptap {
    min-height: 0;
    padding: 0;
  }

  .web-clip-block__content {
    color: var(--theme-text);
    /* Code tier (see .tiptap comment) — was a fixed 14px that never scaled.
       Not the body/prose tier: this is clipped-page content rendered inside
       a chrome card, not the primary document text the byte-identical-at-
       scale-1.0 rule protects. */
    font-size: calc(var(--doc-size) * 0.85);
    line-height: 1.6;
  }

  .web-clip-block__content p { margin: 0 0 0.6em; }
  .web-clip-block__content p:last-child { margin-bottom: 0; }
  .web-clip-block__content ul, .web-clip-block__content ol { margin: 0.4em 0 0.6em 1.4em; padding: 0; }
  .web-clip-block__content li { margin-bottom: 0.2em; }
  .web-clip-block__content strong { color: var(--theme-text); }
  .web-clip-block__content img { max-width: 100%; height: auto; display: block; }
`
