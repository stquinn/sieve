// @ts-check
// What the Ask composer has attached to the message being written, and the chip
// row that shows it. The chips live in `.ask-popup__footer`, left of Send, and
// overflow scrolls horizontally rather than growing the panel, because the
// footer's height feeds ui/layout.js's askPanelMinHeight.
//
// THE MODEL AND ITS CHIPS ARE ONE TYPE: every mutation re-renders from the list.
//
// URI IS IDENTITY, TITLE IS AN ECHO. Two library notes may both be called "Notes".
// Dedupe is by uri, and reconciliation PAIRS tokens to attachments per title
// rather than asking "is this title present", so deleting one of two `@Notes`
// tokens drops exactly one.
//
// THE CHIP IS A VIEW OF THE TOKENS IN THE MESSAGE; THE TEXT IS WHAT YOU EDIT.
// `#known` is every candidate accepted since the composer was last cleared;
// `#attached` is the subset a `@Title` token currently carries. Reconciling
// RE-DERIVES the second from the first, so a token that comes back re-attaches.
// The invariant is one-way: a chip implies a token, a token does not imply a chip.
//
// THE ✕ FORGETS; EDITING THE TEXT DOES NOT. ✕ means "I do not want this
// attached", so its document leaves `#known`; a text edit means "I am editing my
// sentence", so it stays pooled. Forgetting is by URI, never by title.
//
// DETACHING DEMOTES: an attachment the text lost moves to the BACK of the pool
// before the pairing is redone, so a remaining identical `@Notes` pairs with the
// attachment the user did not touch.

import { esc } from '../renderers/html-escape.js'
// The token rule is SHARED with the ai-block, which marks the same `@Title`
// tokens in the question it renders. Two copies of "what counts as a mention"
// would let a chip and its inline mark describe different text.
import { MentionTokens } from '../renderers/mention-tokens.js'

/**
 * A candidate as the picker offers it. `kind`/`detail` are display-only — they
 * exist to tell two same-titled offers apart while choosing — and are NEVER
 * persisted: only `{uri, title}` leaves the composer.
 * @typedef {import('./mention-service.js').MentionCandidate} MentionCandidate
 */

/**
 * The persisted / wire shape of one attachment — the whole of it.
 * @typedef {object} AttachmentEntry
 * @property {string} uri
 * @property {string} title
 */

/**
 * One attachment as this type holds it. `detail` is display-only (the chip's
 * tooltip, which is how two chips with the same title are told apart).
 * @typedef {object} Attachment
 * @property {string} uri
 * @property {string} title
 * @property {string} detail
 */

/**
 * The half-open span of one `@Title` token in the message, and the attachment it
 * carries.
 * @typedef {object} TokenPair
 * @property {Attachment} item
 * @property {number} start  index of the `@`
 * @property {number} end    one past the last character of the title
 */

export class ComposerAttachments {
  /** @type {Attachment[]} THE POOL: every candidate accepted since the composer
   *  was last cleared, insertion-ordered. Only clear() and the chip's ✕ take
   *  anything out of it — a document the TEXT lost stays, which is what lets an
   *  undone deletion re-attach. */ #known = []
  /** @type {Attachment[]} THE VIEW: the subset a `@Title` token carries right
   *  now. The chips, and what send carries. */ #attached = []
  /** @type {HTMLElement|null} the chip row (null → headless: model-only, all verbs still work) */ #row = null
  /** @type {HTMLTextAreaElement|null} the composer whose text is the truth (null
   *  → model-only: the token verbs no-op, the chip verbs still work) */ #textarea = null
  /** @type {(edit: () => void) => void} runs a programmatic composer edit */ #applyEdit

  /**
   * @param {HTMLElement|null} footerEl the structural `.ask-popup__footer`. The
   *   row is CREATED here and inserted before Send, which stays the last child.
   * @param {HTMLTextAreaElement|null} [textarea] the composer. The tokens live in
   *   it, so every verb that removes an attachment removes its text too.
   * @param {((edit: () => void) => void)|null} [applyEdit] how to perform a
   *   programmatic edit of that text. The panel passes the picker's own-edit gate,
   *   so the `input` such an edit fires is understood as OURS and does not reopen
   *   the picker on what was just deleted. Defaults to plain application.
   */
  constructor(footerEl, textarea = null, applyEdit = null) {
    this.#textarea = textarea || null
    this.#applyEdit = applyEdit || ((edit) => edit())
    if (!footerEl) return
    const row = document.createElement('div')
    row.className = 'ask-popup__chips'
    // Send is the anchor, not the first child: TargetChips draws its own row into
    // this same footer, and inserting at the front would put a row built LATER
    // ahead of one built earlier.
    footerEl.insertBefore(row, footerEl.querySelector('.ask-popup__send'))
    this.#row = row
    this.#render()
  }

  /** @returns {number} how many documents are attached */
  get size() { return this.#attached.length }

  /** The persisted shape: `{uri, title}` and nothing else. Anything richer a chip
   *  holds is picker dressing that must not reach storage.
   *  @returns {AttachmentEntry[]} */
  manifest() {
    return this.#attached.map((a) => ({ uri: a.uri, title: a.title }))
  }

  /**
   * Attaches a picked candidate. Idempotent while it IS attached, so a second
   * accept is a no-op — though its `@Title` echo still lands in the text. A
   * document whose token was deleted is NOT attached, so accepting it again
   * genuinely re-attaches.
   * @param {MentionCandidate|null} candidate
   * @returns {boolean} whether it was added
   */
  add(candidate) {
    const uri = (candidate && candidate.uri || '').trim()
    if (!uri) return false                                  // no address = not an attachment
    if (this.#attached.some((a) => a.uri === uri)) return false
    const item = Object.freeze({
      uri: uri,
      title: (candidate && candidate.title || '').trim(),
      detail: (candidate && candidate.detail || '').trim(),
    })
    // Newest last in BOTH lists, so the pool order the pairing walks and the chip
    // order the user sees are the same.
    this.#retain(item)
    this.#attached = this.#attached.concat([item])
    this.#render()
    return true
  }

  /** Detaches by address — the ✕ on a chip. It removes the `@Title` echo too, and
   *  it FORGETS the document: a pooled one would silently re-attach when its title
   *  was written again. @param {string} uri */
  remove(uri) {
    // The pool is the superset, so this finds an attachment whether attached or
    // not. Pair BEFORE forgetting: #pairs walks #known.
    const item = this.#known.find((a) => a.uri === uri)
    if (!item) return
    const pair = this.#pairs(this.#text()).find((p) => p.item.uri === uri) || null
    this.#known = this.#known.filter((a) => a.uri !== uri)
    this.#drop(item, pair)
  }

  /**
   * ATOMIC TOKEN DELETION. If `caret` sits at the RIGHT EDGE of an attached
   * document's `@Title` token, that whole token goes and its chip with it, so a
   * half-broken `@Auth Desig` is unreachable by the ordinary gesture. It is still
   * a TEXT edit, so the document stays pooled and typing the title back re-attaches.
   * @param {number} caret
   * @returns {boolean} whether a token was deleted, and so whether the caller's
   *   keypress was consumed
   */
  detachAt(caret) {
    if (!this.#textarea) return false
    const pair = this.#pairs(this.#text()).find((p) => p.end === caret)
    if (!pair) return false
    this.#retain(pair.item)   // a text edit is not a refusal: undo re-attaches
    this.#drop(pair.item, pair)
    return true
  }

  /** Empties the set AND forgets the pool (after a send). */
  clear() {
    if (this.#known.length === 0 && this.#attached.length === 0) return
    this.#known = []
    this.#attached = []
    this.#render()
  }

  /**
   * RECONCILIATION: re-derives what is attached from the message as written, on
   * EVERY composer edit, so a chip never outlives its token. It re-derives rather
   * than prunes, so a token that comes BACK re-attaches from the pool. Pairing per
   * title rather than testing presence is what makes duplicate titles work.
   * @param {string} text the message as written
   * @returns {AttachmentEntry[]} the surviving manifest
   */
  reconcile(text) {
    this.#attached = this.#pairs(text || '').map((p) => p.item)
    this.#render()
    return this.manifest()
  }

  /**
   * Pairs each pooled attachment with the `@Title` token carrying it, walking the
   * pool in order and handing each the next unspoken-for token of its title. An
   * attachment with no token left is absent from the result, which is precisely
   * what "not attached" means. What IS a token is MentionTokens' rule.
   * @param {string} text
   * @returns {TokenPair[]}
   */
  #pairs(text) {
    /** @type {Map<string, number>} title → how many of its tokens are spoken for */
    const spent = new Map()
    /** @type {TokenPair[]} */ const pairs = []
    for (const item of this.#known) {
      const spans = MentionTokens.spans(text, item.title)
      const nth = spent.get(item.title) || 0
      spent.set(item.title, nth + 1)
      if (nth < spans.length) pairs.push({ item: item, start: spans[nth].start, end: spans[nth].end })
    }
    return pairs
  }

  /** @returns {string} the message as written ('' when headless) */
  #text() { return this.#textarea ? this.#textarea.value : '' }

  /**
   * Puts `item` at the BACK of the pool, adding it if new. Pool order is the order
   * `#pairs` hands out tokens, so touching an attachment sends it to the last
   * identical `@Notes` — which keeps duplicate titles honest: with the first token
   * deleted, the survivor pairs with the attachment the user did not touch.
   * @param {Attachment} item
   */
  #retain(item) {
    this.#known = this.#known.filter((a) => a.uri !== item.uri).concat([item])
  }

  /** Takes `item` off the chip row and cuts its token out of the message. The
   *  caller has already settled its fate in the POOL.
   *  @param {Attachment} item
   *  @param {{start: number, end: number}|null} span its token, if it still has one */
  #drop(item, span) {
    this.#attached = this.#attached.filter((a) => a.uri !== item.uri)
    this.#render()
    if (span) this.#cut(span.start, span.end)
  }

  /** Cuts `[start, end)` out of the message, taking ONE trailing space with it when
   *  the token sat in a gap — deleting a word must not leave the hole it was in.
   *  @param {number} start @param {number} end */
  #cut(start, end) {
    const textarea = this.#textarea
    if (!textarea) return
    const value = textarea.value
    // Only a horizontal space: a newline is structure the user typed, not a gap.
    const gapAfter = /[^\S\n\r]/.test(value.charAt(end))
    const gapBefore = start === 0 || /\s/.test(value.charAt(start - 1))
    const cutTo = gapAfter && gapBefore ? end + 1 : end
    this.#applyEdit(() => {
      textarea.value = value.slice(0, start) + value.slice(cutTo)
      textarea.focus()
      textarea.setSelectionRange(start, start)
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
  }

  /** Redraws the chip row from the view. */
  #render() {
    const row = this.#row
    if (!row) return
    row.innerHTML = ''
    row.style.display = this.#attached.length ? 'flex' : 'none'
    for (const item of this.#attached) row.appendChild(this.#chip(item))
  }

  /** One chip: the title, its detail as the tooltip (how two chips with the same
   *  title are told apart), and a ✕.
   *  @param {Attachment} item @returns {HTMLElement} */
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
    // mousedown is swallowed so clicking ✕ never pulls focus out of the composer,
    // which would fire the popover's blur dismissal.
    remove.addEventListener('mousedown', (e) => e.preventDefault())
    remove.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.remove(item.uri)
    })
    return chip
  }
}
