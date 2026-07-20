// @ts-check
// code-renderer.styles.js — CodeRenderer's stylesheet, a sibling module per
// the styles-file-geography convention (docs/design/archive/specs/2026-07-20-block-renderer-extraction.md,
// "Styles file geography"): a renderer file starts with its class — behaviour
// first, never a CSS wall — so any sheet over ~30 lines lives in its own
// `<kind>-renderer.styles.js` sibling module, imported into the class's
// `static styles`. This module is renderer-internal — nothing outside
// code-renderer.js imports it.
//
// Carried verbatim from editor.css's former UNSCOPED `.sieve-block--code` /
// `.sieve-block__body` / `.sieve-block__gutter` / `.sieve-block__code-area` /
// `.sieve-block__highlight` / `.sieve-block__edit` rules (moved here in the
// same change per the spec — style carriage is never a separate pass), now
// SCOPED under `.sieve-block--code` so this kind owns a complete, independent
// copy (mirroring how diagram-renderer.styles.js scoped its own body chrome
// under `.sieve-block--diagram` in Phase 2, rather than relying on the
// generic unscoped selectors). 'log' shares this exact body-chrome shape
// (its dom used to ALSO carry the `sieve-block--code` class to borrow this
// styling — see log-renderer.styles.js's header for why that coupling was
// retired in the same phase) and gets its OWN scoped copy at its migration —
// once both consumers have one, the generic unscoped rules in editor.css are
// dead and removed (the P4 sweep).
//
// The `--sieve-focus-accent` custom property declaration on `.sieve-block--code`
// stays FRAMEWORK-owned in editor.css (it feeds the shared generic
// `.sieve-block:focus-within` / `.ProseMirror-selectednode` rule every kind's
// shell participates in) — only the kind's OWN visual properties (shell
// background/border/radius, body/gutter/code-area chrome) move here.
//
// One change versus the old rule set (house rule: no hardcoded colour
// literals): the hover box-shadow's rgba(0,0,0,.25) becomes a color-mix
// against --theme-bgDark, matching the conversion diagram-renderer.styles.js
// and ai-block-renderer.styles.js already established for the identical
// unconverted-rgba idiom.

export const codeStyles = /* css */ `
  .sieve-block--code {
    display: flex;
    flex-direction: column;
    background: var(--theme-bgDark);
    border: 1px solid var(--theme-aiBlockBorder);
    border-radius: 8px;
    transition: border-color 0.2s ease, background-color 0.2s ease, box-shadow 0.2s ease;
  }

  .sieve-block--code:hover {
    border-color: color-mix(in srgb, var(--sieve-focus-accent) 60%, var(--theme-aiBlockBorder));
    box-shadow: 0 4px 20px color-mix(in srgb, var(--theme-bgDark) 25%, transparent);
  }

  .sieve-block--code .sieve-block__body {
    display: flex;
    overflow: hidden;
    border-radius: 0 0 8px 8px;
  }

  .sieve-block--code .sieve-block__gutter {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    padding: 0.85em 0.6em;
    background: var(--theme-bgDark);
    border-right: 1px solid var(--theme-gutterLineColor);
    color: var(--theme-lineNumberColor);
    font-family: var(--theme-monoFont);
    font-size: 0.85em;
    line-height: 1.6;
    user-select: none;
    flex-shrink: 0;
  }

  .sieve-block--code .sieve-block__gutter span {
    display: block;
    line-height: 1.6;
  }

  .sieve-block--code .sieve-block__gutter span::selection {
    background: transparent;
    color: inherit;
  }

  .sieve-block--code .sieve-block__code-area {
    display: grid;
    flex: 1;
    min-width: 0;
  }

  .sieve-block--code .sieve-block__highlight,
  .sieve-block--code .sieve-block__edit {
    grid-area: 1 / 1;
    font-family: var(--theme-monoFont);
    font-size: 0.85em;
    line-height: 1.6;
    padding: 0.85em 1.1em;
    white-space: pre-wrap;
    word-break: break-word;
    tab-size: 2;
    margin: 0;
    min-height: 2.5em;
    box-sizing: border-box;
  }

  .sieve-block--code .sieve-block__highlight {
    pointer-events: none;
    background: transparent;
    border: none;
    overflow: hidden;
  }

  .sieve-block--code .sieve-block__highlight code,
  .sieve-block--code .sieve-block__edit code {
    display: block;
    background: transparent;
    border: none;
    padding: 0;
    font: inherit;
    white-space: inherit;
    word-break: inherit;
    tab-size: inherit;
    color: inherit;
    border-radius: 0;
  }

  .sieve-block--code .sieve-block__edit {
    position: relative;
    z-index: 1;
    color: transparent;
    caret-color: var(--theme-text);
    background: transparent;
    border: none;
    outline: none;
    resize: none;
    overflow: hidden;
    cursor: text;
  }
`
