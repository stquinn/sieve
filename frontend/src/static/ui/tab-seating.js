// @ts-check

/**
 * One tab of the strip as seating reads it: its id and when it was last the
 * active tab, in Unix ms (0 for never).
 * @typedef {Readonly<{id: string, viewed: number}>} SeatedTab
 */

/**
 * The strip as rendered: its tabs in order, the index of the active one (-1 for
 * none) and how many tabs, from the left, are fully visible.
 * @typedef {Readonly<{tabs: ReadonlyArray<SeatedTab>, active: number, visible: number}>} Strip
 */

/**
 * One move as the tab reorder verb takes it: the tab at `from` is taken out and
 * put back at insertion position `to`, counted before it was taken out.
 * @typedef {Readonly<{from: number, to: number}>} TabMove
 */

/** Keeps the active tab of a strip that does not scroll where it can be seen. */
export class TabSeating {
  /** @type {boolean} a seating's moves are under way */ #busy = false
  /** @type {Set<string>} the strips, as #signature spells them, the last seating passed through or the strip last accepted */ #settled = new Set()

  /**
   * The moves that seat the active tab of `strip`. A visible active tab, a
   * strip with no visible slot and a strip with no active tab need none.
   * Otherwise the active tab takes the right-most visible slot and the visible
   * tab viewed least recently (never-viewed first, the leftmost of equals)
   * leaves for the first slot past the fold; the visible tabs between shift
   * left by one, and every other tab keeps its place. At most two moves:
   * the leaving tab to the fold, then the active tab to the last visible slot.
   * @param {Strip} strip
   * @returns {TabMove[]}
   */
  movesFor(strip) {
    const { tabs, active, visible } = strip
    if (active < 0 || active >= tabs.length || visible <= 0 || active < visible) return []
    let leaving = 0
    for (let i = 1; i < visible; i++) {
      if (tabs[i].viewed < tabs[leaving].viewed) leaving = i
    }
    /** @type {TabMove[]} */
    const moves = []
    if (leaving !== visible - 1) moves.push(Object.freeze({ from: leaving, to: visible }))
    moves.push(Object.freeze({ from: active, to: visible - 1 }))
    return moves
  }

  /**
   * Seats the active tab of `strip` through `reorder`, each move settled
   * before the next is asked, unless a seating is under way or `strip` is one
   * the last seating passed through — before, between or after its moves — or
   * the strip last accepted. A render that arrives late shows such a strip, and
   * the moves are indices, so seating it again would move the wrong tabs; the
   * same rule stops a tab that cannot be made visible from being moved again on
   * every render.
   * @param {Strip} strip
   * @param {(from: number, to: number) => Promise<any>|any} reorder
   * @returns {Promise<void>}
   */
  seat(strip, reorder) {
    if (this.#busy || this.#settled.has(this.#signature(strip))) return Promise.resolve()
    const moves = this.movesFor(strip)
    if (!moves.length) return Promise.resolve()
    this.#busy = true
    this.#settled = new Set([this.#signature(strip)])
    let passed = strip
    for (const move of moves) {
      passed = this.#apply(passed, move)
      this.#settled.add(this.#signature(passed))
    }
    return moves
      .reduce((done, m) => done.then(() => reorder(m.from, m.to)), Promise.resolve())
      .catch((err) => { console.warn('[tabbar] seating the active tab failed', err) })
      .finally(() => { this.#busy = false })
  }

  /**
   * Takes `strip` as placed by hand, so it is not seated again until its tabs,
   * their order or the active tab change.
   * @param {Strip} strip
   */
  accept(strip) {
    this.#settled = new Set([this.#signature(strip)])
  }

  /** @param {Strip} strip @param {TabMove} move @returns {Strip} `strip` after `move` */
  #apply(strip, { from, to }) {
    const tabs = strip.tabs.slice()
    const [moved] = tabs.splice(from, 1)
    const at = to > from ? to - 1 : to
    tabs.splice(at, 0, moved)
    let active = strip.active
    if (active === from) active = at
    else if (active > from && active <= at) active--
    else if (active < from && active >= at) active++
    return { tabs, active, visible: strip.visible }
  }

  /** @param {Strip} strip @returns {string} the tab order, the active tab and the visible count */
  #signature(strip) {
    const active = strip.tabs[strip.active]
    return strip.tabs.map((t) => t.id).join(',') + '|' + (active ? active.id : '') + '|' + strip.visible
  }
}
