// @ts-check
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CommandBadges } from '../src/static/shell/command-badges.js'

describe('CommandBadges', () => {
  let slot
  let badges

  beforeEach(() => {
    slot = document.createElement('div')
    slot.className = 'status-bar__command-badges'
    document.body.appendChild(slot)
    badges = new CommandBadges(slot)
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('track() paints a pending badge labelled with the command', () => {
    const handle = { correlationId: 'c-1', onResult: vi.fn(), cancel: vi.fn() }
    badges.track(handle, { cmd: 'btw', text: 'what is DRY' })

    const btn = slot.querySelector('.command-badge')
    expect(btn).not.toBeNull()
    expect(btn.textContent).toBe('/btw')
    expect(btn.className).toContain('command-badge--pending')
  })

  it('pending badge carries --pending; terminal result flips it to --holding', () => {
    // Badge states are colour-coded by class only (pending cyan / holding green /
    // error red) — running progress lives in the status-bar jobs spinner, not on
    // the badge. Terminal state must drop --pending.
    let resultCb
    const handle = { correlationId: 'c-1', onResult: (cb) => { resultCb = cb }, cancel: vi.fn() }
    badges.track(handle, { cmd: 'btw', text: 'q' })

    const btn = slot.querySelector('.command-badge')
    expect(btn.classList.contains('command-badge--pending')).toBe(true)

    resultCb({ status: 'COMPLETE', block: { kind: 'ai-block', attrs: { status: 'COMPLETE', question: 'q', response: 'a' } } })
    expect(btn.classList.contains('command-badge--pending')).toBe(false)
    expect(btn.classList.contains('command-badge--holding')).toBe(true)
  })

  it('terminal COMPLETE flips badge to holding and auto-summons popup', () => {
    let resultCb
    const handle = {
      correlationId: 'c-1',
      onResult: (cb) => { resultCb = cb },
      cancel: vi.fn()
    }
    badges.track(handle, { cmd: 'btw', text: 'what is DRY' })

    resultCb({
      status: 'COMPLETE',
      block: { kind: 'ai-block', attrs: { question: 'what is DRY', response: 'Don’t Repeat Yourself', status: 'COMPLETE' } }
    })

    const btn = slot.querySelector('.command-badge')
    expect(btn.className).toContain('command-badge--holding')

    const popup = document.querySelector('.command-popup')
    expect(popup).not.toBeNull()
    expect(popup.textContent).toContain('Don’t Repeat Yourself')
  })

  it('a block-less ERROR does NOT fabricate an ai-block; popup shows a generic error', () => {
    let resultCb
    const handle = { correlationId: 'c-1', onResult: (cb) => { resultCb = cb }, cancel: vi.fn() }
    badges.track(handle, { cmd: 'btw', text: 'boom' })

    resultCb({ status: 'ERROR', error: 'backend exploded' })

    const btn = slot.querySelector('.command-badge')
    expect(btn.className).toContain('command-badge--error')

    const popup = document.querySelector('.command-popup')
    expect(popup).not.toBeNull()
    expect(popup.querySelector('.sieve-ai-block')).toBeNull()   // no fabricated block
    expect(popup.textContent).toContain('backend exploded')
  })

  it('an ERROR after a prior block merges into a fresh block of the SAME kind', () => {
    let resultCb
    const handle = { correlationId: 'c-1', onResult: (cb) => { resultCb = cb }, cancel: vi.fn() }
    badges.track(handle, { cmd: 'render', text: 'diagram' })

    // A non-terminal result arrives first, establishing the block kind.
    resultCb({ status: 'PENDING', block: { kind: 'diagram', attrs: { status: 'PENDING' } } })
    // Then it errors with no block of its own.
    resultCb({ status: 'ERROR', error: 'render failed' })

    const btn = slot.querySelector('.command-badge')
    expect(btn.className).toContain('command-badge--error')
    // The popup mounts the diagram (same-kind), NOT a hardcoded ai-block.
    const popup = document.querySelector('.command-popup')
    expect(popup.textContent).toContain('Unsupported result kind') // no diagram renderer registered in the popup map
    expect(popup.textContent).toContain('diagram')
  })
})
