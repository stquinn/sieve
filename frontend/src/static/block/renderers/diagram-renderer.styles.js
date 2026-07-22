// @ts-check
// diagram-renderer.styles.js — DiagramRenderer's stylesheet, a sibling module
// per the styles-file-geography convention (docs/design/archive/specs/2026-07-20-block-renderer-extraction.md,
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

// DiagramTheme — the diagram kind's COMPLETE theming story in one module
// (user decision 2026-07-20): the CSS sheet (block chrome), the mermaid
// themeVariables mapping (the "stylesheet" for the SVG interior, in mermaid's
// dialect), and the edge-label escape-hatch patch that exists precisely
// because that mapping has a hole. Hole and patch sit side by side here;
// diagram-renderer.js keeps behaviour only.
export class DiagramTheme {
  static sheet = /* css */ `
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

  // ── mermaid escape hatch (rides with the render output, not the app stylesheet) ──
  //
  // Flowchart edge labels (Yes/No on links, and inter-subgraph edges in particular)
  // share mermaid's `.label` colour with node labels, which the theme below sets dark
  // for text sitting on light node fills (see #buildMermaidTheme's CONTRAST MODEL
  // comment). But edge labels float on the dark canvas, so that dark text goes
  // invisible. Mermaid exposes no separate variable for this, so the patch forces
  // edge-label text light — appended to mermaid's OWN in-SVG <style> element (added by
  // mermaid itself in every render) rather than left as an app-stylesheet rule. That
  // makes the SVG artefact style-complete BY ITSELF: it survives the fullscreen
  // lightbox's move (media-lightbox.js MediaLightbox#open relocates the live <svg> into
  // the overlay, and back on close) and any future host — the exact bug (b57fe22) this
  // epic's spec names as its motivating defect. `.edgeLabel` is a mermaid-only class
  // (unused elsewhere in the app), so this is safe wherever the SVG ends up. Node labels
  // use `.nodeLabel` (untouched); only `.edgeLabel` descendants are overridden.
  static edgeLabelPatchCss = /* css */ `
    .edgeLabel,
    .edgeLabel .label,
    .edgeLabel span,
    .edgeLabel p,
    .edgeLabel text,
    .edgeLabel tspan {
      color: var(--theme-text) !important;
      fill: var(--theme-text) !important;
    }
  `

  /** @returns {object} mermaid.initialize() config, incl. themeVariables sourced
   *  entirely from computed --theme-* custom properties on :root. */
  static buildMermaidInit() {
    const s = getComputedStyle(document.documentElement)
    /** @param {string} name */
    const v = (name) => s.getPropertyValue(name).trim()
    const bgDark    = v('--theme-bgDark')        || '#0e0e0e'
    const bgAlt     = v('--theme-bgAlt')         || '#1a1a1a'
    const text      = v('--theme-text')          || '#cccccc'
    const textDim   = v('--theme-textDim')       || '#888888'
    const accent    = v('--theme-accentPrimary') || '#7aa2f7'
    const accentCy  = v('--theme-accentCyan')    || '#7dcfff'
    const accentGr  = v('--theme-accentGreen')   || '#9ece6a'
    const accentOr  = v('--theme-accentOrange')  || '#ff9e64'
    const accentYe  = v('--theme-accentYellow')  || '#e0af68'
    const accentPu  = v('--theme-accentPurple')  || '#bb9af7'
    const accentRe  = v('--theme-accentRed')     || '#f7768e'
    const accentTe  = v('--theme-accentTeal')    || '#73daca'
    const border2   = v('--theme-border2')       || '#3a3a3a'

    // Rotating series palette for multi-series diagrams (pie slices, gitgraph
    // branches, journey/mindmap/timeline cScale, flowchart fillType). Distinct
    // theme accents so adjacent series read apart; assigned via the loop below.
    const palette = [accent, accentCy, accentGr, accentOr, accentYe, accentPu, accentTe, accentRe]

    // CONTRAST MODEL — mermaid's `base` theme assumes a LIGHT canvas with LIGHT
    // node fills, so one dark `textColor` reads everywhere. We invert to a DARK
    // canvas but keep LIGHT accent fills, which breaks that assumption: text on a
    // light fill needs DARK (bgDark); a label on the dark canvas needs LIGHT
    // (text). Mermaid derives ~every per-diagram text colour from `textColor`
    // (which itself defaults to primaryTextColor = bgDark here → dark-on-dark,
    // the whack-a-mole). So: set textColor LIGHT as the canvas default, then
    // override each on-a-fill text colour to bgDark per diagram family below.
    /** @type {Record<string, string>} */
    const tv = {
      // ── Typography ──
      fontFamily:           v('--theme-monoFont') || 'monospace',
      fontSize:             '12px',

      // ── Roots ──
      background:           bgDark,
      textColor:            text,        // master label colour (canvas) — the key fix
      lineColor:            textDim,
      arrowheadColor:       textDim,
      titleColor:           text,

      // ── Flowchart / generic nodes (light accent fills → dark text) ──
      primaryColor:         accent,
      primaryBorderColor:   accent,
      primaryTextColor:     bgDark,
      secondaryColor:       accentCy,
      secondaryBorderColor: accentCy,
      secondaryTextColor:   bgDark,
      tertiaryColor:        accentGr,
      tertiaryBorderColor:  accentGr,
      tertiaryTextColor:    bgDark,
      mainBkg:              accent,
      nodeBkg:              accent,
      nodeBorder:           border2,
      nodeTextColor:        bgDark,
      defaultLinkColor:     textDim,

      // ── Edge / generic labels (float on the dark canvas → light) ──
      // NOT 'transparent': flowchart's .labelBkg does fade(edgeLabelBackground, .5),
      // and fade('transparent') → semi-opaque BLACK (a black box behind edge
      // labels like Yes/No). Use the canvas colour so the box blends into the bg.
      edgeLabelBackground:  bgDark,
      labelColor:           text,
      labelTextColor:       text,
      labelBackgroundColor: bgAlt,

      // ── Subgraphs / clusters ──
      clusterBkg:           bgAlt,
      clusterBorder:        border2,

      // ── ER attributes + Class members (boxes are light → dark member text;
      //    relation labels float on the canvas → light) ──
      attributeBackgroundColorOdd:  bgAlt,
      attributeBackgroundColorEven: bgDark,
      classText:            bgDark,
      relationColor:        textDim,
      relationLabelColor:   text,
      relationLabelBackground: bgAlt,

      // ── State diagrams (state boxes light → dark labels; composites +
      //    transition labels live on the canvas → light) ──
      stateBkg:             accent,
      stateLabelColor:      bgDark,
      altBackground:        bgAlt,
      compositeBackground:  bgAlt,
      compositeBorder:      border2,
      compositeTitleBackground: bgAlt,
      innerEndBackground:   bgAlt,
      specialStateColor:    accentRe,
      transitionColor:      textDim,
      transitionLabelColor: text,

      // ── Sequence diagrams (own variable set, ignore the generic labels) ──
      actorBkg:             accent,
      actorBorder:          accent,
      actorTextColor:       bgDark,
      actorLineColor:       textDim,
      signalColor:          textDim,   // arrow/lifeline lines
      signalTextColor:      text,      // message labels above arrows
      labelBoxBkgColor:     bgAlt,
      labelBoxBorderColor:  border2,
      loopTextColor:        text,
      noteBkgColor:         bgAlt,
      noteBorderColor:      border2,
      noteTextColor:        text,
      activationBkgColor:   bgAlt,
      activationBorderColor: border2,
      sequenceNumberColor:  bgDark,

      // ── Gantt (task bars are light accents → dark in-bar text; section bands
      //    and outside/clickable text live on the canvas → light) ──
      sectionBkgColor:      bgAlt,
      sectionBkgColor2:     bgDark,
      altSectionBkgColor:   bgDark,
      taskBkgColor:         accent,
      taskBorderColor:      accent,
      taskTextColor:        bgDark,
      taskTextDarkColor:    bgDark,
      taskTextLightColor:   text,
      taskTextOutsideColor: text,
      taskTextClickableColor: accentCy,
      activeTaskBkgColor:   accentCy,
      activeTaskBorderColor: accentCy,
      doneTaskBkgColor:     bgAlt,
      doneTaskBorderColor:  border2,
      critBkgColor:         accentRe,
      critBorderColor:      accentRe,
      gridColor:            border2,
      todayLineColor:       accentRe,
      excludeBkgColor:      bgAlt,

      // ── Pie (slices = palette accents → dark slice text; title + legend on
      //    the canvas → light) ──
      pieTitleTextColor:    text,
      pieSectionTextColor:  bgDark,
      pieLegendTextColor:   text,
      pieStrokeColor:       bgDark,
      pieOuterStrokeColor:  border2,

      // ── Gitgraph (branch colours = palette below; commit/tag labels) ──
      commitLabelColor:     text,
      commitLabelBackground: bgAlt,
      branchLabelColor:     bgDark,
      tagLabelColor:        bgDark,
      tagLabelBackground:   accentYe,
      tagLabelBorder:       border2,

      // ── Quadrant charts (distinct accent per quadrant; on-fill text dark;
      //    chart title + axis labels on the canvas → light) ──
      quadrant1Fill: accentOr, quadrant2Fill: accentCy, quadrant3Fill: accentGr, quadrant4Fill: accentYe,
      quadrant1TextFill: bgDark, quadrant2TextFill: bgDark, quadrant3TextFill: bgDark, quadrant4TextFill: bgDark,
      quadrantPointFill: bgDark, quadrantPointTextFill: bgDark,
      quadrantTitleFill: text, quadrantXAxisTextFill: text, quadrantYAxisTextFill: text,
      quadrantInternalBorderStrokeFill: border2, quadrantExternalBorderStrokeFill: border2,

      // ── Requirement diagrams (light box → dark text) ──
      requirementBackground: accent,
      requirementBorderColor: accent,
      requirementTextColor:  bgDark,
    }

    // Multi-series scales — cycle the accent palette so adjacent series differ.
    // cScale 0-11 (journey/mindmap/timeline) and pie 1-12 share one cycle;
    // git/fillType/gitBranchLabel are 0-7. Branch labels sit on the (light)
    // branch colour, so their text is dark.
    for (let i = 0; i < 12; i++) {
      const c = palette[i % palette.length]
      tv['cScale' + i] = c
      tv['pie' + (i + 1)] = c
      if (i < 8) {
        tv['fillType' + i] = c
        tv['git' + i] = c
        tv['gitBranchLabel' + i] = bgDark
      }
    }

    return {
      startOnLoad: false,
      // A diagram's source is invalid BY DEFINITION mid-typing. Without this,
      // mermaid appends its error element straight to document.body on every
      // failed parse — a layout-breaking banner that survives until app
      // reload. Errors surface through the renderer's own catch (the in-block
      // error panel); mermaid must never touch the document.
      suppressErrorRendering: true,
      theme: 'base',
      themeVariables: tv,
      flowchart: { useMaxWidth: false },
      sequence: { useMaxWidth: false },
      gantt: { useMaxWidth: false },
    }
  }
}

// Back-compat alias for existing importers (tests/harness).
export const diagramStyles = DiagramTheme.sheet
