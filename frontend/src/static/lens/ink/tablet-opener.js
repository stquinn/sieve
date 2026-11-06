// @ts-check
// Open on device: asks the tablet a note came from to open the note at a page,
// saying in an ActionStatus that it is asking and then what came of it. A second
// ask while one is under way is the same ask. It is offered only for a note that
// came from a tablet, which the note's block says.

import { InkOpening, InkRefusal } from '../../contract/ink-container-provider.js'

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

  /** @returns {string} the name of the device the note was written on; '' when unknown */
  get device() {
    const device = this.#attrs().note_device
    return String((device && device.name) || '')
  }

  /** @returns {boolean} whether the note came from a tablet, which is when it is offered */
  get offered() { return !!this.#attrs().note_source_id }

  /** @returns {boolean} whether an ask is under way */
  get opening() { return this.#opening !== null }

  /**
   * Asks the tablet to open the note at `pageId`.
   * @param {string|null} pageId the page the reader is on
   * @returns {Promise<void>}
   */
  open(pageId) {
    if (this.#opening) return this.#opening
    const device = this.device || 'the tablet'
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

  /** @returns {Record<string, any>} the note's block attrs as they now stand */
  #attrs() {
    const id = this.#provider.getOrder()[0]
    const block = id ? this.#provider.getBlock(id) : null
    return (block && block.attrs) || {}
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
