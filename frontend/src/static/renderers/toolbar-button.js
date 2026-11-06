// @ts-check
// The toolbar's widget family. Each widget owns its own element and a
// `refresh()` that re-reads whatever state it reflects; the toolbar that shows
// them appends `el` and calls `refresh()`, and knows nothing else about them.
//
// A ToolbarButton carries its own onClick closure (no delegation, no command
// string) and optional active()/enabled() closures. A ToolbarLabel is text that
// is not a button. A ToolbarSeparator divides two sections. A ButtonGroup is a
// `.tb-group` of widgets with a refresh() fanout. Icons arrive pre-resolved as
// `iconHtml`, which keeps every widget content-blind.

/**
 * What a toolbar shows: an element, and a refresh of the state it reflects.
 * @typedef {{ readonly el: HTMLElement, refresh(): void }} ToolbarItem
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
 */

export class ToolbarLabel {
  /** @type {HTMLSpanElement} */
  #el
  /** @type {() => string} */
  #text

  /** @param {ToolbarLabelSpec} spec */
  constructor({ id, text, title, className, live }) {
    const span = document.createElement('span')
    span.className = className ? 'tb-readout ' + className : 'tb-readout'
    if (id) span.id = id
    if (title) span.title = title
    if (live) span.setAttribute('role', 'status')
    this.#el = span
    this.#text = text
    this.refresh()
  }

  /** @returns {HTMLSpanElement} */
  get el() { return this.#el }

  refresh() {
    const text = String(this.#text() ?? '')
    if (this.#el.textContent !== text) this.#el.textContent = text
  }
}

export class ToolbarSeparator {
  /** @type {HTMLDivElement} */
  #el = document.createElement('div')

  constructor() { this.#el.className = 'tb-sep' }

  /** @returns {HTMLDivElement} */
  get el() { return this.#el }

  refresh() {}
}

export class ButtonGroup {
  /** @type {HTMLDivElement} */
  #el
  /** @type {ToolbarItem[]} */
  #buttons

  /**
   * @param {ToolbarItem[]} buttons ordered; appended left→right into the .tb-group
   * @param {{ className?: string, label?: string }} [opts] `label` names the group
   *   for assistive technology
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
  }

  /** @returns {HTMLDivElement} the `.tb-group` element */
  get el() { return this.#el }

  /** @returns {ToolbarItem[]} the group's widgets, in order */
  get buttons() { return this.#buttons.slice() }

  refresh() {
    for (const b of this.#buttons) b.refresh()
  }
}
