// @ts-check
// attachment-renderer.js — AttachmentRenderer: the renderer half of the
// 'attachment' kind's renderer/NodeView split (NORMATIVE contract:
// docs/design/archive/specs/2026-07-21-block-renderer-contract.md; the kind's
// design: docs/design/specs/2026-08-19-attachment-block-design.md).
//
// Owns look-and-feel ONLY, and there is deliberately very little of it: the
// block IS an attachment chip — Sieve already has a vocabulary for "this is an
// attachment", and a second one for the same idea would make the two read as
// different objects. So this class COMPOSES AttachmentChip (the shared
// component, a sibling in this directory) inside a block-level wrapper that
// shrink-wraps it, adds the chevron that reveals `summary`, and stops there. No
// card shell, no header bar, no toolbar.
//
// Zero ProseMirror/editor/window.* dependencies: it mounts identically in the
// note editor's NodeView adapter (editor/surfaces/node-views/attachment-node-view.js,
// by composition) and on a bare page.
//
// ── THE ONE GESTURE IT OWNS ─────────────────────────────────────────────────
// SINGLE click is NOT handled here. A block sits in the editing flow, so a
// single click must place the caret and select it like any other block — that is
// the shared interaction policy's job, and a handler here would fight it.
// DOUBLE click opens, and this class fans out an INTENT (`onOpen`) carrying the
// block's target; it never names a mechanism. Navigating to a container and
// revealing a file are decisions for whoever holds this renderer — the desktop
// adapter answers one way, a hosted build must be able to answer differently
// without touching this file. Same seam as `sieve:ai-ask`/`sieve:ai-explain`.
//
// ── WHY THE ATTR IS `targetKind` AND NOT `kind` ─────────────────────────────
// `kind` is RESERVED: BASE_ATTRS (sieve-block-extension.js) declares it on every
// sieve-* node as the BLOCK's kind. A processor attr of the same name collides,
// and the collision is silent — WysiwygSurface#applyBlockAttrsUpdated copies any
// wire key present in node.attrs, so Go's "yaml" would overwrite the node's own
// "attachment" the moment a job completed. The attr is therefore named for what
// it describes: the kind of the thing this block points at or holds.

import { BlockRenderer } from './block-renderer.js'
import { attachmentStyles } from './attachment-renderer.styles.js'
import { AttachmentChip } from './attachment-chip.js'
import { StatusBadge } from './status-badge.js'

/**
 * The attachment block's payload, as the Go processor stamps it
 * (sieve/block/processors/attachment_processor.go, InitAttrs). Exactly one of
 * `src` / `uri` is ever set — the kind's only invariant.
 * @typedef {object} AttachmentPayload
 * @property {string} [id]
 * @property {string} [src]     an asset filename in the document directory — the block HOLDS a file
 * @property {string} [uri]     a `container:{uuid}` coordinate — the block POINTS at another container
 * @property {string} [title]   the cached name
 * @property {string} [targetKind] what the block points at or holds ("note" for a citation, the mime family for a file)
 * @property {string} [summary] one line under the title; what the chevron reveals
 * @property {string} [bytes]   a held file's size, as a STRING (see the processor for why)
 * @property {string} [mime]
 * @property {string} [status]
 * @property {string} [error]
 * @property {string|null} [createdAt]
 */

/**
 * What this block opens, resolved from its one address attr.
 * @typedef {object} AttachmentTarget
 * @property {string} uri   the coordinate to navigate to ('' for a held file)
 * @property {string} src   the asset to reveal ('' for a citation)
 * @property {string} title what to call it
 */

export class AttachmentRenderer extends BlockRenderer {
  static styles = attachmentStyles
  static rootClass = 'attachment-block'

  /** Disclosure glyphs. A GLYPH SWAP, never a CSS transform — see the styles header. */
  static #CHEVRON = Object.freeze({ COLLAPSED: '▸', EXPANDED: '▾' })

  /** The label a block with no title, no file and no coordinate still wears. */
  static #UNADDRESSED_LABEL = 'Attachment'

  /** @type {HTMLElement|null} the shrink-wrapping row that holds the chip */ #line = null
  /** @type {HTMLElement|null} the revealed summary */ #summaryEl = null
  /** @type {boolean} disclosure state — VIEW state, never persisted (the kind has no attr for it) */ #expanded = false
  /** @type {Array<(target: AttachmentTarget) => void>} */ #openListeners = []

  /**
   * THE address rule, in one place, mirroring the processor's own `address()`:
   * exactly one of src/uri is ever set, and the (illegal) both-set case resolves
   * to `uri` — arbitrarily, but FIXEDLY and identically on both sides of the
   * wire, so a block cannot mean one thing to Go and another to the reader.
   * @param {AttachmentPayload} payload
   * @returns {AttachmentTarget|null} null when the block addresses nothing
   */
  static targetFor(payload) {
    const p = payload || {}
    const uri = (p.uri || '').trim()
    const src = (p.src || '').trim()
    const title = AttachmentRenderer.labelFor(p)
    if (uri) return { uri: uri, src: '', title: title }
    if (src) return { uri: '', src: src, title: title }
    return null
  }

  /**
   * What the chip is CALLED: its cached title, else the thing it addresses. A
   * chip is never blank — one nobody can identify has stopped being one.
   * @param {AttachmentPayload} payload
   * @returns {string}
   */
  static labelFor(payload) {
    const p = payload || {}
    const title = (p.title || '').trim()
    if (title) return title
    const src = (p.src || '').trim()
    if (src) return AttachmentRenderer.filenameOf(src)
    return (p.uri || '').trim() || AttachmentRenderer.#UNADDRESSED_LABEL
  }

  /**
   * The bare asset name from a stored src. Mirrors the processor's `filename`:
   * a src is always a filename in the document directory, and the `.assets/`
   * strip plus the basename are defensive against a path-qualified one.
   * @param {string} src
   * @returns {string}
   */
  static filenameOf(src) {
    const trimmed = (src || '').trim().replace(/^\.assets\//, '')
    const parts = trimmed.split('/')
    return parts[parts.length - 1] || trimmed
  }

  /**
   * A stored byte count as a reader sees it — "412 KB". Mirrors the processor's
   * `humanSize` exactly (1024-based, one decimal below 10) so the chip and the
   * AI context state the same size. `bytes` is a STRING attr, so a value that
   * will not parse renders nothing rather than a lie.
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
    body.className = 'attachment-block__body'
    // setAttribute, not the IDL property: the ATTRIBUTE is what ProseMirror's
    // DOM parser and the read-only guard read (and what jsdom/happy-dom reflect).
    body.setAttribute('contenteditable', 'false')

    this.#line = document.createElement('div')
    this.#line.className = 'attachment-block__line'
    this.#summaryEl = document.createElement('div')
    this.#summaryEl.className = 'attachment-block__summary'
    body.appendChild(this.#line)
    body.appendChild(this.#summaryEl)

    // DOUBLE click opens; single click is the shared policy's (see the header).
    body.addEventListener('dblclick', (e) => this.#onDoubleClick(e))

    this.#draw(/** @type {AttachmentPayload} */ (this.block.payload))
    return body
  }

  /** @param {import('../sieve-block.js').SieveBlock} block */
  update(block) {
    super.update(block)
    this.#draw(/** @type {AttachmentPayload} */ (block.payload))
  }

  // ── Semantic verbs (kind-specific — the contract's abstract-consumer rule) ──

  /**
   * Registers interest in "the user opened this attachment", handing back what
   * the block addresses. The renderer NEVER opens anything itself: it is
   * lens-blind, has no idea what a workspace or a file manager is, and naming
   * either here would harden the desktop into the block.
   * @param {(target: AttachmentTarget) => void} fn
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
    this.#draw(/** @type {AttachmentPayload} */ (this.block.payload))
    return this.#expanded
  }

  /** Is the summary currently revealed? @returns {boolean} */
  get expanded() { return this.#expanded }

  /** The one line the chevron reveals ('' when the block has none). @returns {string} */
  summaryText() {
    const payload = /** @type {AttachmentPayload} */ (this.block.payload)
    return (payload.summary || '').trim()
  }

  /** What this block opens, or null when it addresses nothing. @returns {AttachmentTarget|null} */
  target() {
    return AttachmentRenderer.targetFor(/** @type {AttachmentPayload} */ (this.block.payload))
  }

  /** The address (or filename) a consumer copies for this block. @returns {string} */
  copyText() {
    return AttachmentRenderer.copyTextFor(/** @type {AttachmentPayload} */ (this.block.payload))
  }

  /**
   * What "copy" yields for an attachment, as ONE rule: the coordinate it points
   * at, or the name of the file it holds. Static because the context menu has
   * only the node's attrs — the same rule must not be restated there.
   * @param {AttachmentPayload} payload
   * @returns {string}
   */
  static copyTextFor(payload) {
    const t = AttachmentRenderer.targetFor(payload)
    if (!t) return ''
    return t.uri || AttachmentRenderer.filenameOf(t.src)
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  /**
   * Redraws the chip and the summary from the envelope. The whole line is
   * rebuilt rather than patched: a chip is a value drawn, not a live object
   * (AttachmentChip is immutable once built), and the disclosure state lives on
   * THIS object, so it survives the redraw a render-back triggers.
   * @param {AttachmentPayload} payload
   */
  #draw(payload) {
    const line = this.#line
    const summaryEl = this.#summaryEl
    if (!line || !summaryEl) return

    const missing = AttachmentRenderer.#isMissing(payload)
    const chip = new AttachmentChip({
      // A held file has no coordinate; the chip is then simply not addressed
      // (its own click activation is inert, which is correct — this block opens
      // on DOUBLE click, through the intent below).
      uri: (payload.uri || '').trim(),
      label: AttachmentRenderer.labelFor(payload),
      detail: this.#detail(payload),
      tooltip: this.#tooltip(payload, missing),
      missing: missing,
    })

    const summary = this.summaryText()
    if (summary) chip.element.appendChild(this.#buildChevron())

    line.innerHTML = ''
    line.appendChild(chip.element)

    summaryEl.textContent = summary
    summaryEl.classList.toggle('attachment-block__summary--shown', this.#expanded && !!summary)

    const root = this.root
    if (root) {
      const pending = StatusBadge.classify(payload.status, payload.createdAt, payload.id) === 'pending'
      root.classList.toggle('attachment-block--pending', pending)
    }
  }

  /** The disclosure control — a real button, but never a tab stop (Tab belongs
   *  to the shared interaction policy, and a chip has no editable text).
   *  @returns {HTMLElement} */
  #buildChevron() {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'attachment-block__chevron'
    btn.tabIndex = -1
    btn.setAttribute('aria-expanded', this.#expanded ? 'true' : 'false')
    btn.setAttribute('aria-label', this.#expanded ? 'Hide summary' : 'Show summary')
    btn.textContent = this.#expanded ? AttachmentRenderer.#CHEVRON.EXPANDED : AttachmentRenderer.#CHEVRON.COLLAPSED
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
    if (el && el.closest && el.closest('.attachment-block__chevron')) return
    const target = this.target()
    if (!target) return
    e.preventDefault()
    for (const fn of this.#openListeners) {
      try { fn(target) } catch (err) { console.error('[attachment] open listener threw', err) }
    }
  }

  /**
   * The quiet secondary text after the label: "yaml · 412 KB" for a held file,
   * "note" for a citation. Either half may be missing (a job that has not landed
   * yet) and the line simply shortens rather than inventing a placeholder —
   * mirroring the processor's `typeLine`.
   * @param {AttachmentPayload} payload
   * @returns {string}
   */
  #detail(payload) {
    const parts = []
    const kind = this.#assetKind(payload)
    if (kind) parts.push(kind)
    const size = AttachmentRenderer.humanSize(payload.bytes)
    if (size) parts.push(size)
    return parts.join(' · ')
  }

  /**
   * The kind of the thing this block points at or holds — "note" for a
   * citation, the mime family ("yaml", "pdf") for a held file.
   *
   * It reads `targetKind` rather than `kind` because `kind` is reserved by the
   * framework for the BLOCK's kind; see the file header for what collided.
   * @param {AttachmentPayload} payload
   * @returns {string}
   */
  #assetKind(payload) {
    return (payload.targetKind || '').trim()
  }

  /**
   * DANGLING IS A NORMAL STATE, not a job failure. The processor settles a
   * reference whose target is gone as COMPLETE with a non-empty `error`,
   * deliberately KEEPING the cached face — that pair, not the ERROR status, is
   * what greys a chip. Testing status here instead would miss every dangling
   * block there is.
   *
   * A job that genuinely broke also leaves an `error`, and such a block is
   * equally un-openable, so ONE predicate covers both: an attachment with
   * something wrong with it says so, and still shows whatever it last knew.
   * @param {AttachmentPayload} payload
   * @returns {boolean}
   */
  static #isMissing(payload) {
    return !!(payload.error || '').trim()
  }

  /**
   * What tells two same-labelled chips apart — and, when something is wrong,
   * what is wrong. @param {AttachmentPayload} payload @param {boolean} missing
   * @returns {string}
   */
  #tooltip(payload, missing) {
    if (missing) return (payload.error || '').trim()
    const uri = (payload.uri || '').trim()
    if (uri) return uri
    const src = (payload.src || '').trim()
    return src ? AttachmentRenderer.filenameOf(src) : ''
  }

  // destroy(): base no-op is correct — this class owns no timers/observers, and
  // its listeners live on DOM it owns.
}
