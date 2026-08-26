// @ts-check
// DiagramRenderer's stylesheet: CSS text using ONLY --theme-* variables for
// colour. Renderer-internal.
//
// The mermaid `.edgeLabel` escape hatch is deliberately NOT here — it rides
// inside each rendered SVG's own <style> (see #patchEdgeLabelStyle), so it
// travels with the artefact instead of depending on this stylesheet's cascade
// reaching wherever the SVG currently lives.
//
// `animation: spin …` depends on the shared `@keyframes spin` Tailwind emits
// globally: keyframes register document-wide regardless of which stylesheet
// declares the consuming rule, so no keyframe needs to travel with this class.

// DiagramTheme — the diagram kind's COMPLETE theming story in one module: the
// CSS sheet (block chrome), the mermaid themeVariables mapping (the SVG
// interior's "stylesheet", in mermaid's dialect), and the edge-label
// escape-hatch patch that exists precisely because that mapping has a hole.
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
    /* Smallest chrome tier (badges/chips — see .tiptap comment) — was 10px. */
    font-size: calc(var(--doc-size) * 0.7);
    font-family: var(--theme-monoFont);
    color: var(--theme-fg2);
    background: var(--theme-bgLight);
    border: 1px solid var(--theme-border2);
    border-radius: 3px;
    padding: 1px 6px;
    letter-spacing: 0.02em;
  }

  .sieve-block--diagram .sieve-block__type-label {
    font-size: calc(var(--doc-size) * 0.7);
    color: var(--theme-fg3);
    font-family: var(--theme-monoFont);
  }

  /* Engine picker — a native <select> dressed to read AS the type label, with a
     chevron that fades in on hover so the affordance stays quiet until sought. */
  .diagram-block__engine-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  /* Decorative chevron glyph, not read text — left as a fixed size like
     .block-chrome-handle's drag icon (editor.css); the font-size scale sweep
     covers text content, not icon-glyph affordances. */
  .diagram-block__engine-wrap::after {
    content: "▾";
    position: absolute;
    right: 1px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 8px;
    color: var(--theme-fg3);
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.12s ease;
  }

  .diagram-block__engine-wrap:hover::after,
  .diagram-block__engine-wrap:focus-within::after {
    opacity: 1;
  }

  .diagram-block__engine {
    appearance: none;
    -webkit-appearance: none;
    -moz-appearance: none;
    background: transparent;
    border: none;
    border-radius: 3px;
    margin: 0;
    padding: 1px 12px 1px 2px;
    font-family: var(--theme-monoFont);
    font-size: calc(var(--doc-size) * 0.7);
    line-height: 1.4;
    color: var(--theme-fg3);
    cursor: pointer;
    outline: none;
    transition: color 0.1s, background-color 0.1s;
  }

  .diagram-block__engine:hover,
  .diagram-block__engine:focus {
    color: var(--theme-fg2);
    background: var(--theme-bgLight);
  }

  .diagram-block__engine option {
    background: var(--theme-bgDark);
    color: var(--theme-text);
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
    font-size: calc(var(--doc-size) * 0.7);
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

  /* Gutter + edit-layer metrics are VERBATIM copies of CodeTheme's rules —
     the two edit surfaces are the same affordance and must be visually
     interchangeable. Pinned to literal equality by
     test/diagram-mermaid-init.test.js; change BOTH sheets or neither. */
  .sieve-block--diagram .sieve-block__gutter {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    padding: 0.85em 0.6em;
    background: var(--theme-bgDark);
    border-right: 1px solid var(--theme-gutterLineColor);
    color: var(--theme-lineNumberColor);
    font-family: var(--theme-monoFont);
    font-size: calc(var(--doc-size) * 0.85);
    line-height: 1.6;
    user-select: none;
    flex-shrink: 0;
  }

  .sieve-block--diagram .sieve-block__gutter span {
    display: block;
    line-height: 1.6;
  }

  /* Pseudo-content line numbers (data-ln) — see code-renderer.styles.js for
     the WebKit copy-leak rationale. */
  .sieve-block--diagram .sieve-block__gutter span::before {
    content: attr(data-ln);
  }

  .sieve-block--diagram .sieve-block__code-area {
    flex: 1;
    display: grid;
    grid-template-columns: 1fr;
    grid-template-rows: 1fr;
    min-height: 80px;
  }

  /* Code tier — must equal .sieve-block__gutter above (row-alignment) and
     CodeTheme's copy (test-pinned, see this file's header). Comment sits
     outside the declaration block, not before font-size: the parity test
     parses raw prop/value pairs with no comment-stripping, so a comment
     placed inside (and differing in wording from CodeTheme's copy) would
     perturb the property key it compares against — see code-renderer.styles.js's
     identical gutter/edit comments for the same reason. */
  .sieve-block--diagram .sieve-block__highlight,
  .sieve-block--diagram .sieve-block__edit {
    grid-area: 1 / 1;
    font-family: var(--theme-monoFont);
    font-size: calc(var(--doc-size) * 0.85);
    line-height: 1.6;
    padding: 0.85em 1.1em;
    white-space: pre-wrap;
    word-break: break-word;
    tab-size: 2;
    margin: 0;
    min-height: 2.5em;
    box-sizing: border-box;
  }

  /* editor.css's ".tiptap code" styles INLINE code as an accent pill
     (background, padding, radius, 0.85em). The edit surface's inner <code>
     sits inside .tiptap, so neutralise it on both layers or the pill and its
     smaller line box land on the source text (background-behind-text + gutter
     misalignment). Mirrors CodeTheme's identical reset — the two edit
     surfaces stay visually interchangeable. */
  .sieve-block--diagram .sieve-block__highlight code,
  .sieve-block--diagram .sieve-block__edit code {
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
    /* Smallest chrome tier (see editor.css's .tiptap comment) — was 10px. */
    font-size: calc(var(--doc-size) * 0.7);
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
    /* Code tier (see .tiptap comment) — was 14px. */
    font-size: calc(var(--doc-size) * 0.85);
    flex-shrink: 0;
    margin-top: 1px;
  }

  .diagram-block__error-title {
    /* Secondary/meta tier — was 12px. */
    font-size: calc(var(--doc-size) * 0.75);
    color: var(--theme-accentRed);
    font-weight: 500;
    margin-bottom: 4px;
  }

  .diagram-block__error-msg {
    font-family: var(--theme-monoFont);
    /* Smallest chrome tier — was 11px. */
    font-size: calc(var(--doc-size) * 0.7);
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
    /* Secondary/meta tier (see .tiptap comment) — was 12px. */
    font-size: calc(var(--doc-size) * 0.75);
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

  // Flowchart edge labels (Yes/No on links, inter-subgraph edges) share
  // mermaid's `.label` colour with node labels, which the theme sets dark for
  // text on light node fills (see the CONTRAST MODEL comment below). Edge labels
  // float on the dark canvas, so that dark text goes invisible, and mermaid
  // exposes no separate variable for it. The patch forces edge-label text light
  // and is appended to mermaid's OWN in-SVG <style>, which makes the SVG
  // style-complete BY ITSELF: it survives the lightbox relocating the live <svg>
  // into an overlay, and any future host. `.edgeLabel` is a mermaid-only class,
  // so this is safe wherever the SVG ends up; node labels use `.nodeLabel`.
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
      fontFamily:           v('--theme-monoFont') || 'monospace',
      fontSize:             '12px',

      background:           bgDark,
      textColor:            text,        // master label colour (canvas)
      lineColor:            textDim,
      arrowheadColor:       textDim,
      titleColor:           text,

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

      // NOT 'transparent': flowchart's .labelBkg does fade(edgeLabelBackground, .5),
      // and fade('transparent') → semi-opaque BLACK (a black box behind edge
      // labels like Yes/No). Use the canvas colour so the box blends into the bg.
      edgeLabelBackground:  bgDark,
      labelColor:           text,
      labelTextColor:       text,
      labelBackgroundColor: bgAlt,

      clusterBkg:           bgAlt,
      clusterBorder:        border2,

      // ER/class: relation labels float on the canvas → light.
      attributeBackgroundColorOdd:  bgAlt,
      attributeBackgroundColorEven: bgDark,
      classText:            bgDark,
      relationColor:        textDim,
      relationLabelColor:   text,
      relationLabelBackground: bgAlt,

      // State: transition labels live on the canvas → light.
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

      // Gantt: outside and clickable text live on the canvas → light.
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

      // Pie: title and legend sit on the canvas → light.
      pieTitleTextColor:    text,
      pieSectionTextColor:  bgDark,
      pieLegendTextColor:   text,
      pieStrokeColor:       bgDark,
      pieOuterStrokeColor:  border2,

      commitLabelColor:     text,
      commitLabelBackground: bgAlt,
      branchLabelColor:     bgDark,
      tagLabelColor:        bgDark,
      tagLabelBackground:   accentYe,
      tagLabelBorder:       border2,

      // Quadrant: chart title and axis labels on the canvas → light.
      quadrant1Fill: accentOr, quadrant2Fill: accentCy, quadrant3Fill: accentGr, quadrant4Fill: accentYe,
      quadrant1TextFill: bgDark, quadrant2TextFill: bgDark, quadrant3TextFill: bgDark, quadrant4TextFill: bgDark,
      quadrantPointFill: bgDark, quadrantPointTextFill: bgDark,
      quadrantTitleFill: text, quadrantXAxisTextFill: text, quadrantYAxisTextFill: text,
      quadrantInternalBorderStrokeFill: border2, quadrantExternalBorderStrokeFill: border2,

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
