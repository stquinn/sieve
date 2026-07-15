// @ts-check
// toolbar-button.js — the two toolbar widgets (P4.D).
//
// A ToolbarButton is a pure render+behaviour widget owning its own <button>: it
// carries an onClick closure (NO delegation, NO data-cmd string switch — the
// retired editor.js handleToolbarClick) and optional active()/enabled() closures
// the owner refreshes on selection/context change. A ButtonGroup is a thin
// `.tb-group` wrapper owning an ordered ToolbarButton[] with a refresh() fanout,
// matching the existing toolbar DOM shape verbatim (.tb-group / .tb-btn).
//
// Both are CLASSES (idiomatic-js.md — no free-function file). Icons are hydrated
// at build via the injected `iconHtml` string (the SieveIcons / getSieveIcon
// lookup lives with the caller, keeping the widget content-blind). Dual-use ES
// module: `export` for vitest; imported by editor-toolbar.js.

/**
 * @typedef {object} ToolbarButtonSpec
 * @property {string}  [id]        — the button's DOM id (parity with the old #tb-* ids)
 * @property {string}  [iconHtml]  — pre-resolved inner HTML (SVG) for the button
 * @property {string}  [text]      — text label (used when no icon)
 * @property {string}  [title]     — the button's title/tooltip
 * @property {string}  [className] — extra class(es) beyond `tb-btn`
 * @property {() => void} onClick   — the click behaviour (owns its own action)
 * @property {() => boolean} [enabled] — reflected onto disabled + dim (default: always enabled)
 * @property {() => boolean} [active]  — reflected onto the `.active` class (default: never active)
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
    btn.className = className ? 'tb-btn ' + className : 'tb-btn'
    if (id) btn.id = id
    if (title) btn.title = title
    if (iconHtml) btn.innerHTML = iconHtml
    else if (text) btn.textContent = text
    // mousedown → preventDefault preserves the old toolbar focus-guard (index.html
    // 748–750): a toolbar click must not blur the editor before the command runs.
    btn.addEventListener('mousedown', (e) => { e.preventDefault() })
    btn.addEventListener('click', () => { if (onClick) onClick() })
    this.#el = btn
    this.#enabled = enabled || null
    this.#active = active || null
  }

  /** @returns {HTMLButtonElement} the owned <button>, for a ButtonGroup to append */
  get el() { return this.#el }

  /** Sets the mode-toggle icon/title at runtime (the flip re-render — updateModeUI body). */
  setIcon(iconHtml) { this.#el.innerHTML = iconHtml }
  /** @param {string} title */
  setTitle(title) { this.#el.title = title }

  /** Applies active() → the `.active` class and enabled() → disabled. Called by ButtonGroup.refresh. */
  refresh() {
    if (this.#active) this.#el.classList.toggle('active', !!this.#active())
    if (this.#enabled) {
      const on = !!this.#enabled()
      this.#el.disabled = !on
      this.#el.classList.toggle('tb-disabled', !on)
    }
  }
}

export class ButtonGroup {
  /** @type {HTMLDivElement} */
  #el
  /** @type {ToolbarButton[]} */
  #buttons

  /**
   * @param {ToolbarButton[]} buttons — ordered; appended left→right into the .tb-group
   * @param {{ className?: string }} [opts]
   */
  constructor(buttons, opts = {}) {
    const div = document.createElement('div')
    div.className = opts.className ? 'tb-group ' + opts.className : 'tb-group'
    for (const b of buttons) div.appendChild(b.el)
    this.#el = div
    this.#buttons = buttons.slice()
  }

  /** @returns {HTMLDivElement} the `.tb-group` element */
  get el() { return this.#el }

  /** @returns {ToolbarButton[]} the group's buttons (read-only order) */
  get buttons() { return this.#buttons.slice() }

  /** Refreshes every button's active/enabled state. */
  refresh() {
    for (const b of this.#buttons) b.refresh()
  }
}
