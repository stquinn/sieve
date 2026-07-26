// @ts-check
// command-hint-popover.js — Slash command hint popover for Ask Panel input.
// Positions fixed above the Ask Panel as a visual extension (z-index: 1000)
// and handles keyboard navigation (ArrowUp, ArrowDown, Tab, Enter, Escape).

export class CommandHintPopover {
  /** @type {HTMLTextAreaElement} */ #textarea
  /** @type {import('../block/command-service.js').CommandService|{list: () => any[]}} */ #commandService
  /** @type {HTMLElement|null} */ #popoverEl = null
  /** @type {Array<{name: string, description: string}>} */ #filtered = []
  /** @type {number} */ #selectedIndex = 0
  /** @type {any} */ #onInput
  /** @type {any} */ #onKeyDown
  /** @type {any} */ #onBlur

  /**
   * @param {HTMLTextAreaElement} textarea
   * @param {import('../block/command-service.js').CommandService|{list: () => any[]}} commandService
   */
  constructor(textarea, commandService) {
    this.#textarea = textarea
    this.#commandService = commandService
    this.#createPopoverDom()
    this.#wireEvents()
  }

  #createPopoverDom() {
    const el = document.createElement('div')
    el.className = 'command-hint-popover'
    el.style.cssText = [
      'display: none',
      'position: fixed',
      'z-index: 1000',
      'max-height: 200px',
      'overflow-y: auto',
      'background: var(--theme-bgAlt, #1f2335)',
      'border: 1px solid var(--theme-border2, #3b4261)',
      'border-bottom: 1px solid var(--theme-border, #1a1b26)',
      'border-top-left-radius: 8px',
      'border-top-right-radius: 8px',
      'border-bottom-left-radius: 0',
      'border-bottom-right-radius: 0',
      'box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.45)',
      'box-sizing: border-box'
    ].join('; ') + ';'

    document.body.appendChild(el)
    this.#popoverEl = el
  }

  #wireEvents() {
    this.#onInput = this.#handleInput.bind(this)
    this.#onKeyDown = this.#handleKeyDown.bind(this)
    this.#onBlur = this.#handleBlur.bind(this)

    this.#textarea.addEventListener('input', this.#onInput)
    this.#textarea.addEventListener('keydown', this.#onKeyDown)
    this.#textarea.addEventListener('blur', this.#onBlur)
  }

  #handleInput() {
    const val = this.#textarea.value
    if (!val.startsWith('/')) {
      this.hide()
      return
    }

    const spaceIdx = val.indexOf(' ')
    if (spaceIdx >= 0) {
      this.hide()
      return
    }

    const prefix = val.slice(1).toLowerCase()
    const all = this.#commandService.list() || []
    this.#filtered = all.filter((c) => c.name.toLowerCase().startsWith(prefix))

    if (this.#filtered.length === 0) {
      this.hide()
      return
    }

    this.#selectedIndex = 0
    this.#render()
    this.show()
  }

  /**
   * @param {KeyboardEvent} e
   */
  #handleKeyDown(e) {
    if (!this.#popoverEl || this.#popoverEl.style.display === 'none') return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      this.#selectedIndex = (this.#selectedIndex + 1) % this.#filtered.length
      this.#render()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      this.#selectedIndex = (this.#selectedIndex - 1 + this.#filtered.length) % this.#filtered.length
      this.#render()
    } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      if (this.#filtered.length > 0 && this.#selectedIndex >= 0 && this.#selectedIndex < this.#filtered.length) {
        e.preventDefault()
        e.stopPropagation()
        this.#acceptCandidate(this.#filtered[this.#selectedIndex])
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      this.hide()
    }
  }

  #handleBlur() {
    setTimeout(() => this.hide(), 150)
  }

  /**
   * @param {{name: string, description: string}} candidate
   */
  #acceptCandidate(candidate) {
    this.#textarea.value = '/' + candidate.name + ' '
    this.#textarea.focus()
    this.hide()
  }

  #render() {
    if (!this.#popoverEl) return
    this.#popoverEl.innerHTML = ''
    this.#filtered.forEach((cmd, idx) => {
      const item = document.createElement('div')
      const isActive = idx === this.#selectedIndex
      item.className = 'command-hint-item' + (isActive ? ' is-active' : '')
      item.style.cssText = [
        'padding: 8px 14px',
        'cursor: pointer',
        'display: flex',
        'justify-content: space-between',
        'align-items: center',
        'font-size: 13px',
        'font-family: var(--theme-uiFont, system-ui, sans-serif)',
        'transition: background 0.1s ease',
        isActive
          ? 'background: color-mix(in srgb, var(--theme-accentPrimary, #7aa2f7) 16%, var(--theme-bgAlt, #1f2335)); border-left: 3px solid var(--theme-accentPrimary, #7aa2f7); color: var(--theme-text, #c0caf5);'
          : 'background: transparent; border-left: 3px solid transparent; color: var(--theme-textDim, #9aa5ce);'
      ].join('; ')

      const nameEl = document.createElement('span')
      nameEl.className = 'command-hint__name'
      nameEl.style.cssText = 'font-family: var(--theme-monoFont, monospace); font-weight: 600; color: var(--theme-accentPrimary, #7aa2f7);'
      nameEl.textContent = '/' + cmd.name

      const descEl = document.createElement('span')
      descEl.className = 'command-hint__desc'
      descEl.style.cssText = 'font-size: 12px; opacity: 0.75; margin-left: 12px;'
      descEl.textContent = cmd.description || ''

      item.appendChild(nameEl)
      item.appendChild(descEl)

      item.addEventListener('mousedown', (e) => {
        e.preventDefault()
        this.#acceptCandidate(cmd)
      })

      this.#popoverEl.appendChild(item)
    })
  }

  #position() {
    if (!this.#popoverEl) return
    const panel = this.#textarea.closest('#ask-panel') || this.#textarea.parentElement || this.#textarea
    const rect = panel.getBoundingClientRect()

    this.#popoverEl.style.left = Math.max(0, rect.left) + 'px'
    this.#popoverEl.style.width = (rect.width || window.innerWidth) + 'px'
    this.#popoverEl.style.bottom = Math.max(0, window.innerHeight - rect.top) + 'px'
  }

  show() {
    if (this.#popoverEl) {
      this.#position()
      this.#popoverEl.style.display = 'block'
    }
  }

  hide() {
    if (this.#popoverEl) this.#popoverEl.style.display = 'none'
  }

  destroy() {
    this.#textarea.removeEventListener('input', this.#onInput)
    this.#textarea.removeEventListener('keydown', this.#onKeyDown)
    this.#textarea.removeEventListener('blur', this.#onBlur)
    if (this.#popoverEl && this.#popoverEl.parentElement) {
      this.#popoverEl.parentElement.removeChild(this.#popoverEl)
    }
  }
}
