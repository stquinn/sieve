// @ts-check
// The toolbar's widget family. Each widget owns its own element and a
// `refresh()` that re-reads whatever state it reflects; the toolbar that shows
// them appends `el` and calls `refresh()`, and knows nothing else about them.
//
// A ToolbarButton carries its own onClick closure (no delegation, no command
// string) and optional active()/enabled() closures. A ToolbarLabel is text that
// is not a button. A ToolbarSeparator divides two sections. A ButtonGroup is a
// `.tb-group` of widgets with a refresh() fanout. A ToolbarSelect is a
// drop-down of choices. Icons arrive pre-resolved as
// `iconHtml`, which keeps every widget content-blind.

/**
 * Where in the toolbar's strip an item the toolbar shows is drawn: at its
 * start, in its middle or at its end. An item that says nothing is at the start.
 */
export const ToolbarPlace = Object.freeze({ START: 'start', MIDDLE: 'middle', END: 'end' })

/** @typedef {typeof ToolbarPlace[keyof typeof ToolbarPlace]} ToolbarPlaceName */

/**
 * What a toolbar shows: an element, where it is drawn, and a refresh of the
 * state it reflects.
 * @typedef {{ readonly el: HTMLElement, readonly place?: ToolbarPlaceName, refresh(): void }} ToolbarItem
 */

/**
 * @typedef {object} ToolbarButtonSpec
 * @property {string}  [id] the button's DOM id
 * @property {string}  [iconHtml] pre-resolved inner HTML (SVG) for the button
 * @property {string}  [text] text label, used when no icon; the button then also carries `tb-text`
 * @property {string}  [title] the button's title/tooltip
 * @property {string}  [className] extra class(es) beyond `tb-btn`
 * @property {() => void} onClick the click behaviour (owns its own action)
 * @property {() => boolean} [enabled] reflected onto disabled + dim (default: always enabled)
 * @property {() => boolean} [active] reflected onto the `.active` class (default: never active)
 */

export class ToolbarButton {
  /** @type {HTMLButtonElement} */
  #el
  /** @type {(() => boolean)|null} */
  #enabled
  /** @type {(() => boolean)|null} */
  #active

  /** @param {ToolbarButtonSpec} spec */
  constructor({ id, iconHtml, text, title, className, onClick, enabled, active }) {
    const btn = document.createElement('button')
    const classes = ['tb-btn']
    if (!iconHtml && text) classes.push('tb-text')
    if (className) classes.push(className)
    btn.className = classes.join(' ')
    if (id) btn.id = id
    if (title) btn.title = title
    if (iconHtml) btn.innerHTML = iconHtml
    else if (text) btn.textContent = text
    // A toolbar click must not take the keyboard from the lens before the
    // command runs.
    btn.addEventListener('mousedown', (e) => { e.preventDefault() })
    btn.addEventListener('click', () => { if (onClick) onClick() })
    this.#el = btn
    this.#enabled = enabled || null
    this.#active = active || null
  }

  /** @returns {HTMLButtonElement} */
  get el() { return this.#el }

  /** Applies active() → the `.active` class and enabled() → disabled. */
  refresh() {
    if (this.#active) this.#el.classList.toggle('active', !!this.#active())
    if (this.#enabled) {
      const on = !!this.#enabled()
      this.#el.disabled = !on
      this.#el.classList.toggle('tb-disabled', !on)
    }
  }
}

/**
 * @typedef {object} ToolbarLabelSpec
 * @property {string} [id]
 * @property {() => string} text what it says; refreshed with the toolbar
 * @property {string} [title]
 * @property {string} [className] extra class(es) beyond `tb-readout`
 * @property {boolean} [live] announced to assistive technology as it changes (`role="status"`)
 * @property {ToolbarPlaceName} [place] where the toolbar draws it, when it is one of its items
 */

export class ToolbarLabel {
  /** @type {HTMLSpanElement} */
  #el
  /** @type {() => string} */
  #text
  /** @type {ToolbarPlaceName} */
  #place

  /** @param {ToolbarLabelSpec} spec */
  constructor({ id, text, title, className, live, place = ToolbarPlace.START }) {
    const span = document.createElement('span')
    span.className = className ? 'tb-readout ' + className : 'tb-readout'
    if (id) span.id = id
    if (title) span.title = title
    if (live) span.setAttribute('role', 'status')
    this.#el = span
    this.#text = text
    this.#place = place
    this.refresh()
  }

  /** @returns {HTMLSpanElement} */
  get el() { return this.#el }

  /** @returns {ToolbarPlaceName} */
  get place() { return this.#place }

  refresh() {
    const text = String(this.#text() ?? '')
    if (this.#el.textContent !== text) this.#el.textContent = text
  }
}

/**
 * One choice of a ToolbarSelect. `mark` draws the option for attention: a
 * leading `● `, since an `<option>` holds text alone.
 * @typedef {Readonly<{value: string, label: string, mark?: boolean}>} ToolbarOption
 */

/**
 * @typedef {object} ToolbarSelectSpec
 * @property {string} [id] the `<select>`'s DOM id
 * @property {string} [title]
 * @property {string} [className] extra class(es) beyond `tb-select`
 * @property {ReadonlyArray<ToolbarOption>} options in order
 * @property {() => string} value the value in force, read on refresh
 * @property {(value: string) => void} onChange told the value chosen
 * @property {() => string} [face] what the closed control says; default the chosen option's label
 */

/**
 * A drop-down: a native `<select>`, so the keyboard, the list and assistive
 * technology are the platform's, laid transparent over a face that says what is
 * chosen. A choice made with the pointer hands the keyboard back to whatever
 * held it before the pointer opened the list, as a ToolbarButton never takes it;
 * one made from the keyboard leaves it on the control.
 */
export class ToolbarSelect {
  /** @type {HTMLSpanElement} */ #el
  /** @type {HTMLSelectElement} */ #select
  /** @type {HTMLSpanElement} */ #face
  /** @type {() => string} */ #value
  /** @type {(() => string)|null} */ #faceText
  /** @type {Element|null} what held the keyboard when the pointer opened the list */ #returnTo = null

  /** @param {ToolbarSelectSpec} spec */
  constructor({ id, title, className, options, value, onChange, face }) {
    const wrap = document.createElement('span')
    wrap.className = className ? 'tb-select ' + className : 'tb-select'
    const shown = document.createElement('span')
    shown.className = 'tb-select__face'
    shown.setAttribute('aria-hidden', 'true')
    const select = document.createElement('select')
    select.className = 'tb-select__control'
    if (id) select.id = id
    if (title) { select.title = title; select.setAttribute('aria-label', title) }
    for (const option of options) {
      const el = document.createElement('option')
      el.value = option.value
      el.textContent = option.mark ? '● ' + option.label : option.label
      select.appendChild(el)
    }
    select.addEventListener('mousedown', () => {
      const held = document.activeElement
      this.#returnTo = held && held !== select && held !== document.body ? held : null
    })
    select.addEventListener('change', () => {
      const returnTo = this.#returnTo
      this.#returnTo = null
      onChange(select.value)
      if (returnTo && returnTo.isConnected) /** @type {HTMLElement} */ (returnTo).focus()
    })
    wrap.append(shown, select)
    this.#el = wrap
    this.#select = select
    this.#face = shown
    this.#value = value
    this.#faceText = face || null
    this.refresh()
  }

  /** @returns {HTMLSpanElement} */
  get el() { return this.#el }

  /** @returns {HTMLSelectElement} the native control */
  get select() { return this.#select }

  /** Selects the value in force and says it on the face. */
  refresh() {
    const value = String(this.#value() ?? '')
    if (this.#select.value !== value) this.#select.value = value
    const chosen = this.#select.options[this.#select.selectedIndex]
    const text = this.#faceText ? this.#faceText() : chosen ? String(chosen.textContent) : ''
    if (this.#face.textContent !== text) this.#face.textContent = text
  }
}

export class ToolbarSeparator {
  /** @type {HTMLDivElement} */
  #el = document.createElement('div')
  /** @type {ToolbarPlaceName} */
  #place

  /** @param {ToolbarPlaceName} [place] where the two sections it divides are drawn */
  constructor(place = ToolbarPlace.START) {
    this.#el.className = 'tb-sep'
    this.#place = place
  }

  /** @returns {HTMLDivElement} */
  get el() { return this.#el }

  /** @returns {ToolbarPlaceName} */
  get place() { return this.#place }

  refresh() {}
}

export class ButtonGroup {
  /** @type {HTMLDivElement} */
  #el
  /** @type {ToolbarItem[]} */
  #buttons
  /** @type {ToolbarPlaceName} */
  #place

  /**
   * @param {ToolbarItem[]} buttons ordered; appended left→right into the .tb-group
   * @param {{ className?: string, label?: string, place?: ToolbarPlaceName }} [opts]
   *   `label` names the group for assistive technology; `place` is where the
   *   toolbar draws it
   */
  constructor(buttons, opts = {}) {
    const div = document.createElement('div')
    div.className = opts.className ? 'tb-group ' + opts.className : 'tb-group'
    if (opts.label) {
      div.setAttribute('role', 'group')
      div.setAttribute('aria-label', opts.label)
    }
    for (const b of buttons) div.appendChild(b.el)
    this.#el = div
    this.#buttons = buttons.slice()
    this.#place = opts.place || ToolbarPlace.START
  }

  /** @returns {HTMLDivElement} the `.tb-group` element */
  get el() { return this.#el }

  /** @returns {ToolbarPlaceName} */
  get place() { return this.#place }

  /** @returns {ToolbarItem[]} the group's widgets, in order */
  get buttons() { return this.#buttons.slice() }

  refresh() {
    for (const b of this.#buttons) b.refresh()
  }
}
