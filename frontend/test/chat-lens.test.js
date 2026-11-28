// @ts-check
// ChatLens — the lens a chat gets. It is mounted over the real ChatProviderAdapter
// on a FakeSocket, so what is pinned is the whole path from the frames a chat's
// exchanges arrive as to the thread drawn as a conversation (two messages per
// exchange, a day separator before each day's first message, the times kept
// moving by the surface's clock), that what a message offers reaches the
// provider, the clipboard or the lens's event stream and nothing else, the
// selection the lens feeds (the chat and its last exchange), what a Quote hands
// over, and its ask.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import MarkdownIt from 'markdown-it'
import { ChatLens } from '../src/static/lens/chat/chat-lens.js'
import { ChatThreadSurface } from '../src/static/lens/chat/chat-thread-surface.js'
import { SurfaceIntent } from '../src/static/lens/abstract-surface.js'
import { ChatProviderAdapter } from '../src/static/container/chat-provider-adapter.js'
import { WorkspaceToolbar } from '../src/static/shell/workspace-toolbar.js'
import { ProviderAdapter } from '../src/static/container/provider-adapter.js'
import { ContainerModel } from '../src/static/container/container-model.js'
import { ChatMessage } from '../src/static/renderers/chat-message.js'
import { PendingSlot } from '../src/static/renderers/pending-slot.js'
import { ThreadTime } from '../src/static/renderers/thread-time.js'
import { ContractViolation } from '../src/static/contract/sieve-block.js'
import { DocumentFrame } from '../src/static/generated/protocol.js'
import { providerRig, FakeSocket } from './helpers/service-rig.js'
import { ChatShowcase } from './helpers/chat-showcase.js'

const CHAT = '0198c1a0-0000-7000-8000-0000000000c1'
const X1 = '0198c1a0-0000-7000-8000-0000000000e1'
const X2 = '0198c1a0-0000-7000-8000-0000000000e2'
const X3 = '0198c1a0-0000-7000-8000-0000000000e3'

const prose = (/** @type {string} */ content) => ({ kind: 'prose', attrs: { content } })
/** @param {string} id @param {string} status @param {string} question @param {any[]} [answer] @param {Record<string, any>} [times] */
const exchange = (id, status, question, answer = [], times = { createdAt: '2026-11-27T13:58:09Z' }) =>
  ({ id, kind: 'ai-block', attrs: Object.assign({ status, question: [prose(question)], answer }, times) })

/** A ChatLens presented over a chat holding `blocks`. @param {any[]} blocks */
async function presented(blocks) {
  const rig = providerRig({ uuid: CHAT, kind: 'chat', Adapter: ChatProviderAdapter, blocks })
  const lens = new ChatLens(CHAT, { provider: rig.provider })
  const root = document.createElement('div')
  document.body.appendChild(root)
  await lens.presentMode('wysiwyg', root)
  const thread = /** @type {HTMLElement} */ (root.querySelector('.chat-thread'))
  return Object.assign(rig, { lens, root, thread, chat: /** @type {ChatProviderAdapter} */ (rig.provider) })
}

/** @param {Element} root @returns {HTMLElement[]} the thread's messages, in order */
const messages = (root) => Array.from(root.querySelectorAll('.chat-thread__column > .' + ChatMessage.ROOT_CLASS))

/** @param {Element} root @param {string} id @param {'question'|'answer'} side @returns {HTMLElement} */
const message = (root, id, side) => /** @type {HTMLElement} */ (root.querySelector(`.chat-thread__column > [data-id="${id}"][data-side="${side}"]`))

/** What the column holds, in order: a day separator as its label, a message as `side:id`.
 *  @param {Element} root @returns {string[]} */
const column = (root) => Array.from(/** @type {HTMLElement} */ (root.querySelector('.chat-thread__column')).children)
  .map((el) => el.classList.contains(ChatThreadSurface.DAY_CLASS) ? 'day:' + el.textContent : el.getAttribute('data-side') + ':' + el.getAttribute('data-id'))

/** @param {Element} root @returns {boolean} */
const showsEmpty = (root) => !(/** @type {HTMLElement} */ (root.querySelector('.chat-thread__empty')).hidden)

/** @param {Element} el @param {string} intent */
const control = (el, intent) => /** @type {HTMLButtonElement} */ (el.querySelector('[data-intent="' + intent + '"]'))

/** A fixed now, as a local time, and a local time on its calendar. */
const NOW = new Date(2026, 10, 28, 12, 0, 0)
const local = (/** @type {number[]} */ ...parts) => new Date(2026, 10, ...(/** @type {[number]} */ (parts))).toISOString()

/** Puts the page's clock at NOW, with only the clock and the interval faked. */
function freezeClock() {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(NOW)
}

describe('ChatLens', () => {
  beforeAll(() => { Object.assign(/** @type {any} */ (globalThis).TipTap, { MarkdownIt }) })
  afterAll(() => { delete /** @type {any} */ (globalThis).TipTap.MarkdownIt })
  beforeEach(() => FakeSocket.reset())
  afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); vi.useRealTimers() })

  it('refuses a provider that is not a chat\'s', () => {
    const provider = new ProviderAdapter(new ContainerModel(CHAT, 'chat'))
    expect(() => new ChatLens(CHAT, { provider })).toThrow(ContractViolation)
  })

  it('draws two messages per exchange, the question then its answer, in the chat\'s order, the newest last', async () => {
    const { root } = await presented([exchange(X1, 'COMPLETE', 'first?', [prose('one')]), exchange(X2, 'ERROR', 'second?')])
    expect(messages(root).map((m) => m.getAttribute('data-side') + ':' + m.getAttribute('data-id')))
      .toEqual(['question:' + X1, 'answer:' + X1, 'question:' + X2, 'answer:' + X2])
    expect(message(root, X1, 'question').textContent).toContain('first?')
    expect(message(root, X1, 'answer').textContent).toContain('one')
    expect(showsEmpty(root)).toBe(false)
  })

  it('draws no shell round an exchange: nothing in the thread holds both of its messages but the column', async () => {
    const { root } = await presented([exchange(X1, 'COMPLETE', 'first?', [prose('one')])])
    const question = message(root, X1, 'question')
    const answer = message(root, X1, 'answer')
    expect(question.parentElement).toBe(answer.parentElement)
    expect(question.parentElement?.classList.contains('chat-thread__column')).toBe(true)
    expect(root.querySelector('[class*="exchange-record"]')).toBeNull()
  })

  it('draws the showcase chat whole: each exchange as two messages in the state it was left in, and each day said once', async () => {
    const { root } = await presented(ChatShowcase.exchanges())
    const exchanges = ChatShowcase.exchanges()
    expect(messages(root).map((m) => m.getAttribute('data-id'))).toEqual(exchanges.flatMap((x) => [x.id, x.id]))
    const answers = exchanges.map((x) => message(root, x.id, 'answer'))
    expect(answers.map((a) => [!!a.querySelector('.chat-message__body > .ai-block__element'), !!control(a, 'retry'), !!a.querySelector('.pending-slot')]))
      .toEqual([[true, false, false], [true, false, false], [false, true, false], [false, false, true]])
    expect(exchanges.map((x) => message(root, x.id, 'question').querySelector('.chat-message__time')?.textContent !== '')).toEqual([true, true, true, true])
    expect(answers.map((a) => a.querySelector('.chat-message__time')?.textContent !== '')).toEqual([true, true, false, false])
    const clock = new ThreadTime()
    const days = new Set(exchanges.flatMap((x) => [x.attrs.createdAt, x.attrs.completedAt]).filter(Boolean).map((t) => clock.dayOf(new Date(t))))
    expect(root.querySelectorAll('.' + ChatThreadSurface.DAY_CLASS).length).toBe(days.size)
    expect(column(root)[0].startsWith('day:')).toBe(true)
  })

  it.each([
    ['an empty chat', [], 'chat · 0 exchanges'],
    ['a chat of one', [exchange(X1, 'COMPLETE', 'first?', [prose('one')])], 'chat · 1 exchange'],
    ['the showcase chat', ChatShowcase.exchanges(), 'chat · 4 exchanges'],
  ])('tells the status bar how many exchanges %s holds, in place of characters and lines', async (_name, blocks, said) => {
    const { lens } = await presented(blocks)
    expect((lens.stats().readout || []).map((c) => c.text)).toEqual([said])
  })

  it('tells the status bar again when an exchange arrives, and not when one is redrawn', async () => {
    const { lens, sock } = await presented([exchange(X1, 'PENDING', 'first?')])
    /** @type {string[]} */ const told = []
    lens.onEvent((e) => { if (e.type === 'stats') told.push(((/** @type {any} */ (e)).readout || [])[0].text) })
    sock.driveMessage({ type: DocumentFrame.BLOCK_ATTRS_UPDATED, id: X1, attrs: { status: 'COMPLETE', answer: [prose('one')] } })
    sock.driveMessage({ type: DocumentFrame.INSERT_BLOCK, id: X2, kind: 'ai-block', index: -1, attrs: exchange(X2, 'PENDING', 'second?').attrs })
    expect(told).toEqual(['chat · 2 exchanges'])
  })

  it('an empty chat says so, until its first exchange arrives', async () => {
    const { root, sock } = await presented([])
    expect(messages(root)).toEqual([])
    expect(showsEmpty(root)).toBe(true)
    expect(root.querySelector('.chat-thread__empty')?.textContent).toBe(ChatThreadSurface.EMPTY_TEXT)
    sock.driveMessage({ type: DocumentFrame.INSERT_BLOCK, id: X1, kind: 'ai-block', index: -1, attrs: exchange(X1, 'PENDING', 'first?').attrs })
    expect(messages(root).map((m) => m.getAttribute('data-id'))).toEqual([X1, X1])
    expect(showsEmpty(root)).toBe(false)
  })

  it('repaints on a change, redrawing only the exchange it names and never rebuilding an earlier message', async () => {
    const { root, sock } = await presented([exchange(X1, 'COMPLETE', 'first?', [prose('one')])])
    const [question, answer] = messages(root)
    const firstAnswer = answer.querySelector('.chat-message__body > *')
    const draw = vi.spyOn(ChatMessage.prototype, 'draw')

    sock.driveMessage({ type: DocumentFrame.INSERT_BLOCK, id: X2, kind: 'ai-block', index: -1, attrs: exchange(X2, 'PENDING', 'second?').attrs })
    sock.driveMessage({ type: DocumentFrame.BLOCK_ATTRS_UPDATED, id: X2, attrs: { answer: [prose('a block')] } })
    sock.driveMessage({ type: DocumentFrame.BLOCK_ATTRS_UPDATED, id: X2, attrs: { status: 'COMPLETE', answer: [prose('a block'), prose('another')] } })

    const [keptQuestion, keptAnswer] = messages(root)
    expect([keptQuestion, keptAnswer]).toEqual([question, answer])
    expect(keptAnswer.querySelector('.chat-message__body > *')).toBe(firstAnswer)
    expect(draw.mock.calls.map(([x]) => x.id)).toEqual([X2, X2, X2, X2, X2, X2])
    expect(message(root, X2, 'answer').textContent).toContain('another')
    expect(message(root, X2, 'answer').querySelector('.pending-slot')).toBeNull()
  })

  it('Retry on a failed answer asks the chat to run it again', async () => {
    const { root, chat } = await presented([exchange(X1, 'COMPLETE', 'first?', [prose('one')]), exchange(X2, 'TIMEOUT', 'second?')])
    const retry = vi.spyOn(chat, 'requestRetry')
    expect(control(message(root, X1, 'answer'), 'retry')).toBeNull()
    control(message(root, X2, 'answer'), 'retry').click()
    expect(retry.mock.calls).toEqual([[X2]])
  })

  it.each([
    ['the question\'s Copy', 'question', 'copy', 'first?'],
    ['the answer\'s Copy', 'answer', 'copy', 'one\n\ntwo'],
    ['a block\'s Copy', 'answer', 'block-copy', 'one'],
  ])('%s puts what it hands over on the clipboard', async (_name, side, intent, text) => {
    const real = navigator.clipboard
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      const { root } = await presented([exchange(X1, 'COMPLETE', 'first?', [prose('one'), prose('two')])])
      control(message(root, X1, /** @type {any} */ (side)), intent).click()
      expect(writeText.mock.calls).toEqual([[text]])
    } finally { Object.defineProperty(navigator, 'clipboard', { value: real, configurable: true }) }
  })

  it('offers Copy and Quote on each message, and no expand', async () => {
    const { root } = await presented([exchange(X1, 'COMPLETE', 'first?', [prose('one')])])
    const intents = (/** @type {HTMLElement} */ el) => Array.from(el.querySelectorAll('[data-intent]')).map((b) => b.getAttribute('data-intent'))
    expect(intents(message(root, X1, 'question'))).toEqual(['copy', 'quote'])
    expect(intents(message(root, X1, 'answer'))).toEqual(['block-copy', 'copy', 'quote'])
  })

  it('keeps the latest answer\'s actions shown, and hands that on to the next answer as it arrives', async () => {
    const { root, sock } = await presented([exchange(X1, 'COMPLETE', 'first?', [prose('one')])])
    const latest = () => messages(root).filter((m) => m.classList.contains(ChatMessage.LATEST_CLASS)).map((m) => m.getAttribute('data-side') + ':' + m.getAttribute('data-id'))
    expect(latest()).toEqual(['answer:' + X1])
    sock.driveMessage({ type: DocumentFrame.INSERT_BLOCK, id: X2, kind: 'ai-block', index: -1, attrs: exchange(X2, 'PENDING', 'second?').attrs })
    expect(latest()).toEqual(['answer:' + X2])
  })

  it('spaces a question close to its own answer and further from the answer before it, each gap one token', () => {
    expect(ChatThreadSurface.styles).toMatch(/\.chat-thread__column > \.chat-message--question,\s*\.chat-thread__column > \.chat-thread__day \{\s*margin-top: var\(--thread-turn-gap\);\s*\}/)
    expect(ChatThreadSurface.styles).toMatch(/\.chat-thread__column > \.chat-message--answer,\s*\.chat-thread__column > \.chat-thread__day \+ \.chat-message \{\s*margin-top: var\(--thread-reply-gap\);\s*\}/)
    expect(ChatThreadSurface.styles).not.toMatch(/margin-top: (?!var\(--thread-|0;)/)
  })

  it('lays the column out on the thread measure, its colours from tokens only', () => {
    expect(ChatThreadSurface.styles).toMatch(/\.chat-thread__column \{[^}]*max-width: calc\(var\(--thread-measure\) \+ 2 \* var\(--thread-gutter\)\)/)
    expect(ChatThreadSurface.styles).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
  })

  it.each([
    ['at the newest, it keeps the newest in view', 300, 800],
    ['scrolled away, it is left where it is', 100, 100],
  ])('when an exchange arrives with the reader %s', async (_name, scrolledTo, expected) => {
    const { root, thread, sock } = await presented([exchange(X1, 'COMPLETE', 'first?', [prose('one')])])
    Object.defineProperty(thread, 'scrollHeight', { configurable: true, get: () => 400 + 100 * messages(root).length })
    Object.defineProperty(thread, 'clientHeight', { configurable: true, get: () => 300 })
    thread.scrollTop = scrolledTo
    sock.driveMessage({ type: DocumentFrame.INSERT_BLOCK, id: X3, kind: 'ai-block', index: -1, attrs: exchange(X3, 'PENDING', 'more?').attrs })
    expect(thread.scrollTop).toBe(expected)
  })

  /** Gives `thread` a scroller 300px tall over 400px plus 100px a message. @param {HTMLElement} thread @param {Element} root */
  const scroller = (thread, root) => {
    Object.defineProperty(thread, 'scrollHeight', { configurable: true, get: () => 400 + 100 * messages(root).length })
    Object.defineProperty(thread, 'clientHeight', { configurable: true, get: () => 300 })
  }

  it.each([
    ['at the newest, it reports 0', 300, 0],
    ['within the follow slack of the newest, it reports 0', 280, 0],
    ['scrolled away, it reports how far up from the newest', 100, 200],
  ])('reports the reader\'s scroll, measured up from the newest, once scrolling settles: %s', async (_name, scrolledTo, reported) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { root, thread, lens } = await presented([exchange(X1, 'COMPLETE', 'first?', [prose('one')])])
    scroller(thread, root)
    thread.scrollTop = scrolledTo
    thread.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(ChatThreadSurface.SCROLL_SETTLE_MS)
    expect(lens.getSelectionContext().scroll).toBe(reported)
  })

  it.each([
    ['away from the newest, is put back where they were', 200, 100, 100],
    ['at the newest, is put back at the newest and follows what arrives', 0, 300, 800],
  ])('a reader returning to the chat, %s', async (_name, left, restoredTo, afterArrival) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const blocks = [exchange(X1, 'COMPLETE', 'first?', [prose('one')])]
    const away = await presented(blocks)
    scroller(away.thread, away.root)
    away.thread.scrollTop = 300 - left
    away.thread.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(ChatThreadSurface.SCROLL_SETTLE_MS)
    const scroll = away.lens.getSelectionContext().scroll
    expect(scroll).toBe(left)
    away.lens.destroy()

    FakeSocket.reset()
    const back = await presented(blocks)
    scroller(back.thread, back.root)
    back.lens.restoreScroll(/** @type {number} */ (scroll))
    expect(back.thread.scrollTop).toBe(restoredTo)
    back.sock.driveMessage({ type: DocumentFrame.INSERT_BLOCK, id: X2, kind: 'ai-block', index: -1, attrs: exchange(X2, 'PENDING', 'second?').attrs })
    expect(back.thread.scrollTop).toBe(afterArrival)
  })

  it('is read-only by construction: ask its one capability, one mode, no key claimed', async () => {
    const { lens } = await presented([exchange(X1, 'COMPLETE', 'first?', [prose('one')])])
    expect(lens.getCapabilities()).toEqual({ markdown: false, mentions: false, commands: false, blocks: false, ask: true })
    expect(lens.mode).toBe(ChatThreadSurface.MODE)
    expect(await lens.setMode('markdown')).toBe(false)
    expect(lens.claimKey(/** @type {any} */ ({ key: 'Enter', ctrlKey: true }))).toBe(false)
  })

  it.each([
    ['at the newest', 300, false],
    ['scrolled away', 100, true],
  ])('shows Jump to latest only while the reader is away from the newest: %s', async (_name, scrolledTo, shown) => {
    const { root, thread, lens } = await presented([exchange(X1, 'COMPLETE', 'first?', [prose('one')])])
    const surface = /** @type {ChatThreadSurface} */ (lens.surface)
    const jump = /** @type {HTMLButtonElement} */ (thread.querySelector('.' + ChatThreadSurface.JUMP_CLASS))
    expect(jump.hidden).toBe(true)
    Object.defineProperty(thread, 'scrollHeight', { configurable: true, get: () => 400 + 100 * messages(root).length })
    Object.defineProperty(thread, 'clientHeight', { configurable: true, get: () => 300 })
    thread.scrollTop = scrolledTo
    thread.dispatchEvent(new Event('scroll'))
    expect([jump.hidden, surface.jumpShown]).toEqual([!shown, shown])
    expect([jump.getAttribute('aria-label'), jump.title]).toEqual([ChatThreadSurface.JUMP_LABEL, ChatThreadSurface.JUMP_LABEL])
    expect(jump.classList.contains(ChatThreadSurface.ARRIVED_CLASS)).toBe(false)
  })

  it('Jump to latest says when something has arrived since the reader left the newest, and pressing it returns there and resumes following', async () => {
    const { root, thread, lens, sock } = await presented([exchange(X1, 'COMPLETE', 'first?', [prose('one')])])
    const surface = /** @type {ChatThreadSurface} */ (lens.surface)
    const jump = /** @type {HTMLButtonElement} */ (thread.querySelector('.' + ChatThreadSurface.JUMP_CLASS))
    Object.defineProperty(thread, 'scrollHeight', { configurable: true, get: () => 400 + 100 * messages(root).length })
    Object.defineProperty(thread, 'clientHeight', { configurable: true, get: () => 300 })
    thread.scrollTop = 100
    thread.dispatchEvent(new Event('scroll'))
    sock.driveMessage({ type: DocumentFrame.INSERT_BLOCK, id: X2, kind: 'ai-block', index: -1, attrs: exchange(X2, 'PENDING', 'second?').attrs })
    expect(thread.scrollTop).toBe(100)
    expect([jump.hidden, surface.arrivedSince, jump.classList.contains(ChatThreadSurface.ARRIVED_CLASS)]).toEqual([false, true, true])
    expect(jump.getAttribute('aria-label')).toBe(ChatThreadSurface.ARRIVED_LABEL)

    jump.click()
    expect(thread.scrollTop).toBe(800)
    expect([jump.hidden, surface.arrivedSince]).toEqual([true, false])
    sock.driveMessage({ type: DocumentFrame.INSERT_BLOCK, id: X3, kind: 'ai-block', index: -1, attrs: exchange(X3, 'PENDING', 'third?').attrs })
    expect(thread.scrollTop).toBe(1000)
    expect(jump.hidden).toBe(true)
  })

  it('Jump to latest is a legible control: a 28px target with a border and a solid surface, from tokens only', () => {
    const rule = /\.chat-thread__jump \{([^}]*)\}/.exec(ChatThreadSurface.styles)
    expect(rule).not.toBeNull()
    const body = /** @type {RegExpExecArray} */ (rule)[1]
    for (const want of ['min-width: 28px', 'height: 28px', 'border: 1px solid var(--theme-border2)', 'background: var(--theme-bgAlt)', 'position: sticky']) {
      expect(body).toContain(want)
    }
  })

  it('destroy empties the root, releases its messages and stops following the chat', async () => {
    const { lens, root, sock } = await presented([exchange(X1, 'COMPLETE', 'first?', [prose('one')])])
    const destroyed = vi.spyOn(ChatMessage.prototype, 'destroy')
    lens.destroy()
    expect(root.childElementCount).toBe(0)
    expect(destroyed).toHaveBeenCalledTimes(2)
    sock.driveMessage({ type: DocumentFrame.INSERT_BLOCK, id: X2, kind: 'ai-block', index: -1, attrs: exchange(X2, 'PENDING', 'second?').attrs })
    expect(root.childElementCount).toBe(0)
  })
})

// REVEAL. Opening an address that names an exchange (a quote double-clicked, a
// mention followed) brings that exchange into view. The text sought there picks
// the one message marked: the question when it holds it, else the answer when it
// does; when neither does, or nothing is sought, the question is brought to the
// top and nothing is marked.
describe('ChatLens — reveal', () => {
  beforeAll(() => { Object.assign(/** @type {any} */ (globalThis).TipTap, { MarkdownIt }) })
  afterAll(() => { delete /** @type {any} */ (globalThis).TipTap.MarkdownIt })
  beforeEach(() => FakeSocket.reset())
  afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })

  const revealed = (/** @type {HTMLElement} */ root) => Array.from(root.querySelectorAll('.' + ChatMessage.REVEALED_CLASS)).map((el) => el.getAttribute('data-side') + ':' + el.getAttribute('data-id'))
  const CHAT_OF_TWO = () => [
    exchange(X1, 'COMPLETE', 'Why does the first scan drop the fence?', [prose('Because TrimSpace erases the signal.')]),
    exchange(X2, 'COMPLETE', 'second?', [prose('two')]),
  ]

  /** Spies on where each message of `id` is scrolled to. @param {HTMLElement} root @param {string} id */
  function scrolls(root, id) {
    /** @type {string[]} */ const scrolled = []
    for (const side of /** @type {const} */ (['question', 'answer'])) {
      message(root, id, side).scrollIntoView = (/** @type {any} */ at) => { scrolled.push(side + ':' + JSON.stringify(at)) }
    }
    return scrolled
  }

  it.each([
    ['the answer quoted: only the answer, its top at the top', 'TrimSpace erases the signal.', ['answer:' + X1], ['answer:{"block":"start"}']],
    ['the question quoted: only the question', 'Why does the first scan drop the fence?', ['question:' + X1], ['question:{"block":"start"}']],
    ['a quote of an opening cut short, the ellipsis left off: that message', 'Because TrimSpace…', ['answer:' + X1], ['answer:{"block":"start"}']],
    ['text both hold: the question', 'the', ['question:' + X1], ['question:{"block":"start"}']],
    ['text neither holds: the question to the top, nothing marked', 'not in this exchange', [], ['question:{"block":"start"}']],
    ['nothing sought: the question to the top, nothing marked', undefined, [], ['question:{"block":"start"}']],
  ])('brings an exchange into view with %s', async (_name, seek, marked, scrolled) => {
    const { lens, root } = await presented(CHAT_OF_TWO())
    const seen = scrolls(root, X1)
    lens.reveal(X1, seek)
    expect(revealed(root)).toEqual(marked)
    expect(seen).toEqual(scrolled)
  })

  it('the thread presented next, as an open presents it, shows the same message the same way', async () => {
    const { lens, root } = await presented(CHAT_OF_TWO())
    lens.reveal(X1, 'TrimSpace erases the signal.')
    const next = document.createElement('div')
    document.body.appendChild(next)
    await lens.presentMode('wysiwyg', next)
    expect(revealed(next)).toEqual(['answer:' + X1])
    expect(revealed(root)).toEqual([])
  })

  it('a reader taken to an exchange is not then put back where they last were', async () => {
    const { lens, thread } = await presented(CHAT_OF_TWO())
    lens.reveal(X1, 'TrimSpace erases the signal.')
    thread.scrollTop = 7
    lens.restoreScroll(0)
    expect(thread.scrollTop).toBe(7)
  })

  it.each([
    ['an id the chat does not hold', 'nothing-here'],
    ['no id', ''],
  ])('changes nothing for %s', async (_name, leaf) => {
    const { lens, root } = await presented(CHAT_OF_TWO())
    lens.reveal(leaf, 'TrimSpace erases the signal.')
    expect(revealed(root)).toEqual([])
  })
})

// THE THREAD'S TIME. Each message shows its own time, the thread says each date
// once, and the surface's clock moves the labels on while it is mounted.
describe('ChatLens — times and days', () => {
  beforeAll(() => { Object.assign(/** @type {any} */ (globalThis).TipTap, { MarkdownIt }) })
  afterAll(() => { delete /** @type {any} */ (globalThis).TipTap.MarkdownIt })
  beforeEach(() => { FakeSocket.reset(); freezeClock() })
  afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); vi.useRealTimers() })

  /** @param {HTMLElement} el */
  const timeOf = (el) => el.querySelector('.chat-message__time')?.textContent

  it('each message shows its own time: a question when it was asked, an answer when it was completed, an incomplete answer none', async () => {
    const { root } = await presented([
      exchange(X1, 'COMPLETE', 'first?', [prose('one')], { createdAt: local(28, 11, 50), completedAt: local(28, 11, 57) }),
      exchange(X2, 'PENDING', 'second?', [], { createdAt: local(28, 11, 59, 30) }),
    ])
    expect([timeOf(message(root, X1, 'question')), timeOf(message(root, X1, 'answer')), timeOf(message(root, X2, 'question')), timeOf(message(root, X2, 'answer'))])
      .toEqual([new ThreadTime().ofMessage(new Date(local(28, 11, 50)), NOW), '3 minutes ago', ThreadTime.RECENT, ''])
  })

  it.each([
    ['one day', [
      exchange(X1, 'COMPLETE', 'a?', [prose('A')], { createdAt: local(28, 9, 0), completedAt: local(28, 9, 1) }),
      exchange(X2, 'COMPLETE', 'b?', [prose('B')], { createdAt: local(28, 11, 0), completedAt: local(28, 11, 1) }),
    ], ['day:Today', 'question:' + X1, 'answer:' + X1, 'question:' + X2, 'answer:' + X2]],
    ['yesterday then today', [
      exchange(X1, 'COMPLETE', 'a?', [prose('A')], { createdAt: local(27, 9, 0), completedAt: local(27, 9, 1) }),
      exchange(X2, 'COMPLETE', 'b?', [prose('B')], { createdAt: local(28, 9, 0), completedAt: local(28, 9, 1) }),
    ], ['day:Yesterday', 'question:' + X1, 'answer:' + X1, 'day:Today', 'question:' + X2, 'answer:' + X2]],
    ['a question and its answer either side of midnight', [
      exchange(X1, 'COMPLETE', 'a?', [prose('A')], { createdAt: local(27, 23, 59, 30), completedAt: local(28, 0, 0, 20) }),
    ], ['day:Yesterday', 'question:' + X1, 'day:Today', 'answer:' + X1]],
    ['an answer still being written, which falls under no day of its own', [
      exchange(X1, 'PENDING', 'a?', [], { createdAt: local(27, 23, 59) }),
    ], ['day:Yesterday', 'question:' + X1, 'answer:' + X1]],
    ['six days ago and today', [
      exchange(X1, 'COMPLETE', 'a?', [prose('A')], { createdAt: local(22, 10, 0), completedAt: local(22, 10, 1) }),
      exchange(X2, 'PENDING', 'b?', [], { createdAt: local(28, 11, 0) }),
    ], ['day:' + new ThreadTime().ofDay(new Date(2026, 10, 22, 10, 0), NOW), 'question:' + X1, 'answer:' + X1, 'day:Today', 'question:' + X2, 'answer:' + X2]],
  ])('says the date once before the first message of each day: %s', async (_name, blocks, drawn) => {
    const { root } = await presented(blocks)
    expect(column(root)).toEqual(drawn)
    expect(root.querySelectorAll('.' + ChatThreadSurface.DAY_CLASS + '[role="separator"]').length).toBe(drawn.filter((d) => d.startsWith('day:')).length)
  })

  it('a message never says a date itself', async () => {
    const { root } = await presented([exchange(X1, 'COMPLETE', 'a?', [prose('A')], { createdAt: local(22, 10, 0), completedAt: local(22, 10, 1) })])
    const clock = new ThreadTime()
    expect(messages(root).map(timeOf)).toEqual([clock.ofMessage(new Date(local(22, 10, 0)), NOW), clock.ofMessage(new Date(local(22, 10, 1)), NOW)])
    expect(messages(root).map(timeOf).join(' ')).not.toMatch(/November|Sunday|22/)
  })

  it('moves the labels on as time passes, on its own clock, without redrawing a message', async () => {
    const { root } = await presented([exchange(X1, 'COMPLETE', 'a?', [prose('A')], { createdAt: local(28, 11, 58, 50), completedAt: local(28, 11, 59, 50) })])
    const before = messages(root)
    const draw = vi.spyOn(ChatMessage.prototype, 'draw')
    expect([timeOf(message(root, X1, 'question')), timeOf(message(root, X1, 'answer'))]).toEqual(['1 minute ago', ThreadTime.RECENT])
    vi.advanceTimersByTime(ChatThreadSurface.CLOCK_MS)
    expect(timeOf(message(root, X1, 'answer'))).toBe(ThreadTime.RECENT)
    vi.advanceTimersByTime(2 * ChatThreadSurface.CLOCK_MS)
    expect([timeOf(message(root, X1, 'question')), timeOf(message(root, X1, 'answer'))]).toEqual(['2 minutes ago', '1 minute ago'])
    expect(draw).not.toHaveBeenCalled()
    expect(messages(root)).toEqual(before)
  })

  it('moves a day\'s label on past midnight on the same clock', async () => {
    vi.setSystemTime(new Date(2026, 10, 28, 23, 59, 45))
    const { root } = await presented([exchange(X1, 'PENDING', 'a?', [], { createdAt: local(28, 23, 59, 40) })])
    expect(column(root)[0]).toBe('day:Today')
    vi.advanceTimersByTime(ChatThreadSurface.CLOCK_MS)
    expect(column(root)[0]).toBe('day:Yesterday')
  })

  it('stops its clock, and the tick of an answer being written, when it is unmounted', async () => {
    const { lens, root } = await presented([exchange(X1, 'PENDING', 'a?', [], { createdAt: local(28, 11, 59) })])
    expect(/** @type {ChatThreadSurface} */ (lens.surface).ticking).toBe(true)
    const running = vi.getTimerCount()
    const question = message(root, X1, 'question')
    const said = timeOf(question)
    const slot = /** @type {HTMLElement} */ (message(root, X1, 'answer').querySelector('.' + PendingSlot.ROOT_CLASS))
    const waited = slot.textContent
    lens.destroy()
    expect(vi.getTimerCount()).toBe(running - 2)
    vi.advanceTimersByTime(10 * ChatThreadSurface.CLOCK_MS)
    expect([timeOf(question), slot.textContent]).toEqual([said, waited])
  })

  /** @param {Element} root @param {string} id @returns {string|null|undefined} what the answer's pending slot reads */
  const elapsedOf = (root, id) => message(root, id, 'answer')?.querySelector('.' + PendingSlot.ROOT_CLASS)?.textContent

  it('an answer being written counts how long it has been awaited, a second at a time, from when it was asked, redrawing no message', async () => {
    const { root } = await presented([exchange(X1, 'PENDING', 'a?', [], { createdAt: local(28, 11, 59, 50) })])
    const draw = vi.spyOn(ChatMessage.prototype, 'draw')
    expect(elapsedOf(root, X1)).toBe('answering… 10s')
    vi.advanceTimersByTime(ChatThreadSurface.PENDING_TICK_MS)
    expect(elapsedOf(root, X1)).toBe('answering… 11s')
    vi.advanceTimersByTime(50 * ChatThreadSurface.PENDING_TICK_MS)
    expect(elapsedOf(root, X1)).toBe('answering… 1m 01s')
    expect(draw).not.toHaveBeenCalled()
  })

  it('runs the one-second tick only while an answer is being written', async () => {
    const { lens, sock } = await presented([exchange(X1, 'COMPLETE', 'a?', [prose('A')], { createdAt: local(28, 11, 0), completedAt: local(28, 11, 1) })])
    const surface = /** @type {ChatThreadSurface} */ (lens.surface)
    const idle = vi.getTimerCount()
    expect(surface.ticking).toBe(false)
    sock.driveMessage({ type: DocumentFrame.INSERT_BLOCK, id: X2, kind: 'ai-block', index: -1, attrs: exchange(X2, 'PENDING', 'b?', [], { createdAt: local(28, 11, 59) }).attrs })
    expect([surface.ticking, vi.getTimerCount()]).toEqual([true, idle + 1])
    sock.driveMessage({ type: DocumentFrame.BLOCK_ATTRS_UPDATED, id: X2, attrs: { answer: [prose('a block')] } })
    expect(surface.ticking).toBe(true)
    sock.driveMessage({ type: DocumentFrame.BLOCK_ATTRS_UPDATED, id: X2, attrs: { status: 'COMPLETE', completedAt: local(28, 12, 0), answer: [prose('a block')] } })
    expect([surface.ticking, vi.getTimerCount()]).toEqual([false, idle])
  })
})

// WHAT THE LENS FEEDS ITS SELECTION, AND ITS ASK. The Ask panel reaches a chat
// through these alone: the context names the chat and its last exchange; a Quote
// hands over what was quoted on the lens's event stream and leaves the context
// as it was; and a question asked of the lens becomes an exchange through the
// provider, verbatim.
describe('ChatLens — its selection and its ask', () => {
  beforeAll(() => { Object.assign(/** @type {any} */ (globalThis).TipTap, { MarkdownIt }) })
  afterAll(() => { delete /** @type {any} */ (globalThis).TipTap.MarkdownIt })
  beforeEach(() => FakeSocket.reset())
  afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); document.getSelection()?.removeAllRanges() })

  /** The parts of a context that say what it names. @param {any} ctx */
  const named = (ctx) => ({ docUuid: ctx.docUuid, selectionType: ctx.selectionType, blockId: ctx.blockId, blockIds: ctx.blockIds, selectedText: ctx.selectedText, target: ctx.target })

  /** What a chat puts forward as an ask's target: none, so the Ask panel draws no chip. */
  const NO_TARGET = { kind: 'document', ref: 'doc', range: null, label: '' }

  /** @param {string} id @param {string} _label @param {string|null} [selectedText] */
  const exchangeNamed = (id, _label, selectedText = null) => ({
    docUuid: CHAT, selectionType: 'block', blockId: id, blockIds: [id], selectedText,
    target: NO_TARGET,
  })

  it.each([
    ['an empty chat names the chat and no exchange', [], {
      docUuid: CHAT, selectionType: 'none', blockId: null, blockIds: [], selectedText: null,
      target: NO_TARGET,
    }],
    ['a chat names its last exchange, quoting nothing', [exchange(X1, 'COMPLETE', 'first?', [prose('one')]), exchange(X2, 'PENDING', 'second?')],
      exchangeNamed(X2, '"second?"')],
  ])('%s', async (_name, blocks, want) => {
    const { lens } = await presented(blocks)
    expect(named(lens.getSelectionContext())).toEqual(want)
    expect(lens.getSelectionContext().blockKind).toBe(blocks.length ? 'ai-block' : null)
  })

  it('follows the last exchange as one arrives, and tells its listeners', async () => {
    const { lens, sock } = await presented([exchange(X1, 'COMPLETE', 'first?', [prose('one')])])
    /** @type {any[]} */ const heard = []
    lens.onSelectionUpdate((ctx) => heard.push(ctx.blockId))
    sock.driveMessage({ type: DocumentFrame.INSERT_BLOCK, id: X2, kind: 'ai-block', index: -1, attrs: exchange(X2, 'PENDING', 'second?').attrs })
    expect(heard).toEqual([X2])
  })

  it.each([
    ['a question, with nothing selected, quotes its opening', 'question', null, 'first?'],
    ['an answer, with nothing selected, quotes its opening', 'answer', null, 'the answer runs on'],
    ['an answer, with words of it selected, quotes those words', 'answer', 'runs on', 'runs on'],
  ])('Quote on %s: the lens hands over its exchange and the text, and its selection does not move', async (_name, side, words, text) => {
    const { lens, root } = await presented([exchange(X1, 'COMPLETE', 'first?', [prose('the answer runs on')]), exchange(X2, 'COMPLETE', 'second?', [prose('two')])])
    const quoted = message(root, X1, /** @type {any} */ (side))
    if (words) {
      const textNode = /** @type {Text} */ (Array.from(quoted.querySelectorAll('*')).flatMap((el) => Array.from(el.childNodes)).find((n) => n.nodeType === Node.TEXT_NODE && (n.textContent || '').includes(words)))
      const range = document.createRange()
      const at = (textNode.textContent || '').indexOf(words)
      range.setStart(textNode, at)
      range.setEnd(textNode, at + words.length)
      document.getSelection()?.addRange(range)
    }
    const before = lens.getSelectionContext()
    /** @type {any[]} */ const heard = []
    lens.onEvent((e) => { if (e.type === SurfaceIntent.QUOTE) heard.push(e) })
    /** @type {any[]} */ const moved = []
    lens.onSelectionUpdate((ctx) => moved.push(ctx))
    control(quoted, 'quote').click()
    expect(heard).toEqual([{ type: SurfaceIntent.QUOTE, blockId: X1, text }])
    expect(moved).toEqual([])
    expect(lens.getSelectionContext()).toBe(before)
    expect(named(lens.getSelectionContext())).toEqual(exchangeNamed(X2, '"second?"'))
  })

  it('every press of Quote is a quote, the same one again included; a selection that moves is not', async () => {
    const { lens, root, sock } = await presented([exchange(X1, 'COMPLETE', 'first?', [prose('one')]), exchange(X2, 'COMPLETE', 'second?', [prose('two')])])
    /** @type {any[]} */ const quotes = []
    lens.onEvent((e) => { if (e.type === SurfaceIntent.QUOTE) quotes.push([e.blockId, e.text]) })
    sock.driveMessage({ type: DocumentFrame.INSERT_BLOCK, id: X3, kind: 'ai-block', index: -1, attrs: exchange(X3, 'PENDING', 'third?').attrs })
    control(message(root, X1, 'answer'), 'quote').click()
    control(message(root, X1, 'answer'), 'quote').click()
    control(message(root, X1, 'question'), 'quote').click()
    expect(quotes).toEqual([[X1, 'one'], [X1, 'one'], [X1, 'first?']])
    expect(lens.getSelectionContext().blockId).toBe(X3)
  })

  it('after a quote the selection follows the last exchange as the chat grows', async () => {
    const { lens, root, sock } = await presented([exchange(X1, 'COMPLETE', 'first?', [prose('one')])])
    control(message(root, X1, 'answer'), 'quote').click()
    sock.driveMessage({ type: DocumentFrame.INSERT_BLOCK, id: X2, kind: 'ai-block', index: -1, attrs: exchange(X2, 'PENDING', 'second?').attrs })
    expect(named(lens.getSelectionContext())).toEqual(exchangeNamed(X2, '"second?"'))
  })

  it('an ask asks the chat its question verbatim, and its selection is still the last exchange', async () => {
    const { lens, chat } = await presented([exchange(X1, 'COMPLETE', 'first?', [prose('one')]), exchange(X2, 'COMPLETE', 'second?', [prose('two')])])
    const ask = vi.spyOn(chat, 'requestAsk').mockImplementation(() => {})
    const question = [{ kind: 'prose', attrs: { id: 'b0', content: 'and then?' } }, { kind: 'code', attrs: { id: 'b1', source: 'x()', language: 'go' } }]
    await lens.askAi({ type: 'ask', question, context: lens.getSelectionContext() })
    expect(ask.mock.calls).toEqual([[question]])
    expect(named(lens.getSelectionContext())).toEqual(exchangeNamed(X2, '"second?"'))
  })

  it('what was asked of it is each exchange\'s question, in the chat\'s order, frozen; one arriving is the last', async () => {
    const quote = { kind: 'reference', attrs: { id: 'r0', uri: 'sieve://' + CHAT + '/' + X1, rel: 'target', displayAs: 'quote', cache: { quote: 'one' } } }
    const attachment = { kind: 'reference', attrs: { id: 'r1', uri: 'sieve://0198c1a0-0002-7000-8000-0000000000f1', rel: 'attach', cache: { title: 'Auth Design' } } }
    const quoting = { id: X2, kind: 'ai-block', attrs: { status: 'COMPLETE', question: [quote, prose('why @Auth Design?'), attachment], answer: [prose('two')], createdAt: '2026-11-27T13:58:09Z' } }
    const { lens, sock } = await presented([exchange(X1, 'COMPLETE', 'first?', [prose('one')]), quoting])
    const asked = lens.questionsAsked()
    expect(asked).toEqual([[prose('first?')], [quote, prose('why @Auth Design?'), attachment]])
    expect(Object.isFrozen(asked) && asked.every((q) => Object.isFrozen(q) && q.every((el) => Object.isFrozen(el) && Object.isFrozen(el.attrs)))).toBe(true)
    sock.driveMessage({ type: DocumentFrame.INSERT_BLOCK, id: X3, kind: 'ai-block', index: -1, attrs: exchange(X3, 'PENDING', 'third?').attrs })
    expect(lens.questionsAsked().map((q) => q[0].attrs.content)).toEqual(['first?', undefined, 'third?'])
  })

  it('an empty chat has been asked nothing', async () => {
    const { lens } = await presented([])
    expect(lens.questionsAsked()).toEqual([])
  })

  it.each([
    ['an explain', { type: 'explain' }],
    ['an empty question', { type: 'ask', question: [] }],
    ['a question as a string', { type: 'ask', question: 'why?' }],
  ])('%s asks nothing', async (_name, job) => {
    const { lens, chat } = await presented([exchange(X1, 'COMPLETE', 'first?', [prose('one')])])
    const ask = vi.spyOn(chat, 'requestAsk')
    await lens.askAi(/** @type {any} */ (job))
    expect(ask).not.toHaveBeenCalled()
  })

  it.each([
    ['an attachment chip under a question, activated', 'question', (/** @type {HTMLElement} */ el) => {
      /** @type {HTMLElement} */ (el.querySelector('.chat-message__attachments .sieve-reference-chip')).click()
    }, 'sieve://0198c1a0-0002-7000-8000-0000000000f1'],
    ['a reference in an answer, double-clicked', 'answer', (/** @type {HTMLElement} */ el) => {
      /** @type {HTMLElement} */ (el.querySelector('.chat-message__body .reference-block__body'))
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    }, 'sieve://0198c1a0-0002-7000-8000-0000000000f1/0198c1a0-0002-7000-8000-0000000000f2'],
  ])('%s asks the host to open its address', async (_name, side, gesture, uri) => {
    const rich = ChatShowcase.exchange(ChatShowcase.PART.RICH)
    const { lens, root } = await presented([rich])
    /** @type {any[]} */ const intents = []
    lens.onEvent((e) => { if (e.type === SurfaceIntent.OPEN_CONTAINER) intents.push(e) })
    gesture(message(root, rich.id, /** @type {any} */ (side)))
    expect(intents).toEqual([{ type: SurfaceIntent.OPEN_CONTAINER, uri }])
    expect('seek' in intents[0]).toBe(false)
  })

  it('a quote in a question, double-clicked, asks the host to open its address and seek there the text it quotes', async () => {
    const uri = 'sieve://' + CHAT + '/' + X1
    const quote = { kind: 'reference', attrs: { uri, rel: 'target', displayAs: 'quote', cache: { quote: 'one' } } }
    const asked = { id: X2, kind: 'ai-block', attrs: { status: 'COMPLETE', question: [quote, prose('why?')], answer: [], createdAt: '2026-11-27T13:58:09Z' } }
    const { lens, root } = await presented([exchange(X1, 'COMPLETE', 'first?', [prose('one')]), asked])
    /** @type {any[]} */ const intents = []
    lens.onEvent((e) => { if (e.type === SurfaceIntent.OPEN_CONTAINER) intents.push(e) })
    const drawn = /** @type {HTMLElement} */ (message(root, X2, 'question').querySelector('.reference-block__quote'))
    drawn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    expect(intents).toEqual([{ type: SurfaceIntent.OPEN_CONTAINER, uri, seek: 'one' }])
  })
})

// WHAT ACTS ON THE WHOLE CHAT is in the workspace toolbar: Name now and Rename...,
// each reaching the chat only through its provider, and what came of either said
// at the end of the strip.
describe('ChatLens — its toolbar', () => {
  beforeAll(() => { Object.assign(/** @type {any} */ (globalThis).TipTap, { MarkdownIt }) })
  afterAll(() => { delete /** @type {any} */ (globalThis).TipTap.MarkdownIt })
  beforeEach(() => FakeSocket.reset())
  afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); vi.useRealTimers() })

  /** The lens over a chat of one answered exchange, its toolbar drawn by the workspace's. */
  async function withToolbar() {
    const rig = await presented([exchange(X1, 'COMPLETE', 'first?', [prose('one')])])
    const host = document.createElement('div')
    document.body.appendChild(host)
    new WorkspaceToolbar(host).show(rig.lens)
    const button = (/** @type {string} */ id) => /** @type {HTMLButtonElement} */ (host.querySelector('#' + id))
    const said = () => String(host.querySelector('#tb-chat-status')?.textContent || '')
    return Object.assign(rig, { host, button, said })
  }

  it('offers Name now and Rename... at the end of the strip, and New Chat not at all', async () => {
    const { host } = await withToolbar()
    expect(Array.from(host.querySelectorAll('.tb-place--end button')).map((b) => b.textContent)).toEqual(['Name now', 'Rename…'])
    expect(host.textContent).not.toContain('New Chat')
  })

  it('Name now asks the provider, saying it is asking and then that it asked, and is one ask while under way', async () => {
    const { chat, button, said } = await withToolbar()
    /** @type {() => void} */ let accept = () => {}
    const nameNow = vi.spyOn(chat, 'nameNow').mockImplementation(() => new Promise((resolve) => { accept = () => resolve() }))
    button('tb-chat-name-now').click()
    expect(said()).toBe(ChatLens.NamingWords.ASKING)
    expect(button('tb-chat-name-now').disabled).toBe(true)
    button('tb-chat-name-now').click()
    expect(nameNow).toHaveBeenCalledTimes(1)
    accept()
    await vi.waitFor(() => expect(said()).toBe(ChatLens.NamingWords.ASKED))
    expect(button('tb-chat-name-now').disabled).toBe(false)
  })

  it('Name now says the host\'s words when it refuses', async () => {
    const { chat, button, said } = await withToolbar()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(chat, 'nameNow').mockRejectedValue(new Error('This chat has no answer to name it from yet.'))
    button('tb-chat-name-now').click()
    await vi.waitFor(() => expect(said()).toBe('This chat has no answer to name it from yet.'))
  })

  it.each([
    ['Enter', (/** @type {any} */ t) => t.field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))],
    ['its Rename', (/** @type {any} */ t) => t.button('tb-chat-rename-save').click()],
  ])('Rename... puts the chat\'s name in a field, and %s gives the chat what it holds through the provider', async (_name, commit) => {
    const t = await withToolbar()
    const rename = vi.spyOn(t.chat, 'rename').mockResolvedValue(undefined)
    vi.spyOn(t.chat, 'getName').mockReturnValue('first?')
    t.button('tb-chat-rename').click()
    const field = () => /** @type {HTMLInputElement} */ (t.host.querySelector('#tb-chat-rename-field'))
    expect(field().value).toBe('first?')
    expect(document.activeElement).toBe(field())
    expect(field().getAttribute('aria-label')).toBe('The chat\'s name')
    field().value = 'Parser errors'
    commit(Object.assign(t, { field }))
    expect(rename.mock.calls).toEqual([['Parser errors']])
    expect(field()).toBeNull()
    await vi.waitFor(() => expect(t.said()).toBe(ChatLens.NamingWords.RENAMED))
    expect(t.button('tb-chat-rename')).not.toBeNull()
  })

  it.each([
    ['Escape', (/** @type {HTMLElement} */ host) => /** @type {HTMLElement} */ (host.querySelector('#tb-chat-rename-field')).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))],
    ['its Cancel', (/** @type {HTMLElement} */ host) => /** @type {HTMLButtonElement} */ (host.querySelector('#tb-chat-rename-cancel')).click()],
  ])('%s leaves the name as it was', async (_name, cancel) => {
    const { chat, host, button } = await withToolbar()
    const rename = vi.spyOn(chat, 'rename')
    button('tb-chat-rename').click()
    cancel(host)
    expect(rename).not.toHaveBeenCalled()
    expect(host.querySelector('#tb-chat-rename-field')).toBeNull()
    expect(button('tb-chat-name-now')).not.toBeNull()
  })
})
