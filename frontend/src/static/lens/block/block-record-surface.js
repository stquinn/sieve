// @ts-check
// The one surface BlockLens has: each block of the container drawn as a record by
// its kind's renderer, or as a card naming the kind and the block's title when
// nothing draws that kind. It is redrawn whole on every change — a block
// container holds one block — and offers nothing to type into.

import { AbstractSurface } from '../abstract-surface.js'
import { BlockRecordView } from '../../renderers/block-record-view.js'
import { rendererStyles } from '../../renderers/renderer-style-registry.js'

export class BlockRecordSurface extends AbstractSurface {
  /** The mode this surface presents. */
  static MODE = 'block'

  static styles = /* css */ `
  .block-record {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px 24px;
  }

  .block-record__card {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 10px 14px;
    border: 1px solid var(--theme-border2);
    border-radius: 4px;
    background: var(--theme-bg);
  }

  .block-record__kind {
    flex: 0 0 auto;
    font-family: var(--theme-monoFont);
    font-size: 0.75em;
    letter-spacing: 0.04em;
    color: var(--theme-accentPrimary);
  }

  .block-record__title {
    flex: 1 1 auto;
    color: var(--theme-text);
  }
`

  /** @type {string} */ #container
  /** @type {HTMLElement|null} */ #root = null
  /** @type {BlockRecordView[]} */ #views = []

  /** @param {string} container the uuid of the container drawn */
  constructor(container) {
    super()
    this.#container = container
    rendererStyles.register(BlockRecordSurface)
  }

  /** @returns {string} */
  get mode() { return BlockRecordSurface.MODE }

  /** @returns {{ chars: number, lines: number, blockCount: number }} */
  stats() { return { chars: 0, lines: 0, blockCount: this.#views.length } }

  /** @param {HTMLElement} rootEl */
  mount(rootEl) {
    this.#root = document.createElement('div')
    this.#root.className = 'block-record'
    rootEl.appendChild(this.#root)
  }

  unmount() {
    this.#release()
    if (this.#root) this.#root.remove()
    this.#root = null
  }

  /** @param {unknown} _change @param {any} provider */
  applyContainerChange(_change, provider) { this.paintContainer(provider) }

  /** @param {any} provider */
  paintContainer(provider) {
    const root = this.#root
    if (!root) return
    this.#release()
    root.replaceChildren()
    for (const id of provider.getOrder()) {
      const node = provider.getBlock(id)
      if (!node) continue
      const view = new BlockRecordView(this.#container)
      this.#views.push(view)
      root.appendChild(view.draw(node.kind, node.attrs) || this.#card(node.kind, node.attrs))
    }
  }

  flushPending() {}

  #release() {
    for (const view of this.#views) view.destroy()
    this.#views = []
  }

  /**
   * @param {string} kind @param {Record<string, any>} attrs
   * @returns {HTMLElement}
   */
  #card(kind, attrs) {
    const card = document.createElement('div')
    card.className = 'block-record__card'
    card.setAttribute('data-kind', kind)
    const label = document.createElement('span')
    label.className = 'block-record__kind'
    label.textContent = kind
    const title = document.createElement('span')
    title.className = 'block-record__title'
    title.textContent = String((attrs && attrs.title) || '')
    card.append(label, title)
    return card
  }
}
