// @ts-check
// command-popup.js — the detached-answer popup: a host for command-result block
// renderers. An appearance, not an interruption: it never steals focus. Hide
// parks the answer on its badge; Delete (via onDelete) removes it.
//
// The pending state is KIND-AGNOSTIC: when block is null it renders a generic
// spinner + command name, or a generic error view on a block-less terminal error.
//
// Block contract: the popup reads the block's TYPED getters (block.kind /
// block.status). The opaque payload is the kind renderer's business, so Copy
// pulls its text from the renderer (copyText), never by reaching into payload.
//
// The popup is a host that draws whole blocks: it claims the BODY region of a
// renderer that offers bodyElements() and draws those elements there, each
// whole and read-only by its kind's renderer (QuestionListView), or the
// renderer's markdown body while it offers none. The answer grows as steps of a
// running command arrive; the renderer's footer says it is still being written,
// or was cut short. When the host can place a block in the document the popup
// was opened over (onAddToDocument), each drawn block offers Add to Document: a
// copy of that one block. Copy, on the bar, takes the whole answer as text.

import { AiBlockRenderer } from '../renderers/ai-block-renderer.js'
import { rendererStyles } from '../renderers/renderer-style-registry.js'
import { commandPopupStyles } from './command-popup.styles.js'
import { CommandResultRenderer } from '../renderers/command-result-renderer.js'
import { QuestionListView } from '../renderers/question-list-view.js'
import { REGION } from '../renderers/block-renderer.js'

/** @typedef {{ cmd: string, text: string, error?: string, docUuid?: string }} CommandMeta */

/**
 * Kind → renderer resolution for command-result blocks. A new command result
 * kind adds one entry here (its PM-free renderer). NOT the PM-coupled
 * NodeViewRegistry — this popup stays out of ProseMirror.
 * @type {Readonly<Record<string, typeof AiBlockRenderer | typeof CommandResultRenderer>>}
 */
const COMMAND_RENDERERS = Object.freeze({ 'ai-block': AiBlockRenderer, 'command-result': CommandResultRenderer })

export class CommandPopup {
  static styles = commandPopupStyles

  // One command popup visible at a time: opening hides any other, and Escape
  // closes only the top-of-stack.
  /** @type {CommandPopup[]} */ static #openStack = []
  static #top() { return CommandPopup.#openStack[CommandPopup.#openStack.length - 1] || null }

  /** @type {HTMLElement} */ #anchor
  /** @type {() => void} */ #onDelete
  /** @type {((element: {kind: string, attrs: Record<string, any>}, holderId: string) => boolean)|null} */ #onAddToDocument
  /** @type {HTMLElement|null} */ #root = null
  /** @type {import('../renderers/block-renderer.js').BlockRenderer|null} */ #renderer = null
  /** @type {import('../contract/sieve-block.js').SieveBlock|null} */ #block = null
  /** @type {CommandMeta} */ #meta = { cmd: '', text: '' }
  /** @type {HTMLElement|null} */ #bodyEl = null
  /** @type {HTMLElement|null} */ #titleEl = null
  /** @type {HTMLElement|null} the renderer's BODY region, claimed and drawn here */ #answerEl = null
  /** @type {QuestionListView|null} draws the answer's blocks into #answerEl */ #answerView = null
  /** @type {Array<() => void>} */ #unlisten = []

  /**
   * @param {{ anchor: HTMLElement, onDelete: () => void, onAddToDocument?: (element: {kind: string, attrs: Record<string, any>}, holderId: string) => boolean }} options
   *   onAddToDocument places a copy of one answer block in the document the
   *   popup was opened over, reporting whether it could; absent, no block
   *   offers it.
   */
  constructor({ anchor, onDelete, onAddToDocument }) {
    rendererStyles.register(CommandPopup)
    this.#anchor = anchor
    this.#onDelete = onDelete
    this.#onAddToDocument = onAddToDocument || null
  }

  get visible() { return !!this.#root }

  /**
   * @param {import('../contract/sieve-block.js').SieveBlock|null} block
   * @param {CommandMeta} [meta]
   */
  show(block, meta) {
    this.#block = block
    if (meta) this.#meta = meta
    if (this.#root) {
      this.update(block, meta)
      return
    }
    // One visible at a time — park any other open command popup on its badge.
    CommandPopup.#openStack.slice().forEach((p) => { if (p !== this) p.hide() })

    const root = document.createElement('div')
    this.#root = root
    root.className = 'command-popup'

    const bar = document.createElement('div')
    bar.className = 'command-popup__bar'

    this.#titleEl = document.createElement('span')
    this.#titleEl.className = 'command-popup__title'
    this.#renderTitle()

    const actionsEl = document.createElement('div')
    actionsEl.className = 'command-popup__actions'

    actionsEl.append(
      this.#barButton('copy', 'Copy answer', 'Copy', (btn) => {
        const text = this.#answerText()
        if (text && navigator.clipboard) {
          navigator.clipboard.writeText(text)
          this.#flash(btn, 'Copied ✓')
        }
      }),
      this.#barButton('hide', 'Hide (answer stays on the badge)', 'Hide', () => this.hide()),
      this.#barButton('delete', 'Delete', 'Dismiss', () => this.#onDelete())
    )

    bar.append(this.#titleEl, actionsEl)

    this.#bodyEl = document.createElement('div')
    this.#bodyEl.className = 'command-popup__body'

    this.#renderBody()

    root.append(bar, this.#bodyEl)
    document.body.appendChild(root)
    CommandPopup.#openStack.push(this)

    /** @param {KeyboardEvent} e */
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      // Only the most-recently-shown popup responds; stop siblings' listeners.
      if (CommandPopup.#top() !== this) return
      e.stopImmediatePropagation()
      e.stopPropagation()
      this.hide()
    }
    /** @param {MouseEvent} e */
    const onClick = (e) => {
      const target = /** @type {Node} */ (e.target)
      if (root && !root.contains(target) && target !== this.#anchor && !this.#anchor.contains(target)) {
        this.hide()
      }
    }

    // CAPTURE phase (third arg true): document-level capture runs BEFORE any
    // target-phase handler, so Escape is consumed here (stopImmediatePropagation)
    // before the Ask-panel textarea's own keydown handler can fire #dismiss() and
    // silently unpin the panel. removeEventListener MUST pass the same capture
    // flag or it silently no-ops.
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('click', onClick)
    this.#unlisten = [
      () => document.removeEventListener('keydown', onKey, true),
      () => document.removeEventListener('click', onClick)
    ]
  }

  /**
   * @param {import('../contract/sieve-block.js').SieveBlock|null} block
   * @param {CommandMeta} [meta]
   */
  update(block, meta) {
    this.#block = block
    if (meta) this.#meta = meta
    this.#renderTitle()
    this.#renderBody()
  }

  #renderTitle() {
    if (!this.#titleEl) return
    const cmdName = this.#meta.cmd || 'command'
    let suffix
    if (this.#block ? this.#block.status === 'ERROR' : this.#meta.error) suffix = ' failed'
    else if (!this.#block || this.#block.status === 'PENDING') suffix = ' …'
    else suffix = ' answer'
    this.#titleEl.textContent = '/' + cmdName + suffix
  }

  #renderBody() {
    if (!this.#bodyEl) return

    if (!this.#block) {
      this.#releaseAnswer()
      this.#renderer = null
      if (this.#meta.error) this.#renderStatus(true, '⚠', 'Command failed', this.#meta.error)
      else this.#renderStatus(false, null, '/' + this.#meta.cmd + ' is working…', this.#meta.text)
      return
    }

    const RendererClass = COMMAND_RENDERERS[this.#block.kind]
    if (!RendererClass) {
      this.#releaseAnswer()
      this.#renderer = null
      this.#renderStatus(true, '⚠', 'Unsupported result kind', this.#block.kind)
      return
    }

    if (this.#renderer instanceof RendererClass) {
      this.#renderer.update(this.#block)
    } else {
      this.#releaseAnswer()
      this.#bodyEl.innerHTML = ''
      this.#renderer = new RendererClass(this.#block, undefined, (r, region, container) => this.#claim(r, region, container))
      const rendered = this.#renderer.render()
      if (rendered) this.#bodyEl.appendChild(rendered)
    }
    this.#drawAnswer()
  }

  /**
   * The renderer's region interceptor: claims the BODY of a renderer that offers
   * its body as blocks, leaving every other region, and every other renderer's
   * body, to the renderer.
   * @param {import('../renderers/block-renderer.js').BlockRenderer} renderer
   * @param {string} region @param {HTMLElement} container
   * @returns {boolean} false when claimed
   */
  #claim(renderer, region, container) {
    if (region !== REGION.BODY || typeof (/** @type {any} */ (renderer)).bodyElements !== 'function') return true
    container.className = 'sieve-block__content tiptap'
    this.#answerEl = container
    this.#answerView = new QuestionListView()
    return false
  }

  /** Redraws the claimed body from the mounted renderer: its blocks when it
   *  offers them, else its markdown body. */
  #drawAnswer() {
    const r = /** @type {any} */ (this.#renderer)
    const el = this.#answerEl
    if (!r || !el || !this.#answerView) return
    const elements = r.bodyElements()
    if (elements) {
      this.#answerView.fill(el, elements)
      this.#offerAddToDocument(el, elements)
    } else {
      this.#answerView.destroy()
      r.fillBody(el, r.bodyMarkdown())
    }
  }

  /**
   * Gives each drawn block its Add to Document button, when the host can place
   * one. A row is one element, in the order the answer holds them.
   * @param {HTMLElement} el @param {ReadonlyArray<{kind: string, attrs: Record<string, any>}>} elements
   */
  #offerAddToDocument(el, elements) {
    const place = this.#onAddToDocument
    const holderId = this.#block ? this.#block.id : ''
    if (!place || !holderId) return
    const rows = Array.from(el.children).filter((row) => row.classList.contains('ai-block__element'))
    rows.forEach((row, i) => {
      const element = elements[i]
      if (!element) return
      row.appendChild(this.#barButton('add', 'Add a copy of this block to the note', 'Add to Document', (btn) => {
        if (place(element, holderId)) this.#flash(btn, 'Added ✓')
        else this.#flash(btn, 'Open the note first')
      }))
    })
  }

  /** Releases the claimed body and what it drew. */
  #releaseAnswer() {
    if (this.#answerView) this.#answerView.destroy()
    this.#answerView = null
    this.#answerEl = null
  }

  /**
   * Generic status view (pending spinner OR terminal error/unsupported).
   * @param {boolean} isError @param {string|null} icon @param {string} label @param {string} [detail]
   */
  #renderStatus(isError, icon, label, detail) {
    if (!this.#bodyEl) return
    this.#bodyEl.innerHTML = ''
    const wrap = document.createElement('div')
    wrap.className = 'command-popup__status' + (isError ? ' command-popup__status--error' : '')

    if (icon) {
      const iconEl = document.createElement('div')
      iconEl.className = 'command-popup__status-icon'
      iconEl.textContent = icon
      wrap.appendChild(iconEl)
    } else {
      const spinner = document.createElement('div')
      spinner.className = 'status-bar__spinner command-popup__spinner'
      wrap.appendChild(spinner)
    }

    const labelEl = document.createElement('div')
    labelEl.className = 'command-popup__status-label'
    labelEl.textContent = label
    wrap.appendChild(labelEl)

    if (detail) {
      const detailEl = document.createElement('div')
      detailEl.className = 'command-popup__status-detail'
      detailEl.textContent = detail
      wrap.appendChild(detailEl)
    }

    this.#bodyEl.appendChild(wrap)
  }

  /**
   * The answer text to copy, pulled from the kind renderer's copyText()
   * accessor. Empty when no renderer is mounted (pending / generic view).
   * @returns {string}
   */
  #answerText() {
    const r = /** @type {any} */ (this.#renderer)
    return r && typeof r.copyText === 'function' ? String(r.copyText() || '') : ''
  }

  hide() {
    this.#unlisten.forEach((u) => u())
    this.#unlisten = []
    const i = CommandPopup.#openStack.indexOf(this)
    if (i >= 0) CommandPopup.#openStack.splice(i, 1)
    if (this.#root) {
      this.#root.remove()
      this.#root = null
    }
    this.#releaseAnswer()
    this.#renderer = null
    this.#bodyEl = null
    this.#titleEl = null
  }

  destroy() {
    this.hide()
  }

  /**
   * Button micro-feedback: shows `text` on the button for 1.2s. The scrimless
   * popup has no toast channel, so the button is the confirmation surface.
   * @param {HTMLButtonElement} btn @param {string} text
   */
  #flash(btn, text) {
    if (btn.classList.contains('command-popup__btn--copied')) return
    const label = btn.textContent
    btn.classList.add('command-popup__btn--copied')
    btn.textContent = text
    setTimeout(() => {
      btn.classList.remove('command-popup__btn--copied')
      btn.textContent = label
    }, 1200)
  }

  /**
   * @param {string} kind
   * @param {string} title
   * @param {string} text
   * @param {(btn: HTMLButtonElement) => void} onClick
   */
  #barButton(kind, title, text, onClick) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'command-popup__btn command-popup__btn--' + kind
    b.setAttribute('aria-label', title)
    b.title = title
    b.textContent = text
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      onClick(b)
    })
    return b
  }
}
