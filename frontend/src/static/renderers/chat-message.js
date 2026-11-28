// @ts-check
// ChatMessage: one message of a chat's thread, either side of an exchange. A
// QUESTION message is my move: right, in the speaker surface, its blocks by kind
// and what it was handed docked under it as chips; what it is about has no
// entry. An ANSWER message is the reply: left, open, at the column's width with
// no container of its own, each block drawn read-only by its kind's renderer and
// offering its own Copy. While the answer is being written it shows the
// PendingSlot in its place, then under its last block, counting from when the
// question was asked as its host tells it the time (`showElapsed`); once its job
// failed or timed out it says so there and offers Retry.
//
// Under the message, in one row, sit its time and its actions, Copy and Quote.
// The time is the label its host writes (`showTime`), shown only while the
// message has a time: a question's is when it was asked, an answer's when it
// was completed. The actions show while the pointer is over the message or the
// focus is inside it, and stay shown on the message its host calls the latest
// (`setLatest`). A block's Copy shows while that block is hovered or focused,
// whatever the message is doing. A question draws its blocks and the quotes it
// was asked with in the order they were written.
//
// It reports every intent through the callback it was handed and does nothing
// else about it: no clipboard, no navigation, no provider. Quote reports the
// text selected inside the message when the selection lies within it, else the
// message's opening, on every press. Open is reported from an attachment chip
// and from any block whose renderer offers an open intent, with the address it
// was handed and, from a block, the text it seeks there. Nothing here edits,
// removes or reorders an exchange or a block of one.

import { rendererStyles } from './renderer-style-registry.js'
import { chatMessageStyles } from './chat-message.styles.js'
import { QuestionListView } from './question-list-view.js'
import { QuestionList } from './question-list.js'
import { ReferenceChip } from './reference-chip.js'
import { ReferenceRenderer } from './reference-renderer.js'
import { AiBlockRenderer } from './ai-block-renderer.js'
import { PendingSlot } from './pending-slot.js'
import { ThreadTime } from './thread-time.js'
import { ContractViolation } from '../contract/sieve-block.js'

/** @typedef {import('./question-list.js').QuestionElement} QuestionElement */
/** @typedef {'question'|'answer'} MessageSide */

/**
 * What a Quote reports: the exchange the message belongs to, which side of it
 * the message is, and the text quoted.
 * @typedef {{exchangeId: string, side: MessageSide, text: string}} MessageQuote
 */

/**
 * What a message reports, one callback per intent.
 * @typedef {object} MessageIntents
 * @property {(text: string) => void} copy   put this text on the clipboard: the
 *   whole message as markdown from the message's Copy, one block's from that
 *   block's
 * @property {(quote: MessageQuote) => void} quote   quote this message
 * @property {(exchangeId: string) => void} [retry]   run this exchange's job
 *   again; required of an answer, which offers it only once its status is ERROR
 *   or TIMEOUT
 * @property {(uri: string, seek?: string) => void} [open]   open this address,
 *   handed over as the chip or block that asked held it, with the text the block
 *   seeks there when it names one (BlockRecordView); without it a chip is a
 *   label and no block opens
 */

/**
 * The exchange as a message reads it: an ai-block's id and attrs.
 * @typedef {{id: string, attrs: Readonly<Record<string, any>>}} ExchangeData
 */

export class ChatMessage {
  /** CSS text using ONLY `--theme-`, `--utterance-`, `--record-` and `--quote-` vars for colour. */
  static styles = chatMessageStyles

  /** The selector this message's styles hang off. */
  static ROOT_CLASS = 'chat-message'

  /** The two sides of an exchange a message can be. */
  static Side = Object.freeze({ QUESTION: /** @type {MessageSide} */ ('question'), ANSWER: /** @type {MessageSide} */ ('answer') })

  /** The class a message is drawn under while the pointer is over it or the focus inside it. */
  static ACTIVE_CLASS = 'chat-message--active'

  /** The class the latest answer is drawn under. */
  static LATEST_CLASS = 'chat-message--latest'

  /** The class of a message the reader was just taken to. */
  static REVEALED_CLASS = 'chat-message--revealed'

  /** The most a quote of a message's opening holds, in characters. */
  static OPENING_CHARS = 200

  /** The statuses of an exchange whose answer is still being written. */
  static #ANSWERING = Object.freeze(['PENDING', 'DISPATCHED'])

  /** The statuses of an exchange whose job ended without finishing the answer. */
  static #FAILED = Object.freeze(['ERROR', 'TIMEOUT'])

  static #COMPLETE = 'COMPLETE'

  /** The actions' icons, on base/icons.js's 24-unit stroke grid. */
  static #ICONS = Object.freeze({
    copy: ChatMessage.#svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    quote: ChatMessage.#svg('<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.76-2-2-2H4c-1.25 0-2 .75-2 2v6c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 0-1 1v3c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.76-2-2-2h-4c-1.25 0-2 .75-2 2v6c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/>'),
  })

  /** @type {MessageSide} */ #side
  /** @type {MessageIntents} */ #intents
  /** @type {string} */ #container
  /** @type {HTMLElement} */ #root
  /** @type {HTMLElement} */ #body
  /** @type {HTMLElement|null} */ #attachments = null
  /** @type {HTMLElement|null} */ #status = null
  /** @type {HTMLElement} */ #meta
  /** @type {HTMLTimeElement} */ #time
  /** @type {HTMLElement} */ #actions
  /** @type {QuestionListView} */ #view
  /** @type {PendingSlot|null} */ #pending = null
  /** @type {string} */ #exchangeId = ''
  /** @type {string|null} the blocks last drawn, serialized */ #drawn = null
  /** @type {string} the message as markdown, what Copy and an unselected Quote read */ #text = ''
  /** @type {Date|null} */ #at = null
  /** @type {boolean} */ #answering = false
  /** @type {Date|null} when the exchange was asked, what an answer being written counts from */ #askedAt = null
  /** @type {boolean} */ #hovered = false
  /** @type {boolean} */ #focused = false

  /**
   * @param {MessageSide} side which side of the exchange this message draws
   * @param {string} container the uuid of the chat the exchange is in, what a
   *   block's asset reference is resolved against
   * @param {MessageIntents} intents
   */
  constructor(side, container, intents) {
    if (side !== ChatMessage.Side.QUESTION && side !== ChatMessage.Side.ANSWER) {
      throw new ContractViolation('ChatMessage: side must be question or answer')
    }
    const required = side === ChatMessage.Side.ANSWER ? ['copy', 'quote', 'retry'] : ['copy', 'quote']
    for (const name of required) {
      if (!intents || typeof (/** @type {any} */ (intents))[name] !== 'function') {
        throw new ContractViolation('ChatMessage: intents.' + name + ' must be a function')
      }
    }
    if (intents.open !== undefined && typeof intents.open !== 'function') {
      throw new ContractViolation('ChatMessage: intents.open, when given, must be a function')
    }
    rendererStyles.register(ChatMessage)
    this.#side = side
    this.#container = String(container || '')
    this.#intents = intents
    this.#view = new QuestionListView(this.#container, { open: intents.open })

    const root = document.createElement('article')
    root.className = ChatMessage.ROOT_CLASS + ' ' + ChatMessage.ROOT_CLASS + '--' + side
    root.setAttribute('data-side', side)
    root.setAttribute('data-kind', 'ai-block')
    root.tabIndex = 0

    this.#body = ChatMessage.#part('div', 'body')
    if (side === ChatMessage.Side.QUESTION) {
      const bubble = ChatMessage.#part('div', 'bubble')
      this.#attachments = ChatMessage.#part('div', 'attachments')
      bubble.append(this.#body, this.#attachments)
      root.append(bubble)
    } else {
      this.#body.classList.add('tiptap')
      this.#status = ChatMessage.#part('div', 'status')
      root.append(this.#body, this.#status)
    }

    this.#time = /** @type {HTMLTimeElement} */ (ChatMessage.#part('time', 'time'))
    this.#actions = ChatMessage.#part('div', 'actions')
    const copy = this.#iconButton('copy', side === ChatMessage.Side.QUESTION ? 'Copy question' : 'Copy answer', () => this.#intents.copy(this.#text))
    const quote = this.#iconButton('quote', 'Quote in your next question', () => this.#intents.quote({ exchangeId: this.#exchangeId, side: this.#side, text: this.#quotedText() }))
    this.#actions.append(copy, quote)
    this.#meta = ChatMessage.#part('div', 'meta')
    this.#meta.append(this.#time, this.#actions)
    root.append(this.#meta)

    root.addEventListener('pointerenter', () => { this.#hovered = true; this.#syncActive() })
    root.addEventListener('pointerleave', () => { this.#hovered = false; this.#syncActive() })
    root.addEventListener('focusin', () => { this.#focused = true; this.#syncActive() })
    root.addEventListener('focusout', (e) => {
      const next = /** @type {Node|null} */ (e.relatedTarget)
      this.#focused = !!next && root.contains(next)
      this.#syncActive()
    })
    this.#root = root
    this.#syncMeta()
  }

  /** @returns {HTMLElement} the message, for its host to place */
  get element() { return this.#root }

  /** @returns {MessageSide} */
  get side() { return this.#side }

  /** @returns {Date|null} the message's time: when the question was asked, or
   *  when the answer was completed; null while it has none */
  get at() { return this.#at }

  /**
   * Draws this message's side of the exchange as it now stands. Its blocks are
   * redrawn only when they changed, so a host may call this on every change to
   * the exchange.
   * @param {ExchangeData} exchange
   */
  draw(exchange) {
    if (!exchange || !exchange.id) throw new ContractViolation('ChatMessage.draw: the exchange must carry its id')
    const attrs = exchange.attrs || {}
    if (exchange.id !== this.#exchangeId) {
      this.#exchangeId = exchange.id
      this.#drawn = null
      this.#root.setAttribute('data-id', exchange.id)
    }
    const status = String(attrs.status || 'PENDING')
    this.#askedAt = ThreadTime.parse(attrs.createdAt)
    if (this.#side === ChatMessage.Side.QUESTION) {
      this.#setAt(this.#askedAt)
      this.#drawQuestion(attrs.question)
    } else {
      this.#setAt(status === ChatMessage.#COMPLETE ? ThreadTime.parse(attrs.completedAt) : null)
      this.#drawAnswer(attrs.answer)
      this.#drawStatus(status, String(attrs.error || '').trim())
    }
    this.#syncMeta()
  }

  /**
   * Writes the label of the message's time. A message with no time shows none,
   * whatever it is told.
   * @param {string} label
   */
  showTime(label) {
    this.#time.textContent = this.#at ? String(label || '') : ''
  }

  /** @returns {boolean} whether this is an answer still being written */
  get answering() { return this.#answering }

  /**
   * Writes, on an answer still being written, how long it has been awaited at
   * `now`. Nothing else of the message is touched.
   * @param {Date} now
   */
  showElapsed(now) {
    if (this.answering) /** @type {PendingSlot} */ (this.#pending).count(this.#askedAt, now)
  }

  /**
   * Draws the message as the latest of its thread, whose actions stay shown, or not.
   * @param {boolean} latest
   */
  setLatest(latest) {
    this.#root.classList.toggle(ChatMessage.LATEST_CLASS, !!latest)
  }

  /**
   * Puts the message's top at the top of what scrolls it and, asked to, marks
   * it for a moment as the one the reader was taken to. The mark is the
   * stylesheet's and ends with its animation; marking again starts it again.
   * @param {boolean} [marked] whether to mark the message
   */
  reveal(marked) {
    const root = this.#root
    if (marked) {
      root.classList.remove(ChatMessage.REVEALED_CLASS)
      void root.offsetWidth
      root.classList.add(ChatMessage.REVEALED_CLASS)
    }
    if (typeof root.scrollIntoView === 'function') root.scrollIntoView({ block: 'start' })
  }

  /** Releases the renderers the message composed. */
  destroy() {
    this.#view.destroy()
  }

  /** @param {Date|null} at */
  #setAt(at) {
    this.#at = at
    if (at) this.#time.dateTime = at.toISOString()
    else { this.#time.removeAttribute('datetime'); this.#time.textContent = '' }
  }

  /** @param {any} question */
  #drawQuestion(question) {
    const slots = QuestionList.fold(question, this.#container)
    const drawn = QuestionList.drawn(question, this.#container)
    const key = JSON.stringify([drawn, slots.attachments])
    if (key === this.#drawn) return
    this.#drawn = key
    this.#text = AiBlockRenderer.answerMarkdown(slots.body)
    this.#body.hidden = this.#view.fill(this.#body, drawn) === 0
    const attachments = /** @type {HTMLElement} */ (this.#attachments)
    attachments.innerHTML = ''
    attachments.hidden = slots.attachments.length === 0
    for (const element of slots.attachments) attachments.appendChild(this.#chip(element))
  }

  /** @param {any} answer */
  #drawAnswer(answer) {
    const blocks = QuestionList.elementsOf(answer)
    const key = JSON.stringify(blocks)
    if (key === this.#drawn) return
    this.#drawn = key
    this.#text = AiBlockRenderer.answerMarkdown(blocks)
    this.#body.hidden = this.#view.fill(this.#body, blocks) === 0
    const rows = Array.from(this.#body.children).filter((row) => row.classList.contains('ai-block__element'))
    rows.forEach((row, i) => {
      const element = blocks[i]
      row.appendChild(this.#iconButton('block-copy', 'Copy this block', () => this.#intents.copy(AiBlockRenderer.answerMarkdown([element]))))
    })
  }

  /** The row under the answer: the pending slot while it is being written, the
   *  failure and Retry once its job ended unfinished, nothing once answered.
   *  @param {string} status @param {string} error */
  #drawStatus(status, error) {
    const row = /** @type {HTMLElement} */ (this.#status)
    row.innerHTML = ''
    const answering = ChatMessage.#ANSWERING.includes(status)
    this.#answering = answering
    this.#root.setAttribute('aria-busy', answering ? 'true' : 'false')
    if (answering) {
      if (!this.#pending) this.#pending = new PendingSlot()
      row.appendChild(this.#pending.element)
    } else if (ChatMessage.#FAILED.includes(status)) {
      const failure = ChatMessage.#part('div', 'failure')
      const text = ChatMessage.#part('span', 'failure-text')
      text.textContent = status === 'TIMEOUT' ? 'The answer timed out.' : (error || 'The answer failed.')
      const retry = this.#button('retry', 'Ask again', () => { if (this.#intents.retry) this.#intents.retry(this.#exchangeId) })
      retry.textContent = 'Retry'
      failure.append(text, retry)
      row.appendChild(failure)
    }
    row.hidden = row.childElementCount === 0
  }

  /** Shows the actions only while there is something to copy or quote, and the
   *  row under the message only while it holds a time or an action. */
  #syncMeta() {
    this.#actions.hidden = this.#text.trim() === ''
    this.#meta.hidden = this.#actions.hidden && !this.#at
  }

  /**
   * What Quote quotes: the text selected inside this message when the
   * selection lies wholly within it, else the message's opening.
   * @returns {string}
   */
  #quotedText() {
    const selection = this.#root.ownerDocument.getSelection()
    if (selection && !selection.isCollapsed &&
        this.#root.contains(selection.anchorNode) && this.#root.contains(selection.focusNode)) {
      const selected = selection.toString().trim()
      if (selected) return selected
    }
    return ChatMessage.#opening(this.#text)
  }

  /**
   * Whether `quoted` is text of this message, as a Quote of it takes text: the
   * text selected in the drawn message, or its opening ({@link ChatMessage.#opening}).
   * It holds when `quoted`, a trailing ellipsis left off, is found in the drawn
   * message's text or in its text with structure markers left out. Whitespace
   * is not compared: a drawn selection breaks lines between blocks that the
   * text it is found in does not carry. Blank text is held by no message.
   * @param {string} quoted
   * @returns {boolean}
   */
  holds(quoted) {
    const sought = ChatMessage.#unspaced(String(quoted || '').replace(/…\s*$/, ''))
    if (!sought) return false
    return [this.#body.textContent || '', ChatMessage.#flat(this.#text)]
      .some((text) => ChatMessage.#unspaced(text).includes(sought))
  }

  /**
   * The opening of a message's text: all of its flat text ({@link ChatMessage.#flat})
   * when that is short, else up to {@link ChatMessage.OPENING_CHARS} characters
   * of it cut at the last word boundary, marked as cut with a trailing ellipsis.
   * {@link ChatMessage#holds} finds every opening this makes in the text it was
   * made from.
   * @param {string} text @returns {string}
   */
  static #opening(text) {
    const flat = ChatMessage.#flat(text)
    if (flat.length <= ChatMessage.OPENING_CHARS) return flat
    let cut = flat.slice(0, ChatMessage.OPENING_CHARS)
    const space = cut.lastIndexOf(' ')
    if (space > 0) cut = cut.slice(0, space)
    return cut.replace(/[\s.,;:!?]+$/, '') + '…'
  }

  /**
   * A message's text as it is quoted: what only marks structure left out, a
   * code fence's marker lines and the markers opening a line that is a
   * blockquote or a heading, and whitespace runs read as one space.
   * @param {string} text @returns {string}
   */
  static #flat(text) {
    return String(text || '')
      .replace(/^[ \t]*(```|~~~).*$/gm, ' ')
      .replace(/^[ \t]*(?:>[ \t]?)+/gm, '')
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
      .replace(/\s+/g, ' ').trim()
  }

  /** @param {string} text @returns {string} `text` with no whitespace */
  static #unspaced(text) {
    return text.replace(/\s+/g, '')
  }

  /** @param {QuestionElement} element @returns {HTMLElement} */
  #chip(element) {
    const attrs = element.attrs || {}
    const uri = String(attrs.uri || '').trim()
    const chip = new ReferenceChip({ uri: uri, label: ReferenceRenderer.labelFor(attrs), tooltip: uri })
    const open = this.#intents.open
    if (open) chip.onActivate((address) => open(address))
    return chip.element
  }

  #syncActive() {
    this.#root.classList.toggle(ChatMessage.ACTIVE_CLASS, this.#hovered || this.#focused)
  }

  /**
   * One control, its face left for the caller to give. Pressing it leaves the
   * page's selection where it was, and its click reports its intent and stops
   * there, so no gesture it handles reaches a host beneath the message.
   * @param {string} name @param {string} label @param {() => void} report
   * @returns {HTMLButtonElement}
   */
  #button(name, label, report) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = ChatMessage.ROOT_CLASS + '__' + name
    button.setAttribute('data-intent', name)
    button.setAttribute('aria-label', label)
    button.title = label
    button.addEventListener('mousedown', (e) => e.preventDefault())
    button.addEventListener('click', (e) => {
      e.stopPropagation()
      report()
    })
    return button
  }

  /**
   * A control whose face is the icon of the intent it reports, copy's for
   * either copy.
   * @param {'copy'|'block-copy'|'quote'} name @param {string} label @param {() => void} report
   * @returns {HTMLButtonElement}
   */
  #iconButton(name, label, report) {
    const button = this.#button(name, label, report)
    button.innerHTML = ChatMessage.#ICONS[name === 'block-copy' ? 'copy' : name]
    return button
  }

  /** @param {string} body an icon's strokes @returns {string} the icon */
  static #svg(body) {
    return '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>'
  }

  /** @param {string} tag @param {string} part @returns {HTMLElement} */
  static #part(tag, part) {
    const el = document.createElement(tag)
    el.className = ChatMessage.ROOT_CLASS + '__' + part
    return el
  }
}
