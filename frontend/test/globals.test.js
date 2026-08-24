import { describe, it, expect } from 'vitest'
import { getSieveIcon } from '../src/static/renderers/block-kinds.js'

// base/globals.js is the ONE writer of window.GLOBALS — the sole bridge for
// consumers that cannot import ES modules (index.html inline scripts, e.g. the
// [data-sieve-kind] icon decorator). Importing it must publish a frozen bag
// whose members are the SAME function objects their owning modules export —
// no re-implementation, no shared TipTap bus.
describe('base/globals.js', () => {
  it('publishes a frozen window.GLOBALS carrying the real getSieveIcon export', async () => {
    await import('../src/static/base/globals.js')
    expect(Object.isFrozen(window.GLOBALS)).toBe(true)
    expect(window.GLOBALS.getSieveIcon).toBe(getSieveIcon)
  })
})
