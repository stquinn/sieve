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
// as whole-buffer updateText commands (500ms debounce) — the editor owns the
// wire enveloping (doc-update); an in-place transform render-back
// (replace-block) triggers a full reload via the injected requestReload —
// acceptable only in this mode (WS shapes frozen; see recon §1).
//
// Dual-use ES module: `export` for vitest; `window.SieveMarkdownSurface` for
// the classic-script editor.js factory.

import { AbstractSurface, SurfaceEvent } from './abstract-surface.js'
import { EditorMode } from '../editor-mode.js'

/**
 * Injected collaborators — content services commanding into this document's
 * context, plus the ONE outbound notifier. Nothing app-level: no chrome names,
 * no AI concepts, no chords (app-level chords are owned by the native menu,
 * which calls the component API directly — P2.C).
 * @typedef {object} MarkdownSurfaceDeps
 * @property {(markdown: string) => void} updateText — whole-buffer text update → editor transport (dropped by prompts)
 * @property {() => void}            requestReload — full reload for replace-block (softReloadContent)
 * @property {() => number|null}     takeInsertPos — read-and-clear the module sieveInsertPos capture
 * @property {(event: import('./abstract-surface.js').SurfaceEventMsg) => void} notify — outbound editor-domain events
 */

export class MarkdownSurface extends AbstractSurface {
  /** @type {MarkdownSurfaceDeps} */
  #deps

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
   * transport identity is the EDITOR's concern (deps rule, P2.B correction 3).
   * @param {MarkdownSurfaceDeps} deps
   */
  constructor(deps) {
    super()
    if (!deps) throw new Error('MarkdownSurface: deps are required')
    this.#deps = deps
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
      // Producer-named outbound event; the editor forwards it to registrants
      // (the legacy chrome fan-out in editor.js dispatches dirty/stats from it).
      this.#deps.notify(SurfaceEvent.DOC_CHANGED)
      if (this.#timer) clearTimeout(this.#timer)
      this.#timer = setTimeout(() => {
        this.#timer = null
        this.#deps.updateText(val)
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
   * Flushes a pending debounced edit as an immediate updateText (the old
   * flushSave markdown branch / takePendingMarkdown accessor). Idle → no-op.
   */
  flushPending() {
    if (!this.#timer) return
    clearTimeout(this.#timer)
    this.#timer = null
    this.#deps.updateText(this.#body)
  }

  /**
   * Raw selection descriptor for the SelectionModel (P3.A). Markdown mode is an
   * opaque verbatim buffer — there is no block model to key a selection on — so
   * the surface reports a 'none'-ish descriptor; the model's focusZone is
   * 'markdown' while this surface is mounted (set by the editor's focus channel).
   * Textarea sub-string selection targeting is P3.B.
   * @returns {import('../selection-model.js').RawSelectionDescriptor}
   */
  feedSelection() {
    return { selectionType: 'none', caret: null, range: null, selectedText: null, blockId: null, blockIds: [], blockKind: null, ref: null, label: '' }
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
      this.#deps.takeInsertPos()
      this.#body = this.#body.trim() + '\n\n' + (msg.markdown || '') + '\n'
      if (this.#textarea) this.#textarea.value = this.#body
      this.#deps.updateText(this.#body)
      return
    }
    if (msg.type === 'replace-block') {
      this.#deps.requestReload()
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
