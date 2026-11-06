// @ts-check
// What the ink lenses share. Mounted over an InkContainerProvider, an ink lens
// declares no capability and writes nothing. What it can do is one ActionList,
// drawn twice: in the workspace toolbar, after the surface's view controls and
// followed by what came of the last action and the mode toggle, and as the
// context menu its surface raises, followed by the mode toggle.

import { AbstractEditor } from '../abstract-editor.js'
import { SurfaceEvent, SurfaceIntent } from '../abstract-surface.js'
import { LensCapability } from '../../contract/lens-capabilities.js'
import { ContractViolation } from '../../contract/sieve-block.js'
import { ButtonGroup, ToolbarLabel, ToolbarSeparator } from '../../renderers/toolbar-button.js'
import { ActionStatus } from './action-status.js'

/** @typedef {import('../../renderers/action-list.js').ActionList} ActionList */
/** @typedef {import('../../renderers/action-list.js').ContextMenuItem} ContextMenuItem */
/** @typedef {import('../abstract-surface.js').SurfaceEventMsg} SurfaceEventMsg */

const NO_CAPABILITY = Object.freeze({
  [LensCapability.MARKDOWN]: false,
  [LensCapability.MENTIONS]: false,
  [LensCapability.COMMANDS]: false,
  [LensCapability.BLOCKS]: false,
})

export class InkLens extends AbstractEditor {
  /** @type {ActionList|null} */ #actions = null
  /** @type {ActionStatus} */ #status = new ActionStatus(() => this.onSurfaceEvent(SurfaceEvent.TOOLBAR_CHANGED))

  /**
   * @param {string} uuid the container
   * @param {import('../abstract-editor.js').AbstractEditorOptions} [options]
   *   `provider` must be an InkContainerProvider
   */
  constructor(uuid, options = {}) {
    super(uuid, options)
    if (typeof this.provider.loadPage !== 'function') {
      throw new ContractViolation(`${this.constructor.name}: construct with an InkContainerProvider`)
    }
  }

  /** @protected @returns {Readonly<import('../../contract/lens-capabilities.js').LensCapabilities>} */
  get _innateCapabilities() { return NO_CAPABILITY }

  /** @returns {ActionStatus} where what came of the last action is said, in every mode */
  get actionStatus() { return this.#status }

  /** @returns {ActionList} what the lens can do, declared once */
  get actions() {
    if (!this.#actions) this.#actions = this._declareActions()
    return this.#actions
  }

  /**
   * What the lens can do. Asked once, on first use.
   * @abstract
   * @protected
   * @returns {ActionList}
   */
  _declareActions() {
    throw new Error(this.constructor.name + ' must implement _declareActions()')
  }

  /**
   * The actions offered in the mode in force and what came of the last of them,
   * then the mode toggle.
   * @override @protected
   * @returns {import('../../renderers/toolbar-button.js').ToolbarItem[]}
   */
  _toolbarGroups() {
    /** @type {import('../../renderers/toolbar-button.js').ToolbarItem[]} */
    const actions = this.actions.toolbarButtons(this.mode)
    if (this.#status.text) actions.push(new ToolbarLabel({ id: 'tb-ink-status', className: 'tb-status', text: () => this.#status.text, live: true }))
    const toggle = this.modeToggle()
    /** @type {import('../../renderers/toolbar-button.js').ToolbarItem[]} */
    const groups = actions.length ? [new ButtonGroup(actions)] : []
    if (toggle) {
      if (groups.length) groups.push(new ToolbarSeparator())
      groups.push(new ButtonGroup([toggle]))
    }
    return groups
  }

  /**
   * The context menu: the actions offered in the mode in force, disabled while
   * they cannot run, then the mode toggle.
   * @returns {ContextMenuItem[]}
   */
  contextMenuItems() {
    const items = this.actions.menuItems(this.mode)
    const face = this.modeToggleFace
    if (face) {
      if (items.length) items.push({ type: 'divider' })
      items.push({ label: String(face.text || face.title), action: () => { this.toggleMode() } })
    }
    return items
  }

  /**
   * A surface's context-menu intent reaches the host carrying the lens's menu.
   * @override
   * @param {SurfaceEventMsg} event
   */
  onSurfaceEvent(event) {
    if (event && event.type === SurfaceIntent.CONTEXT_MENU && !event.items) {
      super.onSurfaceEvent(Object.freeze({ ...event, items: Object.freeze(this.contextMenuItems()) }))
      return
    }
    super.onSurfaceEvent(event)
  }

  /** @override */
  destroy() {
    this.#status.clear()
    super.destroy()
  }
}
