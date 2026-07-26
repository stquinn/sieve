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
})
