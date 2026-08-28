// @ts-check
// A TriggerHost over a real <textarea> — the popover suites' convenient host
// double. This WAS the Ask panel's production host until #118 replaced the
// textarea socket with the composer lens; it survives here because a textarea
// is still the simplest complete host to exercise popover mechanics over.

import { TriggerHost } from '../../src/static/shell/trigger-host.js'
import { TriggerProvider } from '../../src/static/shell/trigger-providers.js'
import { ContractViolation } from '../../src/static/contract/sieve-block.js'

export class TextareaHost extends TriggerHost {
  /** @type {HTMLTextAreaElement} */ #textarea

  /** @param {HTMLTextAreaElement} textarea */
  constructor(textarea) {
    super()
    if (!textarea || typeof textarea.value !== 'string') {
      throw new ContractViolation('TextareaHost requires a textarea')
    }
    this.#textarea = textarea
  }

  /** @returns {HTMLElement} */
  anchorElement() { return this.#textarea }

  /** CAPTURE PHASE, deliberately: the picker owns ArrowUp/Down, Tab, Enter and
   *  Escape while open. @param {(e: KeyboardEvent) => void} fn @returns {() => void} */
  onKeyDown(fn) {
    /** @param {Event} e */
    const handler = (e) => fn(/** @type {KeyboardEvent} */ (e))
    this.#textarea.addEventListener('keydown', handler, true)
    return () => this.#textarea.removeEventListener('keydown', handler, true)
  }

  /** @param {() => void} fn @returns {() => void} */
  onDismiss(fn) {
    const handler = () => fn()
    this.#textarea.addEventListener('blur', handler)
    return () => this.#textarea.removeEventListener('blur', handler)
  }

  /** @param {() => void} fn @returns {() => void} */
  onInput(fn) {
    const handler = () => fn()
    this.#textarea.addEventListener('input', handler)
    return () => this.#textarea.removeEventListener('input', handler)
  }

  /**
   * @param {Map<string, import('../../src/static/shell/trigger-providers.js').TriggerProvider>} providers
   * @returns {import('../../src/static/shell/trigger-providers.js').TriggerToken|null}
   */
  tokenAtCaret(providers) {
    return TriggerProvider.scanToken(this.#textarea.value, this.#textarea.selectionStart, providers)
  }

  /** @param {number} index @returns {string} */
  textAfter(index) { return this.#textarea.value.slice(index) }

  /** Substitutes `text` for [start, end), caret after it, focused; dispatches
   *  `input` for listeners riding the textarea.
   *  @param {number} start @param {number} end @param {string} text */
  replaceRange(start, end, text) {
    const value = this.#textarea.value
    this.#textarea.value = value.slice(0, start) + text + value.slice(end)
    this.#textarea.focus()
    const caret = start + text.length
    this.#textarea.setSelectionRange(caret, caret)
    this.#textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
  }
}
