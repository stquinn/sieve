// @ts-check
// composer-attachments.js — ComposerAttachments: what the Ask composer has
// attached to the message being written, and the chip row that shows it (#74 P4).
//
// NO NEW ROW. The chips live in the EXISTING `.ask-popup__footer` (index.html),
// whose whole contract is a chip region on the left and Send on the right (the
// Enter/Shift+Enter chord is said in the composer's placeholder, not down here).
// Overflow scrolls horizontally rather than growing the panel — the footer's
// height feeds ui/layout.js's askPanelMinHeight, so a wrapping chip row would
// push the composer's minimum height around.
//
// THE MODEL AND ITS CHIPS ARE ONE TYPE. The chips ARE this data drawn — there is
// no second object that could disagree with it, and every mutation re-renders
// from the list rather than patching the DOM in parallel.
//
// URI IS IDENTITY, TITLE IS AN ECHO. Two library notes may both be called
// "Notes": they are two attachments with two addresses and one text token each.
// So dedupe is by uri, and reconciliation PAIRS tokens to attachments per title
// rather than asking "is this title present" — deleting one of two `@Notes`
// tokens drops exactly one attachment.
//
// THE CHIP IS A VIEW OF THE TOKENS IN THE MESSAGE; THE TEXT IS WHAT YOU EDIT
// (#74 P6). Reconciliation used to run only at SEND, so a chip could go on
// claiming "attached" over a token the user had already broken and the
// attachment was then dropped silently, with no answer and no explanation. Two
// halves fix that:
//
//   • the pool and the view are separate. `#known` is every candidate accepted
//     since the composer was last cleared; `#attached` is the subset a `@Title`
//     token currently carries — the chips, and what send carries. Reconciling
//     RE-DERIVES the second from the first, so a token that comes back (undo, a
//     retyped title) re-attaches instead of being lost for ever;
//   • the INVARIANT is one-way: a chip implies a token, a token does not imply a
//     chip. `@Auth Design` typed as prose and never accepted is just prose — but
//     a chip can never outlive its token, which is exactly the silent drop.
//
// THE ✕ FORGETS; EDITING THE TEXT DOES NOT. Both gestures take the chip and its
// token, and they differ only in INTENT — which is the whole difference. The ✕
// says "I do not want this attached", so its document leaves `#known` and
// writing that title again is ordinary prose; a text edit says "I am editing my
// sentence", so its document stays pooled and the token coming back (Ctrl+Z, a
// retype) re-attaches it. Forgetting is by URI, never by title: with two "Notes"
// attached, ✕ on one leaves the other's token resolving to the other document.
//
// DETACHING DEMOTES. An attachment the text lost moves to the BACK of the pool
// before the pairing is redone, so a remaining identical `@Notes` pairs with the
// attachment the user did not touch rather than sliding onto the deleted one's
// chip.
//
// THE CHIP IS THE SHARED VOCABULARY, DRAWN LOCALLY. A block draws it with the
// AttachmentChip component; the composer cannot — it is not a block, so it
// carries no block styles. The `--chip-*` TOKENS are what unify the two instead
// (editor.css `:root`), so change what a chip looks like in the tokens, never in
// one of the two components.

import { esc } from '../renderers/html-escape.js'
// The token rule is SHARED with the ai-block, which marks the same `@Title`
// tokens in the question it renders (#74). Two copies of "what counts as a
// mention" would let a chip and its inline mark describe different text.
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
   *  undone deletion re-attach instead of being lost. */ #known = []
  /** @type {Attachment[]} THE VIEW: the subset a `@Title` token carries right
   *  now. The chips, and what send carries. */ #attached = []
  /** @type {HTMLElement|null} the chip row (null → headless: model-only, all verbs still work) */ #row = null
  /** @type {HTMLTextAreaElement|null} the composer whose text is the truth (null
   *  → model-only: the token verbs no-op, the chip verbs still work) */ #textarea = null
  /** @type {(edit: () => void) => void} runs a programmatic composer edit */ #applyEdit

  /**
   * @param {HTMLElement|null} footerEl the structural `.ask-popup__footer`. The
   *   row is CREATED here (the panel's own DOM is never rebuilt) and inserted
   *   before Send, which stays the footer's last child.
   * @param {HTMLTextAreaElement|null} [textarea] the composer. The tokens live in
   *   it, so every verb that removes an attachment removes its text too.
   * @param {((edit: () => void) => void)|null} [applyEdit] how to perform a
   *   programmatic edit of that text. The panel passes the picker's own-edit
   *   gate, so the `input` such an edit fires is understood as OURS and does not
   *   reopen the picker on what was just deleted. Defaults to plain application.
   */
  constructor(footerEl, textarea = null, applyEdit = null) {
    this.#textarea = textarea || null
    this.#applyEdit = applyEdit || ((edit) => edit())
    if (!footerEl) return
    const row = document.createElement('div')
    row.className = 'ask-popup__chips'
    // Send is the anchor, not the first child: TargetChips draws its own row into
    // this same footer, and inserting at the front would put a row built LATER
    // ahead of one built earlier. insertBefore(null) appends, so a footer with no
    // Send still works.
    footerEl.insertBefore(row, footerEl.querySelector('.ask-popup__send'))
    this.#row = row
    this.#render()
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  /** @returns {number} how many documents are attached */
  get size() { return this.#attached.length }

  /**
   * The persisted shape: `{uri, title}` and nothing else.
   *
   * NOTHING is resolved on the way to the model — the prompt's manifest is
   * rendered from these two fields alone. So anything richer a chip is holding
   * (`kind`, `detail`, a summary) is picker dressing that must not reach
   * storage, where it could only ever go stale.
   * @returns {AttachmentEntry[]}
   */
  manifest() {
    return this.#attached.map((a) => ({ uri: a.uri, title: a.title }))
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  /**
   * Attaches a picked candidate. Idempotent while it IS attached — attaching the
   * same document twice adds no context, so the second accept is a no-op (its
   * `@Title` echo still lands in the text, which is the user's business). A
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
    // order the user sees are the same order.
    this.#retain(item)
    this.#attached = this.#attached.concat([item])
    this.#render()
    return true
  }

  /**
   * Detaches by address — the ✕ on a chip. It removes the `@Title` echo from the
   * message as well: leaving the token behind is the same chip/text disagreement
   * as a stale chip, just pointing the other way.
   *
   * And it FORGETS the document. The ✕ is an explicit refusal, so it must be
   * final: were the document left pooled, writing its title again later — `as
   * @Auth Design says…` — would silently re-attach what the user had removed.
   * Accepting it from the picker again is how it comes back.
   * @param {string} uri
   */
  remove(uri) {
    // The pool is the superset, so looking there finds an attachment whether it
    // is currently attached or not. Pair BEFORE forgetting: #pairs walks #known.
    const item = this.#known.find((a) => a.uri === uri)
    if (!item) return
    const pair = this.#pairs(this.#text()).find((p) => p.item.uri === uri) || null
    this.#known = this.#known.filter((a) => a.uri !== uri)
    this.#drop(item, pair)
  }

  /**
   * ATOMIC TOKEN DELETION. If `caret` sits at the RIGHT EDGE of an attached
   * document's `@Title` token, that whole token — not one character of it — goes,
   * and its chip with it. This is what makes the half-broken `@Auth Desig` state
   * unreachable by the ordinary gesture.
   *
   * It is still a TEXT edit, so the document stays pooled and typing the title
   * back re-attaches it — that is what lets undo restore the chip.
   * @param {number} caret
   * @returns {boolean} whether a token was deleted (i.e. whether the caller's
   *   keypress was consumed)
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
   * RECONCILIATION: re-derives what is attached from the message as written. Runs
   * on EVERY composer edit, not just at send — a chip that outlives its token is
   * the whole defect, and a send is far too late to discover it.
   *
   * It re-derives rather than prunes, so a token that comes BACK (undo, a retyped
   * title) re-attaches from the pool. Pairing per title (rather than testing
   * presence) is what makes duplicate titles work: two "Notes" attachments
   * survive two `@Notes` tokens, and exactly one survives one.
   * @param {string} text the message as written
   * @returns {AttachmentEntry[]} the surviving manifest
   */
  reconcile(text) {
    this.#attached = this.#pairs(text || '').map((p) => p.item)
    this.#render()
    return this.manifest()
  }

  // ── Tokens ─────────────────────────────────────────────────────────────────

  /**
   * Pairs each pooled attachment with the `@Title` token carrying it, walking the
   * pool in order and handing each attachment the next unspoken-for token of its
   * title. An attachment with no token left is simply absent from the result —
   * which is precisely what "not attached" means. What IS a token is
   * MentionTokens' rule: at the start or after whitespace, so "mail me@Auth
   * Design" is an address.
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
   * Puts `item` at the BACK of the pool, adding it if it is new. Pool order is
   * the order `#pairs` hands out tokens, so touching an attachment sends it to
   * the last identical `@Notes` — which is what keeps duplicate titles honest:
   * with the first token deleted, the survivor must pair with the attachment the
   * user did not touch.
   * @param {Attachment} item
   */
  #retain(item) {
    this.#known = this.#known.filter((a) => a.uri !== item.uri).concat([item])
  }

  /**
   * Takes `item` off the chip row and cuts its token out of the message. The
   * caller has already settled its fate in the POOL — retained or forgotten is
   * the only thing the two removal gestures disagree about.
   * @param {Attachment} item
   * @param {{start: number, end: number}|null} span its token, if it still has one
   */
  #drop(item, span) {
    this.#attached = this.#attached.filter((a) => a.uri !== item.uri)
    this.#render()
    if (span) this.#cut(span.start, span.end)
  }

  /**
   * Cuts `[start, end)` out of the message, taking ONE trailing space with it
   * when the token was sitting in a gap — deleting a word must not leave the hole
   * it was in. The caret lands where the token began, as it would after any
   * deletion.
   * @param {number} start @param {number} end
   */
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

  // ── Render ─────────────────────────────────────────────────────────────────

  /** Redraws the chip row from the view. */
  #render() {
    const row = this.#row
    if (!row) return
    row.innerHTML = ''
    row.style.display = this.#attached.length ? 'flex' : 'none'
    for (const item of this.#attached) row.appendChild(this.#chip(item))
  }

  /**
   * One chip: the document's title, its detail as the tooltip (how two chips
   * with the same title are told apart), and a ✕.
   * @param {Attachment} item
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
