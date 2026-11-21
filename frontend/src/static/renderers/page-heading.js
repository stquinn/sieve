// @ts-check
// The heading printed on a diary page (docs/ink-contract.md §6): the page's date
// in full in English on the page's top line, above the ruling and under every
// stroke. It is print, never a stroke, and is worked out from the note's `type`,
// the page's `name` and the template the page is drawn with. Positions and the
// size are in page units (page width = 1).

import { PageNames } from './page-names.js'

/** @typedef {import('./ink-renderer.js').InkTemplate} InkTemplate */
/** @typedef {import('./ink-renderer.js').InkPage} InkPage */
/** @typedef {Readonly<Record<string, ReadonlyArray<string>>>} InkProperties */

export class PageHeading {
  /** The spacing a template with none above 0 is headed at. */
  static DEFAULT_SPACING = 0.05
  /** The text's size, as a part of the spacing. */
  static SIZE = 0.55
  /** The baseline's depth from the page's top, as a part of the spacing. */
  static BASELINE = 0.8
  /** How far right of the page's left edge, or of a ruled page's margin line, the text starts. */
  static INSET = 0.02
  static COLOR = '#000000'
  static WEEKDAYS = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'])
  static MONTHS = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'])

  /** @type {string} */ text
  /** @type {number} the text's left edge */ x
  /** @type {number} */ baseline
  /** @type {number} */ size

  /**
   * @param {string} text @param {number} x @param {number} baseline @param {number} size
   */
  constructor(text, x, baseline, size) {
    this.text = text
    this.x = x
    this.baseline = baseline
    this.size = size
    Object.freeze(this)
  }

  /**
   * The heading of a page in the export shape; null when it has none.
   * @param {InkPage} page
   * @returns {PageHeading|null}
   */
  static of(page) {
    const names = page?.page?.properties?.name
    const name = Array.isArray(names) && names.length === 1 ? names[0] : ''
    return PageHeading.at(page?.note?.template, PageHeading.textOf(page?.note?.properties, name))
  }

  /**
   * What a page is headed with: its name's date in full — `Saturday 21 November
   * 2026` — when the note's `type` is exactly `diary` and the name is a valid
   * `YYYY-MM-DD`; '' otherwise.
   * @param {InkProperties|null|undefined} noteProperties
   * @param {unknown} name the page's name
   * @returns {string}
   */
  static textOf(noteProperties, name) {
    if (!PageHeading.isDiary(noteProperties) || typeof name !== 'string') return ''
    const date = PageNames.dateOf(name)
    if (!date) return ''
    const weekday = new Date(Date.UTC(date.year, date.month, date.day)).getUTCDay()
    return `${PageHeading.WEEKDAYS[weekday]} ${date.day} ${PageHeading.MONTHS[date.month]} ${date.year}`
  }

  /**
   * Whether a note is a diary: its `type` is exactly `diary`.
   * @param {InkProperties|null|undefined} noteProperties
   * @returns {boolean}
   */
  static isDiary(noteProperties) {
    const type = noteProperties?.type
    return Array.isArray(type) && type.length === 1 && type[0] === 'diary'
  }

  /**
   * `text` placed on a page drawn with `template`: s is the template's spacing
   * when above 0, else DEFAULT_SPACING; m is its margin when it is `ruled` with a
   * margin above 0, else 0. The text starts at m + INSET, its baseline at
   * BASELINE·s, its size SIZE·s.
   * @param {InkTemplate|null|undefined} template the template the page is drawn with
   * @param {string} text
   * @returns {PageHeading|null} null for no text
   */
  static at(template, text) {
    if (!text) return null
    const spacing = Number(template?.params?.spacing)
    const s = spacing > 0 ? spacing : PageHeading.DEFAULT_SPACING
    const margin = Number(template?.params?.margin)
    const m = template?.id === 'ruled' && margin > 0 ? margin : 0
    return new PageHeading(text, m + PageHeading.INSET, PageHeading.BASELINE * s, PageHeading.SIZE * s)
  }
}
