// @ts-check
// What a lens can do, declared once and drawn twice: as toolbar buttons and as
// the entries of a context menu. Each action says the modes it belongs to,
// whether it applies now (one that does not is absent from both drawings) and
// whether it can run now (one that cannot is drawn disabled in both). Both
// drawings read the same closures each time they are drawn, so they never
// disagree.

import { ToolbarButton } from './toolbar-button.js'

/**
 * One action. `label` is what the menu says, `short` what its toolbar button
 * says when that is shorter; the button's DOM id is `tb-{id}`.
 * @typedef {object} LensAction
 * @property {string} id
 * @property {string|(() => string)} label
 * @property {string|(() => string)} [short]
 * @property {string} [title]
 * @property {string} [className] the toolbar button's class(es) beyond `tb-btn tb-text`
 * @property {ReadonlyArray<string>} modes the lens modes it belongs to
 * @property {() => boolean} [applies] default: always
 * @property {() => boolean} [enabled] default: always
 * @property {() => unknown} run
 */

/**
 * An entry of the app's context menu, as `sieve:contextmenu` takes it: an
 * action, or a divider between two runs of them.
 * @typedef {{label: string, disabled?: boolean, action: () => void} | {type: 'divider'}} ContextMenuItem
 */

export class ActionList {
  /** @type {ReadonlyArray<Readonly<LensAction>>} */ #actions

  /** @param {ReadonlyArray<LensAction>} actions in the order both drawings show them */
  constructor(actions) {
    this.#actions = Object.freeze(actions.map((action) => Object.freeze({ ...action, modes: Object.freeze([...action.modes]) })))
  }

  /** @returns {ReadonlyArray<Readonly<LensAction>>} every action declared */
  get actions() { return this.#actions }

  /**
   * The actions that apply in `mode` now, in order.
   * @param {string} mode
   * @returns {Array<Readonly<LensAction>>}
   */
  offered(mode) {
    return this.#actions.filter((a) => a.modes.includes(mode) && (!a.applies || a.applies()))
  }

  /**
   * A toolbar button for each action offered in `mode`.
   * @param {string} mode
   * @returns {ToolbarButton[]}
   */
  toolbarButtons(mode) {
    return this.offered(mode).map((a) => new ToolbarButton({
      id: 'tb-' + a.id,
      text: ActionList.#read(a.short ?? a.label),
      title: a.title,
      className: a.className,
      enabled: a.enabled,
      onClick: () => { a.run() },
    }))
  }

  /**
   * A menu entry for each action offered in `mode`, disabled while it cannot run.
   * @param {string} mode
   * @returns {ContextMenuItem[]}
   */
  menuItems(mode) {
    return this.offered(mode).map((a) => ({
      label: ActionList.#read(a.label),
      disabled: a.enabled ? !a.enabled() : false,
      action: () => { a.run() },
    }))
  }

  /** @param {string|(() => string)} text @returns {string} */
  static #read(text) { return typeof text === 'function' ? text() : text }
}
