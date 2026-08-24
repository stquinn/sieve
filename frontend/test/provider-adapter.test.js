// @ts-check
// provider-adapter.test.js — the read half of the wall (issue #96 P3).

import { describe, it, expect } from 'vitest'
import { ContainerModel } from '../src/static/container/container-model.js'
import { ProviderAdapter } from '../src/static/container/provider-adapter.js'
import { ContractViolation } from '../src/static/contract/sieve-block.js'

/** @returns {ContainerModel} */
function seeded() {
  const model = new ContainerModel('doc-1', 'note')
  model.applyLoad({
    uuid: 'doc-1',
    blocks: [
      { id: 'p1', kind: 'prose', attrs: { content: 'hello' } },
      { id: 'c1', kind: 'code', attrs: { source: 'x=1' } },
    ],
  })
  return model
}

describe('ProviderAdapter', () => {
  it('demands a model', () => {
    expect(() => new ProviderAdapter(/** @type {any} */ (null))).toThrow(ContractViolation)
    expect(() => new ProviderAdapter(/** @type {any} */ ({}))).toThrow(ContractViolation)
  })

  it('answers the base read contract from the model', () => {
    const provider = new ProviderAdapter(seeded())
    expect(provider.getUuid()).toBe('doc-1')
    expect(provider.getKind()).toBe('note')
    expect(provider.getOrder()).toEqual(['p1', 'c1'])
    expect(provider.getBlock('c1')).toEqual({ id: 'c1', kind: 'code', attrs: { source: 'x=1', id: 'c1' } })
    expect(provider.getBlock('nope')).toBeNull()
  })

  it('hands out frozen copies, so a holder cannot write back through a read', () => {
    const provider = new ProviderAdapter(seeded())
    const first = provider.getBlock('p1')
    expect(Object.isFrozen(first)).toBe(true)
    expect(provider.getBlock('p1')).not.toBe(first)
    expect(Object.isFrozen(provider.getOrder())).toBe(true)
  })

  it('relays subscribe and unsubscribe, cue included', () => {
    const model = seeded()
    const provider = new ProviderAdapter(model)
    /** @type {any[]} */
    const seen = []
    const listener = { onChanged: (/** @type {any} */ change) => seen.push(change) }

    provider.subscribe(listener)
    expect(seen).toEqual([{ blockIds: ['p1', 'c1'], orderChanged: true }])

    model.applyFrame({ type: 'block-attrs-updated', id: 'p1', attrs: { content: 'bye' } })
    expect(seen).toHaveLength(2)

    provider.unsubscribe(listener)
    model.applyFrame({ type: 'block-attrs-updated', id: 'p1', attrs: { content: 'again' } })
    expect(seen).toHaveLength(2)
  })

  it('keeps the model out of the object graph a lens holds', () => {
    const provider = new ProviderAdapter(seeded())
    // The read surface is the whole surface: no field, no accessor and no
    // prototype member exposes the model a lens could fold or mutate directly.
    expect(Object.keys(provider)).toEqual([])
    expect([...Object.getOwnPropertyNames(Object.getPrototypeOf(provider))].sort()).toEqual([
      'constructor', 'getBlock', 'getKind', 'getOrder', 'getUuid', 'subscribe', 'unsubscribe',
    ])
  })
})
