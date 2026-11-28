// @ts-check
// ThreadTime: how a time reads in a conversation's thread. A message's label
// says how long ago it was written while that is recent, and the time of day
// after; a day's label says which calendar day a run of messages fell on. Both
// are read against a `now` the caller passes, so a label is a pure function of
// the two times, and nothing here keeps or schedules anything. Days are the
// platform's local calendar days, and the time of day and the date are written
// in the locale this was constructed with.

export class ThreadTime {
  /** What a message less than a minute old says. */
  static RECENT = 'a few seconds ago'

  /** What a day separator says of the day `now` falls on, and of the one before. */
  static TODAY = 'Today'
  static YESTERDAY = 'Yesterday'

  /** Up to this age a message says its age in minutes. */
  static #MINUTES_SHOWN = 5

  static #MINUTE_MS = 60 * 1000

  /** @type {Intl.DateTimeFormat} */ #timeOfDay
  /** @type {Intl.DateTimeFormat} */ #date
  /** @type {Intl.DateTimeFormat} */ #dateWithYear

  /**
   * @param {string|string[]} [locale] the locale times and dates are written in;
   *   the platform's when omitted
   */
  constructor(locale) {
    this.#timeOfDay = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })
    this.#date = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' })
    this.#dateWithYear = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  }

  /**
   * A time as a stored attr holds one.
   * @param {any} value an ISO 8601 timestamp
   * @returns {Date|null} null when it holds no readable time
   */
  static parse(value) {
    if (!value) return null
    const at = new Date(String(value))
    return Number.isNaN(at.getTime()) ? null : at
  }

  /**
   * What a message written at `at` says of its time, read at `now`: under a
   * minute (a time ahead of `now` included) {@link ThreadTime.RECENT}; from one
   * to five minutes "1 minute ago" … "5 minutes ago"; older, the time of day.
   * @param {Date} at @param {Date} now
   * @returns {string}
   */
  ofMessage(at, now) {
    const age = now.getTime() - at.getTime()
    if (age < ThreadTime.#MINUTE_MS) return ThreadTime.RECENT
    if (age <= ThreadTime.#MINUTES_SHOWN * ThreadTime.#MINUTE_MS) {
      const minutes = Math.floor(age / ThreadTime.#MINUTE_MS)
      return minutes + (minutes === 1 ? ' minute ago' : ' minutes ago')
    }
    return this.#timeOfDay.format(at)
  }

  /**
   * What the separator before the first message of `at`'s day says, read at
   * `now`: {@link ThreadTime.TODAY}, {@link ThreadTime.YESTERDAY}, else the
   * weekday and date, with the year when it is not `now`'s.
   * @param {Date} at @param {Date} now
   * @returns {string}
   */
  ofDay(at, now) {
    const day = this.dayOf(at)
    if (day === this.dayOf(now)) return ThreadTime.TODAY
    if (day === this.dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return ThreadTime.YESTERDAY
    return (at.getFullYear() === now.getFullYear() ? this.#date : this.#dateWithYear).format(at)
  }

  /**
   * The calendar day `at` falls on, as a key two times on the same day share.
   * @param {Date} at
   * @returns {string} `YYYY-MM-DD`
   */
  dayOf(at) {
    return at.getFullYear() + '-' + String(at.getMonth() + 1).padStart(2, '0') + '-' + String(at.getDate()).padStart(2, '0')
  }
}
