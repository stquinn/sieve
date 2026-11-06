// @ts-check
// Open in e-ink: asks the tablet a note came from to open the note at a page,
// saying in an ActionStatus that it is asking and then what came of it. A second
// ask while one is under way is the same ask. It is offered only for a note that
// came from a tablet.

import { InkOpening, InkRefusal } from '../../contract/ink-container-provider.js'
import { ToolbarButton } from '../../renderers/toolbar-button.js'

/** @typedef {import('../../contract/ink-container-provider.js').InkContainerProvider} InkContainerProvider */
/** @typedef {import('../../contract/ink-container-provider.js').InkOpeningResult} InkOpeningResult */
/** @typedef {import('./action-status.js').ActionStatus} ActionStatus */

/** What is said of each outcome but opened and refused. */
const OPENING_WORDS = Object.freeze({
  [InkOpening.NO_TABLET]: 'No tablet connected',
  [InkOpening.OTHER_TABLET]: 'Connected to another tablet',
  [InkOpening.NO_ANSWER]: 'The tablet did not answer',
})

/** What is said of each reason the tablet gives for refusing. */
const REFUSAL_WORDS = Object.freeze({
  [InkRefusal.NOT_FOREGROUND]: 'SieveInk is not open on the tablet',
  [InkRefusal.NOT_OFFERED]: 'This note is not shared with this Sieve',
})

export class TabletOpener {
  /** @type {InkContainerProvider} */ #provider
  /** @type {ActionStatus} */ #status
  /** @type {() => void} */ #onChange
  /** @type {string} */ #device = ''
  /** @type {boolean} */ #offered = false
  /** @type {Promise<void>|null} */ #opening = null

  /**
   * @param {InkContainerProvider} provider the note's provider
   * @param {ActionStatus} status where the asking and its outcome are said
   * @param {() => void} onChange told when an ask starts or ends
   */
  constructor(provider, status, onChange) {
    this.#provider = provider
    this.#status = status
    this.#onChange = onChange
  }

  /**
   * Takes the note's block attrs: the device it was written on, and whether it
   * came from a tablet at all.
   * @param {Record<string, any>} attrs
   */
  setNote(attrs) {
    this.#device = String((attrs.note_device && attrs.note_device.name) || '')
    this.#offered = !!attrs.note_source_id
  }

  /** @returns {string} the name of the device the note was written on; '' when unknown */
  get device() { return this.#device }

  /** @returns {boolean} whether the note came from a tablet, which is when it is offered */
  get offered() { return this.#offered }

  /** @returns {boolean} whether an ask is under way */
  get opening() { return this.#opening !== null }

  /**
   * Asks the tablet to open the note at `pageId`.
   * @param {string|null} pageId the page the reader is on
   * @returns {Promise<void>}
   */
  open(pageId) {
    if (this.#opening) return this.#opening
    const device = this.#device || 'the tablet'
    const status = this.#status
    status.showPending(`Opening on ${device}…`)
    this.#opening = this.#provider.openOnTablet(pageId)
      .then((result) => status.showResult(this.#words(result, device)), (err) => {
        console.warn('[ink] the tablet could not be asked to open the note', err)
        status.showResult('Could not ask the tablet')
      })
      .finally(() => {
        this.#opening = null
        this.#onChange()
      })
    this.#onChange()
    return this.#opening
  }

  /**
   * The toolbar's Open in e-ink, asking at the page `pageId` names when pressed.
   * @param {() => string|null} pageId
   * @returns {ToolbarButton}
   */
  button(pageId) {
    return new ToolbarButton({
      id: 'tb-open-on-tablet', text: 'Open in e-ink', title: 'Open this page on the tablet the note was written on',
      enabled: () => !this.opening,
      onClick: () => { this.open(pageId()) },
    })
  }

  /** @param {InkOpeningResult} result @param {string} device @returns {string} */
  #words(result, device) {
    if (result.outcome === InkOpening.OPENED) return `Opened on ${device}`
    if (result.outcome === InkOpening.REFUSED) {
      return Object.hasOwn(REFUSAL_WORDS, result.reason)
        ? REFUSAL_WORDS[/** @type {keyof typeof REFUSAL_WORDS} */ (result.reason)]
        : `The tablet refused (${result.reason || 'no reason given'})`
    }
    return Object.hasOwn(OPENING_WORDS, result.outcome)
      ? OPENING_WORDS[/** @type {keyof typeof OPENING_WORDS} */ (result.outcome)]
      : 'Could not ask the tablet'
  }
}
