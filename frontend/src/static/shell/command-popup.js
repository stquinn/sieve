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
    root.style.cssText = 'position: fixed; z-index: 1000; width: 480px; max-width: 90vw; max-height: 400px; background: var(--theme-bgDark, #1a1b26); border: 1px solid var(--theme-border2, #24283b); border-radius: 8px; box-shadow: 0 8px 32px rgba(0,0,0,0.5); display: flex; flex-direction: column; overflow: hidden;'

    const bar = document.createElement('div')
    bar.className = 'command-popup__bar'
    bar.style.cssText = 'display: flex; justify-content: flex-end; gap: 6px; padding: 6px 10px; background: var(--theme-bg, #1a1b26); border-bottom: 1px solid var(--theme-border2, #24283b); font-size: 12px;'
    
    bar.append(
      this.#barButton('copy', 'Copy answer', () => {
        const text = String((this.#block && this.#block.payload && this.#block.payload.response) || '')
        if (navigator.clipboard) navigator.clipboard.writeText(text)
      }),
      this.#barButton('hide', 'Hide (answer stays on the badge)', () => this.hide()),
      this.#barButton('delete', 'Delete', () => this.#onDelete())
    )

    const body = document.createElement('div')
    body.className = 'command-popup__body'
    body.style.cssText = 'flex: 1; min-height: 0; overflow-y: auto; padding: 12px; user-select: text;'

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
   * @param {string} label
   * @param {() => void} onClick
   */
  #barButton(kind, label, onClick) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'command-popup__btn command-popup__btn--' + kind
    b.setAttribute('aria-label', label)
    b.title = label
    b.textContent = kind === 'copy' ? '📋' : kind === 'hide' ? '─' : '✕'
    b.style.cssText = 'background: transparent; border: none; color: var(--theme-muted, #565f89); cursor: pointer; padding: 2px 6px; border-radius: 4px; font-size: 12px;'
    if (kind === 'delete') b.style.color = 'var(--theme-danger, #f7768e)'
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
    root.style.bottom = Math.max(8, window.innerHeight - r.top + 8) + 'px'
    root.style.right = Math.max(8, window.innerWidth - r.right) + 'px'
  }
}
