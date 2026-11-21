// @ts-check
// What a Digital Note's page is called. An unnamed page is called by its place
// from 1; a named one by its name, or, when the name is an ISO calendar date
// (`YYYY-MM-DD`), by that date relative to today in local time: `Today`,
// `Yesterday`, `Tomorrow`, else `Fri 20 Nov`, with the year when it is not this
// year's. Adjacent pages of the same name are one run, and a named page's place
// is its place in its run. Every label is worked out when asked, the clock read
// then, and never kept.

/** @typedef {Readonly<{name?: unknown}>} NamedPage */

export class PageNames {
  static WEEKDAYS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
  static MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'])
  static DATE = /^(\d{4})-(\d{2})-(\d{2})$/
  static DAY_MS = 86_400_000

  /** @type {() => Date} */ #clock

  /** @param {() => Date} [clock] today's date, read each time a date name is labelled */
  constructor(clock = () => new Date()) {
    this.#clock = clock
  }

  /**
   * What the drop-down lists each page as: `Page n` unnamed; a named page's
   * label, with its place in its run when the run is longer than one.
   * @param {ReadonlyArray<NamedPage>} pages
   * @returns {string[]}
   */
  listed(pages) {
    const today = this.#today(pages)
    return pages.map((_, index) => {
      const run = this.#run(pages, index)
      if (!run) return `Page ${index + 1}`
      const label = this.#label(run.name, today)
      return run.of > 1 ? `${label} · ${run.at} / ${run.of}` : label
    })
  }

  /**
   * The closed face of the drop-down on page `index`: `n / N` unnamed,
   * `{label} · k / K` named, `0 / 0` for a note of no pages.
   * @param {ReadonlyArray<NamedPage>} pages @param {number} index
   * @returns {string}
   */
  face(pages, index) {
    if (!pages.length) return '0 / 0'
    return this.#named(pages, index) ?? `${index + 1} / ${pages.length}`
  }

  /**
   * Where page `index` is, as a readout says it: `Page n of N` unnamed, its
   * face named.
   * @param {ReadonlyArray<NamedPage>} pages @param {number} index
   * @returns {string}
   */
  place(pages, index) {
    return this.#named(pages, index) ?? `Page ${index + 1} of ${pages.length}`
  }

  /**
   * The page a reader of a note starts at when no page is asked for: a diary's
   * last page named today's date in local time, else its last page; any other
   * note's first page. The clock is read only for a diary with pages. This is
   * the page the Diary opens a diary at on the same day.
   * @param {ReadonlyArray<NamedPage>} pages
   * @param {boolean} diary whether the note is a diary (`PageHeading.isDiary`)
   * @returns {number} the page's index; -1 for a note of no pages
   */
  startOf(pages, diary) {
    if (!pages.length) return -1
    if (!diary) return 0
    const today = this.#clock()
    for (let index = pages.length - 1; index >= 0; index--) {
      const date = PageNames.dateOf(this.#nameOf(pages[index]))
      if (date && date.year === today.getFullYear() && date.month === today.getMonth() && date.day === today.getDate()) return index
    }
    return pages.length - 1
  }

  /**
   * A named page's `{label} · k / K`; null for an unnamed page.
   * @param {ReadonlyArray<NamedPage>} pages @param {number} index
   * @returns {string|null}
   */
  #named(pages, index) {
    const run = this.#run(pages, index)
    if (!run) return null
    return `${this.#label(run.name, this.#today([pages[index]]))} · ${run.at} / ${run.of}`
  }

  /**
   * Page `index`'s name and its place in the run of adjacent pages of that
   * name; null when the page has no name.
   * @param {ReadonlyArray<NamedPage>} pages @param {number} index
   * @returns {{name: string, at: number, of: number}|null}
   */
  #run(pages, index) {
    const name = this.#nameOf(pages[index])
    if (!name) return null
    let first = index
    while (first > 0 && this.#nameOf(pages[first - 1]) === name) first--
    let last = index
    while (last < pages.length - 1 && this.#nameOf(pages[last + 1]) === name) last++
    return { name, at: index - first + 1, of: last - first + 1 }
  }

  /** @param {NamedPage|undefined} page @returns {string} its name trimmed, '' for none */
  #nameOf(page) {
    return page && typeof page.name === 'string' ? page.name.trim() : ''
  }

  /**
   * Today, read from the clock only when some page of `pages` is named by a date.
   * @param {ReadonlyArray<NamedPage>} pages
   * @returns {Date|null}
   */
  #today(pages) {
    return pages.some((page) => PageNames.dateOf(this.#nameOf(page))) ? this.#clock() : null
  }

  /**
   * What `name` is shown as: its date relative to `today` when it is one, else itself.
   * @param {string} name @param {Date|null} today
   * @returns {string}
   */
  #label(name, today) {
    const date = PageNames.dateOf(name)
    if (!date || !today) return name
    const days = Math.round((Date.UTC(date.year, date.month, date.day)
      - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / PageNames.DAY_MS)
    if (days === 0) return 'Today'
    if (days === -1) return 'Yesterday'
    if (days === 1) return 'Tomorrow'
    const weekday = PageNames.WEEKDAYS[new Date(date.year, date.month, date.day).getDay()]
    const shown = `${weekday} ${date.day} ${PageNames.MONTHS[date.month]}`
    return date.year === today.getFullYear() ? shown : `${shown} ${date.year}`
  }

  /**
   * `name` as a calendar date, its month from 0; null when it is not a valid `YYYY-MM-DD`.
   * @param {string} name
   * @returns {{year: number, month: number, day: number}|null}
   */
  static dateOf(name) {
    const match = PageNames.DATE.exec(name)
    if (!match) return null
    const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])]
    const date = new Date(year, month, day)
    if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null
    return { year, month, day }
  }
}
