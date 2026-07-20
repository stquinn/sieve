// @ts-check
// diagram-renderer.styles.js — DiagramRenderer's stylesheet, a sibling module
// per the styles-file-geography convention (docs/design/specs/2026-07-20-block-renderer-extraction.md,
// "Styles file geography", user decision 2026-07-20): a renderer file starts
// with its class — behaviour first, never a CSS wall — so any sheet over
// ~30 lines lives in its own `<kind>-renderer.styles.js` sibling module
// (`export const <kind>Styles = /* css */ \`…\``, Lit-style), imported into
// the class's `static styles`. This module is renderer-internal — nothing
// outside diagram-renderer.js imports it.
//
// CSS text using ONLY --theme-* variables for colour (the host<->renderer
// styling contract). Carried verbatim from input.css's former
// .sieve-block--diagram / .diagram-block__* rules (moved here in the same
// change per the spec — style carriage is never a separate pass). Two
// changes versus the old global rule set:
//   1. the hover box-shadow's rgba(0,0,0,.25) becomes a color-mix against
//      --theme-bgDark (house rule: no hardcoded colour literals);
//   2. the mermaid .edgeLabel escape hatch is GONE from here — it now rides
//      inside each rendered SVG's own <style> (see diagram-renderer.js's
//      #patchEdgeLabelStyle), so it travels with the artefact instead of
//      depending on this stylesheet's cascade reaching wherever the SVG
//      currently lives (the lightbox-move bug this whole epic exists to fix).
// `animation: spin …` depends on the shared `@keyframes spin` Tailwind
// already emits globally (input.css / tailwind.css) — keyframes register
// document-wide regardless of which stylesheet (adopted or otherwise)
// declares the consuming rule, so no keyframe needs to travel with this class.

export const diagramStyles = /* css */ `
  .sieve-block--diagram {
    position: relative;
    border: 1px solid var(--theme-border);
    border-radius: 6px;
    background: var(--theme-bgDark);
    margin: 4px 0;
    /* overflow: hidden removed — it clips the block-chrome-host gutter (left: -48px).
       SVG overflow is contained by .sieve-block__body below instead. */
    transition: border-color 0.2s ease, background-color 0.2s ease, box-shadow 0.2s ease;
  }

  .sieve-block--diagram:hover {
    border-color: var(--theme-border2);
    box-shadow: 0 4px 20px color-mix(in srgb, var(--theme-bgDark) 25%, transparent);
  }

  /* Header: always visible in both modes */
  .sieve-block--diagram .sieve-block__header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px 5px 8px;
    border-bottom: 1px solid var(--theme-border);
    background: var(--theme-bgAlt);
  }

  .sieve-block--diagram .sieve-block__badge {
    font-size: 10px;
    font-family: var(--theme-monoFont);
    color: var(--theme-fg2);
    background: var(--theme-bgLight);
    border: 1px solid var(--theme-border2);
    border-radius: 3px;
    padding: 1px 6px;
    letter-spacing: 0.02em;
  }

  .sieve-block--diagram .sieve-block__type-label {
    font-size: 10px;
    color: var(--theme-fg3);
    font-family: var(--theme-monoFont);
  }

  /* Pill mode toggle */
  .diagram-block__toggle {
    display: flex;
    align-items: center;
    background: var(--theme-bgLight);
    border: 1px solid var(--theme-border2);
    border-radius: 4px;
    overflow: hidden;
    height: 22px;
  }

  .diagram-block__toggle-btn {
    font-size: 10px;
    padding: 0 9px;
    height: 100%;
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--theme-fg3);
    cursor: pointer;
    border: none;
    background: transparent;
    letter-spacing: 0.02em;
    transition: color 0.1s;
  }

  .diagram-block__toggle-btn svg {
    width: 9px;
    height: 9px;
    flex-shrink: 0;
  }

  .diagram-block__toggle-btn--active-edit {
    background: var(--theme-bgDark);
    color: var(--sieve-focus-accent, var(--theme-accent));
    border-radius: 3px;
    margin: 1px;
    height: calc(100% - 2px);
    padding: 0 8px;
  }

  .diagram-block__toggle-btn--active-render {
    background: var(--theme-bgDark);
    color: var(--sieve-focus-accent, var(--theme-accentGreen));
    border-radius: 3px;
    margin: 1px;
    height: calc(100% - 2px);
    padding: 0 8px;
  }

  /* Edit mode body — same CSS grid pattern as code block */
  .sieve-block--diagram .sieve-block__body {
    display: flex;
    min-height: 80px;
    overflow: hidden;
    border-radius: 0 0 6px 6px;
  }

  .sieve-block--diagram .sieve-block__gutter {
    width: 36px;
    flex-shrink: 0;
    background: var(--theme-bgDark);
    border-right: 1px solid var(--theme-border);
    padding: 10px 8px 10px 0;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 1px;
  }

  .sieve-block--diagram .sieve-block__gutter span {
    font-size: 10px;
    font-family: var(--theme-monoFont);
    color: var(--theme-fg3);
    line-height: 18px;
    display: block;
  }

  .sieve-block--diagram .sieve-block__code-area {
    flex: 1;
    display: grid;
    grid-template-columns: 1fr;
    grid-template-rows: 1fr;
    min-height: 80px;
  }

  .sieve-block--diagram .sieve-block__highlight,
  .sieve-block--diagram .sieve-block__edit {
    grid-area: 1 / 1;
    font-family: var(--theme-monoFont);
    font-size: 12px;
    line-height: 18px;
    padding: 10px 12px;
    white-space: pre;
    overflow-wrap: normal;
    overflow-x: auto;
    tab-size: 2;
    word-break: normal;
  }

  .sieve-block--diagram .sieve-block__highlight {
    color: var(--theme-text);
    background: transparent;
    pointer-events: none;
    border: none;
    margin: 0;
  }

  .sieve-block--diagram .sieve-block__edit {
    background: transparent;
    color: transparent;
    caret-color: var(--theme-text);
    border: none;
    resize: none;
    outline: none;
    width: 100%;
    min-height: 80px;
  }

  /* Render mode body — a fit-to-column OVERVIEW: the whole diagram, centred and
     scaled to fit, so you get a sense of it at a glance. Reading small labels is the
     lightbox's job (Mod+Alt+E / header ⤢ → fill-window + zoom). The SVG keeps its
     natural size (useMaxWidth:false) so the lightbox can size it; CSS scales it down
     here. max-height guards very tall diagrams; whole thing stays visible, no scroll. */
  .diagram-block__render {
    padding: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 120px;
    overflow: hidden;      /* clip inline Ctrl-zoom to the pane; pan within */
    position: relative;    /* anchor for the Ctrl affordance hint */
    contain: layout paint; /* isolate an inline-zoom transform from the surrounding
                               contentEditable doc — see setupInlinePanzoom below */
  }

  /* Inline pan/zoom wrapper (renderBody > .diagram-block__panzoom > svg). fit-content
     sizes it to the SVG's intrinsic width, capped at the column — breaking the
     circular sizing a plain content-box wrapper would create around max-width:100%. */
  .diagram-block__panzoom {
    width: fit-content;
    max-width: 100%;
    line-height: 0;
  }

  .diagram-block__render svg {
    max-width: 100%;
    max-height: 60vh;
    height: auto;
    display: block;
  }

  /* Armed (Ctrl held): the pane is a pan/zoom surface — grab cursor + a hint. */
  .diagram-block__render--pz { cursor: grab; }
  .diagram-block__render--pz::after {
    content: "⌃ scroll to zoom · drag to pan";
    position: absolute;
    top: 6px;
    right: 8px;
    font-family: var(--theme-monoFont);
    font-size: 10px;
    color: var(--theme-fg3);
    background: color-mix(in srgb, var(--theme-bgDark) 85%, transparent);
    border: 1px solid var(--theme-border);
    padding: 2px 7px;
    border-radius: 4px;
    pointer-events: none;
  }

  /* Error state */
  .diagram-block__error {
    padding: 14px 16px;
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  .diagram-block__error-icon {
    color: var(--theme-accentRed);
    font-size: 14px;
    flex-shrink: 0;
    margin-top: 1px;
  }

  .diagram-block__error-title {
    font-size: 12px;
    color: var(--theme-accentRed);
    font-weight: 500;
    margin-bottom: 4px;
  }

  .diagram-block__error-msg {
    font-family: var(--theme-monoFont);
    font-size: 11px;
    color: var(--theme-fg2);
    line-height: 1.5;
    margin-bottom: 10px;
  }

  /* Loading state while mermaid.js loads */
  .diagram-block__loading {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 80px;
    color: var(--theme-fg3);
    font-size: 12px;
    gap: 8px;
  }

  .diagram-block__spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid var(--theme-border2);
    border-top-color: var(--theme-accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
`
