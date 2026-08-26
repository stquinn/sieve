// @ts-check
// The raw-markdown input surface: the breakglass VERBATIM buffer. Edits flow to
// the host as whole-buffer setRawContent handoffs on a 500ms debounce — `flush` at
// container scale. The buffer is KEPT, deliberately NOT re-parsed, because
// re-parsing a half-typed document would take Go out of verbatim mode
// mid-keystroke.
//
// It FOLLOWS THE CONTAINER only where it can: a block arriving is appended in its
// serialized form, a block LEAVING is a structural change this text cannot express
// so it asks the host for a reload, and everything else has no representation in a
// verbatim buffer and is correctly ignored.

import { AbstractSurface, SurfaceEvent } from './abstract-surface.js'
import { EditorMode } from '../editor-mode.js'
import {
  DEFAULT_POLICY, textInputEdit, applyTextEdit, handleSubstitutionGuard,
} from '../interaction-policy.js'

// The breakglass buffer's own policy declaration. It is one <textarea> holding
// the WHOLE document, prose and fences together, so it cannot know whether the
// caret is in a sentence or in a code fence:
//   - surroundSelection: safe either way, and the gesture users expect.
//   - blockTextSubstitution: macOS smart dashes corrupt fences, and this surface
//     is where the corruption was actually observed.
//   - literalGlyphs: it is a verbatim view; `--` must not paint as an en dash.
//   - autoClosePairs/expandPairOnEnter: DELIBERATELY OFF. Auto-pairing a `(`
//     mid-sentence is the first thing anyone disables, and there is no way to
//     tell prose from code here.
const MARKDOWN_POLICY = Object.freeze({
  ...DEFAULT_POLICY,
  surroundSelection: true,
  blockTextSubstitution: true,
  literalGlyphs: true,
})

/**
 * @typedef {import('../../abstract-editor.js').AbstractEditor} AbstractEditor
 */

export class MarkdownSurface extends AbstractSurface {
  /** @type {AbstractEditor} the parent editor, whose public API this calls
   *  directly. No app-level chrome, no AI concepts, no chords. */
  #host

  /** @type {HTMLElement|null} */
  #rootEl = null

  /** @type {HTMLElement|null} */
  #wrapper = null

  /** @type {HTMLElement|null} */
  #gutter = null

  /** @type {HTMLTextAreaElement|null} */
  #textarea = null

  /** @type {string} the latest raw markdown body */
  #body = ''

  /** @type {ReturnType<typeof setTimeout>|null} 500ms doc-update debounce */
  #timer = null

  /** @type {ReturnType<typeof setTimeout>|null} scroll-report debounce */
  #scrollTimer = null

  /** @type {Set<string>} the container blocks this buffer already accounts for.
   *  Seeded at the first cue, because the load is already IN the buffer, so a later
   *  arrival is recognisable as one — a cue names a block every time anything about
   *  it changes, and appending on each would paste it repeatedly. */
  #known = new Set()

  /** @type {boolean} whether the first cue has been taken. A flag rather than "is
   *  #known empty", because an EMPTY container is legitimate to bootstrap against,
   *  and inferring from the set would make the first real arrival look like a
   *  second bootstrap and swallow it. */
  #bootstrapped = false

  /** No uuid: this surface holds no content needing the document identity —
   *  transport identity is the EDITOR's concern.
   *  @param {AbstractEditor} host — the parent editor */
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
    // font-size MUST match .markdown-raw's exactly: the gutter is a separate
    // scrolling column of one div per line, aligned with the textarea's rows purely
    // by scrollTop sync plus identical row heights.
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

    // The breakglass buffer is verbatim source text, so it takes the same policy
    // every literal-text BLOCK does — the SAME pure transforms the PM surface uses,
    // applied to the textarea value. A divergence here would be a keyboard
    // behaviour that silently stops working the moment you switch to markdown.
    textarea.addEventListener('beforeinput', (e) => {
      // macOS smart-dash/quote substitution corrupts source.
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
      // Producer-named outbound event; the editor forwards it and marks dirty.
      this.#host.onSurfaceEvent(SurfaceEvent.DOC_CHANGED)
      if (this.#timer) clearTimeout(this.#timer)
      this.#timer = setTimeout(() => {
        this.#timer = null
        this.#host.setRawContent(val)
      }, 500)
    })
    // NO app-level chords here: Mod+S / Mod+J bubble to the document listener.
    textarea.addEventListener('scroll', () => {
      gutter.scrollTop = textarea.scrollTop
      // Markdown's own scroller is the textarea itself, with no shell ancestor.
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
   * Applies a policy TextEdit to the textarea, through execCommand where available
   * so the browser's own undo stack records the change — setting `.value` directly
   * would make Mod+Z blow away everything typed since the last native entry.
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

  unmount() {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null }
    if (this.#scrollTimer) { clearTimeout(this.#scrollTimer); this.#scrollTimer = null }
    if (this.#wrapper) this.#wrapper.remove()
    this.#wrapper = null
    this.#gutter = null
    this.#textarea = null
    this.#rootEl = null
  }

  /** Flushes a pending debounced edit as an immediate setRawContent. Idle: no-op. */
  flushPending() {
    if (!this.#timer) return
    clearTimeout(this.#timer)
    this.#timer = null
    this.#host.setRawContent(this.#body)
  }

  /**
   * Raw selection descriptor for the SelectionModel. Markdown mode is an opaque
   * verbatim buffer with no block model to key a selection on, so the AI target is
   * always the whole DOCUMENT. A sub-string selection resolves to a
   * document-scoped 'selection' with a snippet label; otherwise the document
   * target. `target` is ALWAYS present, matching the wysiwyg contract.
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

  /** Restores focus/selection from a SelectionContext coordinate. Markdown is the
   *  degenerate whole-text case: map the DOCUMENT coordinate back onto the
   *  textarea. No blockCursor — markdown has no block-inner cursor.
   *  @param {import('../selection-model.js').SelectionContext} ctx */
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
   * @override — the textarea's own scrollTop, since it is its own scroller unlike
   * wysiwyg's shell ancestor. null when unmounted.
   * @returns {number|null}
   */
  feedScroll() { return this.#textarea ? this.#textarea.scrollTop : null }

  /**
   * @override — restores (or parks) the textarea's scroll position, syncing the
   * gutter to match. null/undefined means nothing to restore; 0 is a real
   * park-at-top value.
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
   * The container changed while this verbatim buffer is the authority.
   *
   * FIRST CUE: the buffer already holds the load, so it only records what the
   * container has and appends nothing.
   *
   * A BLOCK ARRIVED: append its serialized form. That form is Go's — a block's
   * fence is its processor's to write — and it has to land in the BUFFER, because
   * the buffer is what gets saved and what a flip back re-parses.
   *
   * A BLOCK LEFT: the buffer cannot express a removal by position, so ask the host
   * to reload. Break-glass mode, break-glass answer.
   *
   * Anything else — attrs, order — has no raw-markdown representation.
   * @param {{blockIds: ReadonlyArray<string>, orderChanged: boolean}} change
   * @param {any} provider
   */
  applyContainerChange(change, provider) {
    if (!provider) return
    const order = provider.getOrder()
    if (!this.#bootstrapped) {
      this.#bootstrapped = true
      for (const id of order) this.#known.add(id)
      return
    }
    let appended = false
    let departed = false
    for (const id of (change && change.blockIds) || []) {
      const node = provider.getBlock(id)
      if (!node) { if (this.#known.delete(id)) departed = true; continue }
      if (this.#known.has(id)) continue
      this.#known.add(id)
      const text = typeof node.text === 'string' ? node.text : ''
      if (!text) continue
      this.#body = this.#body.trim() + '\n\n' + text + '\n'
      appended = true
    }
    if (appended) {
      if (this.#textarea) this.#textarea.value = this.#body
      this.#updateGutter(this.#body)
      this.#host.setRawContent(this.#body)
      return
    }
    if (departed) this.#host.reload()
  }

  /** Paints the whole container. A whole-content lens has no block-by-block
   *  painting to do — its content IS the buffer, which the host replaces through
   *  replaceBody — so this only re-bases what it accounts for.
   *  @param {any} provider */
  paintContainer(provider) {
    this.#known = new Set(provider ? provider.getOrder() : [])
    this.#bootstrapped = true
  }

  /** Replaces the whole buffer from disk. @param {string} body */
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

window.SieveMarkdownSurface = MarkdownSurface
