// @ts-check
// ai-block-renderer.js — AiBlockRenderer: the renderer half of the ai-block
// kind's renderer/NodeView split (docs/design/archive/specs/2026-07-20-block-renderer-extraction.md,
// Phase 3 / issue #46). Owns look-and-feel: the block shell, the status BADGE
// (its header — the A7 status state machine), the question TITLE, and the
// response/status BODY, plus this kind's stylesheet (`static styles`). Zero
// ProseMirror/editor/window.* dependencies — mounts identically in the note
// editor's NodeView adapter (editor/surfaces/node-views/ai-block-node-view.js, by composition),
// a chat turn, or the bare-page harness.
//
// This class is PURE and lens-blind (NORMATIVE contract:
// docs/design/archive/specs/2026-07-21-block-renderer-contract.md): buildBody() builds
// AND FILLS the body from bodyMarkdown() (sanctioned markdown), and update()
// re-fills it — guarded on the #contentEl ref it recorded. In the editor lens
// the adapter claims the BODY region via the handleBuild interceptor, so no
// #contentEl is recorded and the ref-guarded update() naturally leaves the
// projected body to ProseMirror; the seam authors body content via FRESH
// scratch instances of this class (chain of custody). The badge + question
// title still render renderer-side in every lens. Chain-glow hover and the
// read-only guard plugin stay adapter-side (PM/cross-block).

import { BlockRenderer } from './block-renderer.js'
import { aiBlockStyles } from './ai-block-renderer.styles.js'
import { isJobStale } from './job-status.js'
import { esc } from './html-escape.js'
import { MentionTokens } from './mention-tokens.js'

/** One attachment as it is persisted (#74): the address is the truth and the
 *  title is what labels it. Nothing else is stored, and nothing is resolved to
 *  build the prompt — the model is given the address and dereferences it itself
 *  (MCP `get_by_uri`) if it decides it needs the contents.
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
   * The ATTACHMENTS the question carried, as chips — the FOOTER region, and its
   * first consumer. Same place the composer puts them, so a question as it was
   * sent and the answer that came back read alike.
   *
   * The row is built ALWAYS and hidden when empty, rather than conditionally
   * returned: a block created before its server truth arrives has no attachments
   * yet, and a region that was never built cannot appear on the update() that
   * brings them.
   * @returns {HTMLElement}
   */
  buildFooter() {
    this.#attachmentsEl = document.createElement('div')
    this.#attachmentsEl.className = 'ai-block__attachments'
    // setAttribute, not the IDL property: the ATTRIBUTE is what ProseMirror's
    // DOM parser and the read-only guard read (and what jsdom reflects).
    this.#attachmentsEl.setAttribute('contenteditable', 'false')
    this.#fillAttachments(/** @type {AiBlockAttrs} */ (this.block.payload))
    return this.#attachmentsEl
  }

  /**
   * Registers interest in "the user clicked an attachment chip", handing back the
   * address. A renderer never opens a document itself — it is lens-blind and has
   * no idea what a workspace is; the NodeView adapter that holds it does.
   * @param {(uri: string) => void} fn
   * @returns {() => void} unsubscribe
   */
  onOpenAttachment(fn) {
    this.#openListeners.push(fn)
    return () => { this.#openListeners = this.#openListeners.filter((l) => l !== fn) }
  }

  /**
   * The markdown the BODY shows — response when complete, else a status line —
   * derived from THIS instance's envelope. The renderer OWNS this mapping; the
   * editor-lens seam reads it from a FRESH scratch instance per pass (contract
   * chain of custody) and parses it into PM.
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

  /** @param {import('../sieve-block.js').SieveBlock} block */
  update(block) {
    super.update(block)
    const attrs = /** @type {AiBlockAttrs} */ (block.payload)
    this.#syncRoot(attrs)
    this.#renderBadge(attrs)
    this.#fillQuestion(attrs)
    this.#fillAttachments(attrs)
    // Body patch is REF-GUARDED — a claimed (externally managed) body recorded
    // no #contentEl, so PM's body is left alone with no update() override needed.
    if (this.#contentEl) this.fillBody(this.#contentEl, this.bodyMarkdown())
  }

  /**
   * Renders the question AND marks the `@Title` tokens it attached, in that
   * order: the marking works on the RENDERED prose, so the markdown rendering of
   * the question is untouched by it. The literal `@Auth Design` reading in the
   * accent its footer chip carries is what says "that name in the sentence and
   * that chip are one object" — and only the titles the block actually attached
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
   * Redraws the chip row from the envelope. Empty → the row hides entirely, so a
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
   * One chip. DANGLING IS A NORMAL STATE, not an error: an attachment whose
   * cached title is gone (nothing was ever cached, or the persisted entry
   * predates titles) renders greyed with a missing marker and the bare address,
   * so the chip is still identifiable and still clickable.
   * @param {AiBlockAttachment} attachment
   * @returns {HTMLElement}
   */
  #attachmentChip(attachment) {
    const uri = (attachment && attachment.uri || '').trim()
    const title = (attachment && attachment.title || '').trim()
    const missing = !title

    const chip = document.createElement('span')
    chip.className = 'ai-block__attachment' + (missing ? ' ai-block__attachment--missing' : '')
    chip.setAttribute('data-uri', uri)
    chip.setAttribute('title', missing ? 'Attached document is no longer available: ' + uri : uri)
    chip.innerHTML =
      '<span class="ai-block__attachment-icon" aria-hidden="true">' + (missing ? '&#9888;' : '&#128196;') + '</span>' +
      '<span class="ai-block__attachment-label">' + esc(title || uri) + '</span>'

    chip.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.#openAttachment(uri)
    })
    // The block is a read-only container; a chip must never start a drag/selection.
    chip.addEventListener('mousedown', (e) => e.preventDefault())
    return chip
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
