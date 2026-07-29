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
import {
  DEFAULT_POLICY, textInputEdit, applyTextEdit, handleSubstitutionGuard,
} from '../interaction-policy.js'

// MARKDOWN_POLICY — the breakglass buffer's own declaration. It is one
// <textarea> holding the WHOLE document, prose and fences together, so it
// cannot know whether the caret is in a sentence or in a code fence:
//   - surroundSelection: safe either way, and the gesture users expect.
//   - blockTextSubstitution: macOS smart dashes corrupt fences, and this
//     surface is where the corruption was actually observed.
//   - literalGlyphs: it is a verbatim view; `--` must not paint as `–`.
//   - autoClosePairs/expandPairOnEnter: DELIBERATELY OFF. Auto-pairing a `(`
//     mid-sentence is the first thing anyone disables, and there is no way to
//     tell prose from code here. Autoclose stays where the policy can be sure.
const MARKDOWN_POLICY = Object.freeze({
  ...DEFAULT_POLICY,
  surroundSelection: true,
  blockTextSubstitution: true,
  literalGlyphs: true,
})

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

  /** @type {ReturnType<typeof setTimeout>|null} scroll-report debounce (issue #51) */
  #scrollTimer = null

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
    // font-size MUST match .markdown-raw's (editor.css, code tier =
    // calc(--doc-size)*0.85) exactly: the gutter is a separate scrolling
    // column of one div per line, kept visually aligned with the textarea's
    // rows purely by scrollTop sync (below) plus identical row heights
    // (line-height * font-size). Any divergence between the two would drift
    // the numbers off their lines as soon as editorScale != 1.
    gutter.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;flex-shrink:0;padding:40px 0.6rem 0.85em;background-color:var(--theme-bgDark);border-right:1px solid var(--theme-border);color:var(--theme-muted);font-family:var(--theme-monoFont);font-size:calc(var(--doc-size) * 0.85);line-height:1.75;overflow:hidden'

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

    // The breakglass buffer is verbatim source text, so it takes the same
    // policy every literal-text BLOCK does — the SAME pure transforms the PM
    // surface uses, applied to the textarea value. Two call sites, one rule:
    // a divergence here would be a keyboard behaviour that silently stops
    // working the moment you switch to markdown mode.
    textarea.addEventListener('beforeinput', (e) => {
      // macOS smart-dash/quote substitution corrupts source; see
      // handleSubstitutionGuard. Confirmed reproducing in THIS surface.
      if (handleSubstitutionGuard(e, MARKDOWN_POLICY)) return
      if (e.inputType !== 'insertText' || typeof e.data !== 'string') return
      const edit = textInputEdit(
        textarea.value, textarea.selectionStart, textarea.selectionEnd, e.data, MARKDOWN_POLICY)
      if (!edit) return
      e.preventDefault()
      this.#applyTextEdit(edit)
    })

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
    textarea.addEventListener('scroll', () => {
      gutter.scrollTop = textarea.scrollTop
      // issue #51: markdown's own scroller is the textarea itself (no shell
      // ancestor involved) — debounce-report it the same way the wysiwyg
      // surface reports #htmx-editor.
      if (this.#scrollTimer) clearTimeout(this.#scrollTimer)
      this.#scrollTimer = setTimeout(() => {
        this.#scrollTimer = null
        this.#host.onSurfaceEvent(SurfaceEvent.SCROLL_CHANGED)
      }, 300)
    })

    wrapper.appendChild(gutter)
    wrapper.appendChild(textarea)
    rootEl.appendChild(wrapper)
    this.#wrapper = wrapper

    requestAnimationFrame(() => { textarea.focus() })
  }

  /**
   * Applies a policy TextEdit to the textarea. Goes through execCommand where
   * available so the browser's own undo stack records the change — setting
   * `.value` directly would make Mod+Z blow away everything typed since the
   * last native entry, which is exactly the undo-history damage the
   * backend-is-source-of-truth rule guards against on the PM side.
   * @param {import('../interaction-policy.js').TextEdit} edit
   */
  #applyTextEdit(edit) {
    const ta = this.#textarea
    if (!ta) return
    const next = applyTextEdit(ta.value, edit)
    let inserted = false
    // Ops are descending, so replacing each range in order stays valid.
    if (document.execCommand) {
      inserted = edit.ops.every((op) => {
        ta.setSelectionRange(op.from, op.to)
        return document.execCommand('insertText', false, op.insert)
      })
    }
    if (!inserted) ta.value = next.text
    ta.setSelectionRange(next.caret, next.head)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  }

  /** Removes the surface's DOM and kills the pending debounces. */
  unmount() {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null }
    if (this.#scrollTimer) { clearTimeout(this.#scrollTimer); this.#scrollTimer = null }
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
   * @override — the textarea's own scrollTop (its scroller, unlike wysiwyg's
   * shell ancestor). null when unmounted. issue #51.
   * @returns {number|null}
   */
  feedScroll() { return this.#textarea ? this.#textarea.scrollTop : null }

  /**
   * @override — restores (or parks) the textarea's scroll position, syncing the
   * gutter to match. null/undefined ⇒ nothing to restore; 0 is a real
   * park-at-top value. issue #51.
   * @param {number|null|undefined} value
   */
  applyScroll(value) {
    if (value == null) return
    const ta = this.#textarea
    const gutter = this.#gutter
    if (!ta) return
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ta.scrollTop = value
        if (gutter) gutter.scrollTop = ta.scrollTop
      })
    })
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
