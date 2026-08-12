// @ts-check
// composer-attachments.js — ComposerAttachments: what the Ask composer has
// attached to the message being written, and the chip row that shows it (#74 P4).
//
// NO NEW ROW. The chips live in the EXISTING `.ask-popup__footer` (index.html),
// which already holds the hint on the left and Send on the right. Chips take the
// left region and DISPLACE the hint while any attachment is present; overflow
// scrolls horizontally rather than growing the panel (the footer's height feeds
// ui/layout.js's askPanelMinHeight, so a wrapping chip row would push the
// composer's minimum height around).
//
// THE MODEL AND ITS CHIPS ARE ONE TYPE. The chips ARE this data drawn — there is
// no second object that could disagree with it, and every mutation re-renders
// from the list rather than patching the DOM in parallel.
//
// URI IS IDENTITY, TITLE IS AN ECHO. Two library notes may both be called
// "Notes": they are two attachments with two addresses and one text token each.
// So dedupe is by uri, and reconciliation COUNTS tokens per title rather than
// asking "is this title present" — deleting one of two `@Notes` tokens drops
// exactly one attachment.

import { esc } from '../block/renderers/html-escape.js'

/**
 * A candidate as the picker offers it. `kind`/`detail` are display-only: they
 * are resolved fresh server-side at job time and NEVER persisted.
 * @typedef {import('../block/mention-service.js').MentionCandidate} MentionCandidate
 */

/**
 * The persisted / wire shape of one attachment — the whole of it.
 * @typedef {object} AttachmentEntry
 * @property {string} uri
 * @property {string} title
 */

export class ComposerAttachments {
  /** @type {Array<{uri: string, title: string, detail: string}>} insertion-ordered */ #items = []
  /** @type {HTMLElement|null} the chip row (null → headless: model-only, all verbs still work) */ #row = null
  /** @type {HTMLElement|null} the hint the chips displace */ #hint = null

  /**
   * @param {HTMLElement|null} footerEl the structural `.ask-popup__footer`. The
   *   row is CREATED here (the panel's own DOM is never rebuilt) and inserted
   *   before the hint, so Send stays the footer's last child.
   */
  constructor(footerEl) {
    if (!footerEl) return
    this.#hint = footerEl.querySelector('.ask-popup__hint')
    const row = document.createElement('div')
    row.className = 'ask-popup__chips'
    if (this.#hint) footerEl.insertBefore(row, this.#hint)
    else footerEl.insertBefore(row, footerEl.firstChild)
    this.#row = row
    this.#render()
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  /** @returns {number} how many documents are attached */
  get size() { return this.#items.length }

  /**
   * The persisted shape: `{uri, title}` and nothing else. `kind` and `summary`
   * are the Router's to resolve at job time — a chip must never be able to
   * smuggle a stale one into storage.
   * @returns {AttachmentEntry[]}
   */
  manifest() {
    return this.#items.map((a) => ({ uri: a.uri, title: a.title }))
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  /**
   * Attaches a picked candidate. Idempotent by uri — attaching the same document
   * twice adds no context, so the second accept is a no-op (its `@Title` echo
   * still lands in the text, which is the user's business).
   * @param {MentionCandidate|null} candidate
   * @returns {boolean} whether it was added
   */
  add(candidate) {
    const uri = (candidate && candidate.uri || '').trim()
    if (!uri) return false                                  // no address = not an attachment
    if (this.#items.some((a) => a.uri === uri)) return false
    this.#items.push({
      uri: uri,
      title: (candidate && candidate.title || '').trim(),
      detail: (candidate && candidate.detail || '').trim(),
    })
    this.#render()
    return true
  }

  /** Detaches by address (the ✕ on a chip). @param {string} uri */
  remove(uri) {
    const before = this.#items.length
    this.#items = this.#items.filter((a) => a.uri !== uri)
    if (this.#items.length !== before) this.#render()
  }

  /** Empties the set (after a send). */
  clear() {
    if (this.#items.length === 0) return
    this.#items = []
    this.#render()
  }

  /**
   * SEND-TIME RECONCILIATION: drops any attachment whose `@Title` token is no
   * longer in the message. Deleting the text is a legitimate way to detach —
   * the chip is a view of the message, not a second place to edit.
   *
   * Counting (rather than testing presence) is what makes duplicate titles work:
   * two "Notes" attachments survive two `@Notes` tokens, and exactly one survives
   * one.
   * @param {string} text the message as written
   * @returns {AttachmentEntry[]} the surviving manifest
   */
  reconcile(text) {
    /** @type {Map<string, number>} title → tokens already spent on it */
    const spent = new Map()
    this.#items = this.#items.filter((a) => {
      const used = spent.get(a.title) || 0
      if (used >= ComposerAttachments.#countTokens(text, a.title)) return false
      spent.set(a.title, used + 1)
      return true
    })
    this.#render()
    return this.manifest()
  }

  /**
   * How many times `@title` appears in `text` as a token — i.e. at the start or
   * after whitespace, so "mail me@Auth Design" is an address, not a mention.
   * @param {string} text @param {string} title @returns {number}
   */
  static #countTokens(text, title) {
    if (!title) return 0
    const needle = '@' + title
    const haystack = text || ''
    let count = 0
    let idx = haystack.indexOf(needle)
    while (idx !== -1) {
      const before = idx > 0 ? haystack.charAt(idx - 1) : ''
      if (before === '' || /\s/.test(before)) count++
      idx = haystack.indexOf(needle, idx + needle.length)
    }
    return count
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  /** Redraws the chip row from the list and yields/restores the hint. */
  #render() {
    if (this.#hint) this.#hint.style.display = this.#items.length ? 'none' : ''
    const row = this.#row
    if (!row) return
    row.innerHTML = ''
    row.style.display = this.#items.length ? 'flex' : 'none'
    for (const item of this.#items) row.appendChild(this.#chip(item))
  }

  /**
   * One chip: the document's title, its detail as the tooltip (how two chips
   * with the same title are told apart), and a ✕.
   * @param {{uri: string, title: string, detail: string}} item
   * @returns {HTMLElement}
   */
  #chip(item) {
    const chip = document.createElement('span')
    chip.className = 'ask-chip'
    chip.setAttribute('data-uri', item.uri)
    if (item.detail) chip.setAttribute('title', item.detail)
    chip.innerHTML =
      '<span class="ask-chip__icon" aria-hidden="true">&#128196;</span>' +
      '<span class="ask-chip__label">' + esc(item.title || item.uri) + '</span>' +
      '<button type="button" class="ask-chip__remove" aria-label="Remove ' + esc(item.title) + '">&#10005;</button>'

    const remove = /** @type {HTMLElement} */ (chip.querySelector('.ask-chip__remove'))
    // mousedown is swallowed so clicking ✕ never pulls focus out of the composer
    // (which would fire the popover's blur dismissal and close the panel's box).
    remove.addEventListener('mousedown', (e) => e.preventDefault())
    remove.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.remove(item.uri)
    })
    return chip
  }
}
