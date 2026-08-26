// @ts-check
// A read-only lens: paints the container as a list of block cards. It extends Lens
// directly and demands only the base ContainerProvider — reads and the presence
// seam, no verbs, no in-flight text. PM-free and host-free by construction.

import { Lens } from '../lens.js'
import { esc } from '../../renderers/html-escape.js'
import { rendererStyles } from '../../renderers/renderer-style-registry.js'

// Attr keys searched, in order, for something human-legible to show. First hit
// wins; a kind whose payload is unreadable still gets a card with its kind word.
const EXCERPT_KEYS = Object.freeze([
  'title', 'question', 'content', 'source', 'text', 'url', 'filename', 'response', 'alt', 'src',
])
const EXCERPT_MAX = 120

export class OutlineLens extends Lens {
  static styles = /* css */ `
  .sieve-outline {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .sieve-outline__card {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 6px 10px;
    border: 1px solid var(--theme-border2);
    border-radius: 4px;
    background: var(--theme-bg);
    cursor: pointer;
  }

  .sieve-outline__card.is-selected {
    border-color: var(--theme-accentPrimary);
  }

  .sieve-outline__kind {
    flex: 0 0 auto;
    font-family: var(--theme-monoFont);
    font-size: 0.75em;
    letter-spacing: 0.04em;
    color: var(--theme-accentPrimary);
  }

  .sieve-outline__excerpt {
    flex: 1 1 auto;
    margin: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--theme-text);
  }
`

  /** @type {HTMLElement|null} */ #root = null
  /** @type {Map<string, HTMLElement>} */ #cards = new Map()
  /** @type {string|null} */ #selectedId = null

  /** @param {import('../../contract/container-provider.js').ContainerProvider} provider */
  constructor(provider) {
    super(provider)
    rendererStyles.register(OutlineLens)
  }

  unmount() {
    super.unmount()
    this.#root = null
    this.#cards.clear()
    this.#selectedId = null
  }

  /**
   * `orderChanged` is the whole patch decision: it is set by every fold that moved
   * a child in or out of the list (the bootstrap cue included), and clear for every
   * fold that only rewrote one in place.
   * @param {Readonly<import('../../contract/container-update-listener.js').ContainerChange>} change
   */
  paint(change) {
    const root = this.#ensureRoot()
    if (change.orderChanged) this.#relist(root)
    else this.#patch(root, change.blockIds)
  }

  /** The list element, built on first paint — `mount` cannot build it, because
   *  subscribing cues the first paint before `mount` returns.
   *  @returns {HTMLElement} */
  #ensureRoot() {
    if (this.#root) return this.#root
    const root = document.createElement('div')
    root.className = 'sieve-outline'
    root.addEventListener('click', (event) => this.#onClick(event))
    this.#root = root
    const host = /** @type {HTMLElement} */ (this.host)
    host.appendChild(root)
    return root
  }

  /** Rebuilds the list from the container order, reusing the card element of
   *  every id that survived — a reorder moves cards, it does not replace them.
   *  @param {HTMLElement} root */
  #relist(root) {
    /** @type {HTMLElement[]} */
    const children = []
    /** @type {Set<string>} */
    const live = new Set()
    for (const id of this.provider.getOrder()) {
      const node = this.provider.getBlock(id)
      if (!node) continue // an order name with no node is a position nothing can paint
      live.add(id)
      children.push(this.#card(node))
    }
    for (const id of [...this.#cards.keys()]) if (!live.has(id)) this.#cards.delete(id)
    if (this.#selectedId && !live.has(this.#selectedId)) this.#selectedId = null
    root.replaceChildren(...children)
  }

  /** @param {HTMLElement} root @param {ReadonlyArray<string>} blockIds */
  #patch(root, blockIds) {
    for (const id of blockIds) {
      const node = this.provider.getBlock(id)
      const card = this.#cards.get(id)
      if (!node) {
        if (card) { card.remove(); this.#cards.delete(id) }
        continue
      }
      // A node with no card means this lens never placed it, and only the order
      // says where it belongs — so ask the list, not the cue.
      if (!card) { this.#relist(root); return }
      this.#fill(card, node)
    }
  }

  /** @param {Readonly<import('../../contract/container-provider.js').BlockData>} node @returns {HTMLElement} */
  #card(node) {
    let card = this.#cards.get(node.id)
    if (!card) {
      card = document.createElement('article')
      card.className = 'sieve-outline__card'
      card.dataset.blockId = node.id
      this.#cards.set(node.id, card)
    }
    this.#fill(card, node)
    return card
  }

  /** @param {HTMLElement} card @param {Readonly<import('../../contract/container-provider.js').BlockData>} node */
  #fill(card, node) {
    card.dataset.blockKind = node.kind
    card.classList.toggle('is-selected', node.id === this.#selectedId)
    card.innerHTML =
      '<span class="sieve-outline__kind">' + esc(node.kind) + '</span>' +
      '<p class="sieve-outline__excerpt">' + esc(this.#excerpt(node)) + '</p>'
  }

  /** @param {Readonly<import('../../contract/container-provider.js').BlockData>} node @returns {string} */
  #excerpt(node) {
    const attrs = node.attrs || {}
    for (const key of EXCERPT_KEYS) {
      const value = attrs[key]
      if (typeof value !== 'string' || !value.trim()) continue
      const flat = value.trim().replace(/\s+/g, ' ')
      return flat.length > EXCERPT_MAX ? flat.slice(0, EXCERPT_MAX - 1) + '…' : flat
    }
    return ''
  }

  /** @param {Event} event */
  #onClick(event) {
    const target = /** @type {Element|null} */ (event.target)
    const card = target && typeof target.closest === 'function' ? target.closest('[data-block-id]') : null
    const id = card instanceof HTMLElement ? card.dataset.blockId : undefined
    if (!id || !this.#cards.has(id)) return

    this.#selectedId = id
    for (const [cardId, element] of this.#cards) element.classList.toggle('is-selected', cardId === id)

    const node = this.provider.getBlock(id)
    this.advertiseSelection({
      selectionType: 'block',
      blockId: id,
      blockIds: [id],
      blockKind: node ? node.kind : null,
    })
  }
}
