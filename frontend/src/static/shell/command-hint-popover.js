// @ts-check
// command-hint-popover.js — Slash command hint popover for Ask Panel input.
// Renders autocomplete candidates when typing `/` in the textarea and supports
// keyboard navigation (ArrowUp, ArrowDown, Tab, Enter, Escape).

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
    el.style.cssText = 'display: none; position: absolute; bottom: 100%; left: 0; right: 0; max-height: 180px; overflow-y: auto; background: var(--theme-bgDark, #1a1b26); border: 1px solid var(--theme-border2, #24283b); border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.4); z-index: 100; margin-bottom: 4px;'

    const parent = this.#textarea.parentElement
    if (parent) {
      if (getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative'
      }
      parent.appendChild(el)
    }
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
      item.className = 'command-hint-item' + (idx === this.#selectedIndex ? ' is-active' : '')
      item.style.cssText = 'padding: 6px 12px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--theme-fg, #a9b1d6);'
      if (idx === this.#selectedIndex) {
        item.style.background = 'var(--theme-bgHighlight, #292e42)'
        item.style.color = 'var(--theme-accentCyan, #7dcfff)'
      }

      const nameEl = document.createElement('span')
      nameEl.style.fontWeight = '600'
      nameEl.textContent = '/' + cmd.name

      const descEl = document.createElement('span')
      descEl.style.opacity = '0.7'
      descEl.style.marginLeft = '8px'
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

  show() {
    if (this.#popoverEl) this.#popoverEl.style.display = 'block'
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
