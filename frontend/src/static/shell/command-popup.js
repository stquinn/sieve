// @ts-check
// command-popup.js — the detached-answer popup (#55): a host for command-result
// block renderers (note lens / bare harness / here). An appearance, not an
// interruption: never steals focus. Hide parks the answer on its badge;
// Delete (via onDelete) removes it from existence.
//
// The pending state is KIND-AGNOSTIC: when block is null the popup renders a
// generic spinner + command name (or, on a block-less terminal error, a generic
// error view). Only when a real block arrives does the popup resolve the kind's
// renderer (COMMAND_RENDERERS) and mount it for the body content.
//
// Envelope contract: the popup reads the block's TYPED getters (block.kind /
// block.status) — the opaque payload is the kind renderer's business, so the
// Copy button pulls its answer text from the renderer (copyText), never by
// reaching into payload.

import { AiBlockRenderer } from '../block/renderers/ai-block-renderer.js'
import { CommandResultRenderer } from '../block/renderers/command-result-renderer.js'

/** @typedef {{ cmd: string, text: string, error?: string }} CommandMeta */

/**
 * Kind → renderer resolution for command-result blocks. Frozen and small; a new
 * command result kind adds one entry here (its PM-free renderer). NOT the
 * PM-coupled NodeViewRegistry — this popup stays out of ProseMirror. AI
 * commands (/btw, /summary, /todo) resolve to AiBlockRenderer; non-AI developer
 * utilities (/uuid, /hash, …) to the honest CommandResultRenderer.
 * @type {Readonly<Record<string, typeof AiBlockRenderer | typeof CommandResultRenderer>>}
 */
const COMMAND_RENDERERS = Object.freeze({ 'ai-block': AiBlockRenderer, 'command-result': CommandResultRenderer })

export class CommandPopup {
  // One command popup visible at a time: opening hides any other, and Escape
  // closes only the top-of-stack. A static registry (not a window.* bus).
  /** @type {CommandPopup[]} */ static #openStack = []
  static #top() { return CommandPopup.#openStack[CommandPopup.#openStack.length - 1] || null }

  /** @type {HTMLElement} */ #anchor
  /** @type {() => void} */ #onDelete
  /** @type {HTMLElement|null} */ #root = null
  /** @type {import('../block/renderers/block-renderer.js').BlockRenderer|null} */ #renderer = null
  /** @type {import('../block/sieve-block.js').SieveBlock|null} */ #block = null
  /** @type {CommandMeta} */ #meta = { cmd: '', text: '' }
  /** @type {HTMLElement|null} */ #bodyEl = null
  /** @type {HTMLElement|null} */ #titleEl = null
  /** @type {Array<() => void>} */ #unlisten = []

  /**
   * @param {{ anchor: HTMLElement, onDelete: () => void }} options
   */
  constructor({ anchor, onDelete }) {
    this.#anchor = anchor
    this.#onDelete = onDelete
  }

  get visible() { return !!this.#root }

  /**
   * @param {import('../block/sieve-block.js').SieveBlock|null} block
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
          this.#flashCopied(btn)
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
    // target-phase handler, so when a popup is on top of the stack, Escape is
    // consumed here (stopImmediatePropagation) before the Ask-panel textarea's
    // own keydown handler can fire #dismiss() and silently unpin the panel.
    // Precedent: command-hint-popover.js. removeEventListener MUST pass the same
    // capture flag or it silently no-ops.
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('click', onClick)
    this.#unlisten = [
      () => document.removeEventListener('keydown', onKey, true),
      () => document.removeEventListener('click', onClick)
    ]
  }

  /**
   * @param {import('../block/sieve-block.js').SieveBlock|null} block
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

    // No envelope yet: a block-less terminal error → generic error view; else the
    // generic pending view (spinner + command name).
    if (!this.#block) {
      this.#renderer = null
      if (this.#meta.error) this.#renderStatus(true, '⚠', 'Command failed', this.#meta.error)
      else this.#renderStatus(false, null, '/' + this.#meta.cmd + ' is working…', this.#meta.text)
      return
    }

    // Resolve the kind's renderer; an unknown kind gets a safe generic view.
    const RendererClass = COMMAND_RENDERERS[this.#block.kind]
    if (!RendererClass) {
      this.#renderer = null
      this.#renderStatus(true, '⚠', 'Unsupported result kind', this.#block.kind)
      return
    }

    if (this.#renderer instanceof RendererClass) {
      this.#renderer.update(this.#block)
    } else {
      this.#bodyEl.innerHTML = ''
      this.#renderer = new RendererClass(this.#block)
      const rendered = this.#renderer.render()
      if (rendered) this.#bodyEl.appendChild(rendered)
    }
  }

  /**
   * Generic status view (pending spinner OR terminal error/unsupported): a
   * centred icon-or-spinner + a label + an optional detail line.
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
   * The answer text to copy — pulled from the kind renderer's copyText()
   * accessor (a command result yields its raw `primary` value; other kinds fall
   * back to their markdown body). Empty when no renderer is mounted (pending /
   * generic view).
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
    this.#renderer = null
    this.#bodyEl = null
    this.#titleEl = null
  }

  destroy() {
    this.hide()
  }

  /**
   * Copy micro-feedback: flashes the button green + "Copied ✓" for 1.2s, then
   * restores it. The scrimless popup has no toast channel, so the button is
   * the confirmation surface.
   * @param {HTMLButtonElement} btn
   */
  #flashCopied(btn) {
    if (btn.classList.contains('command-popup__btn--copied')) return
    const label = btn.textContent
    btn.classList.add('command-popup__btn--copied')
    btn.textContent = 'Copied ✓'
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
