// @ts-check
// ReferenceRenderer: the 'reference' kind's look-and-feel, and there is
// deliberately very little of it — the block IS a reference chip, so this class
// composes ReferenceChip on a shrink-wrapping line and adds the chevron that
// reveals `summary`. No card shell, no header bar, no toolbar.
//
// THE ONE GESTURE IT OWNS: DOUBLE click, fanned out as an INTENT (`onOpen`)
// carrying the block's target. Single click is NOT handled here — a block sits
// in the editing flow, so placing the caret is the shared policy's job.

import { BlockRenderer } from './block-renderer.js'
import { referenceStyles } from './reference-renderer.styles.js'
import { ReferenceChip } from './reference-chip.js'
import { StatusBadge } from './status-badge.js'
import { registerBlockRenderer } from './block-kinds.js'

/**
 * What the last resolve took from the TARGET — the reference's cached face,
 * namespaced under one attr so it can never be mistaken for a fact about the
 * reference itself. `mime` is the DISCRIMINATOR — HELD ⇔ the mime names a real
 * format (`text/yaml`) rather than Sieve's own space (`sieve/note`) — and it is
 * the only noun the chip needs.
 * @typedef {object} ReferenceFace
 * @property {string} [title]    the cached name
 * @property {string} [summary]  one line under the title; what the chevron reveals
 * @property {string} [bytes]    a held file's size, as a STRING (see the processor for why)
 * @property {string} [mime]     what this block points at or holds; non-sieve/* ⇔ held
 * @property {string} [cachedAt] when this face was taken from the target
 */

/**
 * The reference block's payload, as the Go processor stamps it. Root attrs are
 * facts about the POINTING; `cache` is the facts about the POINTED-AT. `uri` is
 * the ONE address: a held file's bytes live at a `sieve://{container}/{leaf}`
 * coordinate like any other.
 * @typedef {object} ReferencePayload
 * @property {string} [id]
 * @property {string} [uri]    the ONE address: sieve://{container}[/{leaf}]
 * @property {ReferenceFace} [cache] the cached face; absent until something resolves
 * @property {string} [rel]    the authored role a CONSUMER classifies on — an
 *   ai-block's question reads `target`/`attach` off it to decide which slot this
 *   reference belongs to, and falls back to the address when it declares
 *   neither. It never alters permissions or what the reference IS; this block's
 *   own rendering does not read it.
 * @property {string} [status]
 * @property {string} [error]
 * @property {string|null} [createdAt]
 */

/**
 * What this block opens, resolved from its one address attr.
 * @typedef {object} ReferenceTarget
 * @property {string} uri     the coordinate to navigate to
 * @property {string} title   what to call it
 * @property {boolean} held   true when the face carries `mime` — a file this
 *   block itself holds, opened by revealing it rather than navigating to it
 */

export class ReferenceRenderer extends BlockRenderer {
  static styles = referenceStyles
  static rootClass = 'reference-block'

  /** Disclosure glyphs. A GLYPH SWAP, never a CSS transform. */
  static #CHEVRON = Object.freeze({ COLLAPSED: '▸', EXPANDED: '▾' })

  /** The label a block with no title, no file and no coordinate still wears. */
  static #UNADDRESSED_LABEL = 'Reference'

  /** @type {HTMLElement|null} the shrink-wrapping row that holds the chip */ #line = null
  /** @type {HTMLElement|null} the revealed summary */ #summaryEl = null
  /** @type {boolean} disclosure state — VIEW state, never persisted (the kind has no attr for it) */ #expanded = false
  /** @type {Array<(target: ReferenceTarget) => void>} */ #openListeners = []

  /**
   * The one thing a reference addresses, whatever it points at or holds.
   * @param {ReferencePayload} payload
   * @returns {ReferenceTarget|null} null when the block addresses nothing
   */
  static targetFor(payload) {
    const p = payload || {}
    const uri = (p.uri || '').trim()
    if (!uri) return null
    return { uri: uri, title: ReferenceRenderer.labelFor(p), held: ReferenceRenderer.#isHeld(p) }
  }

  /**
   * The cached face — the facts about the pointed-at. Always an object, so a
   * block nothing has resolved yet reads as an empty face.
   * @param {ReferencePayload} payload
   * @returns {ReferenceFace}
   */
  static faceOf(payload) {
    return (payload || {}).cache || {}
  }

  /**
   * What the chip is CALLED: its cached title, else the thing it addresses.
   * Never blank.
   * @param {ReferencePayload} payload
   * @returns {string}
   */
  static labelFor(payload) {
    const p = payload || {}
    const title = (ReferenceRenderer.faceOf(p).title || '').trim()
    if (title) return title
    if (ReferenceRenderer.#isHeld(p)) return ReferenceRenderer.filenameOf(p.uri)
    return (p.uri || '').trim() || ReferenceRenderer.#UNADDRESSED_LABEL
  }

  /**
   * The bare filename at the end of a `sieve://{container}/{leaf}` address —
   * the leaf key a held file's uri names.
   * @param {string} uri
   * @returns {string}
   */
  static filenameOf(uri) {
    const trimmed = (uri || '').trim()
    const parts = trimmed.split('/')
    return parts[parts.length - 1] || trimmed
  }

  /**
   * A stored byte count as a reader sees it — "412 KB" (1024-based, one decimal
   * below 10). `bytes` is a STRING attr, so a value that will not parse renders
   * nothing rather than a wrong number.
   * @param {string|number} [bytes]
   * @returns {string}
   */
  static humanSize(bytes) {
    const n = parseInt(String(bytes == null ? '' : bytes).trim(), 10)
    if (!Number.isFinite(n) || n < 0) return ''
    if (n < 1024) return n + ' B'
    const suffixes = ['KB', 'MB', 'GB', 'TB']
    let div = 1024
    let exp = 0
    for (let m = Math.floor(n / 1024); m >= 1024 && exp < suffixes.length - 1; m = Math.floor(m / 1024)) {
      div *= 1024
      exp++
    }
    const v = n / div
    return (v < 10 ? v.toFixed(1) : v.toFixed(0)) + ' ' + suffixes[exp]
  }

  /** The whole block: a chip on a shrink-wrapping line, and the summary under it. @returns {HTMLElement} */
  buildBody() {
    const body = document.createElement('div')
    body.className = 'reference-block__body'
    // setAttribute, not the IDL property: the ATTRIBUTE is what a DOM parser reads.
    body.setAttribute('contenteditable', 'false')

    this.#line = document.createElement('div')
    this.#line.className = 'reference-block__line'
    this.#summaryEl = document.createElement('div')
    this.#summaryEl.className = 'reference-block__summary'
    body.appendChild(this.#line)
    body.appendChild(this.#summaryEl)
    body.addEventListener('dblclick', (e) => this.#onDoubleClick(e))

    this.#draw(/** @type {ReferencePayload} */ (this.block.payload))
    return body
  }

  /** @param {import('../contract/sieve-block.js').SieveBlock} block */
  update(block) {
    super.update(block)
    this.#draw(/** @type {ReferencePayload} */ (block.payload))
  }

  /**
   * Registers interest in "the user opened this reference", handing back what the
   * block addresses. The renderer never opens anything itself.
   * @param {(target: ReferenceTarget) => void} fn
   * @returns {() => void} unsubscribe
   */
  onOpen(fn) {
    this.#openListeners.push(fn)
    return () => { this.#openListeners = this.#openListeners.filter((l) => l !== fn) }
  }

  /**
   * Reveal or hide the summary — the chevron's verb, also reachable from a menu.
   * A no-op when there is no summary to show.
   * @param {boolean} [force] explicit state; omitted toggles
   * @returns {boolean} the resulting state
   */
  toggleSummary(force) {
    const next = force === undefined ? !this.#expanded : !!force
    this.#expanded = next && !!this.summaryText()
    this.#draw(/** @type {ReferencePayload} */ (this.block.payload))
    return this.#expanded
  }

  /** @returns {boolean} */
  get expanded() { return this.#expanded }

  /** The one line the chevron reveals ('' when the block has none). @returns {string} */
  summaryText() {
    const payload = /** @type {ReferencePayload} */ (this.block.payload)
    return (ReferenceRenderer.faceOf(payload).summary || '').trim()
  }

  /** What this block opens, or null when it addresses nothing. @returns {ReferenceTarget|null} */
  target() {
    return ReferenceRenderer.targetFor(/** @type {ReferencePayload} */ (this.block.payload))
  }

  /** The address (or filename) a consumer copies for this block. @returns {string} */
  copyText() {
    return ReferenceRenderer.copyTextFor(/** @type {ReferencePayload} */ (this.block.payload))
  }

  /**
   * What "copy" yields for a reference: the coordinate it points at, or the
   * friendly name of the file it holds.
   * @param {ReferencePayload} payload
   * @returns {string}
   */
  static copyTextFor(payload) {
    const t = ReferenceRenderer.targetFor(payload)
    if (!t) return ''
    return t.held ? t.title : t.uri
  }

  /**
   * Redraws the chip and the summary from the block. The whole line is rebuilt,
   * not patched: ReferenceChip is immutable once built.
   * @param {ReferencePayload} payload
   */
  #draw(payload) {
    const line = this.#line
    const summaryEl = this.#summaryEl
    if (!line || !summaryEl) return

    const held = ReferenceRenderer.#isHeld(payload)
    const missing = ReferenceRenderer.#isMissing(payload)
    const chip = new ReferenceChip({
      // A held file's own chip carries no data-uri: its click activation is
      // inert — this block opens the file on DOUBLE click, through the intent below.
      uri: held ? '' : (payload.uri || '').trim(),
      label: ReferenceRenderer.labelFor(payload),
      detail: this.#detail(payload),
      tooltip: this.#tooltip(payload, missing),
      missing: missing,
    })

    const summary = this.summaryText()
    if (summary) chip.element.appendChild(this.#buildChevron())

    line.innerHTML = ''
    line.appendChild(chip.element)

    summaryEl.textContent = summary
    summaryEl.classList.toggle('reference-block__summary--shown', this.#expanded && !!summary)

    const root = this.root
    if (root) {
      const pending = StatusBadge.classify(payload.status, payload.createdAt, payload.id) === 'pending'
      root.classList.toggle('reference-block--pending', pending)
    }
  }

  /** The disclosure control — a real button, never a tab stop.
   *  @returns {HTMLElement} */
  #buildChevron() {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'reference-block__chevron'
    btn.tabIndex = -1
    btn.setAttribute('aria-expanded', this.#expanded ? 'true' : 'false')
    btn.setAttribute('aria-label', this.#expanded ? 'Hide summary' : 'Show summary')
    btn.textContent = this.#expanded ? ReferenceRenderer.#CHEVRON.EXPANDED : ReferenceRenderer.#CHEVRON.COLLAPSED
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.toggleSummary()
    })
    return btn
  }

  /** @param {MouseEvent} e */
  #onDoubleClick(e) {
    const el = /** @type {HTMLElement|null} */ (e.target)
    // The chevron reads the asset in place; it is not an open gesture.
    if (el && el.closest && el.closest('.reference-block__chevron')) return
    const target = this.target()
    if (!target) return
    e.preventDefault()
    for (const fn of this.#openListeners) {
      try { fn(target) } catch (err) { console.error('[reference] open listener threw', err) }
    }
  }

  /**
   * The quiet secondary text after the label: "yaml · 412 KB" for a held file,
   * "note" for a citation. Either half may be missing, and the line simply
   * shortens rather than inventing a placeholder.
   * @param {ReferencePayload} payload
   * @returns {string}
   */
  #detail(payload) {
    const parts = []
    const kind = this.#assetKind(payload)
    if (kind) parts.push(kind)
    const size = ReferenceRenderer.humanSize(ReferenceRenderer.faceOf(payload).bytes)
    if (size) parts.push(size)
    return parts.join(' · ')
  }

  /**
   * The noun for the thing this block points at or holds — "note" for a pointer,
   * "yaml" or "pdf" for a held file. DERIVED from `mime`, never stored beside it.
   * @param {ReferencePayload} payload
   * @returns {string}
   */
  #assetKind(payload) {
    const mime = (ReferenceRenderer.faceOf(payload).mime || '').trim()
    const slash = mime.indexOf('/')
    if (slash < 0) return mime
    let sub = mime.slice(slash + 1)
    const plus = sub.indexOf('+')
    if (plus > 0) sub = sub.slice(0, plus)          // image/svg+xml → svg
    sub = sub.replace(/^vnd\./, '').replace(/^x-/, '')
    if (sub === 'plain') return 'text'              // nothing is called a "plain"
    const dot = sub.lastIndexOf('.')
    return dot >= 0 ? sub.slice(dot + 1) : sub      // the office types' last segment
  }

  /**
   * DANGLING IS A NORMAL STATE, not a job failure: a reference whose target is
   * gone settles COMPLETE with a non-empty `error`, keeping the cached face. So
   * it is the ERROR TEXT that greys a chip, never `status`.
   * @param {ReferencePayload} payload
   * @returns {boolean}
   */
  static #isMissing(payload) {
    return !!(payload.error || '').trim()
  }

  /**
   * held ⇔ the cached mime does NOT name Sieve's own space (`sieve/…`). THE
   * FACE DECIDES: the uri is never inspected to answer this.
   * @param {ReferencePayload} payload
   * @returns {boolean}
   */
  static #isHeld(payload) {
    const mime = (ReferenceRenderer.faceOf(payload).mime || '').trim()
    return mime !== '' && !mime.startsWith('sieve/')
  }

  /**
   * What tells two same-labelled chips apart — and, when something is wrong,
   * what is wrong. @param {ReferencePayload} payload @param {boolean} missing
   * @returns {string}
   */
  #tooltip(payload, missing) {
    if (missing) return (payload.error || '').trim()
    const uri = (payload.uri || '').trim()
    if (!uri) return ''
    return ReferenceRenderer.#isHeld(payload) ? ReferenceRenderer.filenameOf(uri) : uri
  }

}

registerBlockRenderer('reference', () => ReferenceRenderer)
