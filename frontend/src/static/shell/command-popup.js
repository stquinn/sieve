// @ts-check
// command-popup.js — the detached-answer popup (#55): the THIRD host of
// AiBlockRenderer (note lens / bare harness / here). An appearance, not an
// interruption: never steals focus. Hide parks the answer on its badge;
// Delete (via onDelete) removes it from existence.

import { AiBlockRenderer } from '../block/renderers/ai-block-renderer.js'

export class CommandPopup {
  /** @type {HTMLElement} */ #anchor
  /** @type {() => void} */ #onDelete
  /** @type {HTMLElement|null} */ #root = null
  /** @type {AiBlockRenderer|null} */ #renderer = null
  /** @type {import('../block/sieve-block.js').SieveBlock|null} */ #block = null
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
   * @param {import('../block/sieve-block.js').SieveBlock} block
   */
  show(block) {
    this.#block = block
    if (this.#root) {
      this.update(block)
      return
    }
    const root = document.createElement('div')
    this.#root = root
    root.className = 'command-popup'
    root.style.cssText = [
      'position: fixed',
      'z-index: 1000',
      'width: min(85vw, 680px)',
      'max-height: min(75vh, 520px)',
      'background: var(--theme-bgAlt, #1f2335)',
      'border: 1px solid var(--theme-border2, #3b4261)',
      'border-radius: 10px',
      'box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6)',
      'display: flex',
      'flex-direction: column',
      'overflow: hidden',
      'backdrop-filter: blur(16px)'
    ].join('; ') + ';'

    const bar = document.createElement('div')
    bar.className = 'command-popup__bar'
    bar.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; background: var(--theme-bgDark, #1a1b26); border-bottom: 1px solid var(--theme-border2, #24283b);'

    const titleEl = document.createElement('span')
    titleEl.className = 'command-popup__title'
    titleEl.style.cssText = 'font-size: 12px; font-weight: 700; color: var(--theme-accentCyan, #7dcfff); text-transform: uppercase; letter-spacing: 0.08em;'
    const cmdName = (block && block.payload && block.payload.type) ? String(block.payload.type) : 'BTW'
    titleEl.textContent = '/' + cmdName.toLowerCase() + ' answer'

    const actionsEl = document.createElement('div')
    actionsEl.style.cssText = 'display: flex; align-items: center; gap: 8px;'

    actionsEl.append(
      this.#barButton('copy', 'Copy answer', 'Copy', () => {
        const text = String((this.#block && this.#block.payload && this.#block.payload.response) || '')
        if (navigator.clipboard) navigator.clipboard.writeText(text)
      }),
      this.#barButton('hide', 'Hide (answer stays on the badge)', 'Hide', () => this.hide()),
      this.#barButton('delete', 'Delete', 'Dismiss', () => this.#onDelete())
    )

    bar.append(titleEl, actionsEl)

    const body = document.createElement('div')
    body.className = 'command-popup__body'
    body.style.cssText = 'flex: 1; min-height: 0; overflow-y: auto; padding: 18px 20px; user-select: text;'

    this.#renderer = new AiBlockRenderer(block)
    const rendered = this.#renderer.render()
    if (rendered) body.appendChild(rendered)

    root.append(bar, body)
    document.body.appendChild(root)
    this.#position(root)

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
   * @param {import('../block/sieve-block.js').SieveBlock} block
   */
  update(block) {
    this.#block = block
    if (this.#renderer) {
      this.#renderer.update(block)
    } else {
      this.show(block)
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
    b.style.cssText = 'background: transparent; border: 1px solid var(--theme-border2, #24283b); color: var(--theme-textDim, #9aa5ce); cursor: pointer; padding: 3px 10px; border-radius: 4px; font-size: 11px; font-weight: 500; transition: background 0.15s ease;'
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

  /**
   * @param {HTMLElement} root
   */
  #position(root) {
    const r = this.#anchor.getBoundingClientRect()
    root.style.position = 'fixed'
    root.style.bottom = Math.max(40, window.innerHeight - r.top + 6) + 'px'
    const left = Math.max(16, Math.min(r.left, window.innerWidth - 700))
    root.style.left = left + 'px'
    root.style.right = 'auto'
  }
}
