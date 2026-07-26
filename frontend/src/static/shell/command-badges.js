// @ts-check
// command-badges.js — status-bar badge lifecycle for correlated command jobs
// (#55): one badge per correlationId (spinner → holding → dismissed); the badge
// IS the re-summon affordance and, later, the Job Engine Viewer's summon seed.

import { SieveBlock } from '../block/sieve-block.js'
import { CommandPopup } from './command-popup.js'

export class CommandBadges {
  /** @type {HTMLElement|null} */ #slot
  /** @type {Map<string, {el: HTMLElement, handle: any, state: string, block: SieveBlock, popup: CommandPopup|null}>} */ #entries = new Map()

  /** @param {HTMLElement|null} [slot] the .status-bar__command-badges element */
  constructor(slot) {
    this.#slot = slot || (typeof document !== 'undefined' ? document.querySelector('.status-bar__command-badges') : null)
  }

  /**
   * @param {import('../block/command-service.js').CommandResult & any} handle
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
    el.style.cssText = 'background: var(--theme-bgHighlight, #292e42); color: var(--theme-accentCyan, #7dcfff); border: 1px solid var(--theme-border2, #24283b); border-radius: 4px; padding: 2px 8px; margin-right: 6px; font-size: 11px; cursor: pointer;'
    this.#slot.appendChild(el)

    const entry = {
      el,
      handle,
      state: 'pending',
      popup: /** @type {CommandPopup|null} */ (null),
      block: new SieveBlock('ai-block', { question: meta.text, type: 'BTW', status: 'PENDING', createdAt: new Date().toISOString() }),
    }
    this.#entries.set(handle.correlationId, entry)
    el.addEventListener('click', () => this.#toggle(entry))
    if (typeof handle.onResult === 'function') {
      handle.onResult((r) => this.#onResult(entry, r))
    }
  }

  #onResult(entry, r) {
    if (r.block) {
      entry.block = new SieveBlock(r.block.kind, r.block.attrs)
    } else if (r.status === 'ERROR') {
      entry.block = new SieveBlock('ai-block', Object.assign({}, entry.block.payload, { status: 'ERROR', error: r.error || '' }))
    }

    if (r.status === 'COMPLETE' || r.status === 'ERROR') {
      entry.state = 'holding'
      entry.el.className = 'command-badge command-badge--holding' + (r.status === 'ERROR' ? ' command-badge--error' : '')
      if (r.status === 'ERROR') {
        entry.el.style.color = 'var(--theme-danger, #f7768e)'
      } else {
        entry.el.style.color = 'var(--theme-accentGreen, #9ece6a)'
      }
      this.#summon(entry)
    } else if (entry.popup && entry.popup.visible) {
      entry.popup.update(entry.block)
    }
  }

  #toggle(entry) {
    if (entry.popup && entry.popup.visible) {
      entry.popup.hide()
    } else {
      this.#summon(entry)
    }
  }

  #summon(entry) {
    if (!entry.popup) {
      entry.popup = new CommandPopup({ anchor: entry.el, onDelete: () => this.#delete(entry) })
    }
    entry.popup.show(entry.block)
  }

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
