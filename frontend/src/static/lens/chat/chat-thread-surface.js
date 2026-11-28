// @ts-check
// The one surface ChatLens has: the thread, in a scroller of its own, read as a
// conversation. Each exchange is two messages, my question then its answer,
// each a ChatMessage, in the chat's order with the newest at the bottom. A
// message is made once per exchange and side and kept across repaints, and a
// change redraws only the exchanges it names, so an answer block arriving
// redraws its own exchange and no other. Before the first message of each
// calendar day the thread says the day once, in a separator; a question and its
// answer may fall either side of one. Every message shows its time, and the
// surface's clock moves the labels on while it is mounted without redrawing a
// message. While an answer is being written, a one-second tick, running only
// while one is, moves on how long it has been awaited. The latest answer keeps
// its actions shown. While the reader is at the bottom, what arrives is kept in
// view; a reader who has scrolled up is left where they are, and a quiet Jump to
// latest at the foot of the thread, shown only while they are away, takes them
// back and resumes following. It says when something has arrived since they
// left the newest. A chat with no exchange says it is empty. The thread's column
// is the `--thread-*` measure, and the status bar reads the count of exchanges.
//
// The scroll it reports and restores is measured UP FROM THE NEWEST message, in
// pixels: 0 is at the newest, which is where a chat never seen before opens and
// where following resumes, and a reader within the follow slack of it reports 0.
//
// What it feeds its lens's selection model is the chat and its last exchange,
// quoting nothing; a chat with no exchange selects nothing, and its target is
// the chat. Quote on a message reports the `quote` intent carrying the
// message's exchange and the quoted text, every press, and changes nothing
// about the selection.
// An attachment chip or a block that asks to open an address reports the
// `open-container` intent with that address, and with the text the block seeks
// there when it names one.

import { AbstractSurface, SurfaceEvent, SurfaceIntent } from '../abstract-surface.js'
import { ChatMessage } from '../../renderers/chat-message.js'
import { ThreadTime } from '../../renderers/thread-time.js'
import { rendererStyles } from '../../renderers/renderer-style-registry.js'

/** @typedef {import('../document-editor/selection-model.js').RawSelectionDescriptor} RawSelectionDescriptor */
/** @typedef {import('../../renderers/chat-message.js').MessageQuote} MessageQuote */
/** @typedef {Readonly<{id: string, kind?: string, attrs: Record<string, any>}>} Exchange */
/** @typedef {{question: ChatMessage, answer: ChatMessage}} Turn */
/** @typedef {{element: HTMLElement, label: HTMLElement, at: Date}} DaySeparator */

/**
 * What the surface asks of the lens it is presented by.
 * @typedef {object} ChatThreadHost
 * @property {string} uuid the chat
 * @property {(exchangeId: string) => void} retry
 * @property {(text: string) => unknown} copy
 * @property {(event: import('../abstract-surface.js').SurfaceEventMsg) => void} onSurfaceEvent
 *   told when the thread holds a different number of exchanges, when the
 *   selection it feeds changes, when a message is quoted, when a message asks
 *   to open an address, and when the scroll it reports may have moved: after
 *   every repaint, and once the reader's scrolling has settled
 */

export class ChatThreadSurface extends AbstractSurface {
  /** The mode this surface presents. */
  static MODE = 'chat'

  /** How far from the bottom, in px, the reader still counts as at it. */
  static FOLLOW_SLACK = 48

  /** How often, in ms, the clock moves the time labels on while mounted. */
  static CLOCK_MS = 30 * 1000

  /** How often, in ms, the time an answer has been awaited moves on while one is being written. */
  static PENDING_TICK_MS = 1000

  /** How long, in ms, the scroller is still before its position is reported. */
  static SCROLL_SETTLE_MS = 300

  /** What an empty chat shows. */
  static EMPTY_TEXT = 'Nothing has been asked yet.'

  /** The target a chat puts forward for an ask: none. A question in a chat is
   *  about nothing it points at, so the label is empty, which draws no target. */
  static #NO_TARGET = Object.freeze({ kind: 'document', ref: 'doc', range: null, label: '' })

  /** The class of a day separator. */
  static DAY_CLASS = 'chat-thread__day'

  /** The class of Jump to latest, and of it while something has arrived since the reader left. */
  static JUMP_CLASS = 'chat-thread__jump'
  static ARRIVED_CLASS = 'chat-thread__jump--arrived'

  /** What Jump to latest is called, and called while something has arrived. */
  static JUMP_LABEL = 'Jump to latest'
  static ARRIVED_LABEL = 'Jump to latest: new messages'

  static styles = /* css */ `
  .chat-thread {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .chat-thread__column {
    box-sizing: border-box;
    width: 100%;
    max-width: calc(var(--thread-measure) + 2 * var(--thread-gutter));
    margin: 0 auto;
    padding: 20px var(--thread-gutter) 12px;
    display: flex;
    flex-direction: column;
  }

  .chat-thread__column > .chat-message--question,
  .chat-thread__column > .chat-thread__day {
    margin-top: var(--thread-turn-gap);
  }

  .chat-thread__column > .chat-message--answer,
  .chat-thread__column > .chat-thread__day + .chat-message {
    margin-top: var(--thread-reply-gap);
  }

  .chat-thread__column > :first-child {
    margin-top: 0;
  }

  .chat-thread__day {
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--theme-textDim);
    font-family: var(--theme-uiFont);
    font-size: calc(var(--doc-size) * 0.75);
    user-select: none;
    -webkit-user-select: none;
  }

  .chat-thread__day::before,
  .chat-thread__day::after {
    content: '';
    flex: 1 1 auto;
    border-top: 1px solid var(--theme-border2);
  }

  .chat-thread__empty {
    margin: auto;
    padding: 24px;
    color: var(--theme-muted);
    font-size: calc(var(--doc-size) * 0.85);
  }

  .chat-thread__jump {
    position: sticky;
    bottom: 12px;
    align-self: center;
    flex: 0 0 auto;
    box-sizing: border-box;
    min-width: 28px;
    height: 28px;
    padding: 0 10px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--theme-border2);
    border-radius: 14px;
    background: var(--theme-bgAlt);
    color: var(--theme-textDim);
    font-family: var(--theme-uiFont);
    font-size: calc(var(--doc-size) * 0.75);
    cursor: pointer;
  }

  .chat-thread__jump[hidden] {
    display: none;
  }

  .chat-thread__jump:hover {
    color: var(--theme-text);
    border-color: var(--theme-border);
  }

  .chat-thread__jump:focus-visible {
    outline: 2px solid var(--theme-accentPrimary);
    outline-offset: 2px;
  }

  .chat-thread__jump-dot {
    display: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--theme-accentPrimary);
  }

  .chat-thread__jump--arrived .chat-thread__jump-dot {
    display: inline-block;
  }
`

  /** @type {ChatThreadHost} */ #host
  /** @type {ThreadTime} */ #clock = new ThreadTime()
  /** @type {HTMLElement|null} the scroller */ #root = null
  /** @type {HTMLElement|null} */ #column = null
  /** @type {HTMLElement|null} */ #empty = null
  /** @type {HTMLButtonElement|null} Jump to latest */ #jump = null
  /** @type {boolean} something has arrived since the reader left the newest */ #arrived = false
  /** @type {ReturnType<typeof setInterval>|null} */ #timer = null
  /** @type {ReturnType<typeof setInterval>|null} runs only while an answer is being written */ #tick = null
  /** @type {ReturnType<typeof setTimeout>|null} */ #scrollTimer = null
  /** @type {Map<string, Turn>} exchange id → the two messages drawing it */ #turns = new Map()
  /** @type {{leaf: string, seek: string}|null} the exchange to bring into view once the thread has drawn it, and the text sought in it */ #revealing = null
  /** @type {boolean} whether the reader was taken to an exchange, or is owed one, since the thread was mounted */ #revealed = false
  /** @type {Map<string, DaySeparator>} calendar day → the separator saying it */ #days = new Map()
  /** @type {ChatMessage|null} the answer drawn as the latest */ #latest = null
  /** @type {ReadonlyArray<Exchange>} the exchanges as last drawn, in order */ #exchanges = []
  /** @type {string|null} what the selection last fed named */ #fed = null

  /** @param {ChatThreadHost} host the lens presenting the chat */
  constructor(host) {
    super()
    this.#host = host
    rendererStyles.register(ChatThreadSurface)
  }

  /** @returns {string} */
  get mode() { return ChatThreadSurface.MODE }

  /**
   * How many exchanges the chat holds, as the status bar reads it.
   * @returns {import('../abstract-surface.js').SurfaceStats}
   */
  stats() {
    const count = this.#turns.size
    return {
      chars: 0, lines: 0, blockCount: count,
      readout: Object.freeze([
        Object.freeze({ text: `chat · ${count} exchange${count === 1 ? '' : 's'}`, title: 'Exchanges in this chat' }),
      ]),
    }
  }

  /** @param {HTMLElement} rootEl */
  mount(rootEl) {
    const root = document.createElement('div')
    root.className = 'chat-thread'
    const column = document.createElement('div')
    column.className = 'chat-thread__column'
    const empty = document.createElement('div')
    empty.className = 'chat-thread__empty'
    empty.textContent = ChatThreadSurface.EMPTY_TEXT
    const jump = this.#jumpButton()
    root.append(column, empty, jump)
    rootEl.appendChild(root)
    root.addEventListener('scroll', () => {
      this.#drawJump()
      this.#reportScrollSettled()
    })
    this.#root = root
    this.#column = column
    this.#empty = empty
    this.#jump = jump
    this.#drawJump()
    this.#timer = setInterval(() => this.#tellTime(new Date()), ChatThreadSurface.CLOCK_MS)
  }

  unmount() {
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
    this.#stopTick()
    if (this.#scrollTimer !== null) clearTimeout(this.#scrollTimer)
    this.#scrollTimer = null
    for (const turn of this.#turns.values()) { turn.question.destroy(); turn.answer.destroy() }
    this.#turns.clear()
    this.#days.clear()
    this.#latest = null
    this.#exchanges = []
    this.#fed = null
    if (this.#root) this.#root.remove()
    this.#root = null
    this.#column = null
    this.#empty = null
    this.#jump = null
    this.#arrived = false
  }

  /** @returns {boolean} whether the one-second tick is running: an answer is being written */
  get ticking() { return this.#tick !== null }

  /** @returns {number|null} how far up from the newest message the reader is, in px; null unmounted */
  feedScroll() {
    const root = this.#root
    if (!root) return null
    if (this.#atNewest()) return 0
    return Math.max(0, Math.round(root.scrollHeight - root.scrollTop - root.clientHeight))
  }

  /**
   * Puts the reader `value` px up from the newest message; 0 is at the newest,
   * following what arrives. null or undefined leaves the thread where it is, and
   * so does any value once the reader was taken to an exchange (reveal).
   * @param {number|null|undefined} value
   */
  applyScroll(value) {
    const root = this.#root
    if (value == null || !root || this.#revealed) return
    root.scrollTop = Math.max(0, root.scrollHeight - root.clientHeight - Math.max(0, value))
    this.#drawJump()
    this.#host.onSurfaceEvent(SurfaceEvent.SCROLL_CHANGED)
  }

  /** @returns {boolean} whether Jump to latest is shown: the reader is away from the newest */
  get jumpShown() { return !!this.#jump && !this.#jump.hidden }

  /** @returns {boolean} whether Jump to latest says something has arrived since the reader left */
  get arrivedSince() { return this.#arrived }

  /**
   * Brings the exchange `leaf` into view. With `seek`, the message of the
   * exchange that holds that text (ChatMessage.holds) has its top put at the top
   * of the thread and is marked for a moment, and no other: the question when it
   * holds the text, else the answer when it does. When neither holds it, or
   * nothing is sought, the top of the question is put at the top of the thread
   * and nothing is marked. Asked before the thread has drawn that exchange, it
   * is done when the thread draws it, once. An id the chat does not hold changes
   * nothing. A thread that has taken its reader to an exchange is not then put
   * back where the reader last was.
   * @param {string} leaf an exchange id
   * @param {string} [seek] the text looked for in the exchange
   */
  reveal(leaf, seek) {
    if (typeof leaf !== 'string' || !leaf) return
    const sought = typeof seek === 'string' ? seek : ''
    const turn = this.#turns.get(leaf)
    if (!turn) {
      this.#revealing = this.#exchanges.length ? null : { leaf: leaf, seek: sought }
      this.#revealed = this.#revealing !== null
      return
    }
    this.#revealing = null
    this.#revealed = true
    const holder = ChatThreadSurface.#holderOf(turn, sought)
    if (holder) holder.reveal(true)
    else turn.question.reveal(false)
    this.#drawJump()
  }

  /** Takes the reader to the newest message, and so back to following what arrives. */
  jumpToLatest() {
    const root = this.#root
    if (!root) return
    root.scrollTop = root.scrollHeight
    this.#arrived = false
    this.#drawJump()
  }

  /**
   * @param {{blockIds: ReadonlyArray<string>, replaced?: ReadonlyArray<string>}} change
   * @param {any} provider the chat's ChatContainerProvider
   */
  applyContainerChange(change, provider) {
    this.#paint(provider, new Set([...(change.blockIds || []), ...(change.replaced || [])]))
  }

  /** @param {any} provider the chat's ChatContainerProvider */
  paintContainer(provider) { this.#paint(provider, null) }

  flushPending() {}

  /**
   * The chat and its last exchange, with no target for an ask.
   * @returns {Readonly<RawSelectionDescriptor>}
   */
  feedSelection() {
    const last = this.#exchanges.length ? this.#exchanges[this.#exchanges.length - 1] : null
    if (!last) {
      return Object.freeze({
        selectionType: 'none',
        target: ChatThreadSurface.#NO_TARGET,
      })
    }
    return Object.freeze({
      selectionType: 'block',
      blockId: last.id,
      blockIds: [last.id],
      blockKind: last.kind || 'ai-block',
      ref: last.id,
      selectedText: null,
      target: ChatThreadSurface.#NO_TARGET,
    })
  }

  /**
   * Draws the thread as the chat now holds it: the two messages made for each
   * exchange new to it, those of the exchanges `named` redrawn (all of them when
   * null), a day separator before the first message of each day, each in the
   * chat's order, and the messages of an exchange that is gone dropped.
   * @param {any} provider
   * @param {Set<string>|null} named
   */
  #paint(provider, named) {
    const column = this.#column
    if (!column || !this.#root || !this.#empty) return
    const follow = this.#atNewest()
    const before = this.#turns.size
    /** @type {ReadonlyArray<Exchange>} */
    const exchanges = provider.getExchanges()
    const held = new Set(exchanges.map((exchange) => exchange.id))
    for (const [id, turn] of this.#turns) {
      if (held.has(id)) continue
      for (const message of [turn.question, turn.answer]) { message.destroy(); message.element.remove() }
      this.#turns.delete(id)
    }
    for (const exchange of exchanges) {
      const known = this.#turns.get(exchange.id)
      if (known && named && !named.has(exchange.id)) continue
      const turn = known || this.#turnFor()
      turn.question.draw(exchange)
      turn.answer.draw(exchange)
      this.#turns.set(exchange.id, turn)
    }
    this.#place(column, exchanges)
    const last = exchanges.length ? this.#turns.get(exchanges[exchanges.length - 1].id) : null
    this.#markLatest(last ? last.answer : null)
    this.#tellTime(new Date())
    this.#empty.hidden = exchanges.length > 0
    if (follow) this.#root.scrollTop = this.#root.scrollHeight
    else if (named === null ? exchanges.length !== before : named.size > 0 || this.#turns.size !== before) this.#arrived = true
    this.#drawJump()
    this.#exchanges = exchanges
    if (this.#revealing !== null) this.reveal(this.#revealing.leaf, this.#revealing.seek)
    if (this.#turns.size !== before) this.#host.onSurfaceEvent(SurfaceEvent.DOC_PROJECTED)
    this.#feed()
    this.#syncTick()
    this.#host.onSurfaceEvent(SurfaceEvent.SCROLL_CHANGED)
  }

  /**
   * The message of `turn` that holds `seek`: the question when it does, else the
   * answer when it does, else none; none when nothing is sought.
   * @param {Turn} turn @param {string} seek @returns {ChatMessage|null}
   */
  static #holderOf(turn, seek) {
    if (!seek) return null
    if (turn.question.holds(seek)) return turn.question
    if (turn.answer.holds(seek)) return turn.answer
    return null
  }

  /** Runs the one-second tick while an answer is being written, and stops it when none is. */
  #syncTick() {
    let answering = false
    for (const turn of this.#turns.values()) if (turn.answer.answering) { answering = true; break }
    if (answering && this.#tick === null) {
      this.#tick = setInterval(() => this.#tellElapsed(new Date()), ChatThreadSurface.PENDING_TICK_MS)
    } else if (!answering) {
      this.#stopTick()
    }
  }

  #stopTick() {
    if (this.#tick !== null) clearInterval(this.#tick)
    this.#tick = null
  }

  /** Writes how long each answer being written has been awaited at `now`. @param {Date} now */
  #tellElapsed(now) {
    for (const turn of this.#turns.values()) turn.answer.showElapsed(now)
  }

  /** Reports the scroll once the scroller has been still a moment. */
  #reportScrollSettled() {
    if (this.#scrollTimer !== null) clearTimeout(this.#scrollTimer)
    this.#scrollTimer = setTimeout(() => {
      this.#scrollTimer = null
      this.#host.onSurfaceEvent(SurfaceEvent.SCROLL_CHANGED)
    }, ChatThreadSurface.SCROLL_SETTLE_MS)
  }

  /**
   * Puts the messages in the column in the chat's order, a day separator before
   * the first message of each day, and drops a separator no message needs.
   * @param {HTMLElement} column @param {ReadonlyArray<Exchange>} exchanges
   */
  #place(column, exchanges) {
    /** @type {HTMLElement[]} */ const sequence = []
    /** @type {Set<string>} */ const said = new Set()
    for (const exchange of exchanges) {
      const turn = /** @type {Turn} */ (this.#turns.get(exchange.id))
      for (const message of [turn.question, turn.answer]) {
        const at = message.at
        const day = at ? this.#clock.dayOf(at) : null
        if (at && day && !said.has(day)) {
          said.add(day)
          sequence.push(this.#separatorFor(day, at).element)
        }
        sequence.push(message.element)
      }
    }
    for (const [day, separator] of this.#days) {
      if (said.has(day)) continue
      separator.element.remove()
      this.#days.delete(day)
    }
    /** @type {ChildNode|null} */ let next = column.firstChild
    for (const el of sequence) {
      if (el === next) next = next.nextSibling
      else column.insertBefore(el, next)
    }
  }

  /** @param {string} day @param {Date} at the first message's time that day @returns {DaySeparator} */
  #separatorFor(day, at) {
    const known = this.#days.get(day)
    if (known) { known.at = at; return known }
    const element = document.createElement('div')
    element.className = ChatThreadSurface.DAY_CLASS
    element.setAttribute('role', 'separator')
    element.setAttribute('data-day', day)
    const label = document.createElement('span')
    label.className = ChatThreadSurface.DAY_CLASS + '-label'
    element.appendChild(label)
    const separator = { element, label, at }
    this.#days.set(day, separator)
    return separator
  }

  /** Writes every message's time and every day's label as they read at `now`.
   *  @param {Date} now */
  #tellTime(now) {
    for (const turn of this.#turns.values()) {
      for (const message of [turn.question, turn.answer]) {
        const at = message.at
        message.showTime(at ? this.#clock.ofMessage(at, now) : '')
      }
    }
    for (const separator of this.#days.values()) separator.label.textContent = this.#clock.ofDay(separator.at, now)
    this.#tellElapsed(now)
  }

  /** @param {ChatMessage|null} answer */
  #markLatest(answer) {
    if (answer === this.#latest) return
    if (this.#latest) this.#latest.setLatest(false)
    if (answer) answer.setLatest(true)
    this.#latest = answer
  }

  /** Tells the lens the selection changed, when what it names did. */
  #feed() {
    const selection = this.feedSelection()
    const fed = (selection.blockId || '') + '|' + (selection.target ? selection.target.label : '')
    if (fed === this.#fed) return
    this.#fed = fed
    this.#host.onSurfaceEvent(SurfaceEvent.SELECTION_CHANGED)
  }

  /** @returns {boolean} whether the reader is at the newest exchange, which a
   *  thread that has drawn none always is */
  #atNewest() {
    const root = /** @type {HTMLElement} */ (this.#root)
    if (this.#turns.size === 0) return true
    return root.scrollHeight - root.scrollTop - root.clientHeight <= ChatThreadSurface.FOLLOW_SLACK
  }

  /** @returns {HTMLButtonElement} Jump to latest, hidden */
  #jumpButton() {
    const jump = document.createElement('button')
    jump.type = 'button'
    jump.className = ChatThreadSurface.JUMP_CLASS
    jump.hidden = true
    const dot = document.createElement('span')
    dot.className = 'chat-thread__jump-dot'
    dot.setAttribute('aria-hidden', 'true')
    const label = document.createElement('span')
    label.textContent = '↓ Latest'
    label.setAttribute('aria-hidden', 'true')
    jump.append(dot, label)
    jump.addEventListener('mousedown', (e) => { e.preventDefault() })
    jump.addEventListener('click', () => this.jumpToLatest())
    return jump
  }

  /** Shows Jump to latest while the reader is away from the newest, saying whether
   *  something has arrived since; at the newest it is hidden and nothing is new. */
  #drawJump() {
    const jump = this.#jump
    if (!jump || !this.#root) return
    const away = !this.#atNewest()
    if (!away) this.#arrived = false
    jump.hidden = !away
    jump.classList.toggle(ChatThreadSurface.ARRIVED_CLASS, this.#arrived)
    const label = this.#arrived ? ChatThreadSurface.ARRIVED_LABEL : ChatThreadSurface.JUMP_LABEL
    jump.title = label
    jump.setAttribute('aria-label', label)
  }

  /** @returns {Turn} */
  #turnFor() {
    const intents = {
      copy: (/** @type {string} */ text) => { this.#host.copy(text) },
      quote: (/** @type {MessageQuote} */ quote) => this.#host.onSurfaceEvent({ type: SurfaceIntent.QUOTE, blockId: quote.exchangeId, text: quote.text }),
      retry: (/** @type {string} */ exchangeId) => this.#host.retry(exchangeId),
      open: (/** @type {string} */ uri, /** @type {string|undefined} */ seek) => this.#host.onSurfaceEvent(
        seek ? { type: SurfaceIntent.OPEN_CONTAINER, uri: uri, seek: seek } : { type: SurfaceIntent.OPEN_CONTAINER, uri: uri }),
    }
    return {
      question: new ChatMessage(ChatMessage.Side.QUESTION, this.#host.uuid, intents),
      answer: new ChatMessage(ChatMessage.Side.ANSWER, this.#host.uuid, intents),
    }
  }
}
