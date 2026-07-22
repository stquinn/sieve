// @ts-check
// markdown-surface.js — the raw-markdown input surface (P2.B).
//
// Faithful code motion of editor.js's mountMarkdown (+ updateGutter, the
// markdown branch of the insert-block render-back, and the markdown flush
// semantics of the old flushSave/takePendingMarkdown seam). The former module
// vars `lastSyncedBody`, `docUpdateTimer`, and `currentMarkdownTextarea` are
// #private fields here — they live and die with the surface, so a stale timer
// can never fire against a torn-down mount.
//
// Markdown mode is the breakglass verbatim buffer: edits flow to the editor
// as whole-buffer setRawContent commands (500ms debounce) — the editor
// delegates to DocumentService, which owns the wire enveloping (doc-update);
// an in-place transform render-back
// (replace-block) triggers a full reload via the host editor's softReload —
// acceptable only in this mode (WS shapes frozen; see recon §1).
//
// Dual-use ES module: `export` for vitest; `window.SieveMarkdownSurface` for
// the classic-script editor.js factory.

import { AbstractSurface, SurfaceEvent } from './abstract-surface.js'
import { EditorMode } from '../editor-mode.js'

/**
 * @typedef {import('../abstract-editor.js').AbstractEditor} AbstractEditor
 */

export class MarkdownSurface extends AbstractSurface {
  /**
   * The parent editor (`host`) — the surface calls its public API directly
   * (onSurfaceEvent / setRawContent / takeInsertPos / softReload). No app-level
   * chrome, no AI concepts, no chords: app-level chords are owned by the native
   * menu, which calls the editor API directly (P2.C).
   * @type {AbstractEditor}
   */
  #host

  /** @type {HTMLElement|null} */
  #rootEl = null

  /** @type {HTMLElement|null} */
  #wrapper = null

  /** @type {HTMLElement|null} */
  #gutter = null

  /** @type {HTMLTextAreaElement|null} */
  #textarea = null

  /** @type {string} the latest raw markdown body (formerly module lastSyncedBody) */
  #body = ''

  /** @type {ReturnType<typeof setTimeout>|null} 500ms doc-update debounce (formerly module docUpdateTimer) */
  #timer = null

  /**
   * No uuid: this surface holds no content that needs the document identity —
   * transport identity is the EDITOR's concern (host rule, P2.B correction 3).
   * @param {AbstractEditor} host — the parent editor
   */
  constructor(host) {
    super()
    if (!host) throw new Error('MarkdownSurface: host is required')
    this.#host = host
  }

  /** @returns {import('../editor-mode.js').EditorModeValue} */
  get mode() { return EditorMode.MARKDOWN }

  /** @returns {string} the latest raw markdown body */
  get body() { return this.#body }

  /**
   * Builds the gutter + textarea under the root (verbatim mountMarkdown DOM).
   * @param {HTMLElement} rootEl
   * @param {unknown}     content — the raw markdown body
   */
  mount(rootEl, content) {
    const body = typeof content === 'string' ? content : ''
    this.#rootEl = rootEl
    this.#body = body

    const wrapper = document.createElement('div')
    wrapper.style.cssText = 'display:flex;flex-direction:row;height:100%;overflow:hidden;background:var(--theme-bg);position:relative'

    const gutter = document.createElement('div')
    gutter.className = 'markdown-gutter'
    gutter.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;flex-shrink:0;padding:40px 0.6rem 0.85em;background-color:var(--theme-bgDark);border-right:1px solid var(--theme-border);color:var(--theme-muted);font-family:var(--theme-monoFont);font-size:14px;line-height:1.75;overflow:hidden'

    const textarea = document.createElement('textarea')
    this.#textarea = textarea
    this.#gutter = gutter
    textarea.className = 'markdown-editor markdown-raw'
    textarea.spellcheck = true
    textarea.placeholder = 'Raw markdown — Mod+Shift+M to return'
    textarea.setAttribute('autocomplete', 'off')
    textarea.setAttribute('autocorrect', 'off')
    textarea.style.cssText = 'flex:1;padding-top:40px;padding-left:1rem;padding-right:1rem;padding-bottom:1rem'
    textarea.value = body

    this.#updateGutter(body)

    textarea.addEventListener('input', () => {
      const val = textarea.value
      if (val === this.#body) return
      this.#body = val
      this.#updateGutter(val)
      // Producer-named outbound event; the editor's SurfaceListener handler
      // (onSurfaceEvent) forwards it to registrants and marks the doc dirty.
      this.#host.onSurfaceEvent(SurfaceEvent.DOC_CHANGED)
      if (this.#timer) clearTimeout(this.#timer)
      this.#timer = setTimeout(() => {
        this.#timer = null
        this.#host.setRawContent(val)
      }, 500)
    })
    // NO app-level chords here: Mod+S / Mod+J bubble from the textarea to the
    // transitional document-level listener in editor.js (P2.C owns the proper
    // chord transport migration).
    textarea.addEventListener('scroll', () => { gutter.scrollTop = textarea.scrollTop })

    wrapper.appendChild(gutter)
    wrapper.appendChild(textarea)
    rootEl.appendChild(wrapper)
    this.#wrapper = wrapper

    requestAnimationFrame(() => { textarea.focus() })
  }

  /** Removes the surface's DOM and kills the pending debounce. */
  unmount() {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null }
    if (this.#wrapper) this.#wrapper.remove()
    this.#wrapper = null
    this.#gutter = null
    this.#textarea = null
    this.#rootEl = null
  }

  /**
   * Flushes a pending debounced edit as an immediate setRawContent (the old
   * flushSave markdown branch / takePendingMarkdown accessor). Idle → no-op.
   */
  flushPending() {
    if (!this.#timer) return
    clearTimeout(this.#timer)
    this.#timer = null
    this.#host.setRawContent(this.#body)
  }

  /**
   * Raw selection descriptor for the SelectionModel. Markdown mode is an opaque
   * verbatim buffer — there is no block model to key a selection on — so the AI
   * target is always the whole DOCUMENT; the model's focusZone is 'markdown' while
   * this surface is mounted (set by the editor's focus channel).
   *
   * P3.C: a textarea sub-string selection resolves to a document-scoped 'selection'
   * (ref 'doc') with a snippet label; otherwise the document target with a 'Document'
   * label. The `target` is ALWAYS present (label folded in), matching the wysiwyg
   * surface's contract.
   * @returns {import('../selection-model.js').RawSelectionDescriptor}
   */
  feedSelection() {
    const ta = this.#textarea
    if (ta && ta.selectionStart !== ta.selectionEnd) {
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd)
      return {
        selectionType: 'range', caret: ta.selectionStart,
        range: { from: ta.selectionStart, to: ta.selectionEnd },
        selectedText: sel, blockId: null, blockIds: [], blockKind: null, ref: null,
        // Markdown is a verbatim buffer — no block hosts an inner cursor.
        blockCursor: null,
        target: { kind: 'selection', ref: 'doc', range: null, label: this.quoteSnippet(sel) },
      }
    }
    return {
      selectionType: 'none', caret: null, range: null, selectedText: null,
      blockId: null, blockIds: [], blockKind: null, ref: null, blockCursor: null,
      target: { kind: 'document', ref: 'doc', range: null, label: 'Document' },
    }
  }

  /**
   * Restores focus/selection from a SelectionContext coordinate (P3.E write side).
   * Markdown is the degenerate whole-text case: map the DOCUMENT coordinate
   * (`caret`/`range`, textarea offsets) back onto the textarea. No blockCursor —
   * markdown has no block-inner cursor. Behaviour-equivalent to the retired
   * `{kind:'markdown',start,end}` focus token.
   * @param {import('../selection-model.js').SelectionContext} ctx
   */
  applyPosition(ctx) {
    const ta = this.#textarea
    if (!ta) return
    ta.focus()
    const len = ta.value.length
    const from = Math.min((ctx && ctx.caret != null) ? ctx.caret : 0, len)
    const to = Math.min((ctx && ctx.range) ? ctx.range.to : from, len)
    try { ta.selectionStart = from; ta.selectionEnd = to } catch (_) {}
  }

  /**
   * Markdown-mode render-back behavior (verbatim from the old handlers):
   * insert-block appends the block's markdown to the buffer and syncs it;
   * replace-block is breakglass → full reload; block-attrs-updated has no
   * markdown representation → no-op.
   * @param {import('./abstract-surface.js').ServerOp & {markdown?: string}} msg
   */
  applyServerOp(msg) {
    if (msg.type === 'insert-block') {
      this.#host.takeInsertPos()
      this.#body = this.#body.trim() + '\n\n' + (msg.markdown || '') + '\n'
      if (this.#textarea) this.#textarea.value = this.#body
      this.#host.setRawContent(this.#body)
      return
    }
    if (msg.type === 'replace-block') {
      this.#host.softReload()
    }
    // block-attrs-updated: PM node attrs have no raw-markdown representation.
  }

  /**
   * Replaces the whole buffer from disk (softReloadContent's markdown branch).
   * @param {string} body
   */
  replaceBody(body) {
    this.#body = body
    if (this.#textarea) this.#textarea.value = body
    this.#updateGutter(body)
  }

  /** @param {string} value */
  #updateGutter(value) {
    const gutter = this.#gutter
    if (!gutter) return
    const count = value.split('\n').length
    gutter.innerHTML = ''
    for (let i = 0; i < count; i++) {
      const span = document.createElement('span')
      span.textContent = String(i + 1)
      gutter.appendChild(span)
    }
  }
}

// Expose on window for classic-script access from editor.js.
window.SieveMarkdownSurface = MarkdownSurface
