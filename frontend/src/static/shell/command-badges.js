// @ts-check
// command-badges.js — status-bar badge lifecycle for correlated command jobs
// (#55): one badge per correlationId (spinner → holding → dismissed); the badge
// IS the re-summon affordance and, later, the Job Engine Viewer's summon seed.
//
// The pending state is KIND-AGNOSTIC: `block` starts as null, and the popup
// shows a generic spinner + command name. Only when the server result arrives
// does the block become a real SieveBlock with its final kind (ai-block, etc.).

import { SieveBlock } from '../block/sieve-block.js'
import { CommandPopup } from './command-popup.js'

/**
 * @typedef {object} BadgeEntry
 * @property {HTMLElement} el
 * @property {import('../block/command-service.js').DispatchHandle} handle
 * @property {string} state
 * @property {{cmd: string, text: string, error?: string}} meta
 * @property {SieveBlock|null} block
 * @property {CommandPopup|null} popup
 */

export class CommandBadges {
  /** @type {HTMLElement|null} */ #slot
  /** @type {Map<string, BadgeEntry>} */ #entries = new Map()

  /** @param {HTMLElement|null} [slot] the .status-bar__command-badges element */
  constructor(slot) {
    this.#slot = slot || (typeof document !== 'undefined' ? document.querySelector('.status-bar__command-badges') : null)
  }

  /**
   * @param {import('../block/command-service.js').DispatchHandle} handle
   * @param {{cmd: string, text: string}} meta
   */
  track(handle, meta) {
    if (!this.#slot) return
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'command-badge command-badge--pending'
    el.title = '/' + meta.cmd + (meta.text ? ' ' + meta.text : '')
    el.setAttribute('aria-label', el.title)
    el.textContent = '/' + meta.cmd
    this.#slot.appendChild(el)

    /** @type {BadgeEntry} */
    const entry = {
      el,
      handle,
      state: 'pending',
      meta,
      popup: /** @type {CommandPopup|null} */ (null),
      block: /** @type {SieveBlock|null} */ (null),
    }
    this.#entries.set(handle.correlationId, entry)
    el.addEventListener('click', () => this.#toggle(entry))
    if (typeof handle.onResult === 'function') {
      handle.onResult((r) => this.#onResult(entry, r))
    }
  }

  /** @param {BadgeEntry} entry @param {import('../block/command-service.js').CommandResult} r */
  #onResult(entry, r) {
    if (r.block) {
      entry.block = new SieveBlock(r.block.kind, r.block.attrs)
    } else if (r.status === 'ERROR') {
      if (entry.block) {
        // A prior block exists — merge the error into a FRESH envelope of the
        // SAME kind (never a hardcoded 'ai-block'); the block keeps its identity.
        entry.block = new SieveBlock(entry.block.kind, Object.assign({}, entry.block.payload, { status: 'ERROR', error: r.error || '' }))
      } else {
        // No block ever arrived — do NOT fabricate an ai-block envelope (the
        // "assumed ai-block" 8808c0a removed). Carry the error on the meta so the
        // popup renders a generic, kind-less error view.
        entry.meta = Object.assign({}, entry.meta, { error: r.error || 'Command failed.' })
      }
    }

    if (r.status === 'COMPLETE' || r.status === 'ERROR') {
      entry.state = 'holding'
      entry.el.className = 'command-badge command-badge--holding' + (r.status === 'ERROR' ? ' command-badge--error' : '')
      this.#summon(entry)
    } else if (entry.popup && entry.popup.visible) {
      entry.popup.update(entry.block, entry.meta)
    }
  }

  /** @param {BadgeEntry} entry */
  #toggle(entry) {
    if (entry.popup && entry.popup.visible) {
      entry.popup.hide()
    } else {
      this.#summon(entry)
    }
  }

  /** @param {BadgeEntry} entry */
  #summon(entry) {
    if (!entry.popup) {
      entry.popup = new CommandPopup({ anchor: entry.el, onDelete: () => this.#delete(entry) })
    }
    entry.popup.show(entry.block, entry.meta)
  }

  /** @param {BadgeEntry} entry */
  #delete(entry) {
    if (entry.state === 'pending' && entry.handle && typeof entry.handle.cancel === 'function') {
      entry.handle.cancel()
    }
    if (entry.popup) {
      entry.popup.destroy()
    }
    entry.el.remove()
    this.#entries.delete(entry.handle.correlationId)
  }
}
