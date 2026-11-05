// @ts-check
// provider-adapter.test.js — the read half of the wall (issue #96 P3).

import { describe, it, expect, vi } from 'vitest'
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
    expect(seen).toEqual([{ blockIds: ['p1', 'c1'], orderChanged: true, replaced: [] }])

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
      '_startFeed', 'constructor', 'getBlock', 'getKind', 'getOrder', 'getUuid', 'subscribe', 'subscribeFeed',
      'unsubscribe', 'unsubscribeFeed',
    ])
  })
})

/** A kind's adapter whose feed the test drives: `push` delivers through the source while it runs. */
class FedAdapter extends ProviderAdapter {
  /** @type {((event: Record<string, any>) => void)|null} */ deliver = null
  starts = 0
  stops = 0

  /** @param {(event: Record<string, any>) => void} deliver */
  _startFeed(deliver) {
    this.starts++
    this.deliver = deliver
    return () => { this.stops++; this.deliver = null }
  }

  /** @param {Record<string, any>} event */
  push(event) { if (this.deliver) this.deliver(event) }
}

describe('ProviderAdapter — the container feed', () => {
  /** @returns {{heard: any[], listener: {onFeed: (e: any) => void}}} */
  function recorder() {
    /** @type {any[]} */ const heard = []
    return { heard, listener: { onFeed: (e) => heard.push(e) } }
  }

  it('delivers every event to every listener, in order, from subscribe on', () => {
    const provider = new FedAdapter(seeded())
    provider.push({ type: 'before' })
    const a = recorder()
    const b = recorder()
    provider.subscribeFeed(a.listener)
    provider.subscribeFeed(b.listener)
    provider.push({ type: 'one', n: 1 })
    provider.push({ type: 'two', n: 2 })
    expect(a.heard).toEqual([{ type: 'one', n: 1 }, { type: 'two', n: 2 }])
    expect(b.heard).toEqual(a.heard)
  })

  it('hands out a frozen copy, frozen all the way down', () => {
    const provider = new FedAdapter(seeded())
    const { heard, listener } = recorder()
    provider.subscribeFeed(listener)
    const sent = { type: 'nested', inner: { list: [{ x: 1 }] } }
    provider.push(sent)
    expect(heard[0]).not.toBe(sent)
    expect(Object.isFrozen(heard[0])).toBe(true)
    expect(Object.isFrozen(heard[0].inner.list[0])).toBe(true)
    expect(Object.isFrozen(sent)).toBe(false)
  })

  it('a listener that throws does not stop the others hearing the event', () => {
    const provider = new FedAdapter(seeded())
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { heard, listener } = recorder()
    provider.subscribeFeed({ onFeed: () => { throw new Error('boom') } })
    provider.subscribeFeed(listener)
    provider.push({ type: 'one' })
    expect(heard).toEqual([{ type: 'one' }])
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('runs the source from the first listener to the last, and an unsubscribed listener hears nothing', () => {
    const provider = new FedAdapter(seeded())
    const a = recorder()
    const b = recorder()
    provider.subscribeFeed(a.listener)
    provider.subscribeFeed(b.listener)
    expect(provider.starts).toBe(1)
    provider.unsubscribeFeed(a.listener)
    provider.push({ type: 'one' })
    expect(a.heard).toEqual([])
    expect(provider.stops).toBe(0)
    provider.unsubscribeFeed(b.listener)
    expect(provider.stops).toBe(1)
    provider.subscribeFeed(a.listener)
    expect(provider.starts).toBe(2)
  })

  it('a container whose kind has no feed takes listeners and delivers nothing', () => {
    const provider = new ProviderAdapter(seeded())
    const { heard, listener } = recorder()
    provider.subscribeFeed(listener)
    provider.unsubscribeFeed(listener)
    expect(heard).toEqual([])
    expect(() => provider.subscribeFeed(/** @type {any} */ ({}))).toThrow(ContractViolation)
  })
})
