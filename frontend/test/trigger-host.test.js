// @ts-check
// trigger-host.test.js — the TriggerHost seam (#38).
//
// This file pins the SPLIT, not the composer: what every host must provide, what
// only a typed host provides, and — the assertion that matters most — that
// ACCEPTING IS NOT DEFINED AS A TEXT SUBSTITUTION. Both providers that exist
// today replace a token with a string; the next one (`{kind`) will delete the
// token and create a block, so a seam that typed `accept` as string replacement
// would have to be reopened. The FakeHost here is not a textarea and never
// touches text, which is the whole point: it proves the popover can drive a host
// that has no text in it at all.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { TriggerHost, TextareaHost, TriggerPlacement, PanelPlacement } from '../src/static/shell/trigger-host.js'
import { TriggerPopover } from '../src/static/shell/trigger-popover.js'
import { TriggerProvider, SlashCommandProvider } from '../src/static/shell/trigger-providers.js'
import { ContractViolation } from '../src/static/block/sieve-block.js'

function mountTextarea() {
  document.body.innerHTML = `
    <div id="ask-panel">
      <textarea class="ask-popup__input"></textarea>
    </div>
  `
  return /** @type {HTMLTextAreaElement} */ (document.querySelector('.ask-popup__input'))
}

/** A minimal token, as TriggerProvider.scanToken would mint one. */
function tokenFor(provider, start, end, prefix) {
  return Object.freeze({ provider, start, end, prefix })
}

afterEach(() => { document.body.innerHTML = '' })

// ── The abstract host ────────────────────────────────────────────────────────

describe('TriggerHost — the required core', () => {
  it('refuses to be used directly', () => {
    const bare = new TriggerHost()
    expect(() => bare.anchorElement()).toThrow(ContractViolation)
    expect(() => bare.anchorRect()).toThrow(ContractViolation)   // derives from the element
    expect(() => bare.onKeyDown(() => {})).toThrow(ContractViolation)
    expect(() => bare.onDismiss(() => {})).toThrow(ContractViolation)
  })

  it('does NOT declare the typed slice — its PRESENCE is the capability', () => {
    const bare = new TriggerHost()
    // Throwing stubs would make every host look typed to a `typeof` check, which
    // is how the popover tells a summoned host from one with a caret in it.
    expect(/** @type {any} */ (bare).tokenAtCaret).toBeUndefined()
    expect(/** @type {any} */ (bare).replaceRange).toBeUndefined()
    expect(/** @type {any} */ (bare).textAfter).toBeUndefined()
    expect(/** @type {any} */ (bare).onInput).toBeUndefined()
  })

  it('anchorRect defaults to the anchor element\'s box', () => {
    class ElementHost extends TriggerHost {
      constructor(el) { super(); this.el = el }
      anchorElement() { return this.el }
    }
    const el = document.createElement('div')
    el.getBoundingClientRect = () => /** @type {any} */ ({ left: 12, top: 34, width: 56 })
    expect(new ElementHost(el).anchorRect().left).toBe(12)
  })
})

// ── Acceptance is core, and is not a text substitution ───────────────────────

describe('TriggerHost.accept — "do something with this candidate"', () => {
  it('hands the candidate to the provider, passing the HOST rather than a payload', () => {
    class NoTextHost extends TriggerHost {
      anchorElement() { return document.body }
    }
    class BlockProvider extends TriggerProvider {
      constructor() { super(); this.received = null }
      get trigger() { return '{' }
      accept(item, token, host) { this.received = { item, token, host } }
    }
    const host = new NoTextHost()
    const provider = new BlockProvider()
    const token = tokenFor(provider, 0, 5, 'code')

    host.accept({ kind: 'code' }, token)

    // Nothing about the host was assumed to be text: no value, no range, no
    // element. A `{kind` provider would create a block from exactly this.
    expect(provider.received.item).toEqual({ kind: 'code' })
    expect(provider.received.token).toBe(token)
    expect(provider.received.host).toBe(host)
  })

  it('is the boundary a host may own — an override wraps acceptance', () => {
    const calls = []
    class TransactionalHost extends TriggerHost {
      anchorElement() { return document.body }
      onKeyDown() { return () => {} }
      onDismiss() { return () => {} }
      accept(candidate, token) {
        calls.push('begin')
        super.accept(candidate, token)
        calls.push('commit')
      }
    }
    class Recording extends TriggerProvider {
      get trigger() { return '{' }
      accept() { calls.push('provider') }
    }
    const provider = new Recording()
    new TransactionalHost().accept({}, tokenFor(provider, 0, 1, 'x'))
    expect(calls).toEqual(['begin', 'provider', 'commit'])
  })
})

// ── The textarea host ────────────────────────────────────────────────────────

describe('TextareaHost — the composer\'s host', () => {
  it('rejects anything that is not a textarea', () => {
    expect(() => new TextareaHost(/** @type {any} */ (null))).toThrow(ContractViolation)
    expect(() => new TextareaHost(/** @type {any} */ (document.createElement('div')))).toThrow(ContractViolation)
  })

  it('anchors on the textarea itself', () => {
    const textarea = mountTextarea()
    expect(new TextareaHost(textarea).anchorElement()).toBe(textarea)
  })

  it('scans the token under its own caret', () => {
    const textarea = mountTextarea()
    const host = new TextareaHost(textarea)
    const providers = new Map([['/', new SlashCommandProvider({ list: () => [] })]])

    textarea.value = '/btw hello'
    textarea.setSelectionRange(3, 3)
    expect(host.tokenAtCaret(providers)?.prefix).toBe('bt')

    textarea.setSelectionRange(10, 10)
    expect(host.tokenAtCaret(providers)).toBeNull()   // the token ended at the space
  })

  it('reads what follows a position', () => {
    const textarea = mountTextarea()
    textarea.value = 'How does @au handle this?'
    expect(new TextareaHost(textarea).textAfter(12)).toBe(' handle this?')
  })

  it('replaceRange substitutes, focuses, leaves the caret after the insert and fires input', () => {
    const textarea = mountTextarea()
    const host = new TextareaHost(textarea)
    const inputs = vi.fn()
    textarea.addEventListener('input', inputs)
    textarea.value = 'How does @au handle this?'

    host.replaceRange(9, 12, '@Auth Design')

    expect(textarea.value).toBe('How does @Auth Design handle this?')
    expect(textarea.selectionStart).toBe('How does @Auth Design'.length)
    expect(textarea.selectionEnd).toBe('How does @Auth Design'.length)
    expect(document.activeElement).toBe(textarea)
    // The composer has OTHER listeners on `input` (the attachment reconciler);
    // a programmatic completion is a real change to the message.
    expect(inputs).toHaveBeenCalledTimes(1)
  })

  it('unsubscribing actually removes each listener', () => {
    const textarea = mountTextarea()
    const host = new TextareaHost(textarea)
    const keys = vi.fn(); const dismiss = vi.fn(); const input = vi.fn()

    const offs = [host.onKeyDown(keys), host.onDismiss(dismiss), host.onInput(input)]
    textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    textarea.dispatchEvent(new window.Event('blur'))
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
    expect([keys.mock.calls.length, dismiss.mock.calls.length, input.mock.calls.length]).toEqual([1, 1, 1])

    // keydown is registered in the CAPTURE phase (the picker owns the arrows,
    // Tab, Enter and Escape while it is open, before the composer sees them), and
    // removeEventListener silently does nothing when the flag does not match.
    for (const off of offs) off()
    textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    textarea.dispatchEvent(new window.Event('blur'))
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
    expect([keys.mock.calls.length, dismiss.mock.calls.length, input.mock.calls.length]).toEqual([1, 1, 1])
  })
})

// ── Completion semantics belong to the provider, not the host ────────────────

describe('TriggerProvider.replaceToken — over a typed host', () => {
  /** Records the range replacement rather than performing one. */
  class RecordingHost extends TriggerHost {
    constructor(text) { super(); this.text = text; this.call = null }
    anchorElement() { return document.body }
    onKeyDown() { return () => {} }
    onDismiss() { return () => {} }
    onInput() { return () => {} }
    tokenAtCaret() { return null }
    textAfter(index) { return this.text.slice(index) }
    replaceRange(start, end, text) { this.call = { start, end, text } }
  }

  class Echo extends TriggerProvider {
    get trigger() { return '@' }
    accept(item, token, host) { this.replaceToken(host, token, item) }
  }

  it('adds a separator when nothing follows the token', () => {
    const host = new RecordingHost('@au')
    new Echo().accept('@Auth Design', tokenFor(null, 0, 3, 'au'), host)
    expect(host.call).toEqual({ start: 0, end: 3, text: '@Auth Design ' })
  })

  it('SWALLOWS an existing separator instead of doubling it', () => {
    // "How does @au| handle this?" — the space after the token is pulled into
    // the replaced range and re-emitted, so the caret still lands one past the
    // completion without the host knowing completions have a trailing gap.
    const host = new RecordingHost('How does @au handle this?')
    new Echo().accept('@Auth Design', tokenFor(null, 9, 12, 'au'), host)
    expect(host.call).toEqual({ start: 9, end: 13, text: '@Auth Design ' })
  })

  it('names the wiring mistake when the host cannot be typed into', () => {
    class CoreOnly extends TriggerHost {
      anchorElement() { return document.body }
    }
    expect(() => new Echo().accept('@Auth Design', tokenFor(null, 0, 3, 'au'), new CoreOnly()))
      .toThrow(ContractViolation)
  })

  it('reuses a newline as the separator rather than inserting a space before it', () => {
    const host = new RecordingHost('@au\nrest')
    new Echo().accept('@Auth Design', tokenFor(null, 0, 3, 'au'), host)
    expect(host.call).toEqual({ start: 0, end: 4, text: '@Auth Design\n' })
  })
})

// ── Placement ────────────────────────────────────────────────────────────────

describe('PanelPlacement — the composer\'s placement', () => {
  it('refuses an abstract placement', () => {
    expect(() => new TriggerPlacement().place(document.createElement('div'), new TriggerHost()))
      .toThrow(ContractViolation)
  })

  it('takes the panel\'s full width and pins the popover above its top edge', () => {
    const textarea = mountTextarea()
    const panel = /** @type {HTMLElement} */ (document.getElementById('ask-panel'))
    panel.getBoundingClientRect = () => /** @type {any} */ ({ left: 40, top: 500, width: 600 })
    const el = document.createElement('div')

    new PanelPlacement().place(el, new TextareaHost(textarea))

    expect(el.style.left).toBe('40px')
    expect(el.style.width).toBe('600px')
    expect(el.style.bottom).toBe((window.innerHeight - 500) + 'px')
  })

  it('falls back to the host\'s anchor rect when there is no panel to hang from', () => {
    class BareHost extends TriggerHost {
      anchorElement() { return null }
      anchorRect() { return /** @type {any} */ ({ left: 7, top: 200, width: 300 }) }
    }
    const el = document.createElement('div')
    new PanelPlacement().place(el, new BareHost())
    expect(el.style.left).toBe('7px')
    expect(el.style.width).toBe('300px')
  })
})

// ── What the popover asks of a host ──────────────────────────────────────────

describe('TriggerPopover — over the host seam', () => {
  it('refuses a host that is not a TriggerHost', () => {
    const textarea = mountTextarea()
    expect(() => new TriggerPopover(/** @type {any} */ (textarea), [])).toThrow(ContractViolation)
  })

  it('refuses a placement that is not a TriggerPlacement', () => {
    const textarea = mountTextarea()
    expect(() => new TriggerPopover(new TextareaHost(textarea), [], /** @type {any} */ ({ place: () => {} })))
      .toThrow(ContractViolation)
  })

  it('positions through the placement it was given, never itself', () => {
    const textarea = mountTextarea()
    const placed = []
    class SpyPlacement extends TriggerPlacement {
      place(el, host) { placed.push({ el, host }) }
    }
    const host = new TextareaHost(textarea)
    const popover = new TriggerPopover(host, [new SlashCommandProvider({ list: () => [{ name: 'btw' }] })], new SpyPlacement())

    textarea.value = '/b'
    textarea.setSelectionRange(2, 2)
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }))

    expect(placed.length).toBe(1)
    expect(placed[0].host).toBe(host)
    popover.destroy()
  })

  it('accepts THROUGH the host, so the host owns the boundary', () => {
    const textarea = mountTextarea()
    const accepted = []
    class WatchfulHost extends TextareaHost {
      accept(candidate, token) { accepted.push(candidate); super.accept(candidate, token) }
    }
    const popover = new TriggerPopover(new WatchfulHost(textarea), [
      new SlashCommandProvider({ list: () => [{ name: 'btw', description: 'by the way' }] }),
    ])

    textarea.value = '/bt'
    textarea.setSelectionRange(3, 3)
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
    textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))

    expect(accepted).toEqual([{ name: 'btw', description: 'by the way' }])
    expect(textarea.value).toBe('/btw ')
    popover.destroy()
  })

  it('a host with no typed slice wires no input stream and never arms', () => {
    // The core-only host: a toolbar button or Mod+K summoning the picker with no
    // token. It has nothing to scan, so the picker stays shut until something
    // summons it — which is a later task, not a silent failure here.
    const subscriptions = []
    class CoreOnlyHost extends TriggerHost {
      anchorElement() { return document.body }
      onKeyDown() { subscriptions.push('keydown'); return () => {} }
      onDismiss() { subscriptions.push('dismiss'); return () => {} }
    }
    const popover = new TriggerPopover(new CoreOnlyHost(), [new SlashCommandProvider({ list: () => [{ name: 'btw' }] })])

    expect(subscriptions).toEqual(['keydown', 'dismiss'])
    expect(/** @type {HTMLElement} */ (document.querySelector('.command-hint-popover')).style.display).toBe('none')
    popover.destroy()
  })

  it('destroy drops every host subscription', () => {
    const textarea = mountTextarea()
    const popover = new TriggerPopover(new TextareaHost(textarea), [
      new SlashCommandProvider({ list: () => [{ name: 'btw' }] }),
    ])
    popover.destroy()

    textarea.value = '/b'
    textarea.setSelectionRange(2, 2)
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }))

    expect(document.querySelector('.command-hint-popover')).toBeNull()
  })
})
