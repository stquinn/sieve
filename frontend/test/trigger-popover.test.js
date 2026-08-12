// @ts-check
// trigger-popover.test.js — the composer's trigger-driven hint popover (#74 P4).
//
// The `/` HALF OF THIS FILE IS THE UNCHANGED-BEHAVIOUR CONTRACT: every assertion
// in "slash trigger" is carried verbatim from the retired
// command-hint-popover.test.js. Only the CONSTRUCTION line changed (the popover
// takes providers now instead of hard-coding CommandService), which is the whole
// point of the generalisation: `/` must look exactly as it did.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TriggerPopover } from '../src/static/shell/trigger-popover.js'
import { SlashCommandProvider, MentionProvider, TriggerProvider } from '../src/static/shell/trigger-providers.js'
import { ContractViolation } from '../src/static/block/sieve-block.js'

function mountDom() {
  document.body.innerHTML = `
    <div id="ask-panel">
      <textarea class="ask-popup__input"></textarea>
    </div>
  `
  return {
    panel: document.getElementById('ask-panel'),
    textarea: /** @type {HTMLTextAreaElement} */ (document.querySelector('.ask-popup__input'))
  }
}

/** Types `value` and puts the caret at `caret` (default: end), then fires input. */
function type(textarea, value, caret) {
  textarea.value = value
  const at = caret == null ? value.length : caret
  textarea.setSelectionRange(at, at)
  textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
}

const popoverEl = () => document.querySelector('.command-hint-popover')
const items = () => Array.from(document.querySelectorAll('.command-hint-item'))

// ── The `/` contract, carried verbatim ───────────────────────────────────────

describe('TriggerPopover — slash trigger (behaviour unchanged)', () => {
  let textarea
  let popover
  let commands

  beforeEach(() => {
    const dom = mountDom()
    textarea = dom.textarea
    commands = [
      { name: 'btw', description: 'Ask by the way' },
      { name: 'buffer', description: 'Buffer doc' }
    ]
    popover = new TriggerPopover(textarea, [new SlashCommandProvider({ list: () => commands })])
  })

  afterEach(() => {
    popover.destroy()
    document.body.innerHTML = ''
  })

  it('shows matching commands when typing slash prefix', () => {
    type(textarea, '/b')

    const el = popoverEl()
    expect(el).not.toBeNull()
    expect(/** @type {HTMLElement} */ (el).style.display).not.toBe('none')

    expect(items().length).toBe(2)
    expect(items()[0].textContent).toContain('/btw')
    expect(items()[1].textContent).toContain('/buffer')
  })

  it('filters commands according to input prefix', () => {
    type(textarea, '/btw')
    expect(items().length).toBe(1)
    expect(items()[0].textContent).toContain('/btw')
  })

  it('hides when input is cleared or does not start with slash', () => {
    type(textarea, '/b')
    type(textarea, 'hello')
    expect(/** @type {HTMLElement} */ (popoverEl()).style.display).toBe('none')
  })

  it('completes highlighted command on Tab or Enter', () => {
    type(textarea, '/bt')

    const event = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    textarea.dispatchEvent(event)

    expect(textarea.value).toBe('/btw ')
    expect(textarea.selectionStart).toBe('/btw '.length)
    expect(textarea.selectionEnd).toBe('/btw '.length)
    expect(/** @type {HTMLElement} */ (popoverEl()).style.display).toBe('none')
  })

  it('navigates options with ArrowDown and ArrowUp', () => {
    type(textarea, '/b')

    const el = /** @type {HTMLElement} */ (popoverEl())
    let active = el.querySelector('.command-hint-item.is-active')
    expect(active?.textContent).toContain('/btw')

    textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    active = el.querySelector('.command-hint-item.is-active')
    expect(active?.textContent).toContain('/buffer')

    textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    active = el.querySelector('.command-hint-item.is-active')
    expect(active?.textContent).toContain('/btw')
  })

  it('Escape dismisses without completing', () => {
    type(textarea, '/bt')
    textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(/** @type {HTMLElement} */ (popoverEl()).style.display).toBe('none')
    expect(textarea.value).toBe('/bt')
  })

  it('a slash that is NOT at position 0 never triggers (start-of-line only)', () => {
    type(textarea, 'and/or')
    expect(/** @type {HTMLElement} */ (popoverEl()).style.display).toBe('none')
  })
})

// ── The provider registry ────────────────────────────────────────────────────

describe('TriggerPopover — the provider registry', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('routes each trigger to its own provider — no cross-talk', async () => {
    vi.useFakeTimers()
    const { textarea } = mountDom()
    const listCommands = vi.fn(() => [{ name: 'btw', description: 'by the way' }])
    const searchNotes = vi.fn(() => Promise.resolve([{ uri: 'container:1', title: 'Auth Design', detail: 'design/' }]))
    const popover = new TriggerPopover(textarea, [
      new SlashCommandProvider({ list: listCommands }),
      new MentionProvider({ search: searchNotes }, undefined, { debounceMs: 1 }),
    ])

    type(textarea, '/b')
    expect(items().map((i) => i.textContent)).toEqual([expect.stringContaining('/btw')])
    expect(searchNotes).not.toHaveBeenCalled()   // the mention source was never asked

    listCommands.mockClear()
    type(textarea, 'ask @au')
    await vi.advanceTimersByTimeAsync(10)
    expect(items().map((i) => i.textContent)).toEqual([expect.stringContaining('@Auth Design')])
    expect(listCommands).not.toHaveBeenCalled()  // the command list was never asked

    popover.destroy()
    vi.useRealTimers()
  })

  it('rejects two providers claiming the same trigger', () => {
    const { textarea } = mountDom()
    const a = new SlashCommandProvider({ list: () => [] })
    const b = new SlashCommandProvider({ list: () => [] })
    expect(() => new TriggerPopover(textarea, [a, b])).toThrow(ContractViolation)
  })

  it('rejects a provider that is not a TriggerProvider', () => {
    const { textarea } = mountDom()
    expect(() => new TriggerPopover(textarea, [/** @type {any} */ ({ trigger: '#' })])).toThrow(ContractViolation)
  })

  it('the abstract provider refuses to be used directly', () => {
    const bare = new TriggerProvider()
    expect(() => bare.trigger).toThrow(ContractViolation)
    expect(() => bare.search('x')).toThrow(ContractViolation)
    expect(() => bare.render({})).toThrow(ContractViolation)
    expect(() => bare.accept({}, /** @type {any} */ (null), /** @type {any} */ (null))).toThrow(ContractViolation)
  })
})

// ── The token-under-caret scan ───────────────────────────────────────────────

describe('TriggerPopover.scanToken — the token under the caret', () => {
  const providers = () => new Map([
    ['/', new SlashCommandProvider({ list: () => [] })],
    ['@', new MentionProvider({ search: () => [] })],
  ])

  it('finds a slash token only at position 0', () => {
    expect(TriggerPopover.scanToken('/bt', 3, providers())?.prefix).toBe('bt')
    expect(TriggerPopover.scanToken('x/bt', 4, providers())).toBeNull()
  })

  it('finds an @ token MID-TEXT, after a space', () => {
    const token = TriggerPopover.scanToken('How does @auth', 14, providers())
    expect(token?.prefix).toBe('auth')
    expect(token?.start).toBe(9)
    expect(token?.end).toBe(14)
    expect(token?.provider.trigger).toBe('@')
  })

  it('finds an @ token at position 0', () => {
    expect(TriggerPopover.scanToken('@au', 3, providers())?.prefix).toBe('au')
  })

  it('picks the @ NEAREST the caret when there are several', () => {
    const text = '@one and @two'
    const token = TriggerPopover.scanToken(text, text.length, providers())
    expect(token?.prefix).toBe('two')
    expect(token?.start).toBe(9)
  })

  it('scans from the CARET, not the end of the text', () => {
    const text = '@one and @two'
    // Caret parked just after "@on".
    expect(TriggerPopover.scanToken(text, 3, providers())?.prefix).toBe('on')
  })

  it('refuses an @ glued to a preceding word (an email address is not a mention)', () => {
    expect(TriggerPopover.scanToken('me@example', 10, providers())).toBeNull()
  })

  it('returns null once a space separates the caret from the trigger', () => {
    expect(TriggerPopover.scanToken('@Auth Design ', 13, providers())).toBeNull()
    expect(TriggerPopover.scanToken('/btw ', 5, providers())).toBeNull()
  })

  it('returns null when there is no trigger at all', () => {
    expect(TriggerPopover.scanToken('plain words', 11, providers())).toBeNull()
    expect(TriggerPopover.scanToken('', 0, providers())).toBeNull()
  })
})

// ── The `@` provider ─────────────────────────────────────────────────────────

describe('MentionProvider — the debounced, mid-text trigger', () => {
  afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers() })

  it('debounces the round-trip and renders the answering candidates', async () => {
    vi.useFakeTimers()
    const { textarea } = mountDom()
    const search = vi.fn(() => Promise.resolve([
      { uri: 'container:9f2b', title: 'Auth Design', kind: 'note', detail: 'design/ · #auth' },
    ]))
    const popover = new TriggerPopover(textarea, [new MentionProvider({ search }, undefined, { debounceMs: 40 })])

    type(textarea, 'how does @a')
    type(textarea, 'how does @au')
    type(textarea, 'how does @aut')
    expect(search).not.toHaveBeenCalled()   // still inside the debounce window

    await vi.advanceTimersByTimeAsync(50)
    // ONE round-trip for three keystrokes, carrying the LAST prefix.
    expect(search).toHaveBeenCalledTimes(1)
    expect(search.mock.calls[0][0]).toBe('aut')

    expect(items().length).toBe(1)
    expect(items()[0].textContent).toContain('@Auth Design')
    expect(items()[0].textContent).toContain('design/ · #auth')
    popover.destroy()
  })

  it('never queries on a bare @ (Go answers an empty query with nothing)', async () => {
    vi.useFakeTimers()
    const { textarea } = mountDom()
    const search = vi.fn(() => Promise.resolve([]))
    const popover = new TriggerPopover(textarea, [new MentionProvider({ search }, undefined, { debounceMs: 5 })])

    type(textarea, 'hello @')
    await vi.advanceTimersByTimeAsync(20)
    expect(search).not.toHaveBeenCalled()
    expect(/** @type {HTMLElement} */ (popoverEl()).style.display).toBe('none')
    popover.destroy()
  })

  it('accepting inserts the literal @Title in place of the token AND notifies the sink', async () => {
    vi.useFakeTimers()
    const { textarea } = mountDom()
    const candidate = { uri: 'container:9f2b', title: 'Auth Design', kind: 'note', detail: 'design/' }
    const attached = []
    const popover = new TriggerPopover(textarea, [
      new MentionProvider({ search: () => Promise.resolve([candidate]) }, (c) => attached.push(c), { debounceMs: 1 }),
    ])

    type(textarea, 'How does @au handle this?', 12)   // caret right after "@au"
    await vi.advanceTimersByTimeAsync(10)
    expect(items().length).toBe(1)

    textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))

    // The token is REPLACED in place and the existing gap is reused — an accepted
    // mention never doubles the space that already followed the token.
    expect(textarea.value).toBe('How does @Auth Design handle this?')
    expect(textarea.selectionStart).toBe('How does @Auth Design '.length)
    expect(attached).toEqual([candidate])
    expect(/** @type {HTMLElement} */ (popoverEl()).style.display).toBe('none')
    popover.destroy()
  })

  it('a stale answer never overwrites a newer query\'s list', async () => {
    vi.useFakeTimers()
    const { textarea } = mountDom()
    /** @type {Array<(v: any) => void>} */ const resolvers = []
    const search = vi.fn(() => new Promise((resolve) => resolvers.push(resolve)))
    const popover = new TriggerPopover(textarea, [new MentionProvider({ search }, undefined, { debounceMs: 1 })])

    type(textarea, '@aa')
    await vi.advanceTimersByTimeAsync(5)
    type(textarea, '@bb')
    await vi.advanceTimersByTimeAsync(5)
    expect(resolvers.length).toBe(2)

    resolvers[1]([{ uri: 'container:b', title: 'Bee' }])
    await vi.advanceTimersByTimeAsync(1)
    resolvers[0]([{ uri: 'container:a', title: 'Ay' }])   // the STALE answer lands last
    await vi.advanceTimersByTimeAsync(1)

    expect(items().map((i) => i.textContent)).toEqual([expect.stringContaining('@Bee')])
    popover.destroy()
  })
})
