// @ts-check
// The panel a view of a Digital Note shows in place of the note while the note
// has no published log: its first records are still arriving from the tablet.
// It says so and nothing else; how far the sync has got is its job's.

import { rendererStyles } from './renderer-style-registry.js'

export class SyncingPanel {
  /** What the panel says. */
  static Words = Object.freeze({
    TITLE: 'Syncing from the tablet',
    DETAIL: 'This notebook opens here once its pages have arrived.',
  })

  static styles = /* css */ `
  .ink-syncing {
    margin: 96px auto;
    max-width: 28rem;
    color: var(--theme-muted);
    text-align: center;
    font-family: var(--theme-uiFont);
  }

  .ink-syncing__title {
    margin: 0 0 6px;
    color: var(--theme-text);
    font-weight: 600;
  }

  .ink-syncing__detail {
    margin: 0;
    font-size: 0.9em;
  }
`

  /** @type {HTMLElement} */ #element

  constructor() {
    rendererStyles.register(SyncingPanel)
    const panel = document.createElement('div')
    panel.className = 'ink-syncing'
    panel.setAttribute('role', 'status')
    const title = document.createElement('p')
    title.className = 'ink-syncing__title'
    title.textContent = SyncingPanel.Words.TITLE
    const detail = document.createElement('p')
    detail.className = 'ink-syncing__detail'
    detail.textContent = SyncingPanel.Words.DETAIL
    panel.append(title, detail)
    this.#element = panel
  }

  /** @returns {HTMLElement} the panel; one element, moved wherever it is put */
  get element() { return this.#element }
}
