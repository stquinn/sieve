// @ts-check
// address-status.test.js — the liveness oracle behind a dangling attachment
// chip (#82).
//
// What is pinned here is the COST POLICY, because that is the whole reason the
// class exists: a renderer redraws on every transaction that touches its node,
// so "does this address still resolve?" must cost at most one round trip per
// address for the life of the editor that owns the oracle. The verdict mapping
// is trivial; the traffic ceiling is not.
import { describe, it, expect, vi } from 'vitest'
import { AddressStatus, AddressState } from '../src/static/block/address-status.js'
import { ContractViolation } from '../src/static/block/sieve-block.js'

/**
 * A stubbed MentionService: it answers from a map and counts what it was asked.
 * NO SOCKET — the wire is MentionService's business and it has its own suite.
 * @param {Record<string, {found: boolean}|null>} answers
 */
function fakeResolver(answers) {
  return {
    asked: /** @type {string[]} */ ([]),
    resolve: vi.fn(function (uri) {
      this.asked.push(uri)
      return Promise.resolve(uri in answers ? answers[uri] : { found: true })
    }),
  }
}

describe('AddressStatus — what is known about a coordinate', () => {
  it('requires something that can resolve an address', () => {
    expect(() => new AddressStatus(/** @type {any} */ (null))).toThrow(ContractViolation)
    expect(() => new AddressStatus(/** @type {any} */ ({}))).toThrow(ContractViolation)
  })

  it('an unasked address is UNKNOWN — the state a chip renders normally in', () => {
    const status = new AddressStatus(fakeResolver({}))
    expect(status.stateOf('container:9f2b')).toBe(AddressState.UNKNOWN)
  })

  it('found:false is an ANSWER — the address is DANGLING, not merely unresolved', async () => {
    const resolver = fakeResolver({ 'container:gone': { found: false } })
    const status = new AddressStatus(resolver)

    expect(await status.check('container:gone')).toBe(AddressState.DANGLING)
    expect(status.stateOf('container:gone')).toBe(AddressState.DANGLING)
  })

  it('found:true settles LIVE', async () => {
    const status = new AddressStatus(fakeResolver({ 'container:9f2b': { found: true } }))
    expect(await status.check('container:9f2b')).toBe(AddressState.LIVE)
    expect(status.stateOf('container:9f2b')).toBe(AddressState.LIVE)
  })

  it('asks ONCE per address however many times it is checked — the traffic ceiling', async () => {
    const resolver = fakeResolver({ 'container:gone': { found: false } })
    const status = new AddressStatus(resolver)

    await Promise.all([
      status.check('container:gone'),
      status.check('container:gone'),
      status.check('container:gone'),
    ])
    await status.check('container:gone')   // and again long after it settled

    expect(resolver.resolve).toHaveBeenCalledTimes(1)
  })

  it('concurrent checks share the ONE in-flight probe', async () => {
    /** @type {(v: any) => void} */ let release = () => {}
    const resolver = {
      calls: 0,
      resolve: vi.fn(function () {
        this.calls++
        return new Promise((settle) => { release = settle })
      }),
    }
    const status = new AddressStatus(/** @type {any} */ (resolver))

    const a = status.check('container:gone')
    const b = status.check('container:gone')
    expect(resolver.calls).toBe(1)

    release({ found: false })
    expect(await a).toBe(AddressState.DANGLING)
    expect(await b).toBe(AddressState.DANGLING)
  })

  it('distinct addresses are asked about separately', async () => {
    const resolver = fakeResolver({ 'container:gone': { found: false }, 'container:live': { found: true } })
    const status = new AddressStatus(resolver)

    await Promise.all([status.check('container:gone'), status.check('container:live')])

    expect(resolver.asked).toEqual(['container:gone', 'container:live'])
    expect(status.stateOf('container:gone')).toBe(AddressState.DANGLING)
    expect(status.stateOf('container:live')).toBe(AddressState.LIVE)
  })

  it('NO ANSWER is not a verdict: the address stays UNKNOWN and is never re-asked', async () => {
    // null is what MentionService.resolve settles with on a timeout. Greying a
    // document that is merely unreachable would be a lie; re-asking on every
    // redraw would be the chatter this class exists to prevent.
    const resolver = fakeResolver({ 'container:silent': null })
    const status = new AddressStatus(resolver)

    expect(await status.check('container:silent')).toBe(AddressState.UNKNOWN)
    expect(status.stateOf('container:silent')).toBe(AddressState.UNKNOWN)

    await status.check('container:silent')
    expect(resolver.resolve).toHaveBeenCalledTimes(1)
  })

  it('an empty address is UNKNOWN and puts nothing on the wire', async () => {
    const resolver = fakeResolver({})
    const status = new AddressStatus(resolver)

    expect(await status.check('')).toBe(AddressState.UNKNOWN)
    expect(await status.check('   ')).toBe(AddressState.UNKNOWN)
    expect(resolver.resolve).not.toHaveBeenCalled()
  })

  it('an address is trimmed on both faces, so padding cannot split one in two', async () => {
    const resolver = fakeResolver({ 'container:gone': { found: false } })
    const status = new AddressStatus(resolver)

    await status.check('  container:gone  ')
    expect(resolver.asked).toEqual(['container:gone'])
    expect(status.stateOf('container:gone ')).toBe(AddressState.DANGLING)
  })
})
