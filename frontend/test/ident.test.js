// @ts-check
// ident.test.js — the client's half of identity (issue #96). A block born in a
// lens carries a REAL id from birth, so these pin the properties Go's validator
// will hold the client to: the canonical form, the version and variant bits, the
// time-ordering that makes coordination-free minting safe, and uniqueness.

import { describe, it, expect } from 'vitest'
import { Ident } from '../src/static/ident/ident.js'

describe('Ident.mint', () => {
  it('mints the canonical 8-4-4-4-12 form', () => {
    const id = Ident.mint()
    expect(id).toHaveLength(36)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('sets the version nibble to 7', () => {
    // Version is the first nibble of the third group — position 14 in the string.
    for (let i = 0; i < 50; i++) expect(Ident.mint()[14]).toBe('7')
  })

  it('sets the RFC 4122 variant bits (10xx) on the fourth group', () => {
    for (let i = 0; i < 50; i++) {
      const nibble = parseInt(Ident.mint()[19], 16)
      expect(nibble & 0b1100).toBe(0b1000)
    }
  })

  it('leads with a millisecond timestamp, so ids sort chronologically', () => {
    // The first 48 bits are unix_ts_ms, big-endian, so the hex prefix IS the
    // clock. Read it back and check it is now, not an arbitrary random run.
    const before = Date.now()
    const stamp = parseInt(Ident.mint().slice(0, 8) + Ident.mint().slice(9, 13), 16)
    expect(Number.isFinite(stamp)).toBe(true)

    const id = Ident.mint()
    const ms = parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
    expect(ms).toBeGreaterThanOrEqual(before - 1000)
    expect(ms).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('orders lexically by time across a clock tick', async () => {
    const first = Ident.mint()
    await new Promise((resolve) => setTimeout(resolve, 3))
    expect(first < Ident.mint()).toBe(true)
  })

  it('never repeats — the whole reason a lens may mint without asking', () => {
    const seen = new Set()
    for (let i = 0; i < 20000; i++) seen.add(Ident.mint())
    expect(seen.size).toBe(20000)
  })
})

describe('Ident.valid', () => {
  it('accepts what it mints', () => {
    for (let i = 0; i < 50; i++) expect(Ident.valid(Ident.mint())).toBe(true)
  })

  it.each([
    ['empty', ''],
    ['a legacy short handle', 'b-3f2a'],
    ['the hyphen-less spelling', '018f1b2c3d4e7f8a9b0c1d2e3f4a5b6c'],
    ['the urn spelling', 'urn:uuid:018f1b2c-3d4e-7f8a-9b0c-1d2e3f4a5b6c'],
    ['the braced spelling', '{018f1b2c-3d4e-7f8a-9b0c-1d2e3f4a5b6c}'],
    ['one char short', '018f1b2c-3d4e-7f8a-9b0c-1d2e3f4a5b6'],
    ['non-hex', '018f1b2c-3d4e-7f8a-9b0c-1d2e3f4a5bZZ'],
  ])('refuses %s — a form we never mint is not one of ours', (_name, value) => {
    expect(Ident.valid(value)).toBe(false)
  })

  it('refuses anything that is not a string', () => {
    for (const v of [null, undefined, 42, {}, []]) expect(Ident.valid(v)).toBe(false)
  })
})
