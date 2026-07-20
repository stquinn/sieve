// @ts-check
// ai-block-renderer.js — AiBlockRenderer: the renderer half of the ai-block
// kind's renderer/NodeView split (docs/design/specs/2026-07-20-block-renderer-extraction.md,
// Phase 3 / issue #46). Owns look-and-feel ONLY: the block shell, the status
// badge (attrs → CSS class + text — the "status badge state machine" the
// migration survey calls A7), and this kind's complete stylesheet (`static
// styles`). Zero ProseMirror/editor/window.* app-global dependencies — this
// class mounts identically in the note editor's NodeView adapter
// (frontend/src/static/processors/ai-block-renderer.js, which HOLDS an
// instance of this class by composition, never inheritance), a bare-page
// harness, or any future non-PM lens (chat turn, embedded card).
//
// What this class deliberately does NOT own, and why — the PM-specificity
// sorting test (docs/design/specs/2026-07-20-block-renderer-extraction.md,
// "The sorting test is PM-specificity"):
//   - The question TITLE and response/status BODY are never built as DOM by
//     this class. Unlike the diagram pilot (where the renderer owns the whole
//     visible surface), an ai-block's title/content are rendered as LIVE
//     ProseMirror nodes inside contentDOM by sieve-block-extension.js's
//     framework-owned titleProvider/contentProvider seam (PMDOMParser.parseSlice
//     + a tracked PM transaction) — that is unavoidably PM-coupled (schema,
//     transactions, selection) and stays adapter/framework-side. The adapter
//     declares `titleProvider: 'question'` / `contentProvider: fn` on its
//     registered descriptor; this class only builds the EMPTY contentDOM
//     container the framework seam fills.
//   - Chain-glow hover (gatherChain/applyChain, cross-block
//     `document.querySelectorAll('[data-ai-ref]')` walking, and the PM
//     decoration for native prose peers via ai-target-decoration.js) is
//     CROSS-BLOCK behaviour, not this block's own look-and-feel — it stays
//     adapter-side (framework-layer material for the future X-D framework
//     extraction), even though the CSS this class carries (`.ai-block--chain-active`)
//     is what that adapter-side class-toggle makes visible.
//   - The read-only-container guard plugin (isInsideAiBlock +
//     handleTextInput/KeyDown/Paste/Drop) speaks PM plugin props directly —
//     adapter-side, per the sorting test.
//
// Restraint (P4 note): the badge state-machine here (attrs.status +
// isJobStale → CSS class) is survey item A7; it gets a shared home only when
// a SECOND migrated kind needs the identical mapping — not hoisted into
// BlockRenderer speculatively now.

import { BlockRenderer } from './block-renderer.js'
import { aiBlockStyles } from './ai-block-renderer.styles.js'
import { isJobStale } from '../../base/fenced-block-base.js'

// The adapter passes the FULL node.attrs object (not a filtered subset) — the
// same shape declared on the adapter descriptor's `attrs` (question/response/
// model/error included), since sieve-block-extension.js's title/content seam
// reads question/response off the very same attrs this renderer receives.
// This class only reads id/ref/type/status/createdAt; the rest pass through
// unused, which is why they are typed optional/unknown rather than omitted.
/** @typedef {{ id?: string, ref?: string, type?: 'ASK'|'EXPLAIN', status?: string, createdAt?: string, question?: string, response?: string|null, error?: string|null, model?: string|null, supportsEmbedding?: boolean }} AiBlockAttrs */

export class AiBlockRenderer extends BlockRenderer {
  // Sheet lives in the sibling ai-block-renderer.styles.js — styles-file-geography
  // convention: a renderer file starts with its class, never a CSS wall.
  static styles = aiBlockStyles

  /** @type {HTMLElement|null} */ #badge = null
  /** @type {HTMLElement|null} */ #contentDOM = null

  /** The live ProseMirror contentDOM the adapter binds as its NodeView's
   *  contentDOM — this class builds the empty container; the framework's
   *  titleProvider/contentProvider seam (sieve-block-extension.js) fills it
   *  with real PM nodes, never this class. @returns {HTMLElement|null} */
  get contentDOM() { return this.#contentDOM }

  /** @param {AiBlockAttrs} attrs @returns {HTMLElement} */
  mount(attrs) {
    const dom = document.createElement('div')
    dom.className = 'sieve-ai-block ai-block'

    const badge = document.createElement('span')
    badge.className = 'ai-block__badge'
    badge.contentEditable = 'false'

    // contentDOM holds the WHOLE composed body (question heading + divider +
    // response or status line) as real PM nodes — filled by the framework
    // seam, never by this class (see file header).
    const contentDOM = document.createElement('div')
    contentDOM.className = 'sieve-block__content tiptap' // tiptap class for internal PM styling

    dom.appendChild(badge)
    dom.appendChild(contentDOM)

    this.#badge = badge
    this.#contentDOM = contentDOM
    this.update(dom, attrs)
    return dom
  }

  /**
   * Patches the badge visuals and the chain-glow data attributes for changed
   * attrs. render maintains only the badge (the visual status indicator) and
   * the data attributes the adapter-side chain-glow reads — the textual
   * content (question/response/status line) is the framework seam's job.
   * @param {HTMLElement} dom
   * @param {AiBlockAttrs} attrs
   */
  update(dom, attrs) {
    dom.setAttribute('data-id', attrs.id || '')
    dom.setAttribute('data-ai-ref', attrs.ref || 'doc')

    const badge = this.#badge
    if (!badge) return
    const status = attrs.status || 'PENDING'
    let cls = 'ai-block__badge'
    if (status === 'PENDING' || status === 'DISPATCHED') {
      // NOTE: the '--error' variant carries no distinct CSS rule, same as
      // before this split (a pre-existing gap in ai-block-renderer.styles.js,
      // out of scope here — preserved verbatim, not fixed).
      cls += isJobStale(attrs.createdAt, attrs.id) ? ' ai-block__badge--error' : ' ai-block__badge--thinking'
    } else if (status !== 'COMPLETE') {
      cls += ' ai-block__badge--error'
    }
    badge.className = cls
    badge.textContent = attrs.type === 'EXPLAIN' ? 'EXPLAIN' : 'ASK'
  }

  // destroy(dom): base no-op is correct — this class owns no timers,
  // observers, or listeners (unlike DiagramRenderer's panzoom cleanup).
}
