// @ts-check
// diagram-renderer.js — DiagramRenderer: the renderer half of the diagram
// kind's renderer/NodeView split (docs/design/specs/2026-07-20-block-renderer-extraction.md,
// Phase 2 / issue #45 — the epic's pilot). Owns look-and-feel ONLY: attrs in,
// DOM out, the mermaid invocation (including the --theme-* → themeVariables
// mapping), and this kind's complete stylesheet (`static styles`). Zero
// ProseMirror/editor/window.* app-global dependencies — this class mounts
// identically in the note editor's NodeView adapter
// (frontend/src/static/processors/diagram-renderer.js, which HOLDS an
// instance of this class by composition, never inheritance), the bare-page
// harness (frontend/test/harness/bare-page-renderer.html), or any future
// non-PM lens (chat turn, embedded card).
//
// PM-specific concerns deliberately stay OUT of this file per the spec's
// PM-specificity sorting test — they live in the adapter instead:
//   - ProseMirror's contentDOM binding/selection/ignoreMutation/stopEvent
//   - cursor restore via editorPane.commands + getPos()
//   - the lowlight DECORATION plugin (buildPlugins) — a ProseMirror concept
//   - the header toolbar (badge + edit/render toggle), which persists via
//     ctx.updateAttributes — a PM-framework slot (sieve-block-extension.js)
//   - the mode-flip dispatch through the held Editor (flipMode/onModEnter)
//
// This class DOES own the render-mode SVG, the edit-mode chrome (gutter +
// code-area box), and the escape-hatch CSS patch mermaid needs for edge
// labels — all pure "attrs (+ live source text) in, DOM out".

import { BlockRenderer } from './block-renderer.js'
import { diagramStyles } from './diagram-renderer.styles.js'

/** @typedef {{ id?: string, source: string, diagramType?: string, mode: 'edit'|'render', cursorPos?: number }} DiagramAttrs */

export class DiagramRenderer extends BlockRenderer {
  // Sheet lives in the sibling diagram-renderer.styles.js — styles-file-geography
  // convention (docs/design/specs/2026-07-20-block-renderer-extraction.md, "Styles
  // file geography"): a renderer file starts with its class, never a CSS wall.
  static styles = diagramStyles

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
  static #EDGE_LABEL_PATCH_CSS = `
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

  /** @param {SVGSVGElement} svg */
  static #patchEdgeLabelStyle(svg) {
    /** @type {Element|null} */
    let styleEl = svg.querySelector('style')
    if (!styleEl) {
      styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style')
      svg.insertBefore(styleEl, svg.firstChild)
    }
    styleEl.appendChild(document.createTextNode(DiagramRenderer.#EDGE_LABEL_PATCH_CSS))
  }

  // ── mermaid lazy-load + theming ──────────────────────────────────────────────
  // Module-level (class-static) singleton: one mermaid runtime/theme shared by
  // every DiagramRenderer instance, matching mermaid's own global init() model.

  /** @type {Promise<void>|null} */
  static #mermaidReady = null
  /** @type {Set<DiagramRenderer>} */
  static #liveInstances = new Set()
  static #themeListenerInstalled = false
  static #renderCounter = 0

  // mermaid.js ships no types this codebase consumes elsewhere (loaded as a
  // vendored global script, /static/vendor/mermaid.min.js — see ensureMermaid
  // below); this getter is the one cast point, mirroring the established
  // `/** @type {any} */ (window).X` idiom (media-lightbox.js, editor-toolbar.js)
  // for untyped window globals under @ts-check.
  /** @returns {any} */
  static #mermaidGlobal() { return /** @type {any} */ (window).mermaid }

  static #installThemeListener() {
    if (DiagramRenderer.#themeListenerInstalled) return
    DiagramRenderer.#themeListenerInstalled = true
    // 'sse:settings:changed' — a documented app-wide SSE event (CLAUDE.md), not an
    // editor/PM signal; a bare page that never fires it simply never re-themes, which
    // degrades gracefully (no error, no PM dependency).
    document.addEventListener('sse:settings:changed', () => {
      if (!DiagramRenderer.#mermaidGlobal()) return
      DiagramRenderer.#initMermaid()
      DiagramRenderer.#liveInstances.forEach((instance) => instance.rerenderForThemeChange())
    })
  }

  /** @returns {object} mermaid.initialize() config, incl. themeVariables sourced
   *  entirely from computed --theme-* custom properties on :root. */
  static #buildMermaidTheme() {
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
      theme: 'base',
      themeVariables: tv,
      flowchart: { useMaxWidth: false },
      sequence: { useMaxWidth: false },
      gantt: { useMaxWidth: false },
    }
  }

  static #initMermaid() {
    const mermaid = DiagramRenderer.#mermaidGlobal()
    if (!mermaid) return
    mermaid.initialize(DiagramRenderer.#buildMermaidTheme())
  }

  /** @returns {Promise<void>} */
  static ensureMermaid() {
    if (DiagramRenderer.#mermaidReady) return DiagramRenderer.#mermaidReady
    DiagramRenderer.#mermaidReady = new Promise((resolve, reject) => {
      if (DiagramRenderer.#mermaidGlobal()) { DiagramRenderer.#initMermaid(); resolve(); return }
      const s = document.createElement('script')
      s.src = '/static/vendor/mermaid.min.js'
      s.onload = () => { DiagramRenderer.#initMermaid(); resolve() }
      s.onerror = () => { DiagramRenderer.#mermaidReady = null; reject(new Error('Failed to load mermaid.min.js')) }
      document.head.appendChild(s)
    })
    return DiagramRenderer.#mermaidReady
  }

  /** @param {string} [blockId] @returns {string} */
  static #uniqueMermaidId(blockId) {
    return 'mermaid-' + (blockId || 'di') + '-' + (++DiagramRenderer.#renderCounter)
  }

  // renderMermaidSvgEntry — renders a mermaid source, from a diagram node OR an
  // embedded ```mermaid fence among `entries`, into an image/svg+xml ContentEntry.
  // Resolves to null when there is no mermaid here; render FAILURES reject so each
  // caller chooses to alert (smart-image extract) or degrade (prose embed).
  // Browser-only (window.mermaid). Shared by smart-image's and prose's
  // resolveEntries via the adapter's re-export — kept static since it needs no
  // renderer instance (no DOM to mount, no dom/attrs pair to own).
  /** @param {any} sourceNode @param {any[]} entries @returns {Promise<{mimeType:string,content:string}|null>} */
  static renderMermaidSvgEntry(sourceNode, entries) {
    let src = ''
    if (sourceNode && sourceNode.attrs && sourceNode.attrs.kind === 'diagram') {
      src = String(sourceNode.attrs.source || '').trim()
    }
    if (!src) {
      for (const entry of (entries || [])) {
        const m = /^```mermaid\n([\s\S]*?)```$/.exec(String((entry && entry.content) || '').trim())
        if (m) { src = m[1].trim(); break }
      }
    }
    if (!src) return Promise.resolve(null)
    return DiagramRenderer.ensureMermaid().then(() => {
      const id = 'mermaid-render-' + Date.now() + '-' + Math.floor(Math.random() * 1000)
      return DiagramRenderer.#mermaidGlobal().render(id, src)
    }).then((result) => ({ mimeType: 'image/svg+xml', content: result.svg }))
  }

  // ── instance state ────────────────────────────────────────────────────────
  // Deliberately kept minimal: the elements this renderer built (so update()/
  // destroy() can find them again even while detached — edit/render bodies are
  // never both attached at once) and the last attrs applied, so update() can
  // detect a mode TRANSITION and hand the adapter a signal for its own
  // PM-specific follow-up (cursor placement) without this class touching PM.

  /** @type {HTMLElement|null} */ #editBody = null
  /** @type {HTMLElement|null} */ #renderBody = null
  /** @type {HTMLElement|null} */ #gutter = null
  /** @type {HTMLElement|null} */ #codeEl = null
  /** @type {DiagramAttrs|null} */ #attrs = null
  /** @type {(() => void)|null} */ #panzoomCleanup = null
  #destroyed = false

  /** The live ProseMirror contentDOM the adapter binds as its NodeView's
   *  contentDOM — this class builds it, the adapter (never this class) hands
   *  it to ProseMirror. @returns {HTMLElement|null} */
  get contentDOM() { return this.#codeEl }

  /**
   * @param {DiagramAttrs} attrs — `source` MUST be the LIVE text (the adapter
   *   passes node.textContent here, not the debounced attrs.source, so a
   *   mode-flip immediately after typing never renders stale mermaid source).
   * @returns {HTMLElement}
   */
  mount(attrs) {
    const dom = document.createElement('div')
    dom.className = 'sieve-block sieve-block--diagram'

    this.#editBody = this.#buildEditBody()
    this.#renderBody = this.#buildRenderBodyShell()

    this.#attrs = attrs
    this.#applyMode(dom, attrs)
    DiagramRenderer.#liveInstances.add(this)
    DiagramRenderer.#installThemeListener()
    return dom
  }

  /**
   * @param {HTMLElement} dom
   * @param {DiagramAttrs} attrs
   * @returns {{ modeChangedTo: 'edit'|'render' }|null} non-null only when
   *   attrs.mode actually changed since the last mount()/update() — the
   *   adapter's cue to run its own PM-specific follow-up (e.g. restoring the
   *   caret into contentDOM). null means "redrew in place, no transition".
   */
  update(dom, attrs) {
    const prevMode = this.#attrs ? this.#attrs.mode : attrs.mode
    this.#attrs = attrs
    this.#applyMode(dom, attrs)
    return prevMode === attrs.mode ? null : { modeChangedTo: attrs.mode }
  }

  /** @param {HTMLElement} dom */
  destroy(dom) {
    this.#destroyed = true
    if (this.#panzoomCleanup) { this.#panzoomCleanup(); this.#panzoomCleanup = null }
    DiagramRenderer.#liveInstances.delete(this)
  }

  // Presentational hook for the adapter's live-typing sync: the gutter's line
  // count must track every keystroke, which happens via a MutationObserver on
  // contentDOM OUTSIDE this class's mount()/update() lifecycle (ProseMirror
  // does not call NodeView.update() for in-place text edits it owns). Kept as
  // an explicit extra method (not part of the mount/update/destroy contract)
  // rather than folded into update(), since it fires far more often than attrs
  // actually change.
  /** @param {string} source */
  syncGutterLineCount(source) {
    if (this.#gutter) DiagramRenderer.#updateGutter(this.#gutter, source)
  }

  // Re-render the live SVG in place after a theme change (settings changed) —
  // a no-op unless this instance is currently showing render mode. Invoked by
  // the static theme-change listener across every live instance.
  rerenderForThemeChange() {
    if (this.#destroyed || !this.#renderBody || !this.#attrs || this.#attrs.mode !== 'render') return
    this.#renderMermaidInto(this.#renderBody, this.#attrs)
  }

  // ── DOM construction (presentational only) ───────────────────────────────

  /** @returns {HTMLElement} */
  #buildEditBody() {
    const editBody = document.createElement('div')
    editBody.className = 'sieve-block__body'

    const gutter = document.createElement('div')
    gutter.className = 'sieve-block__gutter'
    gutter.contentEditable = 'false'

    const codeArea = document.createElement('div')
    codeArea.className = 'sieve-block__code-area'

    const pre = document.createElement('pre')
    pre.className = 'sieve-block__edit'
    pre.style.whiteSpace = 'pre-wrap'
    pre.style.pointerEvents = 'auto'
    pre.style.outline = 'none'
    pre.style.color = 'var(--theme-text)'

    const codeEl = document.createElement('code')
    codeEl.className = 'hljs'

    pre.appendChild(codeEl)
    codeArea.appendChild(pre)
    editBody.appendChild(gutter)
    editBody.appendChild(codeArea)

    this.#gutter = gutter
    this.#codeEl = codeEl
    return editBody
  }

  /** @returns {HTMLElement} */
  #buildRenderBodyShell() {
    const renderBody = document.createElement('div')
    renderBody.className = 'diagram-block__render'
    renderBody.setAttribute('tabindex', '0')
    renderBody.style.outline = 'none'
    return renderBody
  }

  /** @param {HTMLElement} dom @param {DiagramAttrs} attrs */
  #applyMode(dom, attrs) {
    const editBody = this.#editBody
    const renderBody = this.#renderBody
    if (!editBody || !renderBody) return

    if (attrs.mode === 'render') {
      const comingFromEdit = dom.contains(editBody)
      if (comingFromEdit) dom.removeChild(editBody)
      if (!dom.contains(renderBody)) dom.appendChild(renderBody)
      // Give the render area keyboard focus so Ctrl+Enter can flip back to edit —
      // only on the actual transition, never re-stolen on an in-mode attrs update.
      if (comingFromEdit) renderBody.focus()
      this.#renderMermaidInto(renderBody, attrs)
    } else {
      if (dom.contains(renderBody)) dom.removeChild(renderBody)
      if (!dom.contains(editBody)) dom.appendChild(editBody)
      this.syncGutterLineCount(attrs.source || '')
    }
  }

  /** @param {HTMLElement} gutter @param {string} source */
  static #updateGutter(gutter, source) {
    const lines = (source || '').split('\n')
    const count = Math.max(lines.length, 1)
    if (gutter.childElementCount === count) return
    gutter.innerHTML = ''
    for (let i = 1; i <= count; i++) {
      const span = document.createElement('span')
      span.textContent = String(i)
      gutter.appendChild(span)
    }
  }

  /** @param {HTMLElement} renderBody @param {DiagramAttrs} attrs */
  #renderMermaidInto(renderBody, attrs) {
    if (this.#panzoomCleanup) { this.#panzoomCleanup(); this.#panzoomCleanup = null }

    const src = (attrs.source || '').trim()
    if (!src) {
      renderBody.innerHTML =
        '<div class="diagram-block__loading" style="color:var(--theme-fg3);font-size:12px;padding:20px">' +
        'Add diagram source in Edit mode</div>'
      return
    }

    renderBody.innerHTML = '<div class="diagram-block__loading"><span class="diagram-block__spinner"></span>Rendering…</div>'

    DiagramRenderer.ensureMermaid().then(() => {
      const id = DiagramRenderer.#uniqueMermaidId(attrs.id)
      return DiagramRenderer.#mermaidGlobal().render(id, src)
    }).then((result) => {
      if (this.#destroyed) return
      if (this.#panzoomCleanup) { this.#panzoomCleanup(); this.#panzoomCleanup = null }
      const wrap = document.createElement('div')
      wrap.className = 'diagram-block__panzoom'
      wrap.innerHTML = result.svg
      renderBody.innerHTML = ''
      renderBody.appendChild(wrap)
      const svg = wrap.querySelector('svg')
      if (svg) DiagramRenderer.#patchEdgeLabelStyle(svg)
      this.#setupInlinePanzoom(renderBody, wrap)
    }).catch((err) => {
      if (this.#destroyed) return
      const msg = (err && err.message) ? err.message : String(err)
      renderBody.innerHTML =
        '<div class="diagram-block__error">' +
        '<div class="diagram-block__error-icon">⚠</div>' +
        '<div>' +
        '<div class="diagram-block__error-title">Diagram syntax error</div>' +
        '<div class="diagram-block__error-msg">' + msg.replace(/</g, '&lt;') + '</div>' +
        '</div></div>'
    })
  }

  // Inline Ctrl-gated pan/zoom on the rendered diagram — a lightweight cousin of
  // the fullscreen lightbox (no chrome, no Esc, no title). Bare wheel/click pass
  // straight through (document scroll, block selection); ONLY while Ctrl(=Mod) is
  // held does the pane become a pan/zoom surface. One atomic CSS transform on the
  // WRAPPER div (NOT @panzoom/panzoom, whose canvas/animate handling was jerky
  // here). Expand still hands the bare SVG to the lightbox untouched. Purely a
  // generic interactive-viewer behaviour — no PM/editor coupling, so it stays
  // with the renderer (a chat-lens diagram would want the same affordance).
  /** @param {HTMLElement} renderBody @param {HTMLElement} wrap */
  #setupInlinePanzoom(renderBody, wrap) {
    const MIN = 1, MAX = 20
    let scale = 1, tx = 0, ty = 0
    wrap.style.transformOrigin = '0 0'
    function apply() {
      wrap.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'
    }

    // Cursor-anchored, closed-form: for s→s', tx' = tx + p·(s − s') where
    // p = (cursor − rect.topLeft)/s. No animation, so nothing to jump/collapse.
    /** @param {WheelEvent} e */
    function onWheel(e) {
      if (!(e.ctrlKey || e.metaKey)) return   // bare wheel scrolls the document
      e.preventDefault()
      const s2 = Math.min(MAX, Math.max(MIN, scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)))
      if (s2 === scale) return
      const rect = wrap.getBoundingClientRect()
      tx += ((e.clientX - rect.left) / scale) * (scale - s2)
      ty += ((e.clientY - rect.top) / scale) * (scale - s2)
      scale = s2
      if (scale === MIN) { tx = 0; ty = 0 }   // fit floor re-centres cleanly
      apply()
    }
    renderBody.addEventListener('wheel', onWheel, { passive: false })

    // Ctrl+drag pan (bare drag is left alone so click still selects the block).
    let panning = false, lastX = 0, lastY = 0
    /** @param {PointerEvent} e */
    function onDown(e) {
      if (!(e.ctrlKey || e.metaKey)) return
      panning = true; lastX = e.clientX; lastY = e.clientY
      try { wrap.setPointerCapture(e.pointerId) } catch (_) {}
      e.preventDefault(); e.stopPropagation()
    }
    /** @param {PointerEvent} e */
    function onMove(e) {
      if (!panning) return
      tx += e.clientX - lastX; ty += e.clientY - lastY
      lastX = e.clientX; lastY = e.clientY
      apply()
    }
    /** @param {PointerEvent} e */
    function onUp(e) { if (panning) { panning = false; try { wrap.releasePointerCapture(e.pointerId) } catch (_) {} } }
    wrap.addEventListener('pointerdown', onDown)
    wrap.addEventListener('pointermove', onMove)
    wrap.addEventListener('pointerup', onUp)
    wrap.addEventListener('pointercancel', onUp)

    // Affordance: grab cursor + hint only while Ctrl is held.
    let armed = false
    /** @param {boolean} on */
    function syncArm(on) {
      if (on === armed) return
      armed = on
      renderBody.classList.toggle('diagram-block__render--pz', on)
    }
    /** @param {KeyboardEvent} e */
    function onKeyDown(e) { if (e.key === 'Control' || e.key === 'Meta') syncArm(true) }
    /** @param {KeyboardEvent} e */
    function onKeyUp(e)   { if (e.key === 'Control' || e.key === 'Meta') syncArm(false) }
    function onBlur()     { syncArm(false); panning = false }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)

    this.#panzoomCleanup = function () {
      renderBody.removeEventListener('wheel', onWheel)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      renderBody.classList.remove('diagram-block__render--pz')
      wrap.style.transform = ''
    }
  }
}
