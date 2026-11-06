// @ts-check
// tab-seating.test.js — TabSeating: which moves keep the active tab of a strip
// that does not scroll where it can be seen, and when it asks for none.

import { describe, it, expect, vi } from 'vitest'
import { TabSeating } from '../src/static/ui/tab-seating.js'

/**
 * A strip of tabs named by `ids`, each viewed at its `viewed` (0 when absent),
 * `active` the active one's id and `visible` the tabs that fit.
 * @param {string} ids @param {Record<string, number>} viewed @param {string} active @param {number} visible
 */
function strip(ids, viewed, active, visible) {
  const tabs = ids.split('').map((id) => ({ id, viewed: viewed[id] || 0 }))
  return { tabs, active: tabs.findIndex((t) => t.id === active), visible }
}

/**
 * The order `moves` leave the tabs of `ids` in, as the reorder verb moves them.
 * @param {string} ids @param {ReadonlyArray<{from: number, to: number}>} moves
 */
function after(ids, moves) {
  const tabs = ids.split('')
  for (const { from, to } of moves) {
    const [moved] = tabs.splice(from, 1)
    tabs.splice(to > from ? to - 1 : to, 0, moved)
  }
  return tabs.join('')
}

describe('TabSeating.movesFor', () => {
  const seating = new TabSeating()
  it.each([
    ['an active tab already visible stays where it is', 'abcdef', { a: 1, b: 2, c: 3, d: 4 }, 'b', 4, 'abcdef', 0],
    ['an active tab past the fold takes the last visible slot, the least recently viewed leaves, the rest shift left',
      'abcdef', { a: 5, b: 1, c: 3, d: 4 }, 'f', 4, 'acdfbe', 2],
    ['a never-viewed visible tab is the first to leave', 'abcdef', { a: 5, b: 6, c: 0, d: 4 }, 'e', 4, 'abdecf', 2],
    ['the leftmost of equally old tabs leaves', 'abcdef', {}, 'f', 4, 'bcdfae', 2],
    ['the right-most visible tab leaving takes one move', 'abcdef', { a: 5, b: 6, c: 7, d: 1 }, 'f', 4, 'abcfde', 1],
    ['one visible slot holds the active tab alone', 'abc', { a: 1 }, 'c', 1, 'cab', 1],
    ['no visible slot moves nothing', 'abc', {}, 'c', 0, 'abc', 0],
    ['no active tab moves nothing', 'abc', {}, 'z', 2, 'abc', 0],
  ])('%s', (_, ids, viewed, active, visible, order, count) => {
    const moves = seating.movesFor(strip(ids, viewed, active, visible))
    expect(moves.length).toBe(count)
    expect(after(ids, moves)).toBe(order)
  })

  it('keeps two overflow tabs flicked between both visible, and moves nothing once they are', () => {
    let ids = 'abcdef'
    /** @type {Record<string, number>} */ const viewed = { a: 1, b: 2, c: 3, d: 4 }
    let clock = 10
    const view = (/** @type {string} */ id) => {
      viewed[id] = clock++
      const moves = seating.movesFor(strip(ids, viewed, id, 4))
      ids = after(ids, moves)
      return moves.length
    }
    view('e')
    view('f')
    expect(ids.slice(0, 4)).toContain('e')
    expect(ids.slice(0, 4)).toContain('f')
    for (let i = 0; i < 4; i++) {
      expect(view('e')).toBe(0)
      expect(view('f')).toBe(0)
    }
    expect(ids).toBe('cdefba')
  })
})

describe('TabSeating.seat', () => {
  it('asks for each move once the one before has settled', async () => {
    const seating = new TabSeating()
    /** @type {string[]} */ const asked = []
    /** @type {Array<() => void>} */ const settle = []
    const reorder = vi.fn((from, to) => {
      asked.push(`${from}>${to}`)
      return new Promise((resolve) => settle.push(() => resolve(undefined)))
    })
    const done = seating.seat(strip('abcdef', { a: 5, b: 1, c: 3, d: 4 }, 'f', 4), reorder)
    await Promise.resolve()
    expect(asked).toEqual(['1>4'])
    settle[0]()
    await new Promise((r) => setTimeout(r, 0))
    expect(asked).toEqual(['1>4', '5>3'])
    settle[1]()
    await done
  })

  it('seats nothing while a seating is under way, nor a strip it passed through — a late render — nor one accepted as placed', async () => {
    const seating = new TabSeating()
    /** @type {() => void} */ let release = () => {}
    const reorder = vi.fn(() => new Promise((resolve) => { release = () => resolve(undefined) }))
    const hidden = strip('abcdef', {}, 'f', 4)
    const seated = seating.seat(hidden, reorder)
    await seating.seat(strip('bcdafe', {}, 'f', 4), reorder)
    expect(reorder).toHaveBeenCalledTimes(1)
    release()
    await new Promise((r) => setTimeout(r, 0))
    release()
    await seated
    expect(reorder).toHaveBeenCalledTimes(2)

    reorder.mockClear()
    await seating.seat(strip('bcdfae', {}, 'f', 4), reorder)
    await seating.seat(strip('bcdaef', {}, 'f', 4), reorder)
    await seating.seat(hidden, reorder)
    expect(reorder).not.toHaveBeenCalled()
    const dropped = strip('abcdef', {}, 'f', 4)
    seating.accept(dropped)
    await seating.seat(dropped, reorder)
    expect(reorder).not.toHaveBeenCalled()
  })
})
