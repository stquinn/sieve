// @ts-check
// diagram-renderer.js — DiagramRenderer: the renderer half of the diagram
// kind's renderer/NodeView split (docs/design/archive/specs/2026-07-20-block-renderer-extraction.md,
// Phase 2 / issue #45 — the epic's pilot). Owns look-and-feel ONLY: the HEADER
// (badge + mermaid label + edit/render toggle + expand button); the edit-mode
// chrome (gutter + code-area) and render-mode SVG (incl. the --theme-* →
// themeVariables mapping and the mermaid escape-hatch CSS patch); and this
// kind's stylesheet (`static styles`). Zero ProseMirror/editor/window.*
// dependencies.
//
// buildHeader() lays out a DiagramHeader via a HeaderBar; its toggle and the
// expand button call this renderer's SEMANTIC VERBS (setMode / expand — the
// contract's core API; docs/design/archive/specs/2026-07-21-block-renderer-contract.md).
// setMode maps the MODE enum to this kind's wire strings privately via
// _pushAttrs; caret capture on the render-ward flip is the PM adapter's
// business (a NodeView-local variable in its update()). buildBody() builds
// both mode surfaces; the editable <code> is exposed as renderer.codeElement
// for the adapter's contentDOM.

import { BlockRenderer } from './block-renderer.js'
import { MODE } from '../sieve-block.js'
import { DiagramTheme } from './diagram-renderer.styles.js'
import { AdvancedHeaderProvider, HeaderBar, expandButton } from './header-bar.js'
import { expandBlock } from '../../ui/media-lightbox.js'

/** @typedef {{ id?: string, source: string, diagramType?: string, mode: 'edit'|'render' }} DiagramAttrs */

// ── Header provider — badge + 'mermaid' label + edit/render toggle. ──
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
  left() {
    const t = document.createElement('span')
    t.className = 'sieve-block__type-label'
    t.textContent = 'mermaid'
    return [t]
  }
  /** @param {DiagramAttrs} attrs @param {DiagramRenderer} r — the renderer (semantic verbs) */
  right(attrs, r) {
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

  // ── mermaid lazy-load + theming (class-static singleton) ──────────────────
  /** @type {Promise<void>|null} */
  static #mermaidReady = null
  /** @type {Set<DiagramRenderer>} */
  static #liveInstances = new Set()
  static #themeListenerInstalled = false
  static #renderCounter = 0

  /** @returns {any} */
  static #mermaidGlobal() { return /** @type {any} */ (window).mermaid }

  static #installThemeListener() {
    if (DiagramRenderer.#themeListenerInstalled) return
    DiagramRenderer.#themeListenerInstalled = true
    document.addEventListener('sse:settings:changed', () => {
      if (!DiagramRenderer.#mermaidGlobal()) return
      DiagramRenderer.#initMermaid()
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

  // renderMermaidSvgEntry — renders a mermaid source (from a diagram node OR an
  // embedded ```mermaid fence among `entries`) into an image/svg+xml
  // ContentEntry. Shared by smart-image's and prose's resolveEntries. Static.
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
  /** @type {HeaderBar|null} */ #headerBar = null
  /** @type {HTMLElement|null} */ #editBody = null
  /** @type {HTMLElement|null} */ #renderBody = null
  /** @type {HTMLElement|null} */ #gutter = null
  /** @type {HTMLElement|null} */ #codeEl = null
  /** @type {(() => void)|null} */ #panzoomCleanup = null
  /** @type {{ modeChangedTo: 'edit'|'render' }|null} */ #modeTransition = null
  #destroyed = false

  /** The editable <code> the adapter binds as ProseMirror's contentDOM. Stable
   *  across mode swaps (the edit body detaches in render mode but its <code> is
   *  retained). A neutral accessor. @returns {HTMLElement|null} */
  get codeElement() { return this.#codeEl }

  /**
   * Consume the last mode transition — non-null only when attrs.mode changed on
   * the most recent update(). The adapter reads this right after update() to run
   * its PM-specific caret restore on an edit-ward transition.
   * @returns {{ modeChangedTo: 'edit'|'render' }|null}
   */
  takeModeTransition() { const t = this.#modeTransition; this.#modeTransition = null; return t }

  /** @returns {HTMLElement} */
  buildHeader() {
    // The header's context IS this renderer — buttons speak the semantic verbs
    // (setMode / expand), never attr names or injected closures.
    this.#headerBar = new HeaderBar(new DiagramHeader(), (bar, _attrs, ctx) => {
      const r = /** @type {DiagramRenderer} */ (ctx)
      // Expand button — shown only when there is something to expand (render mode).
      if (r.expandContent()) {
        bar.appendChild(expandButton('⤢', () => r.expand()))
      }
    })
    return this.#headerBar.render(/** @type {DiagramAttrs} */ (this.block.payload), this)
  }

  /** Builds BOTH surfaces (so the <code> always exists) and renders the initial
   *  mode's content; returns the current-mode surface for the base to install.
   *  @returns {HTMLElement} */
  buildBody() {
    this.#editBody = this.#buildEditBody()
    this.#renderBody = this.#buildRenderBodyShell()
    DiagramRenderer.#liveInstances.add(this)
    DiagramRenderer.#installThemeListener()
    const attrs = /** @type {DiagramAttrs} */ (this.block.payload)
    if (attrs.mode === 'render') {
      this.#renderMermaidInto(this.#renderBody, attrs)
      return this.#renderBody
    }
    this.syncGutterLineCount(attrs.source || '')
    return this.#editBody
  }

  /** @param {import('../sieve-block.js').SieveBlock} block */
  update(block) {
    // Previous truth read BEFORE super stores the new envelope (the base's
    // envelope is the ONE copy of state — no shadow caches, by contract).
    const prevMode = /** @type {DiagramAttrs} */ (this.block.payload).mode
    super.update(block)
    const attrs = /** @type {DiagramAttrs} */ (block.payload)
    if (this.#headerBar) this.#headerBar.update(attrs, this)
    if (this.root) this.#applyMode(this.root, attrs)
    this.#modeTransition = prevMode === attrs.mode ? null : { modeChangedTo: attrs.mode }
  }

  // ── Semantic verbs (the contract's core API) ──────────────────────────────

  /**
   * MODE → this kind's wire strings, privately. DEFAULT = render (the
   * diagram's natural presentation). Caret capture on the render-ward flip is
   * the PM adapter's business (NodeView-local), not knowledge this class holds.
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
   * that lives here and nowhere else (contract §setContent direction; the
   * retired v1 applier used to do this mapping adapter-side).
   * @param {string} text
   */
  setContent(text) { this._pushAttrs({ source: text }) }

  /**
   * Capability probe + spec builder — non-null only when there is something to
   * expand (render mode; edit mode is raw text). Also the behaviour-registry
   * path's implementation (one capability, every trigger lands here).
   * @returns {{ element: Element|null, title: string, mode: 'media' }|null}
   */
  expandContent() {
    const attrs = /** @type {DiagramAttrs} */ (this.block.payload)
    if (attrs.mode === 'edit') return null
    const svg = this.root ? this.root.querySelector('.diagram-block__render svg') : null
    return { element: svg, title: (attrs.diagramType || 'mermaid') + ' diagram', mode: 'media' }
  }

  /** Expand the rendered SVG into the lightbox (chord / header / menu all land here). */
  expand() {
    const spec = this.expandContent()
    if (spec && spec.element) expandBlock({ element: spec.element, title: spec.title, mode: spec.mode })
  }

  destroy() {
    this.#destroyed = true
    if (this.#panzoomCleanup) { this.#panzoomCleanup(); this.#panzoomCleanup = null }
    DiagramRenderer.#liveInstances.delete(this)
  }

  // Presentational hook for the adapter's live-typing sync (a MutationObserver
  // on contentDOM, OUTSIDE the render/update lifecycle).
  /** @param {string} source */
  syncGutterLineCount(source) {
    if (this.#gutter) DiagramRenderer.#updateGutter(this.#gutter, source)
  }

  // Re-render the live SVG in place after a theme change — a no-op unless this
  // instance is currently showing render mode.
  rerenderForThemeChange() {
    const attrs = /** @type {DiagramAttrs} */ (this.block.payload)
    if (this.#destroyed || !this.#renderBody || attrs.mode !== 'render') return
    this.#renderMermaidInto(this.#renderBody, attrs)
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

  // Inline Ctrl-gated pan/zoom on the rendered diagram (one atomic CSS transform
  // on the wrapper). Purely a generic interactive-viewer behaviour — no PM/editor
  // coupling, so it stays here.
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
