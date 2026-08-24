// @ts-check
// log-renderer.js — LogRenderer: the renderer half of the 'log' kind's
// renderer/NodeView split (Block Renderer Contract,
// docs/design/archive/specs/2026-07-21-block-renderer-contract.md). Owns look-and-feel
// ONLY: the block shell, the HEADER (badge + format + raw/explore toggle +
// noise | filter + column buttons), the raw-text body (gutter + code-area) and
// the Explore table, and this kind's stylesheet (`static styles`). Zero
// ProseMirror/editor/window.* dependencies.
//
// buildHeader() lays out a LogHeader via a HeaderBar; its controls call this
// renderer's SEMANTIC VERBS (setMode — core API; setFilter / toggleNoise /
// toggleColumn — kind-specific verbs under the abstract-consumer rule: the
// header is this kind's own chrome). setMode maps the MODE enum to this kind's
// wire strings (raw/explore) privately via _pushAttrs. buildBody() builds the
// raw/explore surfaces and kicks off the async parsed-JSON table. WHICH columns
// exist is data-driven: once the asset loads the renderer stores the columns
// (renderer-owned state, read by the header via renderer.columns) and
// re-renders its header — the live Filter… input survives that re-render via
// HeaderBar's adopt/restoreFocusedControl.
//
// PM-specific concerns stay adapter-side: the raw text is ProseMirror-owned
// (the adapter binds the <code>, exposed as renderer.codeElement), the log-line
// DECORATION plugin, the read-only guard plugin, and resolving parsedAssetRef →
// URL against the held Editor's uuid (overlaid onto the block as
// resolvedAssetUrl).

import { BlockRenderer } from './block-renderer.js'
import { MODE } from '../contract/sieve-block.js'
import { logStyles } from './log-renderer.styles.js'
import { LineGutter } from './line-gutter.js'
import { AdvancedHeaderProvider, badgeEl, HeaderBar } from './header-bar.js'

/** @typedef {{ id?: string, source?: string, parsedAssetRef?: string, resolvedAssetUrl?: string, logFormatName?: string, logFormatRegex?: string, status?: string, mode?: string, filter?: string, disabledCols?: string, hideNoise?: boolean }} LogAttrs */
/** @typedef {{ key: string, name: string }} LogColumn */

const RAW_SVG = '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">' +
  '<path d="M1 7.5 L6 2 L8 4 L3 9 L1 9 Z"/><line x1="5" y1="3" x2="7" y2="5"/></svg>'
const EXPLORE_SVG = '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">' +
  '<rect x="1" y="1" width="8" height="8" rx="1"/><line x1="1" y1="4" x2="9" y2="4"/><line x1="4" y1="4" x2="4" y2="9"/></svg>'

// ── Header provider — the richest toolbar. The ctx IS the renderer (contract
// rule): controls speak its semantic verbs; the available columns are read
// off renderer.columns. ──
class LogHeader extends AdvancedHeaderProvider {
  badge() { return 'Log' }

  /** @param {LogAttrs} attrs @param {LogRenderer} r — the renderer (semantic verbs) */
  left(attrs, r) {
    const items = []
    if (attrs.logFormatName) {
      const fb = badgeEl('Format: ' + attrs.logFormatName)
      fb.style.background = 'var(--theme-bg)'
      fb.style.color = 'var(--theme-textSubtle)'
      fb.style.border = '1px solid var(--theme-border)'
      fb.style.fontWeight = 'normal'
      fb.style.marginLeft = '12px'
      if (attrs.logFormatRegex) fb.title = 'Regex: ' + attrs.logFormatRegex
      items.push(fb)
    }
    const explore = LogRenderer.isExplore(attrs)
    const toggle = document.createElement('div')
    toggle.className = 'log-block__toggle'
    toggle.style.marginLeft = '8px'
    const rawBtn = document.createElement('button')
    rawBtn.className = 'log-block__toggle-btn' + (!explore ? ' log-block__toggle-btn--active-raw' : '')
    rawBtn.innerHTML = RAW_SVG + ' Raw'
    rawBtn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); r.setMode(MODE.EDIT) })
    const exploreBtn = document.createElement('button')
    exploreBtn.className = 'log-block__toggle-btn' + (explore ? ' log-block__toggle-btn--active-explore' : '')
    exploreBtn.innerHTML = EXPLORE_SVG + ' Explore'
    exploreBtn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); r.setMode(MODE.RENDER) })
    toggle.appendChild(rawBtn); toggle.appendChild(exploreBtn)
    items.push(toggle)
    if (!explore) {
      const noiseBtn = document.createElement('button')
      noiseBtn.className = 'sieve-block__badge sieve-block__badge--clickable' + (attrs.hideNoise ? ' sieve-block__badge--active' : '')
      noiseBtn.textContent = attrs.hideNoise ? 'Show Noise' : 'Toggle Noise'
      noiseBtn.style.cursor = 'pointer'
      noiseBtn.style.marginLeft = '8px'
      noiseBtn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); r.toggleNoise() })
      items.push(noiseBtn)
    }
    return items
  }

  /** @param {LogAttrs} attrs @param {LogRenderer} r — the renderer (semantic verbs) */
  right(attrs, r) {
    if (!LogRenderer.isExplore(attrs)) return []
    const items = []
    const filter = document.createElement('input')
    filter.type = 'text'
    filter.placeholder = 'Filter...'
    filter.className = 'sieve-block__badge'
    filter.value = attrs.filter || ''
    filter.style.background = 'transparent'
    filter.style.border = '1px solid var(--theme-border)'
    filter.style.color = 'var(--theme-text)'
    filter.style.outline = 'none'
    filter.addEventListener('mousedown', (e) => { e.stopPropagation() })
    filter.addEventListener('input', (e) => { e.stopPropagation(); r.setFilter(filter.value) })
    items.push(filter)

    const cols = r.columns
    if (cols.length) {
      const disabled = LogRenderer.disabledSet(attrs)
      const wrap = document.createElement('div')
      wrap.style.display = 'flex'
      wrap.style.alignItems = 'center'
      wrap.style.marginLeft = '8px'
      cols.forEach((/** @type {LogColumn} */ col) => {
        const btn = document.createElement('div')
        btn.className = 'sieve-block__badge sieve-block__badge--clickable' + (!disabled[col.key] ? ' sieve-block__badge--active' : '')
        btn.textContent = col.name
        btn.style.opacity = disabled[col.key] ? '0.4' : '1'
        btn.style.cursor = 'pointer'
        btn.style.marginLeft = '4px'
        btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); r.toggleColumn(col.key) })
        wrap.appendChild(btn)
      })
      items.push(wrap)
    }
    return items
  }
}

export class LogRenderer extends BlockRenderer {
  static styles = logStyles
  static rootClass = 'sieve-block sieve-block--log'

  // ── Shared attrs-decision helpers (consumed by THIS class and LogHeader) ──
  /** @param {LogAttrs} attrs @returns {'raw'|'explore'} */
  static mode(attrs) { return /** @type {'raw'|'explore'} */ (attrs.mode || (attrs.parsedAssetRef ? 'explore' : 'raw')) }
  /** @param {LogAttrs} attrs @returns {boolean} */
  static isExplore(attrs) { return LogRenderer.mode(attrs) === 'explore' }
  /** @param {LogAttrs} attrs @returns {Record<string, boolean>} */
  static disabledSet(attrs) {
    /** @type {Record<string, boolean>} */
    const s = {}
    ;(attrs.disabledCols || '').split(',').forEach((k) => { if (k) s[k] = true })
    return s
  }
  /** @param {LogAttrs} attrs @param {string} key @returns {string} */
  static toggleDisabled(attrs, key) {
    const s = LogRenderer.disabledSet(attrs)
    if (s[key]) delete s[key]; else s[key] = true
    return Object.keys(s).join(',')
  }

  /** @type {HeaderBar|null} */ #headerBar = null
  /** @type {HTMLElement|null} */ #gutter = null
  /** @type {HTMLElement|null} */ #codeEl = null
  /** @type {HTMLElement|null} */ #editArea = null
  /** @type {HTMLElement|null} */ #exploreArea = null
  /** @type {HTMLElement|null} */ #tableContainer = null
  /** @type {any} */ #loadedJson = null
  #loadingAsset = false
  /** @type {IntersectionObserver|null} */ #tableObserver = null
  /** @type {LogColumn[]} */ #cols = []

  /** The columns the loaded parsed-JSON asset made available (renderer-owned
   *  state; LogHeader reads this to build the column buttons). @returns {LogColumn[]} */
  get columns() { return this.#cols }

  /** @returns {HTMLElement} */
  buildHeader() {
    // The header's context IS this renderer — controls speak the semantic
    // verbs (setMode / setFilter / toggleNoise / toggleColumn), never attr
    // names or injected closures.
    this.#headerBar = new HeaderBar(new LogHeader())
    return this.#headerBar.render(/** @type {LogAttrs} */ (this.block.payload), this)
  }

  /** @returns {HTMLElement} */
  buildBody() {
    const body = document.createElement('div')
    body.className = 'sieve-block__body'

    const editArea = document.createElement('div')
    editArea.className = 'log-block__edit-area'

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
    codeEl.className = 'hljs language-log'

    pre.appendChild(codeEl)
    codeArea.appendChild(pre)
    editArea.appendChild(gutter)
    editArea.appendChild(codeArea)

    const exploreArea = document.createElement('div')
    exploreArea.className = 'log-block__explore-area'

    const tableContainer = document.createElement('div')
    tableContainer.className = 'log-block__table'

    // Shield the native drag-select (copy log lines) from the framework's
    // click-to-own-selection: stop mousedown (except controls), cancel dragstart.
    exploreArea.addEventListener('mousedown', (e) => {
      const t = /** @type {HTMLElement} */ (e.target)
      if (t.closest && t.closest('input, textarea, button, select')) return
      e.stopPropagation()
    })
    exploreArea.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation() })

    exploreArea.appendChild(tableContainer)
    body.appendChild(editArea)
    body.appendChild(exploreArea)

    this.#gutter = gutter
    this.#codeEl = codeEl
    this.#editArea = editArea
    this.#exploreArea = exploreArea
    this.#tableContainer = tableContainer
    this.#syncBody(/** @type {LogAttrs} */ (this.block.payload), true)
    return body
  }

  /** THE inbound truth channel. @param {import('../contract/sieve-block.js').SieveBlock} block */
  update(block) {
    // Previous truth read BEFORE super stores the new block (the base's
    // block is the ONE copy of state — no shadow caches, by contract).
    const prev = /** @type {LogAttrs} */ (this.block.payload)
    super.update(block)
    const attrs = /** @type {LogAttrs} */ (block.payload)
    if (this.#headerBar) this.#headerBar.update(attrs, this)
    const assetChanged = prev.parsedAssetRef !== attrs.parsedAssetRef || prev.status !== attrs.status
    this.#syncBody(attrs, assetChanged)
  }

  // ── Semantic verbs (core setMode + this kind's own — contract
  //    §abstract-consumer rule: LogHeader is this kind's own chrome) ──────────

  /**
   * MODE → this kind's wire strings, privately: EDIT → 'raw' (the editable
   * text surface), RENDER → 'explore', DEFAULT → the attr's unset default ''
   * (natural presentation: explore when a parsed asset exists, else raw).
   * @param {string} mode
   */
  setMode(mode) {
    const attrs = /** @type {LogAttrs} */ (this.block.payload)
    if (mode === MODE.DEFAULT) {
      if (attrs.mode) this._pushAttrs({ mode: '' })
      return
    }
    const wire = mode === MODE.EDIT ? 'raw' : 'explore'
    if (wire === LogRenderer.mode(attrs)) return
    this._pushAttrs({ mode: wire })
  }

  /** Set the Explore table's row filter text. @param {string} text */
  setFilter(text) { this._pushAttrs({ filter: text }) }

  /** Flip the raw view's noise dimming. */
  toggleNoise() { this._pushAttrs({ hideNoise: !(/** @type {LogAttrs} */ (this.block.payload).hideNoise) }) }

  /** Toggle one Explore column's visibility by key. The comma-joined
   *  disabledCols wire encoding stays private to this class. @param {string} key */
  toggleColumn(key) { this._pushAttrs({ disabledCols: LogRenderer.toggleDisabled(/** @type {LogAttrs} */ (this.block.payload), key) }) }

  /**
   * Outbound truth report — THIS kind's content attr is `source`, knowledge
   * that lives here and nowhere else (contract §setContent direction; the
   * retired v1 applier used to do this mapping adapter-side). The log body is
   * read-only in the editor, so no lens drives this today — declared for
   * contract completeness.
   * @param {string} text
   */
  setContent(text) { this._pushAttrs({ source: text }) }

  /** @param {LogAttrs} attrs @param {boolean} assetChanged */
  #syncBody(attrs, assetChanged) {
    const dom = this.root
    if (dom) dom.classList.toggle('log--hide-noise', !!attrs.hideNoise)
    if (this.#gutter) LineGutter.sync(this.#gutter, attrs.source || '')
    this.#updateVisibility(attrs)

    if (assetChanged) this.#loadAsset(attrs)
    else if (this.#loadedJson) this.#renderTable(attrs)
  }

  /** The editable <code> the adapter binds as ProseMirror's contentDOM. @returns {HTMLElement|null} */
  get codeElement() { return this.#codeEl }

  destroy() {
    if (this.#tableObserver) { this.#tableObserver.disconnect(); this.#tableObserver = null }
  }

  /** @param {LogAttrs} attrs */
  #updateVisibility(attrs) {
    const editArea = this.#editArea, exploreArea = this.#exploreArea
    if (!editArea || !exploreArea) return
    if (LogRenderer.isExplore(attrs)) {
      editArea.style.position = 'absolute'
      editArea.style.opacity = '0'
      editArea.style.pointerEvents = 'none'
      editArea.style.height = '0'
      editArea.style.overflow = 'hidden'
      exploreArea.style.display = 'flex'
    } else {
      editArea.style.position = ''
      editArea.style.opacity = ''
      editArea.style.pointerEvents = ''
      editArea.style.height = ''
      editArea.style.overflow = ''
      editArea.style.display = 'flex'
      exploreArea.style.display = 'none'
    }
  }

  /** @param {LogAttrs} attrs */
  #loadAsset(attrs) {
    if (!this.#tableContainer) return
    if (!attrs.parsedAssetRef) return
    if (attrs.status === 'PENDING' || attrs.status === 'DISPATCHED') {
      this.#tableContainer.innerHTML = '<div class="log-block__table-msg">Processing logs...</div>'
      return
    }
    if (this.#loadingAsset || !attrs.resolvedAssetUrl) return
    this.#loadingAsset = true
    fetch(attrs.resolvedAssetUrl).then((res) => res.json()).then((data) => {
      this.#loadingAsset = false
      this.#loadedJson = data
      // WHICH columns exist is now known — store them (renderer-owned) and
      // re-render the header so the column buttons appear. Truth is read live
      // off the block (it may have advanced while the fetch was in flight).
      const live = /** @type {LogAttrs} */ (this.block.payload)
      this.#cols = this.#availableColumns()
      if (this.#headerBar) this.#headerBar.update(live, this)
      this.#renderTable(live)
    }).catch(() => {
      this.#loadingAsset = false
      if (this.#tableContainer) this.#tableContainer.innerHTML = '<div class="log-block__table-msg log-block__table-msg--error">Failed to load parsed logs.</div>'
    })
  }

  /** @returns {LogColumn[]} */
  #availableColumns() {
    if (!this.#loadedJson || !this.#loadedJson.lines) return []
    /** @type {LogColumn[]} */
    const out = []
    if (this.#loadedJson.lines.some((/** @type {any} */ l) => l.date))   out.push({ key: 'date',   name: 'Date' })
    if (this.#loadedJson.lines.some((/** @type {any} */ l) => l.level))  out.push({ key: 'level',  name: 'Level' })
    if (this.#loadedJson.lines.some((/** @type {any} */ l) => l.thread)) out.push({ key: 'thread', name: 'Thread' })
    if (this.#loadedJson.lines.some((/** @type {any} */ l) => l.logger)) out.push({ key: 'logger', name: 'Logger' })
    return out
  }

  /** @param {LogAttrs} attrs */
  #renderTable(attrs) {
    const tableContainer = this.#tableContainer
    if (!tableContainer || !this.#loadedJson || !this.#loadedJson.lines) return
    tableContainer.innerHTML = ''
    const filterText = (attrs.filter || '').toLowerCase()
    const disabled = LogRenderer.disabledSet(attrs)

    const lines = this.#loadedJson.lines
    const hasDate   = lines.some((/** @type {any} */ l) => l.date)
    const hasLevel  = lines.some((/** @type {any} */ l) => l.level)
    const hasThread = lines.some((/** @type {any} */ l) => l.thread)
    const hasLogger = lines.some((/** @type {any} */ l) => l.logger)

    const showDate   = hasDate && !disabled['date']
    const showLevel  = hasLevel && !disabled['level']
    const showThread = hasThread && !disabled['thread']
    const showLogger = hasLogger && !disabled['logger']

    if (this.#tableObserver) { this.#tableObserver.disconnect(); this.#tableObserver = null }

    const cols = [{ key: 'line', width: '40px' }]
    if (showDate)   cols.push({ key: 'date', width: '160px' })
    if (showLevel)  cols.push({ key: 'level', width: '60px' })
    if (showThread) cols.push({ key: 'thread', width: '120px' })
    if (showLogger) cols.push({ key: 'logger', width: '200px' })
    cols.push({ key: 'message', width: '1fr' })

    /** @param {string} text @param {string} width @param {string} [color] @param {number} [opacity] */
    function makeCell(text, width, color, opacity) {
      const c = document.createElement('div')
      c.textContent = text || ''
      c.className = 'log-block__cell'
      if (color) c.style.color = color
      if (opacity !== undefined) c.style.opacity = String(opacity)
      if (width === '1fr') c.style.flex = '1'
      else { c.style.width = width; c.style.flexShrink = '0' }
      return c
    }

    const headerRow = document.createElement('div')
    headerRow.className = 'log-block__row log-block__row--header'
    cols.forEach((col) => { headerRow.appendChild(makeCell(col.key === 'line' ? '#' : col.key, col.width)) })
    tableContainer.appendChild(headerRow)

    const rowsContainer = document.createElement('div')
    rowsContainer.className = 'log-block__rows'
    tableContainer.appendChild(rowsContainer)

    const filteredLines = lines.filter((/** @type {any} */ l) => !filterText || (l.raw || '').toLowerCase().indexOf(filterText) > -1)

    let currentIndex = 0
    const chunkSize = 100

    function renderChunk() {
      const chunk = filteredLines.slice(currentIndex, currentIndex + chunkSize)
      if (chunk.length === 0) return false

      chunk.forEach((/** @type {any} */ l) => {
        const row = document.createElement('div')
        row.className = 'log-block__row'

        let rowColor = ''
        if (l.severity === 'error') rowColor = 'var(--theme-red)'
        else if (l.severity === 'warn') rowColor = 'var(--theme-yellow)'
        else if (l.severity === 'info') rowColor = 'var(--theme-textSubtle)'

        cols.forEach((col) => {
          let cell
          if (col.key === 'line') cell = makeCell(l.lineNumber, col.width, 'var(--theme-textSubtle)', 0.5)
          else if (col.key === 'date') cell = makeCell(l.date, col.width, 'var(--theme-textSubtle)', 0.5)
          else if (col.key === 'level') { cell = makeCell(l.level, col.width, rowColor, 1); cell.style.fontWeight = 'bold' }
          else if (col.key === 'thread') cell = makeCell(l.thread, col.width, 'var(--theme-magenta)', 0.7)
          else if (col.key === 'logger') cell = makeCell(l.logger, col.width, 'var(--theme-green)', 0.7)
          else { cell = makeCell(l.message, col.width, rowColor || 'var(--theme-text)', l.severity === 'info' ? 0.8 : 1); cell.style.whiteSpace = 'pre-wrap' }
          row.appendChild(cell)
        })
        rowsContainer.appendChild(row)
      })

      currentIndex += chunkSize
      return currentIndex < filteredLines.length
    }

    const hasMore = renderChunk()

    if (hasMore) {
      const sentinel = document.createElement('div')
      sentinel.style.height = '1px'
      tableContainer.appendChild(sentinel)

      const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
          const more = renderChunk()
          if (!more) {
            observer.disconnect()
            if (sentinel.parentNode) sentinel.parentNode.removeChild(sentinel)
          }
        }
      }, { root: tableContainer, rootMargin: '200px' })

      observer.observe(sentinel)
      this.#tableObserver = observer
    }
  }
}
