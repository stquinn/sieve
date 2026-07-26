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

/** @typedef {{ id?: string, ref?: string, type?: 'ASK'|'EXPLAIN', status?: string, createdAt?: string, question?: string, response?: string|null, error?: string|null, model?: string|null, supportsEmbedding?: boolean }} AiBlockAttrs */

export class AiBlockRenderer extends BlockRenderer {
  static styles = aiBlockStyles
  static rootClass = 'sieve-ai-block ai-block'

  /** @type {HTMLElement|null} */ #badge = null
  /** @type {HTMLElement|null} */ #titleEl = null
  /** @type {HTMLElement|null} */ #contentEl = null

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
    this.fillTitleSlot(this.#titleEl, /** @type {AiBlockAttrs} */ (this.block.payload).question)
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
    if (this.#titleEl) this.fillTitleSlot(this.#titleEl, attrs.question)
    // Body patch is REF-GUARDED — a claimed (externally managed) body recorded
    // no #contentEl, so PM's body is left alone with no update() override needed.
    if (this.#contentEl) this.fillBody(this.#contentEl, this.bodyMarkdown())
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
    badge.textContent = (attrs.type === 'EXPLAIN' || attrs.type === 'BTW') ? attrs.type : 'ASK'
  }

  // destroy(): base no-op is correct — this class owns no timers/observers.
}
