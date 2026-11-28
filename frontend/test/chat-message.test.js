// @ts-check
// chat-message.test.js — one message of a chat's thread, either side of an
// exchange: my question in the speaker surface, the answer open at the column's
// width, the time under each, the actions in the row with it and what each
// reports, the pending slot while an answer is written, and Retry only where
// the job ended unfinished.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import MarkdownIt from 'markdown-it'
import { ChatMessage } from '../src/static/renderers/chat-message.js'
import { PendingSlot } from '../src/static/renderers/pending-slot.js'
import { ContractViolation } from '../src/static/contract/sieve-block.js'
import { ChatShowcase } from './helpers/chat-showcase.js'

const CHAT = '0198c1a0-0000-7000-8000-0000000000c1'
const EXCHANGE = '0198c1a0-0000-7000-8000-0000000000e1'
const { QUESTION: Q, ANSWER: A } = ChatMessage.Side

const prose = (/** @type {string} */ content) => ({ kind: 'prose', attrs: { content } })
const code = (/** @type {string} */ source) => ({ kind: 'code', attrs: { source, language: 'go' } })
const QUESTION = [
  { kind: 'reference', attrs: { uri: 'sieve://' + CHAT + '/' + EXCHANGE, rel: 'target' } },
  prose('Why does this drop the closing fence?'),
  code('trimmed := strings.TrimSpace(line)'),
  { kind: 'reference', attrs: { uri: 'sieve://0198c1a0-0000-7000-8000-00000000d0c1', rel: 'attach', cache: { title: 'fence-cases.log' } } },
]
const ANSWER = [prose('TrimSpace erases the signal.'), code('if col == 0 { return false }')]
const CITED = 'sieve://0198c1a0-0000-7000-8000-00000000d0c2/0198c1a0-0000-7000-8000-00000000b001'
const ASKED = '2026-11-27T13:58:09Z'
const COMPLETED = '2026-11-27T13:58:40Z'

function intents() {
  return { copy: vi.fn(), quote: vi.fn(), retry: vi.fn(), open: vi.fn() }
}

/** Draws one side of one exchange, placed in the page.
 *  @param {'question'|'answer'} side @param {Record<string, any>} attrs */
function drawn(side, attrs) {
  const spies = intents()
  const message = new ChatMessage(side, CHAT, spies)
  message.draw({ id: EXCHANGE, attrs: Object.assign({ question: QUESTION, createdAt: ASKED }, attrs) })
  document.body.appendChild(message.element)
  return { message, spies, el: message.element }
}

/** @param {Element} el */
const kindsIn = (el) => Array.from(el.querySelectorAll('.chat-message__body > .ai-block__element')).map((r) => r.getAttribute('data-kind'))

/** @param {Element} el @param {string} intent */
const control = (el, intent) => /** @type {HTMLButtonElement} */ (el.querySelector('[data-intent="' + intent + '"]'))

/** @param {Element} el */
const intentsIn = (el) => Array.from(el.querySelectorAll('[data-intent]')).map((b) => b.getAttribute('data-intent'))

/** Selects the whole text of `node`. @param {Node} node */
function select(node) {
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = /** @type {Selection} */ (document.getSelection())
  selection.removeAllRanges()
  selection.addRange(range)
}

describe('ChatMessage — the two sides', () => {
  beforeAll(() => { Object.assign(/** @type {any} */ (globalThis).TipTap, { MarkdownIt }) })
  afterAll(() => { delete /** @type {any} */ (globalThis).TipTap.MarkdownIt })
  afterEach(() => { document.body.innerHTML = '' })

  it.each([
    ['a question without copy', Q, { copy: undefined }, true],
    ['a question without quote', Q, { quote: undefined }, true],
    ['a question without retry', Q, { retry: undefined }, false],
    ['an answer without retry', A, { retry: undefined }, true],
    ['an answer with an open that is no function', A, { open: 'x' }, true],
    ['an answer without open', A, { open: undefined }, false],
    ['a side that is neither', 'both', {}, true],
  ])('constructed as %s, it throws: %s', (_name, side, change, throws) => {
    const make = () => new ChatMessage(/** @type {any} */ (side), CHAT, /** @type {any} */ (Object.assign(intents(), change)))
    if (throws) expect(make).toThrow(ContractViolation)
    else expect(make).not.toThrow()
  })

  it('carries its stylesheet, colour from tokens only', () => {
    expect(ChatMessage.styles).toContain('.chat-message')
    expect(ChatMessage.styles).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
  })

  it('marks a message it was taken to with one brief animation of a faint accent on its own face, and none under reduced motion', () => {
    const styles = ChatMessage.styles
    expect(styles.match(/@keyframes /g)).toEqual(['@keyframes '])
    expect(styles.match(/animation: chat-message-revealed [^;]*;/g)).toEqual(['animation: chat-message-revealed 1s ease-out 1;'])
    const frames = /** @type {RegExpMatchArray} */ (styles.match(/@keyframes chat-message-revealed \{([\s\S]*?)\n  \}/))
    expect(frames[1]).toContain('color-mix(in srgb, var(--theme-accentPrimary) 10%, transparent)')
    expect(frames[1]).not.toMatch(/background/)
    expect(styles).toMatch(/\.chat-message--revealed > \.chat-message__bubble,\s*\.chat-message--answer\.chat-message--revealed > \.chat-message__body \{\s*animation: chat-message-revealed/)
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.chat-message--revealed > \.chat-message__bubble,\s*\.chat-message--answer\.chat-message--revealed > \.chat-message__body \{\s*animation: none;/)
  })

  it('sets its own face from the theme\'s UI face, and the answer\'s document typography inherits it', () => {
    expect(ChatMessage.styles).toMatch(/\.chat-message \{[^}]*font-family: var\(--theme-uiFont\)/)
    expect(ChatMessage.styles).toMatch(/\.chat-message--answer > \.chat-message__body\.tiptap \{[^}]*font-family: inherit/)
    expect(drawn(A, { status: 'COMPLETE', answer: ANSWER }).el.querySelector('.chat-message__body')?.classList.contains('tiptap')).toBe(true)
  })

  it('sets no margin of its own: the space between messages is the thread\'s', () => {
    expect(ChatMessage.styles).not.toMatch(/\.chat-message(--question|--answer)? \{[^}]*margin/)
  })

  it('draws no shell round the exchange: a message is its side alone', () => {
    const question = drawn(Q, { status: 'COMPLETE', answer: ANSWER }).el
    const answer = drawn(A, { status: 'COMPLETE', answer: ANSWER }).el
    expect(question.textContent).not.toContain('TrimSpace erases the signal.')
    expect(answer.textContent).not.toContain('Why does this drop the closing fence?')
    for (const el of [question, answer]) {
      expect(el.querySelector('[class*="exchange-record"], [class*="__stamp"], [class*="__tools"]')).toBeNull()
    }
    expect(ChatMessage.styles).not.toMatch(/exchange-record|--record-radius/)
  })

  it('draws my question in the speaker surface, its blocks by kind, what it was handed as chips, and what it is about not at all', () => {
    const { el } = drawn(Q, {})
    const bubble = /** @type {HTMLElement} */ (el.querySelector('.chat-message__bubble'))
    expect(el.classList.contains('chat-message--question')).toBe(true)
    expect(kindsIn(bubble)).toEqual(['prose', 'code'])
    expect(bubble.textContent).toContain('Why does this drop the closing fence?')
    expect(bubble.querySelector('.sieve-block--code code')?.textContent).toBe('trimmed := strings.TrimSpace(line)')
    const chips = Array.from(bubble.querySelectorAll('.chat-message__attachments .sieve-reference-chip'))
    expect(chips.map((c) => c.textContent)).toEqual(['📄fence-cases.log'])
  })

  it('draws a quote in my question where it was written, as the blockquote it is drawn as', () => {
    const quote = { kind: 'reference', attrs: { uri: 'sieve://' + CHAT + '/' + EXCHANGE, rel: 'target', displayAs: 'quote', cache: { quote: 'TrimSpace erases the signal.' } } }
    const { el } = drawn(Q, { question: [prose('Before'), quote, prose('Why?')] })
    const bubble = /** @type {HTMLElement} */ (el.querySelector('.chat-message__bubble'))
    expect(kindsIn(bubble)).toEqual(['prose', 'reference', 'prose'])
    expect(bubble.querySelector('.reference-block__quote')?.textContent).toBe('TrimSpace erases the signal.')
  })

  it('draws the answer as its blocks, each by its kind\'s renderer, with no bubble of its own', () => {
    const { el } = drawn(A, { status: 'COMPLETE', answer: ANSWER })
    const body = /** @type {HTMLElement} */ (el.querySelector('.chat-message__body'))
    expect(el.classList.contains('chat-message--answer')).toBe(true)
    expect(el.querySelector('.chat-message__bubble')).toBeNull()
    expect(body.hidden).toBe(false)
    expect(kindsIn(el)).toEqual(['prose', 'code'])
    expect(body.textContent).toContain('TrimSpace erases the signal.')
    expect(body.querySelector('.sieve-block--code pre')?.getAttribute('contenteditable')).toBe('false')
    expect(body.querySelector('.ai-block')).toBeNull()
    expect(el.querySelector('.pending-slot')).toBeNull()
  })

  it.each([[Q], [A]])('a %s message presents the exchange as the block a gesture inside it resolves to, and no block of it', (side) => {
    const { el } = drawn(side, { status: 'COMPLETE', answer: ANSWER })
    expect(el.getAttribute('data-id')).toBe(EXCHANGE)
    expect(el.getAttribute('data-side')).toBe(side)
    expect(el.querySelectorAll('[data-id]').length).toBe(0)
  })

  it('redraws the answer as its blocks arrive, a block at a time, and leaves a block already drawn alone when nothing changed', () => {
    const { message, el } = drawn(A, { status: 'PENDING', answer: [] })
    message.draw({ id: EXCHANGE, attrs: { question: QUESTION, status: 'PENDING', answer: ANSWER.slice(0, 1) } })
    expect(kindsIn(el)).toEqual(['prose'])
    message.draw({ id: EXCHANGE, attrs: { question: QUESTION, status: 'COMPLETE', answer: ANSWER } })
    expect(kindsIn(el)).toEqual(['prose', 'code'])
    const row = el.querySelector('.chat-message__body > .ai-block__element')
    message.draw({ id: EXCHANGE, attrs: { question: QUESTION, status: 'COMPLETE', answer: ANSWER, completedAt: COMPLETED } })
    expect(el.querySelector('.chat-message__body > .ai-block__element')).toBe(row)
  })
})

describe('ChatMessage — its time', () => {
  beforeAll(() => { Object.assign(/** @type {any} */ (globalThis).TipTap, { MarkdownIt }) })
  afterAll(() => { delete /** @type {any} */ (globalThis).TipTap.MarkdownIt })
  afterEach(() => { document.body.innerHTML = '' })

  it.each([
    ['a question', Q, { status: 'PENDING' }, ASKED],
    ['a completed answer', A, { status: 'COMPLETE', answer: ANSWER, completedAt: COMPLETED }, COMPLETED],
    ['an answer being written', A, { status: 'PENDING', answer: ANSWER.slice(0, 1) }, null],
    ['a failed answer', A, { status: 'ERROR', completedAt: COMPLETED }, null],
    ['a completed answer that holds no completion time', A, { status: 'COMPLETE', answer: ANSWER }, null],
    ['a question that holds no readable time', Q, { createdAt: 'soon' }, null],
  ])('%s carries its own time', (_name, side, attrs, at) => {
    const { message, el } = drawn(side, attrs)
    message.showTime('2 minutes ago')
    const time = /** @type {HTMLTimeElement} */ (el.querySelector('time.chat-message__time'))
    expect(message.at ? message.at.toISOString() : null).toBe(at ? new Date(at).toISOString() : null)
    expect(time.textContent).toBe(at ? '2 minutes ago' : '')
    expect(time.getAttribute('datetime')).toBe(at ? new Date(at).toISOString() : null)
  })

  it('sits its time under the message, in the row with its actions, and draws it in the dimmed text colour a tier down', () => {
    const { el } = drawn(Q, {})
    const meta = /** @type {HTMLElement} */ (el.querySelector('.chat-message__meta'))
    expect(el.lastElementChild).toBe(meta)
    expect(Array.from(meta.children).map((c) => c.className)).toEqual(['chat-message__time', 'chat-message__actions'])
    expect(ChatMessage.styles).toMatch(/\.chat-message__time \{[^}]*color: var\(--theme-textDim\);[^}]*font-size: calc\(var\(--doc-size\) \* 0\.75\)/)
    expect(ChatMessage.styles).toMatch(/\.chat-message--question > \.chat-message__meta \{[^}]*flex-direction: row-reverse/)
  })

  it('a message that will hold a time shows the label when it arrives', () => {
    const { message, el } = drawn(A, { status: 'PENDING', answer: [] })
    message.showTime('a few seconds ago')
    expect(el.querySelector('.chat-message__time')?.textContent).toBe('')
    message.draw({ id: EXCHANGE, attrs: { question: QUESTION, status: 'COMPLETE', answer: ANSWER, completedAt: COMPLETED } })
    message.showTime('a few seconds ago')
    expect(el.querySelector('.chat-message__time')?.textContent).toBe('a few seconds ago')
  })
})

describe('ChatMessage — while the answer is written, and once it ended unfinished', () => {
  beforeAll(() => { Object.assign(/** @type {any} */ (globalThis).TipTap, { MarkdownIt }) })
  afterAll(() => { delete /** @type {any} */ (globalThis).TipTap.MarkdownIt })
  afterEach(() => { document.body.innerHTML = '' })

  it.each([
    ['PENDING'],
    ['DISPATCHED'],
  ])('an unanswered %s answer shows the pending slot in its place', (status) => {
    const { el } = drawn(A, { status, answer: [] })
    expect(/** @type {HTMLElement} */ (el.querySelector('.chat-message__body')).hidden).toBe(true)
    expect(el.querySelector('.chat-message__status .pending-slot')?.textContent).toBe(PendingSlot.LABEL)
    expect(el.getAttribute('aria-busy')).toBe('true')
  })

  it('a partly written answer keeps the pending slot under its last block, until it settles', () => {
    const { message, el } = drawn(A, { status: 'PENDING', answer: ANSWER.slice(0, 1) })
    const body = /** @type {HTMLElement} */ (el.querySelector('.chat-message__body'))
    const slot = /** @type {HTMLElement} */ (el.querySelector('.pending-slot'))
    expect(kindsIn(el)).toEqual(['prose'])
    expect(body.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    message.draw({ id: EXCHANGE, attrs: { question: QUESTION, status: 'COMPLETE', answer: ANSWER } })
    expect(el.querySelector('.pending-slot')).toBeNull()
    expect(el.getAttribute('aria-busy')).toBe('false')
  })

  it.each([
    ['PENDING', false],
    ['DISPATCHED', false],
    ['COMPLETE', false],
    ['ERROR', true],
    ['TIMEOUT', true],
  ])('a %s answer offers Retry: %s', (status, offered) => {
    const { el } = drawn(A, { status, answer: status === 'COMPLETE' ? ANSWER : [] })
    expect(!!control(el, 'retry')).toBe(offered)
  })

  it('a question offers no Retry and shows no pending slot, whatever its answer is doing', () => {
    const { el } = drawn(Q, { status: 'ERROR' })
    expect(control(el, 'retry')).toBeNull()
    expect(el.querySelector('.pending-slot')).toBeNull()
  })

  it.each([
    ['TIMEOUT', {}, 'The answer timed out.'],
    ['ERROR', { error: 'claude exited 1' }, 'claude exited 1'],
    ['ERROR', {}, 'The answer failed.'],
  ])('a %s answer says why in its place', (status, extra, said) => {
    const { el } = drawn(A, Object.assign({ status, answer: [] }, extra))
    expect(el.querySelector('.chat-message__failure-text')?.textContent).toBe(said)
  })
})

describe('ChatMessage — its actions', () => {
  beforeAll(() => { Object.assign(/** @type {any} */ (globalThis).TipTap, { MarkdownIt }) })
  afterAll(() => { delete /** @type {any} */ (globalThis).TipTap.MarkdownIt })
  afterEach(() => { document.body.innerHTML = ''; document.getSelection()?.removeAllRanges() })

  it.each([[Q], [A]])('a %s message shows its actions on pointer hover, and not once the pointer leaves', (side) => {
    const { el } = drawn(side, { status: 'COMPLETE', answer: ANSWER })
    expect(el.classList.contains(ChatMessage.ACTIVE_CLASS)).toBe(false)
    el.dispatchEvent(new Event('pointerenter'))
    expect(el.classList.contains(ChatMessage.ACTIVE_CLASS)).toBe(true)
    el.dispatchEvent(new Event('pointerleave'))
    expect(el.classList.contains(ChatMessage.ACTIVE_CLASS)).toBe(false)
  })

  it.each([[Q], [A]])('a %s message shows its actions on keyboard focus, keeps them while focus moves inside it, and not once focus leaves', (side) => {
    const { el } = drawn(side, { status: 'COMPLETE', answer: ANSWER })
    expect(el.tabIndex).toBe(0)
    el.focus()
    expect(el.classList.contains(ChatMessage.ACTIVE_CLASS)).toBe(true)
    control(el, 'quote').focus()
    expect(el.classList.contains(ChatMessage.ACTIVE_CLASS)).toBe(true)
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    expect(el.classList.contains(ChatMessage.ACTIVE_CLASS)).toBe(false)
  })

  it('keeps its actions shown while focused after the pointer leaves', () => {
    const { el } = drawn(A, { status: 'COMPLETE', answer: ANSWER })
    el.dispatchEvent(new Event('pointerenter'))
    el.focus()
    el.dispatchEvent(new Event('pointerleave'))
    expect(el.classList.contains(ChatMessage.ACTIVE_CLASS)).toBe(true)
  })

  it('the latest answer keeps its actions shown, and stops when it is no longer the latest', () => {
    const { message, el } = drawn(A, { status: 'COMPLETE', answer: ANSWER })
    message.setLatest(true)
    expect(el.classList.contains(ChatMessage.LATEST_CLASS)).toBe(true)
    message.setLatest(false)
    expect(el.classList.contains(ChatMessage.LATEST_CLASS)).toBe(false)
  })

  it('shows the actions of a message hovered, focused or the latest, and hides them by opacity alone', () => {
    const rule = /** @type {RegExpMatchArray} */ (ChatMessage.styles.match(/([^}]*)\{\s*opacity: 1;\s*\}/))
    for (const cls of [ChatMessage.ACTIVE_CLASS, ChatMessage.LATEST_CLASS]) {
      expect(rule[1]).toContain('.' + cls + ' .chat-message__actions')
    }
    expect(ChatMessage.styles).toMatch(/\.chat-message__actions \{[^}]*opacity: 0;/)
    expect(ChatMessage.styles).not.toMatch(/\.chat-message__actions \{[^}]*(display: none|visibility)/)
  })

  it('draws each action as a legible target: 28px, a border and a solid surface from tokens', () => {
    expect(ChatMessage.styles).toMatch(/\.chat-message__copy,\s*\.chat-message__quote \{[^}]*width: 28px;[^}]*height: 28px;/)
    expect(ChatMessage.styles).toMatch(/\.chat-message__block-copy \{[^}]*border: 1px solid var\(--theme-border2\);[^}]*background: color-mix\(in srgb, var\(--theme-bgAlt\) 55%, var\(--theme-bg\)\);/)
  })

  it.each([
    [Q, 'copy', 'Copy question'],
    [Q, 'quote', 'Quote in your next question'],
    [A, 'copy', 'Copy answer'],
    [A, 'quote', 'Quote in your next question'],
    [A, 'block-copy', 'Copy this block'],
  ])('on a %s, the %s action is an icon button named and titled %s, with no text face', (side, intent, name) => {
    const { el } = drawn(side, { status: 'COMPLETE', answer: ANSWER })
    const button = control(el, intent)
    expect(button.getAttribute('aria-label')).toBe(name)
    expect(button.title).toBe(name)
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect((button.textContent || '').trim()).toBe('')
  })

  it.each([
    [Q, 'copy', 'copy', ['Why does this drop the closing fence?\n\n```go\ntrimmed := strings.TrimSpace(line)\n```']],
    [A, 'copy', 'copy', ['TrimSpace erases the signal.\n\n```go\nif col == 0 { return false }\n```']],
    [A, 'block-copy', 'copy', ['TrimSpace erases the signal.']],
  ])('on a %s, the %s action reports %s and nothing else', (side, intent, reported, args) => {
    const { el, spies } = drawn(side, { status: 'COMPLETE', answer: ANSWER })
    const outer = vi.fn()
    document.body.addEventListener('click', outer)
    control(el, intent).click()
    expect(/** @type {any} */ (spies)[reported].mock.calls).toEqual([args])
    for (const [name, spy] of Object.entries(spies)) if (name !== reported) expect(spy).not.toHaveBeenCalled()
    expect(outer).not.toHaveBeenCalled()
    document.body.removeEventListener('click', outer)
  })

  it('a block\'s Copy is always armed: shown by its own block\'s hover or focus, and copying on one click with nothing else hovered', () => {
    const shown = /** @type {RegExpMatchArray} */ (ChatMessage.styles.match(/([^{}]*)\{\s*opacity: 1;\s*\}\s*\.chat-message__status/))
    const selectors = shown[1].split(',').map((s) => s.trim())
    expect(selectors).toEqual([
      '.ai-block__element:hover > .chat-message__block-copy',
      '.ai-block__element:focus-within > .chat-message__block-copy',
    ])
    expect(ChatMessage.styles).not.toMatch(/\.chat-message__block-copy \{[^}]*pointer-events: none/)
    const { el, spies } = drawn(A, { status: 'COMPLETE', answer: ANSWER })
    const second = el.querySelectorAll('.chat-message__body > .ai-block__element')[1]
    const copy = /** @type {HTMLButtonElement} */ (second.querySelector('[data-intent="block-copy"]'))
    copy.click()
    expect(spies.copy.mock.calls).toEqual([['```go\nif col == 0 { return false }\n```']])
    expect(el.classList.contains(ChatMessage.ACTIVE_CLASS)).toBe(false)
  })

  it('offers Copy on each block of the answer, and no actions on an answer that has no block yet', () => {
    const { el } = drawn(A, { status: 'COMPLETE', answer: ANSWER })
    const rows = Array.from(el.querySelectorAll('.chat-message__body > .ai-block__element'))
    expect(rows.map((r) => Array.from(r.children).some((c) => c.getAttribute('data-intent') === 'block-copy'))).toEqual([true, true])
    const pending = drawn(A, { status: 'PENDING', answer: [] }).el
    expect(/** @type {HTMLElement} */ (pending.querySelector('.chat-message__actions')).hidden).toBe(true)
    expect(/** @type {HTMLElement} */ (pending.querySelector('.chat-message__meta')).hidden).toBe(true)
  })

  it('Retry reports retry, naming the exchange, and nothing else', () => {
    const { el, spies } = drawn(A, { status: 'ERROR', answer: [] })
    control(el, 'retry').click()
    expect(spies.retry.mock.calls).toEqual([[EXCHANGE]])
    for (const [name, spy] of Object.entries(spies)) if (name !== 'retry') expect(spy).not.toHaveBeenCalled()
  })

  it('an attachment chip reports open with its address', () => {
    const { el, spies } = drawn(Q, {})
    const chip = /** @type {HTMLElement} */ (el.querySelector('.chat-message__attachments .sieve-reference-chip'))
    chip.click()
    expect(spies.open.mock.calls).toEqual([['sieve://0198c1a0-0000-7000-8000-00000000d0c1']])
  })

  it.each([
    ['a reference, with an open intent, reports open with its address', A, { cache: { title: 'scanner.go' } }, true, [[CITED]]],
    ['a reference, without one, reports nothing', A, { cache: { title: 'scanner.go' } }, false, []],
    ['a quote, with an open intent, reports open with its address and the text it seeks there', A, { displayAs: 'quote', cache: { quote: 'classify the line' } }, true, [[CITED, 'classify the line']]],
    ['a quote in my question reports the same', Q, { displayAs: 'quote', cache: { quote: 'classify the line' } }, true, [[CITED, 'classify the line']]],
  ])('a double-click on %s', (_name, side, attrs, withOpen, calls) => {
    const spies = intents()
    const message = new ChatMessage(side, CHAT, withOpen ? spies : { copy: spies.copy, quote: spies.quote, retry: spies.retry })
    const blocks = [prose('See'), { kind: 'reference', attrs: Object.assign({ uri: CITED }, attrs) }]
    message.draw({ id: EXCHANGE, attrs: { question: side === Q ? blocks : QUESTION, status: 'COMPLETE', answer: side === A ? blocks : ANSWER } })
    document.body.appendChild(message.element)
    const body = /** @type {HTMLElement} */ (message.element.querySelector('.chat-message__body .reference-block__body'))
    body.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    expect(spies.open.mock.calls).toEqual(calls)
  })

  it('Quote is a plain action: every press reports, and nothing about the message is pressed or toggled', () => {
    const { spies, el } = drawn(A, { status: 'COMPLETE', answer: ANSWER })
    const before = el.className
    control(el, 'quote').click()
    control(el, 'quote').click()
    expect(spies.quote).toHaveBeenCalledTimes(2)
    expect(control(el, 'quote').hasAttribute('aria-pressed')).toBe(false)
    expect(el.className).toBe(before)
  })

  it.each([
    [Q, 'the selection inside it', (/** @type {HTMLElement} */ el) => select(/** @type {Node} */ (el.querySelector('.sieve-block--code code'))), 'trimmed := strings.TrimSpace(line)'],
    [A, 'the selection inside it', (/** @type {HTMLElement} */ el) => select(/** @type {Node} */ (el.querySelector('.sieve-block--code code'))), 'if col == 0 { return false }'],
    [Q, 'its opening, with no selection', () => {}, 'Why does this drop the closing fence? trimmed := strings.TrimSpace(line)'],
    [A, 'its opening, with no selection', () => {}, 'TrimSpace erases the signal. if col == 0 { return false }'],
    [A, 'its opening, when the selection lies outside it', () => {
      const other = document.createElement('p')
      other.textContent = 'elsewhere'
      document.body.appendChild(other)
      select(other)
    }, 'TrimSpace erases the signal. if col == 0 { return false }'],
  ])('Quote on a %s reports its side and %s', (side, _name, arrange, text) => {
    const { el, spies } = drawn(side, { status: 'COMPLETE', answer: ANSWER })
    arrange(el)
    control(el, 'quote').click()
    expect(spies.quote.mock.calls).toEqual([[{ exchangeId: EXCHANGE, side, text }]])
  })

  it('Quote of a long message\'s opening is cut at a word boundary short of the limit, and says it was cut', () => {
    const words = Array.from({ length: 80 }, (_v, i) => 'word' + i).join(' ')
    const { el, spies } = drawn(A, { status: 'COMPLETE', answer: [prose(words)] })
    control(el, 'quote').click()
    const text = spies.quote.mock.calls[0][0].text
    expect(text.length).toBeLessThanOrEqual(ChatMessage.OPENING_CHARS + 1)
    expect(text.endsWith('…')).toBe(true)
    expect(words.startsWith(text.slice(0, -1) + ' ')).toBe(true)
  })

  it('Quote of an opening is text: the markers of a blockquote and of a heading are left out', () => {
    const { el, spies } = drawn(A, { status: 'COMPLETE', answer: [prose('> Everything fails, all the time.\n>\n> — Werner Vogels\n\n## The premise\n\nThat is the premise.')] })
    control(el, 'quote').click()
    expect(spies.quote.mock.calls[0][0].text).toBe('Everything fails, all the time. — Werner Vogels The premise That is the premise.')
  })

  it.each([
    ['COMPLETE', ANSWER, ['copy', 'quote', 'block-copy', 'block-copy']],
    ['ERROR', ANSWER.slice(0, 1), ['retry', 'copy', 'quote', 'block-copy']],
  ])('a %s answer offers its read actions and nothing that edits, removes or files', (status, answer, offered) => {
    const { el } = drawn(A, { status, answer })
    expect(intentsIn(el).sort()).toEqual(offered.slice().sort())
    expect(el.querySelectorAll('[contenteditable="true"]').length).toBe(0)
    const words = Array.from(el.querySelectorAll('button')).map((b) => (b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')).join(' | ')
    for (const forbidden of [/delete/i, /remove/i, /edit/i, /branch/i, /extract/i, /add to document/i, /expand/i]) expect(words).not.toMatch(forbidden)
  })
})

// WHAT A MESSAGE HOLDS. A quote taken by a message's own Quote, with a selection
// or of its opening, is held by that message and by no other of its exchange.
describe('ChatMessage — the text it holds', () => {
  beforeAll(() => { Object.assign(/** @type {any} */ (globalThis).TipTap, { MarkdownIt }) })
  afterAll(() => { delete /** @type {any} */ (globalThis).TipTap.MarkdownIt })
  afterEach(() => { document.body.innerHTML = ''; document.getSelection()?.removeAllRanges() })

  const LONG = Array.from({ length: 80 }, (_v, i) => 'word' + i).join(' ')
  const FENCED = [code('func classify(line string) bool {\n\treturn false\n}'), prose('It never classifies.')]
  const QUOTED = [prose('> Everything fails, all the time.\n>\n> — Werner Vogels\n\nThat is the **premise**.')]

  /** Both messages of one exchange, placed in the page. @param {any[]} question @param {any[]} answer */
  function both(question, answer) {
    /** @type {Record<string, {message: ChatMessage, spies: ReturnType<typeof intents>}>} */ const sides = {}
    for (const side of [Q, A]) {
      const spies = intents()
      const message = new ChatMessage(side, CHAT, spies)
      message.draw({ id: EXCHANGE, attrs: { question, answer, status: 'COMPLETE', createdAt: ASKED } })
      document.body.appendChild(message.element)
      sides[side] = { message, spies }
    }
    return sides
  }

  /** @param {string} selector @returns {(el: HTMLElement) => void} */
  const selecting = (selector) => (el) => select(/** @type {Node} */ (el.querySelector(selector)))
  const opening = () => {}

  it.each([
    [Q, 'its opening', QUESTION, ANSWER, opening],
    [A, 'its opening', QUESTION, ANSWER, opening],
    [Q, 'a selected code block', QUESTION, ANSWER, selecting('.sieve-block--code code')],
    [A, 'a selected paragraph', QUESTION, ANSWER, selecting('.sieve-block--prose p')],
    [A, 'its whole body selected', QUESTION, ANSWER, selecting('.chat-message__body')],
    [A, 'the opening of one that starts with a code block', QUESTION, FENCED, opening],
    [Q, 'the opening of one that starts with a code block', FENCED, ANSWER, opening],
    [A, 'the selected code of one that starts with a code block', QUESTION, FENCED, selecting('.sieve-block--code code')],
    [A, 'the opening of one holding a blockquote', QUESTION, QUOTED, opening],
    [Q, 'the opening of one holding a blockquote', QUOTED, ANSWER, opening],
    [A, 'a selected blockquote', QUESTION, QUOTED, selecting('blockquote')],
    [A, 'the opening of a long one, cut', QUESTION, [prose(LONG)], opening],
  ])('a %s holds a quote of %s, taken by its own Quote, and the other side does not', (side, _name, question, answer, arrange) => {
    const sides = both(question, answer)
    const own = sides[side]
    const other = sides[side === Q ? A : Q]
    arrange(own.message.element)
    control(own.message.element, 'quote').click()
    const quoted = own.spies.quote.mock.calls[0][0].text
    expect(quoted).not.toBe('')
    expect([own.message.holds(quoted), other.message.holds(quoted)]).toEqual([true, false])
  })

  it.each([
    ['its text with whitespace laid out differently', 'TrimSpace   erases\nthe signal.', true],
    ['its markdown with the markers left in', 'if col == 0 { return false }', true],
    ['its text with a trailing ellipsis', 'TrimSpace erases…', true],
    ['text it does not hold', 'erases nothing', false],
    ['blank text', '   ', false],
    ['an ellipsis alone', '…', false],
  ])('an answer judges %s', (_name, quoted, held) => {
    const { message } = drawn(A, { status: 'COMPLETE', answer: ANSWER })
    expect(message.holds(quoted)).toBe(held)
  })
})

// THE SHOWCASE CHAT, drawn a message at a time: what each of its parts shows is
// what the lens is judged against by eye.
describe('ChatMessage — the showcase chat', () => {
  beforeAll(() => { Object.assign(/** @type {any} */ (globalThis).TipTap, { MarkdownIt }) })
  afterAll(() => { delete /** @type {any} */ (globalThis).TipTap.MarkdownIt })
  afterEach(() => { document.body.innerHTML = '' })

  /** @param {'question'|'answer'} side @param {number} part */
  function showcase(side, part) {
    const message = new ChatMessage(side, ChatShowcase.UUID, intents())
    message.draw(ChatShowcase.exchange(part))
    document.body.appendChild(message.element)
    return message
  }

  it.each([
    ['plain', ChatShowcase.PART.PLAIN, ['prose'], [], ['prose'], ['block-copy', 'copy', 'quote'], true],
    ['rich', ChatShowcase.PART.RICH, ['prose', 'code'], ['scanner.go'], ['prose', 'code', 'reference'], ['block-copy', 'block-copy', 'block-copy', 'copy', 'quote'], true],
    ['failed', ChatShowcase.PART.FAILED, ['prose'], [], [], ['retry', 'copy', 'quote'], false],
    ['pending', ChatShowcase.PART.PENDING, ['prose'], [], [], ['copy', 'quote'], false],
  ])('the %s exchange draws its question, its attachments, its answer, their actions and their times', (_name, part, question, chips, answer, answerIntents, answered) => {
    const asked = showcase(Q, part)
    const replied = showcase(A, part)
    expect(kindsIn(asked.element)).toEqual(question)
    expect(Array.from(asked.element.querySelectorAll('.chat-message__attachments .sieve-reference-chip__label')).map((c) => c.textContent)).toEqual(chips)
    expect(intentsIn(asked.element)).toEqual(['copy', 'quote'])
    expect(kindsIn(replied.element)).toEqual(answer)
    expect(intentsIn(replied.element)).toEqual(answerIntents)
    expect(asked.at).not.toBeNull()
    expect(!!replied.at).toBe(answered)
  })

  it('the rich answer keeps its inline code and its code block', () => {
    const el = showcase(A, ChatShowcase.PART.RICH).element
    expect(el.querySelector('.chat-message__body .sieve-block--prose code')?.textContent).toBe('Recoverable')
    expect(el.querySelector('.chat-message__body .sieve-block--code code')?.textContent).toContain('func (s *Scanner) classify')
  })

  it('the failed exchange says why, and the pending one holds the pending slot', () => {
    expect(showcase(A, ChatShowcase.PART.FAILED).element.querySelector('.chat-message__failure-text')?.textContent)
      .toBe(ChatShowcase.exchange(ChatShowcase.PART.FAILED).attrs.error)
    expect(showcase(A, ChatShowcase.PART.PENDING).element.querySelector('.chat-message__status .pending-slot')).not.toBeNull()
  })
})
