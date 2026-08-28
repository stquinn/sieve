// @ts-check
// What the Ask composer has attached to the message being written, and the chip
// row that shows it. The chips live in `.ask-popup__footer`, left of Send, and
// overflow scrolls horizontally rather than growing the panel, because the
// footer's height feeds ui/layout.js's askPanelMinHeight.
//
// THE ATTACHMENT IS A BLOCK IN THE DRAFT. Accepting a `@` candidate mints ONE
// reference element declaring `attach` into the draft container, and that
// element is the truth: the chip and the `@Title` mark are its two renderings,
// and the harvest reads it straight out of the draft. Nothing here keeps a
// second list.
//
// URI IS IDENTITY, TITLE IS AN ECHO. Two library notes may both be called "Notes".
// Dedupe is by uri, and reconciliation PAIRS tokens to elements per title rather
// than asking "is this title present", so deleting one of two `@Notes` tokens
// drops exactly one.
//
// THE CHIP IS A VIEW OF THE TOKENS IN THE MESSAGE; THE TEXT IS WHAT YOU EDIT.
// The draft's elements are the POOL — every candidate accepted into this draft;
// `#attached` is the subset a `@Title` token currently carries. Reconciling
// RE-DERIVES the second from the first, so a token that comes back re-attaches.
// The invariant is one-way: a chip implies a token, a token does not imply a chip.
//
// THE ✕ FORGETS; EDITING THE TEXT DOES NOT. ✕ means "I do not want this
// attached", so its element leaves the draft; a text edit means "I am editing my
// sentence", so the element stays and the chip alone goes. `commit()` settles
// the difference at send. Forgetting is by URI, never by title.
//
// THE POOL IS CONTAINER-ORDERED, and that order is what `#pairs` hands tokens
// out in: accepting a second `@Notes` re-mints it at the back, so it pairs with
// the second token rather than stealing the first one's.

import { esc } from '../renderers/html-escape.js'
// The token rule is SHARED with the ai-block, which marks the same `@Title`
// tokens in the question it renders. Two copies of "what counts as a mention"
// would let a chip and its inline mark describe different text.
import { MentionTokens } from '../renderers/mention-tokens.js'
// The element vocabulary is the QUESTION's, minted and read through the one
// definition of it, so what the draft holds is what the wire carries.
import { QuestionList } from '../renderers/question-list.js'
import { Ident } from '../ident/ident.js'

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
 * One attachment as this type holds it: the entry, plus the draft block
 * carrying it — the handle every removal goes through.
 * @typedef {object} Attachment
 * @property {string} id
 * @property {string} uri
 * @property {string} title
 */

/**
 * The draft this row is a view OF: the message as flat text — the coordinate
 * space the `@Title` tokens live in — and the container the attachments are
 * blocks in. Read as a live handle, never captured: a retired draft hands out a
 * different container.
 * @typedef {object} ComposerDraft
 * @property {() => string} read
 * @property {(start: number, end: number) => void} cut
 * @property {any} provider
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
  /** @type {Attachment[]} THE VIEW: the subset a `@Title` token carries right
   *  now. The chips, and what send carries. */ #attached = []
  /** @type {HTMLElement|null} the chip row (null → headless: model-only, all verbs still work) */ #row = null
  /** @type {ComposerDraft|null} the draft the elements and their tokens both
   *  live in (null → model-only: the chip verbs still work, and nothing attaches) */ #draft = null

  /**
   * @param {HTMLElement|null} footerEl the structural `.ask-popup__footer`. The
   *   row is CREATED here and inserted before Send, which stays the last child.
   * @param {ComposerDraft|null} [draft] the message being written. Both halves of
   *   an attachment live in it, so every verb reaches through it.
   */
  constructor(footerEl, draft = null) {
    this.#draft = draft || null
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

  /** The persisted shape: `{uri, title}` and nothing else.
   *  @returns {AttachmentEntry[]} */
  manifest() {
    return this.#attached.map((a) => ({ uri: a.uri, title: a.title }))
  }

  /** The attached titles — what a `@Title` token in the message names, and so
   *  what the draft marks. Titleless attachments contribute nothing: there is no
   *  token to find for one. @returns {string[]} */
  titles() {
    return this.#attached.map((a) => a.title).filter(Boolean)
  }

  /**
   * Attaches a picked candidate, by minting its reference element into the
   * draft. Idempotent while it IS attached, so a second accept is a no-op —
   * though its `@Title` echo still lands in the text. A document whose token was
   * deleted is NOT attached, so accepting it again genuinely re-attaches, and
   * its element is re-minted at the back of the draft.
   * @param {MentionCandidate|null} candidate
   * @returns {boolean} whether it was added
   */
  add(candidate) {
    const uri = (candidate && candidate.uri || '').trim()
    if (!uri) return false                                  // no address = not an attachment
    if (this.#attached.some((a) => a.uri === uri)) return false
    const item = this.#mint(uri, (candidate && candidate.title || '').trim())
    if (!item) return false                                 // no draft to attach to
    this.#attached = this.#attached.concat([item])
    this.#render()
    return true
  }

  /** Detaches by address — the ✕ on a chip. It removes the `@Title` echo too, and
   *  it takes the ELEMENT out of the draft: one left there would silently
   *  re-attach when its title was written again. @param {string} uri */
  remove(uri) {
    // The pool is the superset, so this finds an attachment whether attached or
    // not. Pair BEFORE removing: #pairs walks the pool.
    const item = this.#pool().find((a) => a.uri === uri)
    if (!item) return
    const pair = this.#pairs(this.#text()).find((p) => p.item.uri === uri) || null
    this.#discard(item)
    this.#attached = this.#attached.filter((a) => a.uri !== uri)
    this.#render()
    if (pair) this.#cut(pair.start, pair.end)
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
   * SETTLES THE DRAFT, at send: reconciles, then takes every element whose
   * `@Title` token is gone out of the draft — deleting the text is a legitimate
   * way to detach, and the harvest that follows reads the draft. What the chips
   * show is what travels.
   * @returns {AttachmentEntry[]} the manifest that survived
   */
  commit() {
    const kept = this.reconcile(this.#text())
    for (const item of this.#pool()) {
      if (!kept.some((k) => k.uri === item.uri)) this.#discard(item)
    }
    return kept
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
    for (const item of this.#pool()) {
      const spans = MentionTokens.spans(text, item.title)
      const nth = spent.get(item.title) || 0
      spent.set(item.title, nth + 1)
      if (nth < spans.length) pairs.push({ item: item, start: spans[nth].start, end: spans[nth].end })
    }
    return pairs
  }

  /** THE POOL: the draft's attach-rel reference blocks, in container order —
   *  every candidate accepted into this draft, read afresh so a retired draft
   *  leaves nothing behind. @returns {Attachment[]} */
  #pool() {
    const provider = this.#provider()
    if (!provider) return []
    /** @type {Attachment[]} */ const items = []
    for (const id of provider.getOrder()) {
      const node = provider.getBlock(id)
      const entry = QuestionList.attachmentOf(node)
      if (entry) items.push({ id: node.id, uri: entry.uri, title: entry.title })
    }
    return items
  }

  /** Mints `uri`'s element at the BACK of the draft. Pool order is the order
   *  `#pairs` hands out tokens, so a document accepted again is re-minted rather
   *  than left where it was, and pairs with the token just written for it.
   *  @param {string} uri @param {string} title @returns {Attachment|null} */
  #mint(uri, title) {
    const provider = this.#provider()
    const element = QuestionList.attachment(uri, title)
    if (!provider || !element) return null
    const held = this.#pool().find((a) => a.uri === uri)
    if (held) provider.requestRemoveBlock(held.id)
    const id = Ident.mint()
    provider.requestAddBlock(element.kind, Object.assign({ id: id }, element.attrs))
    return { id: id, uri: uri, title: title }
  }

  /** Takes one attachment's element out of the draft. @param {Attachment} item */
  #discard(item) {
    const provider = this.#provider()
    if (provider) provider.requestRemoveBlock(item.id)
  }

  /** @returns {any} the live draft container (null when headless) */
  #provider() { return (this.#draft && this.#draft.provider) || null }

  /** @returns {string} the message as written ('' when headless) */
  #text() { return this.#draft ? this.#draft.read() : '' }

  /** Cuts `[start, end)` out of the message, taking ONE trailing space with it when
   *  the token sat in a gap — deleting a word must not leave the hole it was in.
   *  @param {number} start @param {number} end */
  #cut(start, end) {
    const draft = this.#draft
    if (!draft) return
    const value = draft.read()
    // Only a horizontal space: a newline is structure the user typed, not a gap.
    const gapAfter = /[^\S\n\r]/.test(value.charAt(end))
    const gapBefore = start === 0 || /\s/.test(value.charAt(start - 1))
    draft.cut(start, gapAfter && gapBefore ? end + 1 : end)
  }

  /** Redraws the chip row from the view. */
  #render() {
    const row = this.#row
    if (!row) return
    row.innerHTML = ''
    row.style.display = this.#attached.length ? 'flex' : 'none'
    for (const item of this.#attached) row.appendChild(this.#chip(item))
  }

  /** One chip: the title, its ADDRESS as the tooltip (identity, and how two
   *  chips with the same title are told apart), and a ✕.
   *  @param {Attachment} item @returns {HTMLElement} */
  #chip(item) {
    const chip = document.createElement('span')
    chip.className = 'ask-chip'
    chip.setAttribute('data-uri', item.uri)
    chip.setAttribute('title', item.uri)
    chip.innerHTML =
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
