// @ts-check
// trigger-popover.js — TriggerPopover: the composer's trigger-driven hint
// picker. Positions fixed above the Ask Panel as a visual extension
// (z-index: 1000) and handles keyboard navigation (ArrowUp, ArrowDown, Tab,
// Enter, Escape).
//
// GENERALISED FROM CommandHintPopover (#74 P4). It used to hard-code three
// things: the `/` character, `commandService.list()`, and `'/' + name + ' '` on
// accept. Those three are now a PROVIDER (shell/trigger-providers.js) and the
// popover keeps only what every trigger shares — the keyboard model, the
// positioning, the scroll-into-view fix (#63), the blur dismissal, and the
// token-under-caret scan. Two providers are registered by the Ask panel: `/` →
// CommandService (behaviour unchanged) and `@` → mentions.
//
// ONE MECHANISM, NOT TWO CATEGORIES. The scan does not branch on "commands
// start the line, mentions appear mid-text": it walks back from the caret to the
// nearest trigger character and asks THAT provider whether its boundary rule is
// satisfied. `/`'s rule is "index 0"; `@`'s is "start of text or after
// whitespace". Same code path, different predicate.

import { ContractViolation } from '../block/sieve-block.js'
import { TriggerProvider } from './trigger-providers.js'

export class TriggerPopover {
  /** @type {HTMLTextAreaElement} */ #textarea
  /** @type {Map<string, TriggerProvider>} trigger character → the ONE provider claiming it */ #providers = new Map()
  /** @type {HTMLElement|null} */ #popoverEl = null
  /** @type {any[]} the candidates currently listed */ #items = []
  /** @type {number} */ #selectedIndex = 0
  /** @type {import('./trigger-providers.js').TriggerToken|null} the token the listed candidates answer */ #token = null
  /** @type {number} monotonic query counter — an async answer that is not the
   *  newest is DROPPED (a slow round-trip must never overwrite a newer list) */ #seq = 0
  /** @type {any} */ #onInput
  /** @type {any} */ #onKeyDown
  /** @type {any} */ #onBlur

  /**
   * @param {HTMLTextAreaElement} textarea
   * @param {TriggerProvider[]} providers  one per trigger character
   */
  constructor(textarea, providers) {
    this.#textarea = textarea
    for (const provider of providers || []) {
      if (!(provider instanceof TriggerProvider)) {
        throw new ContractViolation('TriggerPopover: providers must extend TriggerProvider')
      }
      const trigger = provider.trigger
      if (this.#providers.has(trigger)) {
        throw new ContractViolation('TriggerPopover: trigger already claimed: ' + trigger)
      }
      this.#providers.set(trigger, provider)
    }
    this.#createPopoverDom()
    this.#wireEvents()
  }

  // ── The token under the caret ──────────────────────────────────────────────

  /**
   * The token the caret currently sits in, or null. Walks BACK from the caret to
   * the first trigger character, stopping at whitespace — so a completed mention
   * ("@Auth Design ") no longer matches, and the NEAREST `@` wins when a message
   * carries several.
   *
   * Static and public because it is the piece worth pinning in tests directly;
   * the popover is its only production caller.
   * @param {string} value @param {number} caret
   * @param {Map<string, TriggerProvider>} providers
   * @returns {import('./trigger-providers.js').TriggerToken|null}
   */
  static scanToken(value, caret, providers) {
    const text = value || ''
    const end = Math.max(0, Math.min(caret == null ? text.length : caret, text.length))
    for (let i = end - 1; i >= 0; i--) {
      const ch = text.charAt(i)
      if (/\s/.test(ch)) return null
      const provider = providers.get(ch)
      if (!provider) continue
      const before = i > 0 ? text.charAt(i - 1) : ''
      if (!provider.acceptsBoundary(before, i)) return null
      return Object.freeze({ provider: provider, start: i, end: end, prefix: text.slice(i + 1, end) })
    }
    return null
  }

  // ── DOM + events ───────────────────────────────────────────────────────────

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
    this.#textarea.addEventListener('keydown', this.#onKeyDown, true)
    this.#textarea.addEventListener('blur', this.#onBlur)
  }

  #handleInput() {
    const caret = this.#textarea.selectionStart
    const token = TriggerPopover.scanToken(this.#textarea.value, caret, this.#providers)
    if (!token) {
      this.#token = null
      this.hide()
      return
    }
    this.#token = token
    const seq = ++this.#seq
    const answer = token.provider.search(token.prefix)
    // A provider that can enumerate locally answers SYNCHRONOUSLY, and stays
    // synchronous end-to-end — that is what keeps `/` byte-identical. One that
    // must ask Go answers with a promise, guarded by the sequence number.
    if (answer && typeof (/** @type {any} */ (answer).then) === 'function') {
      /** @type {Promise<any[]>} */ (answer).then((items) => {
        if (seq === this.#seq) this.#present(items)
      })
      return
    }
    this.#present(/** @type {any[]} */ (answer) || [])
  }

  /** Lists `items`, or hides when there is nothing to offer. @param {any[]} items */
  #present(items) {
    this.#items = items || []
    if (this.#items.length === 0) {
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
      e.stopPropagation()
      e.stopImmediatePropagation()
      this.#selectedIndex = (this.#selectedIndex + 1) % this.#items.length
      this.#render()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      this.#selectedIndex = (this.#selectedIndex - 1 + this.#items.length) % this.#items.length
      this.#render()
    } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      if (this.#items.length > 0 && this.#selectedIndex >= 0 && this.#selectedIndex < this.#items.length) {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        this.#acceptCandidate(this.#items[this.#selectedIndex])
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      this.hide()
    }
  }

  #handleBlur() {
    setTimeout(() => this.hide(), 150)
  }

  /**
   * Hands an accepted candidate back to the provider that offered it, together
   * with the token it answers — the popover never knows what a completion means.
   * @param {any} candidate
   */
  #acceptCandidate(candidate) {
    const token = this.#token
    if (!token) return
    token.provider.accept(candidate, token, this.#textarea)
    this.hide()
  }

  #render() {
    if (!this.#popoverEl) return
    const token = this.#token
    if (!token) return
    this.#popoverEl.innerHTML = ''
    this.#items.forEach((item, idx) => {
      const row = document.createElement('div')
      const isActive = idx === this.#selectedIndex
      row.className = 'command-hint-item' + (isActive ? ' is-active' : '')
      row.style.cssText = [
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

      row.appendChild(token.provider.render(item))

      row.addEventListener('mousedown', (e) => {
        e.preventDefault()
        this.#acceptCandidate(item)
      })

      this.#popoverEl?.appendChild(row)
    })

    // Keyboard navigation has to carry the viewport with it (#63). Two things
    // conspire without this: #render() clears innerHTML, which resets the
    // container's scrollTop to 0, and nothing ever scrolls the active row into
    // view — so arrowing past the visible rows left the selection below the fold,
    // appearing to slide under the ask panel (the popover is anchored bottom-up
    // against the panel's top edge). The wheel worked only because it doesn't
    // re-render. 'nearest' scrolls the minimum needed, so it stays still while
    // the selection is already visible instead of recentring on every keypress.
    const activeEl = this.#popoverEl.querySelector('.command-hint-item.is-active')
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' })
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
    this.#textarea.removeEventListener('keydown', this.#onKeyDown, true)
    this.#textarea.removeEventListener('blur', this.#onBlur)
    if (this.#popoverEl && this.#popoverEl.parentElement) {
      this.#popoverEl.parentElement.removeChild(this.#popoverEl)
    }
  }
}
