// @ts-check
// A line of chrome that says what came of the reader's last action, in place and
// briefly: it clears itself, unless it says an action is still under way.

export class ActionStatus {
  /** How long a result is shown. */
  static SHOWN_MS = 4000

  /** @type {HTMLElement} */ #el
  /** @type {ReturnType<typeof setTimeout>|null} */ #timer = null

  constructor() {
    this.#el = document.createElement('span')
    this.#el.className = 'ink-page__status'
    this.#el.setAttribute('role', 'status')
    this.#el.hidden = true
  }

  /** @returns {HTMLElement} */
  get element() { return this.#el }

  /** @returns {string} what it says; '' when it says nothing */
  get text() { return this.#el.hidden ? '' : String(this.#el.textContent) }

  /**
   * Says `text` until the next call: for an action under way.
   * @param {string} text
   */
  showPending(text) {
    this.#show(text)
  }

  /**
   * Says `text` for SHOWN_MS: for what came of an action.
   * @param {string} text
   */
  showResult(text) {
    this.#show(text)
    this.#timer = setTimeout(() => this.clear(), ActionStatus.SHOWN_MS)
  }

  /** Says nothing. */
  clear() {
    this.#stopTimer()
    this.#el.hidden = true
    this.#el.textContent = ''
  }

  /** @param {string} text */
  #show(text) {
    this.#stopTimer()
    this.#el.textContent = text
    this.#el.hidden = false
  }

  #stopTimer() {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }
}
