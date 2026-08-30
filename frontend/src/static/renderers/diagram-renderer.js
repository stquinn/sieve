// @ts-check
// DiagramRenderer — the diagram kind's look-and-feel: the header (badge +
// engine dropdown + edit/render toggle + expand), the edit-mode chrome (gutter +
// code-area), the render-mode SVG (including the --theme-* → themeVariables
// mapping and the mermaid escape-hatch CSS patch), and this kind's stylesheet.
//
// TWO ENGINES, ONE KIND: `diagramType` picks the engine. mermaid renders
// client-side (a held render promise); plantuml renders as a backend JOB and the
// renderer is a PASSIVE display of it — PENDING shows the shared job-status
// spinner, COMPLETE fetches the same-origin svgAsset and inlines it, ERROR shows
// the error card. Both engines converge on ONE display tail (#displaySvg /
// #displayError). No source translation on switch.
//
// buildBody() builds BOTH mode surfaces into the body region and they stay
// ATTACHED in every mode — a flip switches visibility alone. The editable <code>
// inside the edit surface (exposed as renderer.codeElement) is what the adapter
// binds as ProseMirror's contentDOM, and a contentDOM outside the document reads
// to ProseMirror as content the user deleted: it dispatches a replace to match,
// erasing the source.

import { BlockRenderer } from './block-renderer.js'
import { MODE } from '../contract/sieve-block.js'
import { DiagramTheme } from './diagram-renderer.styles.js'
import { StatusBadge } from './status-badge.js'
import { AdvancedHeaderProvider, HeaderBar, expandButton } from './header-bar.js'
import { expandBlock } from '../ui/media-lightbox.js'
import { registerBlockRenderer } from './block-kinds.js'

/**
 * @typedef {Object} DiagramAttrs
 * @property {string} [id]
 * @property {string} source
 * @property {string} [diagramType]  'mermaid' | 'plantuml' — the render engine.
 * @property {'edit'|'render'} mode
 * @property {string} [status]        job lifecycle (plantuml render) — PENDING/COMPLETE/ERROR/TIMEOUT.
 * @property {string|null} [createdAt]
 * @property {string} [svgAsset]      same-origin ExternalRef of the rendered SVG (plantuml, COMPLETE).
 * @property {string|null} [error]    framework-written error on ERROR/TIMEOUT.
 */

const ENGINES = Object.freeze(['mermaid', 'plantuml'])

const EDIT_SVG = '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">' +
  '<path d="M1 7.5 L6 2 L8 4 L3 9 L1 9 Z"/><line x1="5" y1="3" x2="7" y2="5"/></svg>'
const RENDER_SVG = '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">' +
  '<ellipse cx="5" cy="5" rx="4" ry="2.5"/><circle cx="5" cy="5" r="1.2" fill="currentColor" stroke="none"/></svg>'

/** @param {string} label @param {string} icon @param {boolean} active @param {string} activeCls @param {() => void} onClick @returns {HTMLButtonElement} */
function toggleBtn(label, icon, active, activeCls, onClick) {
  const b = document.createElement('button')
  b.className = 'diagram-block__toggle-btn' + (active ? ' ' + activeCls : '')
  b.innerHTML = icon + ' ' + label
  b.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); onClick() })
  return b
}

class DiagramHeader extends AdvancedHeaderProvider {
  badge() { return 'diagram' }
  /** The engine picker — a native <select> styled AS the type label (chevron on
   *  hover). A pointer widget: native <select> keyboard handling is the
   *  platform's, never a per-renderer handleKeyDown.
   *  @param {DiagramAttrs} attrs @param {DiagramRenderer} r @returns {HTMLElement[]} */
  left(attrs, r) {
    const current = (attrs && attrs.diagramType) || 'mermaid'
    // The picker rewrites the block's engine; a record shows the engine as a
    // label instead, so what it was drawn with is still legible.
    if (r.readOnly) {
      const label = document.createElement('span')
      label.className = 'diagram-block__engine-wrap'
      label.textContent = current
      return [label]
    }
    const wrap = document.createElement('span')
    wrap.className = 'diagram-block__engine-wrap'

    const select = document.createElement('select')
    select.className = 'diagram-block__engine'
    select.setAttribute('aria-label', 'Diagram engine')
    ENGINES.forEach((val) => {
      const opt = document.createElement('option')
      opt.value = val
      opt.textContent = val
      if (val === current) opt.selected = true
      select.appendChild(opt)
    })
    // stopPropagation (NOT preventDefault) — let the native dropdown open while
    // keeping the click from reaching ProseMirror's selection machinery.
    select.addEventListener('mousedown', (e) => { e.stopPropagation() })
    select.addEventListener('change', (e) => {
      e.stopPropagation()
      r.setDiagramType(/** @type {HTMLSelectElement} */ (e.target).value)
    })

    wrap.appendChild(select)
    return [wrap]
  }
  /** @param {DiagramAttrs} attrs @param {DiagramRenderer} r — the renderer (semantic verbs) */
  right(attrs, r) {
    if (r.readOnly) return []
    const mode = attrs.mode || 'render'
    const toggle = document.createElement('div')
    toggle.className = 'diagram-block__toggle'
    toggle.appendChild(toggleBtn('Edit', EDIT_SVG, mode === 'edit', 'diagram-block__toggle-btn--active-edit', () => {
      r.setMode(MODE.EDIT)
    }))
    toggle.appendChild(toggleBtn('Render', RENDER_SVG, mode === 'render', 'diagram-block__toggle-btn--active-render', () => {
      r.setMode(MODE.RENDER)
    }))
    return [toggle]
  }
}

export class DiagramRenderer extends BlockRenderer {
  static styles = DiagramTheme.sheet
  static rootClass = 'sieve-block sieve-block--diagram'

  /**
   * This kind IS insertable from the keyboard, and a fresh one carries nothing:
   * the engine comes from settings and a source-less diagram opens in edit mode,
   * both decided server-side on create.
   * @returns {{label: string, description: string, defaults: Record<string, any>}}
   */
  static insertSpec() {
    return { label: 'Diagram', description: 'Mermaid or PlantUML, rendered', defaults: {} }
  }

  /** @param {SVGSVGElement} svg */
  static #patchEdgeLabelStyle(svg) {
    /** @type {Element|null} */
    let styleEl = svg.querySelector('style')
    if (!styleEl) {
      styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style')
      svg.insertBefore(styleEl, svg.firstChild)
    }
    styleEl.appendChild(document.createTextNode(DiagramTheme.edgeLabelPatchCss))
  }

  /** @type {Promise<void>|null} */
  static #mermaidReady = null
  /** @type {Set<DiagramRenderer>} */
  static #liveInstances = new Set()
  static #themeListenerInstalled = false
  static #renderCounter = 0

  // The theme is an INPUT to a rendered diagram under BOTH engines — mermaid
  // bakes it into the SVG, plantuml renders it into the persisted asset — but it
  // lives in CSS custom properties, not in a block's attrs. This counter is the
  // theme's identity for render-signature purposes: it moves exactly when the
  // theme does, which is what makes a signature comparison honest.
  static #themeEpoch = 0

  /** Rendered SVG text by render signature, so a NodeView that ProseMirror
   *  recreates repaints from memory rather than from a mermaid render or an
   *  asset fetch. Insertion-ordered and evicted oldest-first: each entry is a
   *  whole SVG document, so the bound is deliberately small.
   *  @type {Map<string, string>} */
  static #svgCache = new Map()
  static #SVG_CACHE_MAX = 24

  /** @param {string} signature @returns {string|undefined} */
  static #cachedSvg(signature) { return DiagramRenderer.#svgCache.get(signature) }

  /** @param {string} signature @param {string} svg */
  static #cacheSvg(signature, svg) {
    const cache = DiagramRenderer.#svgCache
    cache.delete(signature)
    cache.set(signature, svg)
    while (cache.size > DiagramRenderer.#SVG_CACHE_MAX) {
      const oldest = cache.keys().next()
      if (oldest.done) break
      cache.delete(oldest.value)
    }
  }

  /** @returns {any} */
  static #mermaidGlobal() { return /** @type {any} */ (window).mermaid }

  static #installThemeListener() {
    if (DiagramRenderer.#themeListenerInstalled) return
    DiagramRenderer.#themeListenerInstalled = true
    document.addEventListener('settings:changed', () => {
      // The epoch moves FIRST: every cached SVG and every rendered signature is
      // keyed by it, so this one increment is what invalidates them. The clear
      // then reclaims what the increment just made unreachable.
      DiagramRenderer.#themeEpoch++
      DiagramRenderer.#svgCache.clear()
      // Re-init mermaid's theme variables (if it is loaded) so mermaid
      // instances re-render under the new theme. Plantuml instances nudge a
      // backend re-dispatch, which must happen even in a mermaid-free doc.
      if (DiagramRenderer.#mermaidGlobal()) DiagramRenderer.#initMermaid()
      DiagramRenderer.#liveInstances.forEach((instance) => instance.rerenderForThemeChange())
    })
  }

  static #initMermaid() {
    const mermaid = DiagramRenderer.#mermaidGlobal()
    if (!mermaid) return
    mermaid.initialize(DiagramTheme.buildMermaidInit())
  }

  /** @returns {Promise<void>} */
  static ensureMermaid() {
    if (DiagramRenderer.#mermaidReady) return DiagramRenderer.#mermaidReady
    DiagramRenderer.#mermaidReady = new Promise((resolve, reject) => {
      if (DiagramRenderer.#mermaidGlobal()) { DiagramRenderer.#initMermaid(); resolve(); return }
      const s = document.createElement('script')
      s.src = '/ui/static/vendor/mermaid.min.js'
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

  // renderDiagramSvgEntry — acquires a diagram's SVG as an image/svg+xml
  // ContentEntry for the export/extraction pipeline: mermaid renders the source
  // locally (also handling an embedded ```mermaid fence among `entries`),
  // plantuml fetches the persisted same-origin svgAsset. A never-rendered
  // plantuml block yields no entry, exactly as empty-source mermaid does.
  /** @param {any} sourceNode @param {any[]} entries @returns {Promise<{mimeType:string,content:string}|null>} */
  static renderDiagramSvgEntry(sourceNode, entries) {
    const attrs = (sourceNode && sourceNode.attrs) || {}
    const isDiagram = attrs.kind === 'diagram'

    if (isDiagram && attrs.diagramType === 'plantuml') {
      const url = String(attrs.svgAsset || '')
      if (!url) return Promise.resolve(null)
      // no-cache: stable-URL / mutable-content asset (see #fetchAndDisplayPlantuml).
      return fetch(url, { cache: 'no-cache' })
        .then((res) => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.text() })
        .then((svg) => ({ mimeType: 'image/svg+xml', content: svg }))
    }

    let src = ''
    if (isDiagram) src = String(attrs.source || '').trim()
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

  /** @type {HeaderBar|null} */ #headerBar = null
  /** @type {HTMLElement|null} */ #editBody = null
  /** @type {HTMLElement|null} */ #renderBody = null
  /** @type {HTMLElement|null} */ #gutter = null
  /** @type {HTMLElement|null} */ #codeEl = null
  /** @type {(() => void)|null} */ #panzoomCleanup = null
  /** @type {{ modeChangedTo: 'edit'|'render' }|null} */ #modeTransition = null
  /** The signature of what #renderBody currently shows, or null before the first
   *  paint. @type {string|null} */
  #renderedSignature = null
  #destroyed = false

  /** The editable <code> the adapter binds as ProseMirror's contentDOM. Stable
   *  across mode swaps. @returns {HTMLElement|null} */
  get codeElement() { return this.#codeEl }

  /**
   * Consume the last mode transition — non-null only when attrs.mode changed on
   * the most recent update().
   * @returns {{ modeChangedTo: 'edit'|'render' }|null}
   */
  takeModeTransition() { const t = this.#modeTransition; this.#modeTransition = null; return t }

  /** @returns {HTMLElement} */
  buildHeader() {
    this.#headerBar = new HeaderBar(new DiagramHeader(), (bar, _attrs, ctx) => {
      const r = /** @type {DiagramRenderer} */ (ctx)
      if (r.expandContent()) {
        bar.appendChild(expandButton('⤢', () => r.expand()))
      }
    })
    return this.#headerBar.render(/** @type {DiagramAttrs} */ (this.block.payload), this)
  }

  /** The body region: both mode surfaces, the current one shown.
   *  @returns {HTMLElement} */
  buildBody() {
    const surfaces = document.createElement('div')
    surfaces.className = 'diagram-block__surfaces'
    this.#editBody = this.#buildEditBody()
    this.#renderBody = this.#buildRenderBodyShell()
    surfaces.appendChild(this.#editBody)
    surfaces.appendChild(this.#renderBody)
    DiagramRenderer.#liveInstances.add(this)
    DiagramRenderer.#installThemeListener()
    this.#applyMode(/** @type {DiagramAttrs} */ (this.block.payload))
    return surfaces
  }

  /** @param {import('../contract/sieve-block.js').SieveBlock} block */
  update(block) {
    // Previous truth read BEFORE super stores the new block.
    const prevMode = /** @type {DiagramAttrs} */ (this.block.payload).mode
    super.update(block)
    const attrs = /** @type {DiagramAttrs} */ (block.payload)
    if (this.#headerBar) this.#headerBar.update(attrs, this)
    this.#applyMode(attrs)
    this.#modeTransition = prevMode === attrs.mode ? null : { modeChangedTo: attrs.mode }
  }

  /**
   * MODE → this kind's wire strings. DEFAULT = render.
   * @param {string} mode
   */
  setMode(mode) {
    const wire = mode === MODE.EDIT ? 'edit' : 'render'
    const current = /** @type {DiagramAttrs} */ (this.block.payload).mode || 'render'
    if (wire === current) return
    this._pushAttrs({ mode: wire })
  }

  /**
   * Outbound truth report — THIS kind's content attr is `source`, knowledge
   * that lives here and nowhere else.
   * @param {string} text
   */
  setContent(text) { this._pushAttrs({ source: text }) }

  /**
   * Switch the render ENGINE (mermaid ⇄ plantuml). NO source translation —
   * wrong-engine syntax gets that engine's error, honestly.
   * @param {string} type
   */
  setDiagramType(type) {
    const wire = type === 'plantuml' ? 'plantuml' : 'mermaid'
    const current = /** @type {DiagramAttrs} */ (this.block.payload).diagramType || 'mermaid'
    if (wire === current) return
    this._pushAttrs({ diagramType: wire })
  }

  /**
   * Capability probe + spec builder — non-null only when there is something to
   * expand (render mode; edit mode is raw text).
   * @returns {{ element: Element|null, title: string, mode: 'media' }|null}
   */
  expandContent() {
    const attrs = /** @type {DiagramAttrs} */ (this.block.payload)
    if (attrs.mode === 'edit') return null
    const svg = this.root ? this.root.querySelector('.diagram-block__render svg') : null
    return { element: svg, title: (attrs.diagramType || 'mermaid') + ' diagram', mode: 'media' }
  }

  /** Expand the rendered SVG into the lightbox. */
  expand() {
    const spec = this.expandContent()
    if (spec && spec.element) expandBlock({ element: spec.element, title: spec.title, mode: spec.mode })
  }

  destroy() {
    this.#destroyed = true
    if (this.#panzoomCleanup) { this.#panzoomCleanup(); this.#panzoomCleanup = null }
    DiagramRenderer.#liveInstances.delete(this)
  }

  // Presentational hook for the adapter's live-typing sync, OUTSIDE the render/update lifecycle.
  /** @param {string} source */
  syncGutterLineCount(source) {
    if (this.#gutter) DiagramRenderer.#updateGutter(this.#gutter, source)
  }

  // React to a theme change on a live RENDER-mode block — a no-op otherwise.
  // mermaid re-renders locally; plantuml's theme preamble is part of the backend
  // render hash, so a benign source re-sync nudges the backend to re-dispatch and
  // the new asset arrives as an attrs render-back.
  rerenderForThemeChange() {
    const attrs = /** @type {DiagramAttrs} */ (this.block.payload)
    if (this.#destroyed || !this.#renderBody || attrs.mode !== 'render') return
    if ((attrs.diagramType || 'mermaid') === 'plantuml') {
      if ((attrs.source || '').trim()) this._pushAttrs({ source: attrs.source })
      return
    }
    this.#renderInto(attrs)
  }

  /** @returns {HTMLElement} */
  #buildEditBody() {
    const editBody = document.createElement('div')
    editBody.className = 'sieve-block__body'
    editBody.hidden = true

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
    renderBody.hidden = true
    return renderBody
  }

  /**
   * Show the mode's surface and hide the other — never detach either (see this
   * file's header). A RECORD has no editable surface to offer, so read-only
   * pins the block in render mode whatever its attrs say.
   * @param {DiagramAttrs} attrs
   */
  #applyMode(attrs) {
    const editBody = this.#editBody
    const renderBody = this.#renderBody
    if (!editBody || !renderBody) return

    if (this.readOnly || attrs.mode === 'render') {
      const comingFromEdit = !editBody.hidden
      editBody.hidden = true
      renderBody.hidden = false
      if (comingFromEdit) renderBody.focus()
      this.#renderInto(attrs)
    } else {
      renderBody.hidden = true
      editBody.hidden = false
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
      // Pseudo-content number (data-ln), never a text node (WebKit copy leak).
      span.dataset.ln = String(i)
      gutter.appendChild(span)
    }
  }

  /**
   * Everything the render body's content is a function of, as one comparable
   * string. Two calls with equal signatures MUST paint the same pixels, so
   * anything the display branches on belongs here — the theme included, because
   * mermaid bakes it into the SVG, and for plantuml the CLASSIFIED job state
   * rather than the raw status, because that is what the display actually reads.
   * @param {DiagramAttrs} attrs @returns {string}
   */
  #renderSignature(attrs) {
    const engine = attrs.diagramType || 'mermaid'
    const parts = [engine, String(DiagramRenderer.#themeEpoch), attrs.source || '']
    if (engine === 'plantuml') {
      parts.push(
        StatusBadge.classify(attrs.status, attrs.createdAt, attrs.id),
        String(attrs.svgAsset || ''),
        String(attrs.error || ''),
      )
    }
    return parts.join(' ')
  }

  /** Repaint the render body as a pure function of attrs — and only when that
   *  function's inputs moved, because ProseMirror recreates a NodeView on any
   *  decoration change and an unconditional repaint shows as a twitch.
   *  @param {DiagramAttrs} attrs */
  #renderInto(attrs) {
    if (!this.#renderBody) return
    const signature = this.#renderSignature(attrs)
    if (signature === this.#renderedSignature) return
    this.#renderedSignature = signature
    if (this.#panzoomCleanup) { this.#panzoomCleanup(); this.#panzoomCleanup = null }
    if ((attrs.diagramType || 'mermaid') === 'plantuml') this.#renderPlantuml(attrs, signature)
    else this.#renderMermaid(attrs, signature)
  }

  /** Has a newer signature been painted since `signature` was launched?
   *  @param {string} signature @returns {boolean} */
  #superseded(signature) { return this.#destroyed || this.#renderedSignature !== signature }

  /** Client-side mermaid path — display the cached SVG for this signature, else
   *  render the source locally and hand the SVG to the shared display tail (or
   *  #displayError on a parse failure).
   *  @param {DiagramAttrs} attrs @param {string} signature */
  #renderMermaid(attrs, signature) {
    const src = (attrs.source || '').trim()
    if (!src) { this.#showEmptyHint(); return }
    const cached = DiagramRenderer.#cachedSvg(signature)
    // Consulted BEFORE the spinner: on a hit this paints synchronously, so a
    // recreated NodeView never shows a loading state it will replace one frame
    // later. That gap is the twitch.
    if (cached !== undefined) { this.#displaySvg(cached); return }
    this.#showLoading()
    DiagramRenderer.ensureMermaid().then(() => {
      const id = DiagramRenderer.#uniqueMermaidId(attrs.id)
      return DiagramRenderer.#mermaidGlobal().render(id, src)
    }).then((result) => {
      DiagramRenderer.#cacheSvg(signature, result.svg)
      if (this.#superseded(signature)) return
      this.#displaySvg(result.svg)
    }).catch((err) => {
      if (this.#superseded(signature)) return
      this.#displayError((err && err.message) ? err.message : String(err), 'Diagram syntax error')
    })
  }

  /** Passive display of the plantuml render JOB — a pure function of attrs, no
   *  held render promise. PENDING → job-status spinner; COMPLETE → the cached
   *  asset, else fetch + inline it; ERROR/TIMEOUT/stale → the error card.
   *  @param {DiagramAttrs} attrs @param {string} signature */
  #renderPlantuml(attrs, signature) {
    const src = (attrs.source || '').trim()
    if (!src) { this.#showEmptyHint(); return }

    const state = StatusBadge.classify(attrs.status, attrs.createdAt, attrs.id)
    if (state === 'pending') { this.#showLoading(); return }
    if (state === 'complete') {
      const url = String(attrs.svgAsset || '')
      // COMPLETE without an asset ref is a transient race (status landed before
      // svgAsset) — hold the spinner; the follow-up attrs render-back carries it.
      if (!url) { this.#showLoading(); return }
      const cached = DiagramRenderer.#cachedSvg(signature)
      if (cached !== undefined) { this.#displaySvg(cached); return }
      this.#fetchAndDisplayPlantuml(url, signature)
      return
    }
    // stale | timeout | error
    const msg = (attrs.error || '').trim() ||
      (state === 'timeout' ? 'Render timed out.' : 'Render failed.')
    this.#displayError(msg, 'PlantUML render error')
  }

  /** Fetch a same-origin rendered-SVG asset and inline it via the shared tail.
   *  Guarded so a fetch that resolves after a newer render-back superseded this
   *  asset never inserts a stale SVG. @param {string} url @param {string} signature */
  #fetchAndDisplayPlantuml(url, signature) {
    // no-cache: the asset lives at a STABLE URL but is overwritten in place on
    // each re-render, so its bytes change while svgAsset does not — revalidate,
    // or a stale pre-theme-switch SVG comes back from the HTTP cache. The
    // signature the bytes are memoized under carries everything they are a
    // function of (theme and job state included), so no HTTP cache is involved
    // in serving them again.
    fetch(url, { cache: 'no-cache' })
      .then((res) => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.text() })
      .then((svgText) => {
        DiagramRenderer.#cacheSvg(signature, svgText)
        if (this.#superseded(signature) || this.#assetSuperseded(url)) return
        this.#displaySvg(svgText)
      })
      .catch((err) => {
        if (this.#superseded(signature) || this.#assetSuperseded(url)) return
        this.#displayError((err && err.message) ? err.message : String(err), 'PlantUML render error')
      })
  }

  /** True when the block's current svgAsset no longer matches the one this fetch
   *  was launched for (a newer render-back arrived mid-flight). @param {string} url */
  #assetSuperseded(url) {
    return String(/** @type {DiagramAttrs} */ (this.block.payload).svgAsset || '') !== url
  }

  /** Inline SVG text into the panzoom wrap, patch the edge-label escape hatch,
   *  and (re)arm inline pan/zoom. @param {string} svgText */
  #displaySvg(svgText) {
    const renderBody = this.#renderBody
    if (!renderBody || this.#destroyed) return
    if (this.#panzoomCleanup) { this.#panzoomCleanup(); this.#panzoomCleanup = null }
    const wrap = document.createElement('div')
    wrap.className = 'diagram-block__panzoom'
    wrap.innerHTML = svgText
    renderBody.innerHTML = ''
    renderBody.appendChild(wrap)
    const svg = wrap.querySelector('svg')
    if (svg) DiagramRenderer.#patchEdgeLabelStyle(svg)
    this.#setupInlinePanzoom(renderBody, wrap)
  }

  /** The in-block error card. @param {string} msg @param {string} title */
  #displayError(msg, title) {
    const renderBody = this.#renderBody
    if (!renderBody) return
    renderBody.innerHTML =
      '<div class="diagram-block__error">' +
      '<div class="diagram-block__error-icon">⚠</div>' +
      '<div>' +
      '<div class="diagram-block__error-title">' + title + '</div>' +
      '<div class="diagram-block__error-msg">' + String(msg).replace(/</g, '&lt;') + '</div>' +
      '</div></div>'
  }

  /** The empty-source placeholder (both engines). */
  #showEmptyHint() {
    const renderBody = this.#renderBody
    if (!renderBody) return
    renderBody.innerHTML =
      '<div class="diagram-block__loading" style="color:var(--theme-fg3);font-size:12px;padding:20px">' +
      'Add diagram source in Edit mode</div>'
  }

  /** The job/render-in-progress spinner (both engines). */
  #showLoading() {
    const renderBody = this.#renderBody
    if (!renderBody) return
    renderBody.innerHTML = '<div class="diagram-block__loading"><span class="diagram-block__spinner"></span>Rendering…</div>'
  }

  // Inline Ctrl-gated pan/zoom on the rendered diagram (one atomic CSS transform
  // on the wrapper).
  /** @param {HTMLElement} renderBody @param {HTMLElement} wrap */
  #setupInlinePanzoom(renderBody, wrap) {
    const MIN = 1, MAX = 20
    let scale = 1, tx = 0, ty = 0
    wrap.style.transformOrigin = '0 0'
    function apply() {
      wrap.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'
    }

    /** @param {WheelEvent} e */
    function onWheel(e) {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const s2 = Math.min(MAX, Math.max(MIN, scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)))
      if (s2 === scale) return
      const rect = wrap.getBoundingClientRect()
      tx += ((e.clientX - rect.left) / scale) * (scale - s2)
      ty += ((e.clientY - rect.top) / scale) * (scale - s2)
      scale = s2
      if (scale === MIN) { tx = 0; ty = 0 }
      apply()
    }
    renderBody.addEventListener('wheel', onWheel, { passive: false })

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

registerBlockRenderer('diagram', () => DiagramRenderer)
