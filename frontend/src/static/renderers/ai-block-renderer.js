// @ts-check
// AiBlockRenderer — the ai-block kind's look-and-feel: the block shell, the
// status BADGE (its header), the question TITLE, the response/status BODY and
// the attachment chip row (its footer), plus this kind's stylesheet.
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
import { AddressState } from './address-status.js'

/** One attachment as it is persisted: the address is the truth, the title is
 *  what labels it. Nothing is resolved to build the prompt — the model is given
 *  the address and dereferences it itself (MCP `get_by_uri`) if it needs the
 *  contents.
 * @typedef {{ uri: string, title?: string }} AiBlockAttachment */

/** @typedef {{ id?: string, ref?: string, type?: 'ASK'|'EXPLAIN'|'BTW', status?: string, createdAt?: string, question?: string, response?: string|null, error?: string|null, model?: string|null, supportsEmbedding?: boolean, attachments?: AiBlockAttachment[] }} AiBlockAttrs */

export class AiBlockRenderer extends BlockRenderer {
  static styles = aiBlockStyles
  static rootClass = 'sieve-ai-block ai-block'

  /** @type {HTMLElement|null} */ #badge = null
  /** @type {HTMLElement|null} */ #titleEl = null
  /** @type {HTMLElement|null} */ #contentEl = null
  /** @type {HTMLElement|null} the attachment chip row (the FOOTER region) */ #attachmentsEl = null
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

  /** The question TITLE (base stamps sieve-block__heading + hides when empty). @returns {HTMLElement} */
  buildTitle() {
    this.#titleEl = document.createElement('div')
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
   * Renders the question AND marks the `@Title` tokens it attached, in that
   * order: the marking works on the RENDERED prose, so the markdown rendering of
   * the question is untouched by it. Only the titles the block actually attached
   * are marked, so an email address or a stray `@` stays prose.
   * @param {AiBlockAttrs} attrs
   */
  #fillQuestion(attrs) {
    const el = this.#titleEl
    if (!el) return
    this.fillTitleSlot(el, attrs.question)
    MentionTokens.mark(el, AiBlockRenderer.#attachmentsOf(attrs).map((a) => a && a.title), 'ai-block__mention')
  }

  /**
   * Redraws the chip row from the block. Empty → the row hides entirely, so a
   * block that attached nothing looks exactly as it did before the attr existed.
   * @param {AiBlockAttrs} attrs
   */
  #fillAttachments(attrs) {
    const row = this.#attachmentsEl
    if (!row) return
    const list = AiBlockRenderer.#attachmentsOf(attrs)
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
   * This turn's attachments, tolerantly: an absent or malformed attr is the
   * empty list. The one place the attr's shape is trusted.
   * @param {AiBlockAttrs} attrs
   * @returns {AiBlockAttachment[]}
   */
  static #attachmentsOf(attrs) {
    return Array.isArray(attrs.attachments) ? attrs.attachments : []
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

  /** @param {AiBlockAttrs} attrs */
  #syncRoot(attrs) {
    const dom = this.root
    if (!dom) return
    dom.setAttribute('data-ai-ref', attrs.ref || 'doc')
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

  // destroy(): base no-op is correct — this class owns no timers/observers.
}
