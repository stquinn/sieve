// @ts-check
// AiBlockRenderer — the ai-block kind's look-and-feel: the block shell, the
// status BADGE (its header), the question TITLE, the response/status BODY and
// the attachment chip row (its footer), plus this kind's stylesheet.
//
// THE QUESTION IS A LIST OF BLOCKS, folded once and read in three places, one
// per slot: what it is ABOUT becomes the chain of local handles on the root and
// has no entry of its own — pointing shows as the lineage affordances on the
// blocks it points at, never as a mark in the question; what it was HANDED
// becomes the footer chip row; and what it IS — the body, whatever kinds it is
// composed of — is handed to QuestionListView to draw. The fold is
// QuestionList's, so this class and Go's prompt assembly classify the same
// element the same way.
//
// buildBody() builds AND FILLS the body from bodyMarkdown(). In the editor lens
// the adapter claims the BODY region via handleBuild, so no #contentEl is
// recorded and the ref-guarded update() leaves the projected body to
// ProseMirror; the seam authors body content via FRESH scratch instances.

import { BlockRenderer } from './block-renderer.js'
import { aiBlockStyles } from './ai-block-renderer.styles.js'
import { isJobStale } from './job-status.js'
import { MentionTokens } from './mention-tokens.js'
import { ReferenceChip } from './reference-chip.js'
import { ReferenceRenderer } from './reference-renderer.js'
import { AddressState } from './address-status.js'
import { QuestionList } from './question-list.js'
import { QuestionListView } from './question-list-view.js'
import { registerBlockRenderer } from './block-kinds.js'

/** One attachment as this block shows it: the address is the truth, the title is
 *  what labels it. Nothing is resolved to build the prompt — the model is given
 *  the address and dereferences it itself (MCP `get_by_uri`) if it needs the
 *  contents.
 * @typedef {{ uri: string, title?: string }} AiBlockAttachment */

/** `question` is the ordered list of blocks the question is composed of. A
 *  standalone command's popup block carries the plain text it was asked with
 *  instead — it is a detached answer, not a question in a document — and reads
 *  as the one prose element it is.
 * @typedef {{ id?: string, ref?: string, type?: 'ASK'|'EXPLAIN'|'BTW', status?: string, createdAt?: string, question?: import('./question-list.js').QuestionElement[]|string, response?: string|null, error?: string|null, model?: string|null, supportsEmbedding?: boolean, attachments?: AiBlockAttachment[] }} AiBlockAttrs */

export class AiBlockRenderer extends BlockRenderer {
  static styles = aiBlockStyles
  static rootClass = 'sieve-ai-block ai-block'

  /** @type {HTMLElement|null} */ #badge = null
  /** @type {HTMLElement|null} */ #titleEl = null
  /** @type {HTMLElement|null} */ #contentEl = null
  /** @type {HTMLElement|null} the attachment chip row (the FOOTER region) */ #attachmentsEl = null
  /** @type {QuestionListView|null} draws the question; built with the title */ #questionView = null
  /** @type {any} the question the title currently shows */ #drawnQuestion = null
  /** @type {any} the attachments the title's mention marks were made from */ #drawnAttachments = null
  /** @type {any} the question #folded was folded from */ #foldedFrom = null
  /** @type {import('./question-list.js').QuestionSlots|null} */ #folded = null
  /** @type {Array<(uri: string) => void>} open-the-target listeners */ #openListeners = []
  /** @type {import('./address-status.js').AddressStatus|null} the oracle for
   *  "is that document still there?" (null → a chip never learns it is dangling) */ #addresses = null

  /** The status badge — this kind's HEADER region. Also stamps the kind's own
   *  data-ai-ref on the root (the base stamps data-id). @returns {HTMLElement} */
  buildHeader() {
    this.#syncRoot(this.block.payload)
    this.#badge = document.createElement('span')
    this.#badge.className = 'ai-block__badge'
    this.#badge.contentEditable = 'false'
    this.#renderBadge(this.block.payload)
    return this.#badge
  }

  /** The question TITLE — the question list (base stamps sieve-block__heading).
   *  @returns {HTMLElement} */
  buildTitle() {
    this.#titleEl = document.createElement('div')
    this.#titleEl.className = 'ai-block__question'
    this.#questionView = new QuestionListView(this._container)
    this.#fillQuestion(/** @type {AiBlockAttrs} */ (this.block.payload))
    return this.#titleEl
  }

  /** The response/status BODY, self-filled. In the editor lens the adapter
   *  claims this region via handleBuild, so this hook never runs there.
   *  @returns {HTMLElement} */
  buildBody() {
    this.#contentEl = document.createElement('div')
    this.#contentEl.className = 'sieve-block__content tiptap' // tiptap class for internal PM styling
    this.fillBody(this.#contentEl, this.bodyMarkdown())
    return this.#contentEl
  }

  /**
   * The ATTACHMENTS the question carried, as chips — the FOOTER region. The row
   * is built ALWAYS and hidden when empty, never conditionally returned: a
   * region that was never built cannot appear on the update() that brings them.
   * @returns {HTMLElement}
   */
  buildFooter() {
    this.#attachmentsEl = document.createElement('div')
    this.#attachmentsEl.className = 'ai-block__attachments'
    // setAttribute, not the IDL property: the ATTRIBUTE is what a DOM parser reads.
    this.#attachmentsEl.setAttribute('contenteditable', 'false')
    this.#fillAttachments(/** @type {AiBlockAttrs} */ (this.block.payload))
    return this.#attachmentsEl
  }

  /**
   * Registers interest in "the user clicked an attachment chip", handing back
   * the address. A renderer never opens a document itself.
   * @param {(uri: string) => void} fn
   * @returns {() => void} unsubscribe
   */
  onOpenAttachment(fn) {
    this.#openListeners.push(fn)
    return () => { this.#openListeners = this.#openListeners.filter((l) => l !== fn) }
  }

  /**
   * Supplies the oracle that says whether an attachment's target still exists —
   * a BUSINESS collaborator, not transport, and one per editor so a redraw costs
   * no round trip. Optional: a bare page renders the cached faces.
   * @param {import('./address-status.js').AddressStatus|null} addresses
   */
  probeAttachmentsWith(addresses) {
    this.#addresses = addresses || null
    // Redraw: the call site may come either side of render(), and the row guards on its own ref.
    this.#fillAttachments(/** @type {AiBlockAttrs} */ (this.block.payload))
  }

  /**
   * The markdown the BODY shows — response when complete, else a status line.
   * The renderer OWNS this mapping.
   * @returns {string}
   */
  bodyMarkdown() {
    const attrs = /** @type {AiBlockAttrs} */ (this.block.payload)
    const status = attrs.status || 'PENDING'
    if (status === 'COMPLETE') return (attrs.response || '').trim()
    if (status === 'PENDING' || status === 'DISPATCHED') {
      return isJobStale(attrs.createdAt, attrs.id) ? 'Request timed out. (Right-click to Retry)' : '*(thinking…)*'
    }
    return (attrs.error || 'Request failed. (Right-click to Retry)').trim()
  }

  /** @param {import('../contract/sieve-block.js').SieveBlock} block */
  update(block) {
    super.update(block)
    const attrs = /** @type {AiBlockAttrs} */ (block.payload)
    this.#syncRoot(attrs)
    this.#renderBadge(attrs)
    this.#fillQuestion(attrs)
    this.#fillAttachments(attrs)
    // Body patch is REF-GUARDED — a claimed body recorded no #contentEl.
    if (this.#contentEl) this.fillBody(this.#contentEl, this.bodyMarkdown())
  }

  /**
   * Draws the question AND marks the `@Title` tokens it attached, in that order:
   * the marking works on the RENDERED prose, so the rendering of the question is
   * untouched by it. Only the titles the block actually attached are marked, so
   * an email address or a stray `@` stays prose.
   *
   * A question with nothing to draw hides the region entirely — no title, no
   * divider.
   *
   * REDRAWN ONLY WHEN IT CHANGED. A question is settled at the moment it is
   * asked, while update() arrives on every edit anywhere in the document; the
   * guard is what keeps a keystroke from rebuilding every composed element.
   * @param {AiBlockAttrs} attrs
   */
  #fillQuestion(attrs) {
    const el = this.#titleEl
    const view = this.#questionView
    if (!el || !view) return
    if (attrs.question === this.#drawnQuestion && attrs.attachments === this.#drawnAttachments) return
    this.#drawnQuestion = attrs.question
    this.#drawnAttachments = attrs.attachments
    el.style.display = view.fill(el, this.#slots(attrs.question).body) ? '' : 'none'
    MentionTokens.mark(el, this.#attachmentsOf(attrs).map((a) => a && a.title), 'ai-block__mention')
  }

  /**
   * Redraws the chip row from the block. Empty → the row hides entirely, so a
   * block that attached nothing looks exactly as it did before attachments
   * existed.
   * @param {AiBlockAttrs} attrs
   */
  #fillAttachments(attrs) {
    const row = this.#attachmentsEl
    if (!row) return
    const list = this.#attachmentsOf(attrs)
    row.innerHTML = ''
    row.style.display = list.length ? 'flex' : 'none'
    for (const attachment of list) row.appendChild(this.#attachmentChip(attachment))
    this.#probeAttachments(list)
  }

  /**
   * Asks, ONCE per address, whether each chip's target is still there, and
   * redraws when an answer turns one dangling. Safe to call from a draw pass
   * precisely because AddressStatus caps a probe at one per address for the
   * editor's life. Only a DANGLING answer redraws — LIVE and UNKNOWN change no
   * pixel.
   * @param {AiBlockAttachment[]} list
   */
  #probeAttachments(list) {
    const addresses = this.#addresses
    if (!addresses) return
    for (const attachment of list) {
      const uri = (attachment && attachment.uri || '').trim()
      if (!uri || addresses.stateOf(uri) !== AddressState.UNKNOWN) continue
      addresses.check(uri).then((state) => {
        if (state !== AddressState.DANGLING) return
        this.#fillAttachments(/** @type {AiBlockAttrs} */ (this.block.payload))
      })
    }
  }

  /**
   * This turn's attachments — the documents the question was HANDED — as the
   * chip row and the mention marking both read them.
   *
   * They arrive from two places at once and are the union of both, so no arm
   * branches on which form a block is in: the question's attach-role elements,
   * and the flat `attachments` attr a standalone command's popup block carries.
   * A block in either form has nothing in the other.
   * @param {AiBlockAttrs} attrs
   * @returns {AiBlockAttachment[]}
   */
  #attachmentsOf(attrs) {
    const flat = Array.isArray(attrs.attachments) ? attrs.attachments : []
    return flat.concat(this.#slots(attrs.question).attachments.map((el) => ({
      uri: String((el.attrs && el.attrs.uri) || ''),
      title: ReferenceRenderer.faceOf(el.attrs).title,
    })))
  }

  /**
   * The question, folded — held against the question it was folded from, because
   * update() arrives on every edit anywhere in the document while the question a
   * block was asked with never changes again.
   * @param {any} question
   * @returns {import('./question-list.js').QuestionSlots}
   */
  #slots(question) {
    if (!this.#folded || question !== this.#foldedFrom) {
      this.#foldedFrom = question
      this.#folded = QuestionList.fold(question, this._container)
    }
    return this.#folded
  }

  /**
   * One chip, drawn by the SHARED component — what is ai-block's here is only
   * the MAPPING: which of this kind's fields is the label, and what makes one
   * dangling. DANGLING IS A NORMAL STATE, not an error: the chip greys, keeps
   * its cached title and stays clickable. An attachment with no cached face and
   * one whose face outlived its document are both "orphaned but readable", so
   * both wear that same chip.
   * @param {AiBlockAttachment} attachment
   * @returns {HTMLElement}
   */
  #attachmentChip(attachment) {
    const uri = (attachment && attachment.uri || '').trim()
    const title = (attachment && attachment.title || '').trim()
    const missing = !title || this.#isDangling(uri)
    const chip = new ReferenceChip({
      uri: uri,
      label: title,
      missing: missing,
      tooltip: missing ? 'Attached document is no longer available: ' + uri : uri,
    })
    chip.onActivate((address) => this.#openAttachment(address))
    return chip.element
  }

  /**
   * Has this coordinate been ANSWERED for, negatively? Unasked and unanswered
   * both read false — a chip is normal until Go says otherwise.
   * @param {string} uri
   * @returns {boolean}
   */
  #isDangling(uri) {
    return !!this.#addresses && this.#addresses.stateOf(uri) === AddressState.DANGLING
  }

  /** @param {string} uri */
  #openAttachment(uri) {
    if (!uri) return
    for (const fn of this.#openListeners) {
      try { fn(uri) } catch (e) { console.error('[ai-block] open-attachment listener threw', e) }
    }
  }

  /**
   * Stamps the CHAIN this block names — the handles inside this document that
   * its question is about, comma-separated. It is what the hover glow walks,
   * forwards from this block and backwards from a block it names, so it carries
   * only handles something local can light: a target in another container has
   * none and is drawn in the question instead.
   *
   * The generic `ref` edge is read alongside them: it is not the ai-block's own
   * vocabulary any more, but a block carrying one still names what it names.
   * @param {AiBlockAttrs} attrs
   */
  #syncRoot(attrs) {
    const dom = this.root
    if (!dom) return
    const chain = String(attrs.ref || '').split(',').map((token) => token.trim()).filter(Boolean)
    for (const target of this.#slots(attrs.question).targets) {
      const token = QuestionList.localToken(target, this._container)
      if (token && chain.indexOf(token) === -1) chain.push(token)
    }
    dom.setAttribute('data-ai-ref', chain.join(','))
  }

  /** @param {AiBlockAttrs} attrs */
  #renderBadge(attrs) {
    const badge = this.#badge
    if (!badge) return
    const status = attrs.status || 'PENDING'
    let cls = 'ai-block__badge'
    if (status === 'PENDING' || status === 'DISPATCHED') {
      cls += isJobStale(attrs.createdAt, attrs.id) ? ' ai-block__badge--error' : ' ai-block__badge--thinking'
    } else if (status !== 'COMPLETE') {
      cls += ' ai-block__badge--error'
    }
    badge.className = cls
    badge.textContent = attrs.type ? String(attrs.type) : 'ASK'
  }

  /** Releases the renderers the question list composed; this class owns no
   *  timers or observers of its own. */
  destroy() {
    if (this.#questionView) this.#questionView.destroy()
  }
}

registerBlockRenderer('ai-block', () => AiBlockRenderer)
