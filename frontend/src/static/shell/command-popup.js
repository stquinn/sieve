// @ts-check
// command-popup.js — the detached-answer popup (#55): the THIRD host of
// AiBlockRenderer (note lens / bare harness / here). An appearance, not an
// interruption: never steals focus. Hide parks the answer on its badge;
// Delete (via onDelete) removes it from existence.
//
// The pending state is KIND-AGNOSTIC: when block is null the popup renders a
// generic spinner + command name. Only when a real block arrives (status
// COMPLETE/ERROR) does the popup use AiBlockRenderer for the body content.

import { AiBlockRenderer } from '../block/renderers/ai-block-renderer.js'

export class CommandPopup {
  /** @type {HTMLElement} */ #anchor
  /** @type {() => void} */ #onDelete
  /** @type {HTMLElement|null} */ #root = null
  /** @type {AiBlockRenderer|null} */ #renderer = null
  /** @type {import('../block/sieve-block.js').SieveBlock|null} */ #block = null
  /** @type {{cmd: string, text: string}} */ #meta = { cmd: '', text: '' }
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
   * @param {{cmd: string, text: string}} [meta]
   */
  show(block, meta) {
    this.#block = block
    if (meta) this.#meta = meta
    if (this.#root) {
      this.update(block, meta)
      return
    }
    const root = document.createElement('div')
    this.#root = root
    root.className = 'command-popup'
    root.style.cssText = [
      'position: fixed',
      'z-index: 1000',
      'top: 50%',
      'left: 50%',
      'transform: translate(-50%, -50%)',
      'width: min(90vw, 920px)',
      'height: min(80vh, 640px)',
      'background: var(--theme-bgAlt, #1f2335)',
      'border: 1px solid var(--theme-border2, #3b4261)',
      'border-radius: 12px',
      'box-shadow: 0 20px 60px rgba(0, 0, 0, 0.65)',
      'display: flex',
      'flex-direction: column',
      'overflow: hidden',
      'backdrop-filter: blur(16px)'
    ].join('; ') + ';'

    const bar = document.createElement('div')
    bar.className = 'command-popup__bar'
    bar.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 12px 20px; background: var(--theme-bgDark, #1a1b26); border-bottom: 1px solid var(--theme-border2, #24283b);'

    this.#titleEl = document.createElement('span')
    this.#titleEl.className = 'command-popup__title'
    this.#titleEl.style.cssText = 'font-size: 13px; font-weight: 700; color: var(--theme-accentCyan, #7dcfff); text-transform: uppercase; letter-spacing: 0.08em;'
    this.#renderTitle()

    const actionsEl = document.createElement('div')
    actionsEl.style.cssText = 'display: flex; align-items: center; gap: 10px;'

    actionsEl.append(
      this.#barButton('copy', 'Copy answer', 'Copy', () => {
        const text = String((this.#block && this.#block.payload && this.#block.payload.response) || '')
        if (navigator.clipboard) navigator.clipboard.writeText(text)
      }),
      this.#barButton('hide', 'Hide (answer stays on the badge)', 'Hide', () => this.hide()),
      this.#barButton('delete', 'Delete', 'Dismiss', () => this.#onDelete())
    )

    bar.append(this.#titleEl, actionsEl)

    this.#bodyEl = document.createElement('div')
    this.#bodyEl.className = 'command-popup__body'
    this.#bodyEl.style.cssText = 'flex: 1; min-height: 0; overflow-y: auto; padding: 24px 28px; user-select: text; font-size: 15px; line-height: 1.65;'

    this.#renderBody()

    root.append(bar, this.#bodyEl)
    document.body.appendChild(root)

    /** @param {KeyboardEvent} e */
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        this.hide()
      }
    }
    /** @param {MouseEvent} e */
    const onClick = (e) => {
      const target = /** @type {Node} */ (e.target)
      if (root && !root.contains(target) && target !== this.#anchor && !this.#anchor.contains(target)) {
        this.hide()
      }
    }

    document.addEventListener('keydown', onKey)
    document.addEventListener('click', onClick)
    this.#unlisten = [
      () => document.removeEventListener('keydown', onKey),
      () => document.removeEventListener('click', onClick)
    ]
  }

  /**
   * @param {import('../block/sieve-block.js').SieveBlock|null} block
   * @param {{cmd: string, text: string}} [meta]
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
    const isPending = !this.#block || (this.#block.payload && this.#block.payload.status === 'PENDING')
    this.#titleEl.textContent = '/' + cmdName + (isPending ? ' …' : ' answer')
  }

  #renderBody() {
    if (!this.#bodyEl) return
    const isPending = !this.#block

    if (isPending) {
      // Generic pending view: spinner + command name + prompt
      this.#renderer = null
      this.#bodyEl.innerHTML = ''
      const wrap = document.createElement('div')
      wrap.style.cssText = 'display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 16px; color: var(--theme-textDim, #565f89);'

      const spinner = document.createElement('div')
      spinner.className = 'status-bar__spinner'
      spinner.style.cssText = 'width: 20px; height: 20px; border-width: 2px;'

      const label = document.createElement('div')
      label.style.cssText = 'font-size: 14px; font-weight: 500; letter-spacing: 0.04em;'
      label.textContent = '/' + this.#meta.cmd + ' is working…'

      const prompt = document.createElement('div')
      prompt.style.cssText = 'font-size: 12px; max-width: 400px; text-align: center; opacity: 0.6;'
      prompt.textContent = this.#meta.text || ''

      wrap.append(spinner, label)
      if (this.#meta.text) wrap.appendChild(prompt)
      this.#bodyEl.appendChild(wrap)
      return
    }

    // We have a real block — render it with AiBlockRenderer
    if (this.#renderer) {
      this.#renderer.update(this.#block)
    } else {
      this.#bodyEl.innerHTML = ''
      this.#renderer = new AiBlockRenderer(this.#block)
      const rendered = this.#renderer.render()
      if (rendered) this.#bodyEl.appendChild(rendered)
    }
  }

  hide() {
    this.#unlisten.forEach((u) => u())
    this.#unlisten = []
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
   * @param {string} kind
   * @param {string} title
   * @param {string} text
   * @param {() => void} onClick
   */
  #barButton(kind, title, text, onClick) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'command-popup__btn command-popup__btn--' + kind
    b.setAttribute('aria-label', title)
    b.title = title
    b.textContent = text
    b.style.cssText = 'background: transparent; border: 1px solid var(--theme-border2, #24283b); color: var(--theme-textDim, #9aa5ce); cursor: pointer; padding: 4px 12px; border-radius: 6px; font-size: 12px; font-weight: 500; transition: all 0.15s ease;'
    if (kind === 'delete') {
      b.style.color = 'var(--theme-danger, #f7768e)'
      b.style.borderColor = 'color-mix(in srgb, var(--theme-danger, #f7768e) 40%, transparent)'
    }
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      onClick()
    })
    return b
  }
}
