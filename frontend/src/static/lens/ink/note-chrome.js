// @ts-check
// The chrome every surface of a Digital Note's lens shows above what it draws:
// the note's name, the device it was written on and a status line; the page
// turning — previous, the page's place, next, and one dot per page or, past
// twelve pages, a count of the pages with unseen ink; and the switch between the
// lens's modes. Its buttons say what they do as data — `data-ink-action` prev,
// next, unseen or mode (with `data-ink-mode`), and `data-ink-page` a dot's page —
// and the surface holding it acts on their clicks. Styles are PageSurface's.

import { ActionStatus } from './action-status.js'

/** @typedef {Readonly<{id: string}>} NotePage */

export class NoteChrome {
  /** The most pages the pager shows a dot each for; past it the pager counts the unseen ones. */
  static MAX_DOTS = 12

  /** The lens's modes: the page as it was written, and the page read. */
  static Mode = Object.freeze({ PAGE: 'page', READING: 'reading' })

  /** The modes the switch offers, in order, and what each is called. */
  static MODES = Object.freeze([
    Object.freeze({ mode: NoteChrome.Mode.PAGE, label: 'Page', title: 'Show the page as it was written' }),
    Object.freeze({ mode: NoteChrome.Mode.READING, label: 'Reading', title: 'Show the page read as text and diagrams' }),
  ])

  /** @type {HTMLElement} */ #el
  /** @type {HTMLElement} */ #heading
  /** @type {HTMLElement} */ #title
  /** @type {HTMLElement} */ #device
  /** @type {ActionStatus} */ #status = new ActionStatus()
  /** @type {HTMLElement} */ #pager
  /** @type {HTMLElement} the page turning: previous, position, next and the dots */ #paging
  /** @type {HTMLElement} */ #position
  /** @type {HTMLElement} */ #dots
  /** @type {HTMLButtonElement} */ #prev
  /** @type {HTMLButtonElement} */ #next
  /** @type {HTMLElement} */ #actions

  /** @param {string} mode the mode of the surface this chrome is shown by */
  constructor(mode) {
    this.#el = this.#element('header', 'ink-page__chrome')
    this.#heading = this.#element('div', 'ink-page__heading')
    this.#title = this.#element('span', 'ink-page__title')
    this.#device = this.#element('span', 'ink-page__device')
    this.#heading.append(this.#title, this.#device, this.#status.element)
    this.#pager = this.#element('nav', 'ink-page__pager')
    this.#pager.setAttribute('aria-label', 'Pages')
    this.#paging = this.#element('span', 'ink-page__pages')
    this.#prev = this.#button('prev', '‹', 'Previous page')
    this.#position = this.#element('span', 'ink-page__position')
    this.#next = this.#button('next', '›', 'Next page')
    this.#dots = this.#element('span', 'ink-page__dots')
    this.#paging.append(this.#prev, this.#position, this.#next, this.#dots)
    this.#pager.append(this.#paging)
    const modes = this.#element('span', 'ink-page__modes')
    modes.setAttribute('role', 'group')
    modes.setAttribute('aria-label', 'Show')
    for (const m of NoteChrome.MODES) {
      const button = this.#button('mode', m.label, '')
      button.dataset.inkMode = m.mode
      button.title = m.title
      button.setAttribute('aria-pressed', String(m.mode === mode))
      modes.append(button)
    }
    this.#actions = this.#element('span', 'ink-page__actions')
    this.#el.append(this.#heading, this.#pager, modes, this.#actions)
  }

  /** @returns {HTMLElement} */
  get element() { return this.#el }

  /** @returns {ActionStatus} the chrome's status line */
  get status() { return this.#status }

  /** @returns {HTMLElement} the note's name as shown */
  get titleElement() { return this.#title }

  /** @param {...HTMLElement} els shown after the heading */
  addNotice(...els) { this.#heading.after(...els) }

  /** @param {...HTMLElement} els shown after the page turning, in the pager */
  addToPager(...els) { this.#pager.append(...els) }

  /** @param {...HTMLElement} els shown at the chrome's end */
  addActions(...els) { this.#actions.append(...els) }

  /**
   * @param {string} name what the note is called
   * @param {string} device the device it was written on; '' when unknown
   */
  setNote(name, device) {
    this.#title.textContent = name
    this.#device.textContent = device
  }

  /**
   * Draws the page turning for `pages`, `shown` among them, `unseen` marked.
   * @param {ReadonlyArray<NotePage>} pages
   * @param {string|null} shown
   * @param {ReadonlySet<string>} unseen
   * @param {boolean} hidden whether the page turning is not shown at all
   */
  renderPager(pages, shown, unseen, hidden) {
    const index = pages.findIndex((page) => page.id === shown)
    const count = pages.length
    this.#paging.hidden = hidden
    this.#position.textContent = count ? `${index + 1} / ${count}` : '0 / 0'
    this.#prev.disabled = index <= 0
    this.#next.disabled = index < 0 || index >= count - 1
    this.#dots.replaceChildren(...(count > NoteChrome.MAX_DOTS ? this.#unseenCount(pages, unseen) : this.#pageDots(pages, shown, unseen)))
  }

  /** @param {ReadonlyArray<NotePage>} pages @param {string|null} shown @param {ReadonlySet<string>} unseen
   *  @returns {HTMLButtonElement[]} one dot per page */
  #pageDots(pages, shown, unseen) {
    return pages.map((page, i) => {
      const dot = this.#button('', '', `Page ${i + 1}`)
      dot.className = 'ink-page__dot'
      dot.dataset.inkPage = page.id
      if (page.id === shown) dot.setAttribute('aria-current', 'page')
      if (unseen.has(page.id)) dot.dataset.unseen = ''
      return dot
    })
  }

  /** @param {ReadonlyArray<NotePage>} pages @param {ReadonlySet<string>} unseen
   *  @returns {HTMLButtonElement[]} the count of pages with unseen ink, as the button that
   *  shows the next of them; none while there are none */
  #unseenCount(pages, unseen) {
    const count = pages.filter((page) => unseen.has(page.id)).length
    if (!count) return []
    const button = this.#button('unseen', `${count} unseen`, `Show the next of ${count} pages with unseen ink`)
    button.className = 'ink-page__unseen'
    return [button]
  }

  /** @param {string} tag @param {string} className @returns {HTMLElement} */
  #element(tag, className) {
    const el = document.createElement(tag)
    el.className = className
    return el
  }

  /** @param {string} action @param {string} text @param {string} label @returns {HTMLButtonElement} */
  #button(action, text, label) {
    const button = document.createElement('button')
    button.type = 'button'
    if (action) button.dataset.inkAction = action
    button.textContent = text
    if (label) button.setAttribute('aria-label', label)
    return button
  }
}
