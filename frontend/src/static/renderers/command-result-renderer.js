// @ts-check
// CommandResultRenderer — the generic renderer for non-AI slash-command results
// (/uuid, /hash, /base64, /env, /jwt, /now, /stats). These commands run entirely
// in Go and return a plain answer: Go owns WHAT the answer says (tables, fenced
// code, scope lines, timestamps), this class owns HOW it looks. Header = a /cmd
// chip + the shared StatusBadge treatment; Title = payload.title; Body =
// sanctioned markdown of payload.response. It mounts in the detached-answer
// popup, which stays payload-blind and pulls the copyable value through the base
// copyText() accessor.

import { BlockRenderer } from './block-renderer.js'
import { commandResultStyles } from './command-result-renderer.styles.js'
import { StatusBadge } from './status-badge.js'
import { registerBlockRenderer } from './block-kinds.js'

/** @typedef {{ id?: string, cmd?: string, status?: string, title?: string, response?: string|null, primary?: string|null, error?: string|null, createdAt?: string|null, completedAt?: string|null }} CommandResultAttrs */

export class CommandResultRenderer extends BlockRenderer {
  static styles = commandResultStyles
  static rootClass = 'sieve-command-result command-result'

  /** @type {HTMLElement|null} */ #badge = null
  /** @type {HTMLElement|null} */ #titleEl = null
  /** @type {HTMLElement|null} */ #contentEl = null

  /** The HEADER: a /cmd chip + the shared status badge. @returns {HTMLElement} */
  buildHeader() {
    const attrs = /** @type {CommandResultAttrs} */ (this.block.payload)
    const header = document.createElement('div')
    header.className = 'command-result__header'
    header.contentEditable = 'false'

    const chip = document.createElement('span')
    chip.className = 'command-result__chip'
    chip.textContent = '/' + (attrs.cmd || 'cmd')

    this.#badge = document.createElement('span')
    this.#renderBadge(attrs)

    header.append(chip, this.#badge)
    return header
  }

  /** The TITLE (base stamps sieve-block__heading + hides when empty). @returns {HTMLElement} */
  buildTitle() {
    this.#titleEl = document.createElement('div')
    this.fillTitleSlot(this.#titleEl, /** @type {CommandResultAttrs} */ (this.block.payload).title)
    return this.#titleEl
  }

  /** The response/error BODY, self-filled via sanctioned markdown. @returns {HTMLElement} */
  buildBody() {
    this.#contentEl = document.createElement('div')
    this.#contentEl.className = 'sieve-block__content tiptap' // tiptap class → shared markdown styling
    this.fillBody(this.#contentEl, this.bodyMarkdown())
    return this.#contentEl
  }

  /**
   * The markdown the BODY shows — response when complete, else the error line.
   * @returns {string}
   */
  bodyMarkdown() {
    const attrs = /** @type {CommandResultAttrs} */ (this.block.payload)
    const status = attrs.status || 'COMPLETE'
    if (status === 'COMPLETE') return (attrs.response || '').trim()
    if (status === 'PENDING' || status === 'DISPATCHED') return '*(working…)*'
    return (attrs.error || 'Command failed.').trim()
  }

  /**
   * The plain text the popup's Copy button writes — the raw copyable value
   * (payload.primary) when Go supplied one, else the rendered markdown body, so
   * a command result copies its bare answer (uuid / hash / decoded text), not
   * the surrounding table/scope chrome.
   * @returns {string}
   */
  copyText() {
    const primary = /** @type {CommandResultAttrs} */ (this.block.payload).primary
    const p = primary == null ? '' : String(primary)
    return p.trim() !== '' ? p : (this.bodyMarkdown() || '')
  }

  /** @param {import('../contract/sieve-block.js').SieveBlock} block */
  update(block) {
    super.update(block)
    const attrs = /** @type {CommandResultAttrs} */ (block.payload)
    this.#renderBadge(attrs)
    if (this.#titleEl) this.fillTitleSlot(this.#titleEl, attrs.title)
    if (this.#contentEl) this.fillBody(this.#contentEl, this.bodyMarkdown())
  }

  /** @param {CommandResultAttrs} attrs */
  #renderBadge(attrs) {
    const badge = this.#badge
    if (!badge) return
    const state = StatusBadge.classify(attrs.status, attrs.createdAt, attrs.id)
    badge.className = 'command-result__badge command-result__badge--' + state
    badge.textContent = CommandResultRenderer.#BADGE_TEXT[state] || state.toUpperCase()
  }

  /** State → badge label (StatusBadge's five buckets). @type {Readonly<Record<string, string>>} */
  static #BADGE_TEXT = Object.freeze({
    pending: 'RUNNING',
    stale: 'TIMEOUT',
    complete: 'DONE',
    timeout: 'TIMEOUT',
    error: 'ERROR',
  })

  // destroy(): base no-op is correct — this class owns no timers/observers.
}

registerBlockRenderer('command-result', () => CommandResultRenderer)
