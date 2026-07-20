// @ts-check
// code-renderer.js — CodeRenderer: the renderer half of the 'code' kind's
// renderer/NodeView split (docs/design/archive/specs/2026-07-20-block-renderer-extraction.md,
// Phase 4 / issue #47). Owns look-and-feel ONLY: the block shell, the
// gutter+code-area body chrome, and this kind's complete stylesheet (`static
// styles`). Zero ProseMirror/editor/window.* app-global dependencies — this
// class mounts identically in the note editor's NodeView adapter
// (frontend/src/static/processors/code-renderer.js, which HOLDS an instance
// of this class by composition, never inheritance), a bare-page harness, or
// any future non-PM lens (chat turn, embedded card).
//
// PM-specific concerns deliberately stay OUT of this file per the spec's
// PM-specificity sorting test — they live in the adapter instead:
//   - ProseMirror's contentDOM binding/ignoreMutation/stopEvent (this class
//     builds the <code> element; the adapter binds it as the NodeView's
//     contentDOM and owns the MutationObserver that watches it)
//   - the lowlight DECORATION plugin (buildPlugins) — a ProseMirror concept
//   - the header toolbar (badge: language / detecting… / CODE), a
//     PM-framework slot (headerProvider, rendered by
//     sieve-block-extension.js) — stays adapter-side (CodeHeader in
//     processors/code-renderer.js), same as diagram's DiagramHeader
//   - persisting the live text via ctx.updateAttributes — a PM/framework
//     write path
//
// syncGutterLineCount delegates to the shared LineGutter class
// (block/renderers/line-gutter.js) — hoisted there at 'log's migration once
// both kinds needed an identical span-per-line gutter builder (survey item
// A2; see that file's header for the full rationale).

import { BlockRenderer } from './block-renderer.js'
import { codeStyles } from './code-renderer.styles.js'
import { LineGutter } from './line-gutter.js'

/** @typedef {{ id?: string, source?: string, language?: string, detectionMethod?: string }} CodeAttrs */

export class CodeRenderer extends BlockRenderer {
  // Sheet lives in the sibling code-renderer.styles.js — styles-file-geography
  // convention: a renderer file starts with its class, never a CSS wall.
  static styles = codeStyles

  /** @type {HTMLElement|null} */ #gutter = null
  /** @type {HTMLElement|null} */ #codeEl = null

  /** The live ProseMirror contentDOM the adapter binds as its NodeView's
   *  contentDOM — this class builds it, the adapter (never this class) hands
   *  it to ProseMirror. @returns {HTMLElement|null} */
  get contentDOM() { return this.#codeEl }

  /**
   * @param {CodeAttrs} attrs — `source` is the initial text only; live edits
   *   are tracked by ProseMirror directly in contentDOM. The adapter passes
   *   the LIVE textContent here on every update() (mirroring
   *   DiagramRenderer's effectiveAttrs pattern), so the gutter never lags.
   * @returns {HTMLElement}
   */
  mount(attrs) {
    const dom = document.createElement('div')
    dom.className = 'sieve-block sieve-block--code'

    const body = document.createElement('div')
    body.className = 'sieve-block__body'

    const gutter = document.createElement('div')
    gutter.className = 'sieve-block__gutter'
    gutter.contentEditable = 'false'

    const codeArea = document.createElement('div')
    codeArea.className = 'sieve-block__code-area'

    const pre = document.createElement('pre')
    pre.className = 'sieve-block__edit'
    pre.style.whiteSpace = 'pre-wrap'
    pre.style.pointerEvents = 'auto'
    pre.style.outline = 'none'
    pre.style.color = 'var(--theme-text)'

    const codeEl = document.createElement('code')
    codeEl.className = 'hljs'

    pre.appendChild(codeEl)
    codeArea.appendChild(pre)
    body.appendChild(gutter)
    body.appendChild(codeArea)
    dom.appendChild(body)

    this.#gutter = gutter
    this.#codeEl = codeEl
    this.update(dom, attrs)
    return dom
  }

  /**
   * Patches the highlight class (attrs.language) and the gutter's line count
   * (attrs.source, expected to be the LIVE text — see mount's doc).
   * @param {HTMLElement} dom
   * @param {CodeAttrs} attrs
   */
  update(dom, attrs) {
    this.#applyHighlightClass(attrs.language || '')
    this.syncGutterLineCount(attrs.source || '')
  }

  // Presentational hook for the adapter's live-typing sync: the gutter's line
  // count must track every keystroke via a MutationObserver on contentDOM
  // OUTSIDE this class's mount()/update() lifecycle (ProseMirror does not
  // call NodeView.update() for in-place text edits it owns) — same reasoning
  // as DiagramRenderer.syncGutterLineCount.
  /** @param {string} source */
  syncGutterLineCount(source) {
    if (this.#gutter) LineGutter.sync(this.#gutter, source)
  }

  /** @param {string} lang */
  #applyHighlightClass(lang) {
    if (!this.#codeEl) return
    this.#codeEl.className = (lang && lang !== 'unknown') ? 'language-' + lang + ' hljs' : 'hljs'
  }

  // destroy(dom): base no-op is correct — this class owns no timers or
  // observers (the MutationObserver that watches contentDOM is adapter-side,
  // since it also persists via ctx.updateAttributes — a PM/framework path).
}
