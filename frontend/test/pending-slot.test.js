// @ts-check
// pending-slot.test.js — the mark of an answer still being written: a status
// the page announces, a dot and the words, how long the answer has been awaited
// as its host tells it the time, and nothing that says how far along.

import { describe, it, expect } from 'vitest'
import { PendingSlot } from '../src/static/renderers/pending-slot.js'

describe('PendingSlot', () => {
  it('is a status of a dot and "answering…", and nothing else', () => {
    const el = new PendingSlot().element
    expect(el.className).toBe(PendingSlot.ROOT_CLASS)
    expect(el.getAttribute('role')).toBe('status')
    expect(Array.from(el.children).map((c) => c.className)).toEqual(['pending-slot__dot', 'pending-slot__label'])
    expect(el.querySelector('.pending-slot__elapsed')?.getAttribute('aria-hidden')).toBe('true')
    expect(el.querySelector('.pending-slot__dot')?.getAttribute('aria-hidden')).toBe('true')
    expect(el.textContent).toBe('answering…')
  })

  const ASKED = new Date(2026, 10, 28, 12, 0, 0)
  const after = (/** @type {number} */ seconds) => new Date(ASKED.getTime() + seconds * 1000)

  it.each([
    [0, 'answering… 0s'],
    [59, 'answering… 59s'],
    [60, 'answering… 1m 00s'],
    [125, 'answering… 2m 05s'],
    [-3, 'answering… 0s'],
  ])('counted %is after the answer was asked, it reads %j', (seconds, said) => {
    const slot = new PendingSlot()
    slot.count(ASKED, after(seconds))
    expect(slot.element.textContent).toBe(said)
  })

  it('with no time it was asked at, it counts nothing', () => {
    const slot = new PendingSlot()
    slot.count(null, ASKED)
    expect(slot.element.textContent).toBe('answering…')
  })

  it('carries its stylesheet, colour from tokens only', () => {
    expect(PendingSlot.styles).toContain('.pending-slot')
    expect(PendingSlot.styles).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
  })
})
