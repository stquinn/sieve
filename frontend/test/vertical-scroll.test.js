// @ts-check
// vertical-scroll.test.js — NEW FILE for a genuinely new unit: the editor's one
// way of bringing something into view.
//
// Two things are under test and they are different in kind. The arithmetic —
// how far to move for `center` and for `nearest` — is pure and driven as a
// table. The PROMISE is not arithmetic at all: whatever it moves, it hands the
// horizontal position back untouched, because the pane scrolls sideways by
// accident and nothing ever scrolls it back.

import { describe, it, expect, vi } from 'vitest'
import { VerticalScroll } from '../src/static/lens/document-editor/surfaces/vertical-scroll.js'

/** @param {number} top @param {number} height */
const rect = (top, height) => ({ top: top, bottom: top + height, height: height })

describe('VerticalScroll.deltaFor — how far to move', () => {
  const frame = rect(0, 200)

  /** @type {Array<[string, {top: number, bottom: number, height: number}, 'center'|'nearest', number]>} */
  const cases = [
    ['centres a box below the fold', rect(300, 20), 'center', 210],
    ['centres a box above the fold', rect(-100, 20), 'center', -190],
    ['centres a box already in view — centring is unconditional', rect(90, 20), 'center', 0],
    ['nearest leaves a box that is already in view alone', rect(90, 20), 'nearest', 0],
    ['nearest brings a box below the fold just inside', rect(300, 20), 'nearest', 120],
    ['nearest brings a box above the fold just inside', rect(-30, 20), 'nearest', -30],
    ['nearest tops out a box taller than the frame, where reading it starts', rect(300, 400), 'nearest', 300],
  ]

  for (const [name, box, place, want] of cases) {
    it(name, () => {
      expect(VerticalScroll.deltaFor(box, frame, place)).toBe(want)
    })
  }
})

describe('VerticalScroll.into — what it writes on the scroller', () => {
  /** A pane that scrolls, with a child at a stated place. */
  function staged(childTop) {
    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000 })
    Object.defineProperty(scroller, 'clientHeight', { value: 200 })
    scroller.getBoundingClientRect = () => /** @type {any} */ (rect(0, 200))
    scroller.scrollTop = 500
    scroller.scrollLeft = 77
    scroller.scrollTo = vi.fn()

    const el = document.createElement('p')
    el.getBoundingClientRect = () => /** @type {any} */ (rect(childTop, 20))
    scroller.appendChild(el)
    document.body.appendChild(scroller)
    return { scroller: scroller, el: el }
  }

  it('moves the vertical position and hands the horizontal one back UNTOUCHED', () => {
    const { scroller, el } = staged(300)
    VerticalScroll.into(el, 'center')
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 500 + 210, left: 77, behavior: 'smooth' })
  })

  it('writes nothing at all when the element is already where it should be', () => {
    const { scroller, el } = staged(90)
    VerticalScroll.into(el, 'nearest')
    expect(scroller.scrollTo).not.toHaveBeenCalled()
  })

  it('is silent for an element nothing scrolls', () => {
    const loose = document.createElement('p')
    document.body.appendChild(loose)
    expect(() => VerticalScroll.into(loose, 'center')).not.toThrow()
    expect(() => VerticalScroll.into(null, 'center')).not.toThrow()
  })
})
