// @ts-check
// log-renderer.js — LogRenderer: the renderer half of the 'log' kind's
// renderer/NodeView split (docs/design/specs/2026-07-20-block-renderer-extraction.md,
// Phase 4 / issue #47). Owns look-and-feel ONLY: the block shell, the raw-text
// body (gutter + code-area, shared shape with 'code' via LineGutter), the
// Explore table (parsed-JSON → rows, filter, noise dimming, column
// visibility), and this kind's complete stylesheet (`static styles`). Zero
// ProseMirror/editor/window.* app-global dependencies — this class mounts
// identically in the note editor's NodeView adapter
// (frontend/src/static/processors/log-renderer.js, which HOLDS an instance of
// this class by composition, never inheritance), a bare-page harness, or any
// future non-PM lens.
//
// Independence from 'code' and 'diagram' (fixing a latent cross-kind style
// coupling found during this migration): log's dom used to carry BOTH
// `sieve-block--code` and `sieve-block--log` classes purely to BORROW code's
// shell/body/gutter CSS, and its header toolbar (processors/log-renderer.js
// LogHeader) built its raw/explore toggle out of diagram's
// `.diagram-block__toggle*` classes — CSS that, since diagram's Phase-2
// migration, lives ONLY in diagram-renderer.styles.js's constructable
// stylesheet, registered lazily the first time a DiagramRenderer is
// constructed. A document containing log blocks but NO diagram block would
// therefore never register that stylesheet and render an unstyled toggle —
// exactly the cross-kind coupling this epic exists to eliminate. This class
// now owns a complete, independent copy of its shell/body chrome (dom drops
// the borrowed `sieve-block--code` class — see the adapter) and its own
// `.log-block__toggle*` pill (log-renderer.styles.js), so it renders
// correctly with zero other kind present.
//
// PM-specific concerns stay OUT of this file per the spec's PM-specificity
// sorting test — they live in the adapter instead:
//   - contentDOM binding/ignoreMutation (ProseMirror owns the raw-text node
//     this class's mount() builds the <code> element FOR)
//   - the lowlight-style DECORATION plugin (buildPlugins) that highlights
//     Spring-Boot-style log lines — a ProseMirror concept
//   - the header toolbar (badge/format/raw-explore toggle/noise/filter/
//     column buttons) — a PM-framework headerProvider slot, same as
//     diagram's DiagramHeader and code's CodeHeader — stays adapter-side
//     (LogHeader in processors/log-renderer.js), reading LogRenderer's
//     static mode/disabledCols helpers below rather than re-deriving them
//   - persisting mode/filter/disabledCols/hideNoise via ctx.updateAttributes

import { BlockRenderer } from './block-renderer.js'
import { logStyles } from './log-renderer.styles.js'
import { LineGutter } from './line-gutter.js'

/** @typedef {{ id?: string, source?: string, parsedAssetRef?: string, resolvedAssetUrl?: string, logFormatName?: string, logFormatRegex?: string, status?: string, mode?: string, filter?: string, disabledCols?: string, hideNoise?: boolean }} LogAttrs */
/** @typedef {{ key: string, name: string }} LogColumn */

export class LogRenderer extends BlockRenderer {
  // Sheet lives in the sibling log-renderer.styles.js — styles-file-geography
  // convention: a renderer file starts with its class, never a CSS wall.
  static styles = logStyles

  // ── Shared attrs-decision helpers ─────────────────────────────────────────
  // Pure functions of attrs — consumed by THIS class internally and by the
  // adapter's LogHeader (processors/log-renderer.js) so both sides read one
  // definition of "what mode/columns are active" rather than two.

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

  /** @type {HTMLElement|null} */ #gutter = null
  /** @type {HTMLElement|null} */ #codeEl = null
  /** @type {HTMLElement|null} */ #editArea = null
  /** @type {HTMLElement|null} */ #exploreArea = null
  /** @type {HTMLElement|null} */ #tableContainer = null
  /** @type {any} */ #loadedJson = null
  #loadingAsset = false
  /** @type {IntersectionObserver|null} */ #tableObserver = null
  /** @type {LogAttrs} */ #attrs = { }
  /** @type {((cols: LogColumn[]) => void)|null} */ #onColumnsAvailable = null

  /** The live ProseMirror contentDOM the adapter binds as its NodeView's
   *  contentDOM — this class builds it, the adapter (never this class) hands
   *  it to ProseMirror. @returns {HTMLElement|null} */
  get contentDOM() { return this.#codeEl }

  /**
   * Registers a callback fired whenever the Explore table's available
   * columns change (once the parsed-JSON asset loads or reloads) — the
   * adapter's hook into publishing them to its headerProvider (`ctx.state.cols`
   * + `ctx.refreshHeader()`), a PM-framework concern this PM-free class never
   * touches directly.
   * @param {(cols: LogColumn[]) => void} cb
   */
  onColumnsAvailable(cb) { this.#onColumnsAvailable = cb }

  /** @param {LogAttrs} attrs @returns {HTMLElement} */
  mount(attrs) {
    const dom = document.createElement('div')
    dom.className = 'sieve-block sieve-block--log'

    const body = document.createElement('div')
    body.className = 'sieve-block__body'

    // ── Raw/edit area: gutter + code-area, same shape as 'code' ──────────────
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

    // ── Explore area: a scrollable, filterable table over parsed JSON lines ──
    const exploreArea = document.createElement('div')
    exploreArea.className = 'log-block__explore-area'

    const tableContainer = document.createElement('div')
    tableContainer.className = 'log-block__table'

    // Block SELECTION is owned by the framework (click-to-own-selection in
    // sieve-block-extension.js) — a click anywhere in the block makes it the
    // caret/selection owner uniformly for every kind. The only thing local to
    // this text-table body is shielding the native text selection users drag
    // to copy log lines from that framework click-claim: stop mousedown
    // propagation (except the framework's own controls) and cancel dragstart.
    exploreArea.addEventListener('mousedown', (e) => {
      const t = /** @type {HTMLElement} */ (e.target)
      if (t.closest && t.closest('input, textarea, button, select')) return
      e.stopPropagation()
    })
    exploreArea.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation() })

    exploreArea.appendChild(tableContainer)

    body.appendChild(editArea)
    body.appendChild(exploreArea)
    dom.appendChild(body)

    this.#gutter = gutter
    this.#codeEl = codeEl
    this.#editArea = editArea
    this.#exploreArea = exploreArea
    this.#tableContainer = tableContainer

    this.update(dom, attrs)
    return dom
  }

  /**
   * @param {HTMLElement} dom
   * @param {LogAttrs} attrs — `source` is expected to be the LIVE PM text
   *   (mirrors CodeRenderer/DiagramRenderer's effectiveAttrs pattern); a
   *   `resolvedAssetUrl` (adapter-computed from parsedAssetRef + the held
   *   Editor's uuid — a PM-framework concern) is required to load Explore data.
   */
  update(dom, attrs) {
    const assetChanged = this.#attrs.parsedAssetRef !== attrs.parsedAssetRef || this.#attrs.status !== attrs.status
    this.#attrs = attrs

    dom.classList.toggle('log--hide-noise', !!attrs.hideNoise)
    this.syncGutterLineCount(attrs.source || '')
    this.#updateVisibility(attrs)

    if (assetChanged) this.#loadAsset(attrs)
    else if (this.#loadedJson) this.#renderTable(attrs)
  }

  /** @param {string} source */
  syncGutterLineCount(source) {
    if (this.#gutter) LineGutter.sync(this.#gutter, source)
  }

  /** @param {HTMLElement} dom */
  destroy(dom) {
    if (this.#tableObserver) { this.#tableObserver.disconnect(); this.#tableObserver = null }
  }

  // ── Body-visibility (raw vs explore) ──────────────────────────────────────

  /** @param {LogAttrs} attrs */
  #updateVisibility(attrs) {
    const editArea = this.#editArea, exploreArea = this.#exploreArea
    if (!editArea || !exploreArea) return
    if (LogRenderer.isExplore(attrs)) {
      // Keep editArea in the layout tree but make it visually hidden so
      // WebKit's caret drawing engine doesn't break for empty sibling blocks.
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

  // ── Explore data loading + table rendering ────────────────────────────────

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
      if (this.#onColumnsAvailable) this.#onColumnsAvailable(this.#availableColumns())
      this.#renderTable(attrs)
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
