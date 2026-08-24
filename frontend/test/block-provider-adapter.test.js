// @ts-check
// block-provider-adapter.test.js — the WRITE half of the wall (issue #96 P4a).
//
// The adapter is held against a STUB binding rather than a socket, because what
// is under test is the translation: facade verb in, existing wire call out, and
// nothing written to the model on the way past. The frames those binding calls
// produce are pinned separately, by the service rig — here the binding is the
// boundary.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ContainerModel } from '../src/static/container/container-model.js'
import { BlockProviderAdapter } from '../src/static/container/block-provider-adapter.js'
import { ProviderAdapter } from '../src/static/container/provider-adapter.js'
import { ContractViolation } from '../src/static/contract/sieve-block.js'

/** A recording ContainerBinding: every wire call is a spy, every ack resolves ok. */
function stubBinding(overrides = {}) {
  return Object.assign({
    getUuid: () => 'doc-1',
    createBlock: vi.fn(() => Promise.resolve({ ok: true })),
    updateBlock: vi.fn(() => Promise.resolve({ ok: true })),
    deleteBlock: vi.fn(() => Promise.resolve({ ok: true })),
    setOrder: vi.fn(() => Promise.resolve({ ok: true })),
    extract: vi.fn(() => Promise.resolve({ ok: true })),
    retry: vi.fn(),
    persist: vi.fn(),
    paste: vi.fn(() => Promise.resolve({ outcome: 'none' })),
    detectExtractions: vi.fn(() => Promise.resolve([])),
    getContents: vi.fn(() => Promise.resolve('# doc')),
    setContents: vi.fn(() => Promise.resolve()),
    flushContents: vi.fn(),
    exportAs: vi.fn(() => Promise.resolve('# doc')),
  }, overrides)
}

/** A model holding p1 (prose), c1 (code), p2 (prose) in that order. */
function seeded() {
  const model = new ContainerModel('doc-1', 'note')
  model.applyLoad({
    uuid: 'doc-1',
    blocks: [
      { id: 'p1', kind: 'prose', attrs: { content: 'one' } },
      { id: 'c1', kind: 'code', attrs: { source: 'x=1' } },
      { id: 'p2', kind: 'prose', attrs: { content: 'two' } },
    ],
  })
  return model
}

/** The model's whole observable state, for a "nothing changed" assertion. */
function snapshot(model) {
  return { order: model.getOrder(), blocks: model.getOrder().map((id) => model.getBlock(id)) }
}

describe('BlockProviderAdapter', () => {
  /** @type {ContainerModel} */ let model
  /** @type {any} */ let binding
  /** @type {BlockProviderAdapter} */ let provider
  /** @type {any} */ let before

  beforeEach(() => {
    model = seeded()
    binding = stubBinding()
    provider = new BlockProviderAdapter(model, binding)
    before = snapshot(model)
  })

  it('demands both halves', () => {
    expect(() => new BlockProviderAdapter(seeded(), /** @type {any} */ (null))).toThrow(ContractViolation)
    expect(() => new BlockProviderAdapter(/** @type {any} */ (null), stubBinding())).toThrow(ContractViolation)
  })

  it('is a ContainerProvider, so a read-only mount and a writing one share one read surface', () => {
    expect(provider).toBeInstanceOf(ProviderAdapter)
    expect(provider.getUuid()).toBe('doc-1')
    expect(provider.getOrder()).toEqual(['p1', 'c1', 'p2'])
  })

  // ── Verbs ───────────────────────────────────────────────────────────────────

  describe('requestAddBlock', () => {
    it('resolves the anchor to the slot AFTER it', () => {
      provider.requestAddBlock('code', { source: 'y=2' }, 'p1')
      expect(binding.createBlock).toHaveBeenCalledWith('code', { source: 'y=2' }, 1)
    })

    it('appends when no anchor is named, and for one the container does not hold', () => {
      provider.requestAddBlock('prose', {}, 'ghost')
      provider.requestAddBlock('prose', {})
      for (const call of binding.createBlock.mock.calls) expect(call[2]).toBe(-1)
    })

    it('puts a null anchor at the FRONT — a real place, not "wherever"', () => {
      provider.requestAddBlock('prose', {}, null)
      expect(binding.createBlock).toHaveBeenCalledWith('prose', {}, 0)
    })

    it('refuses a kindless add', () => {
      expect(() => provider.requestAddBlock('', {})).toThrow(ContractViolation)
    })
  })

  describe('requestSetBlock', () => {
    it('sends the patch under the kind the model holds', () => {
      provider.requestSetBlock('c1', { source: 'x=2' })
      expect(binding.updateBlock).toHaveBeenCalledWith('c1', 'code', { source: 'x=2' })
    })

    it('drops an unknown id rather than throwing mid-gesture', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(() => provider.requestSetBlock('ghost', { content: 'x' })).not.toThrow()
      expect(binding.updateBlock).not.toHaveBeenCalled()
      warn.mockRestore()
    })
  })

  describe('requestRemoveBlock', () => {
    it('names the block to Go and says nothing else', () => {
      provider.requestRemoveBlock('c1')
      expect(binding.deleteBlock).toHaveBeenCalledWith('c1')
      // Not an order restatement: removal is its own verb, so nothing describes
      // the container's remaining contents on the way out.
      expect(binding.setOrder).not.toHaveBeenCalled()
    })

    it('drops an id this container does not hold rather than throwing mid-gesture', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(() => provider.requestRemoveBlock('ghost')).not.toThrow()
      expect(binding.deleteBlock).not.toHaveBeenCalled()
      warn.mockRestore()
    })

    it('leaves the block in the model — it goes when Go echoes remove-block', () => {
      provider.requestRemoveBlock('c1')
      expect(model.getOrder()).toEqual(['p1', 'c1', 'p2'])
      model.applyFrame({ type: 'remove-block', id: 'c1' })
      expect(model.getOrder()).toEqual(['p1', 'p2'])
    })
  })

  describe('requestSetOrder', () => {
    it('states the container\'s COMPLETE new order', () => {
      provider.requestSetOrder(['p1', 'p2', 'c1'])
      expect(binding.setOrder).toHaveBeenCalledWith(['p1', 'p2', 'c1'])
    })

    it('says nothing when the container is already in that order', () => {
      provider.requestSetOrder(['p1', 'c1', 'p2'])
      expect(binding.setOrder).not.toHaveBeenCalled()
    })

    it('refuses anything that is not a permutation of what the container holds', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      provider.requestSetOrder(['p1', 'c1'])           // one short — reads as a mass delete
      provider.requestSetOrder(['p1', 'c1', 'ghost'])  // names a block nobody has
      provider.requestSetOrder([])
      expect(binding.setOrder).not.toHaveBeenCalled()
      warn.mockRestore()
    })

    it('leaves the model alone — the order changes when Go echoes order-changed', () => {
      provider.requestSetOrder(['p2', 'p1', 'c1'])
      expect(model.getOrder()).toEqual(['p1', 'c1', 'p2'])
      model.applyFrame({ type: 'order-changed', order: ['p2', 'p1', 'c1'] })
      expect(model.getOrder()).toEqual(['p2', 'p1', 'c1'])
    })
  })

  describe('requestRetry', () => {
    it('names the block and says nothing about what retry means', () => {
      provider.requestRetry('c1')
      expect(binding.retry).toHaveBeenCalledWith('c1')
    })

    it('drops an id this container does not hold', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      provider.requestRetry('ghost')
      expect(binding.retry).not.toHaveBeenCalled()
      warn.mockRestore()
    })
  })

  describe('requestPersist', () => {
    it('asks the container to reach disk, naming no block', () => {
      provider.requestPersist()
      expect(binding.persist).toHaveBeenCalledWith()
      // Persist is not a flush: nothing about any block's text goes out with it.
      expect(binding.updateBlock).not.toHaveBeenCalled()
    })
  })

  describe('whole-content (a document carries BOTH extensions)', () => {
    it('reads the container\'s authoritative text', async () => {
      expect(await provider.getContents()).toBe('# doc')
    })

    it('hands the whole container back and answers when Go has taken it', async () => {
      await provider.setContents('# edited')
      expect(binding.setContents).toHaveBeenCalledWith('# edited')
    })

    it('flushes an in-flight buffer WITHOUT asking for a re-parse', () => {
      provider.flushContents('# half typed')
      expect(binding.flushContents).toHaveBeenCalledWith('# half typed')
      expect(binding.setContents).not.toHaveBeenCalled()
    })
  })

  describe('requestTransform', () => {
    it('plays the offer back at the slot after the source', () => {
      const entries = [{ mimeType: 'text/plain', content: '```go\nx := 1\n```' }]
      provider.requestTransform('c1', 'diagram', 'transform', entries)
      expect(binding.extract).toHaveBeenCalledWith({
        blockId: 'c1', targetKind: 'diagram', operation: 'transform', entries: entries, index: 2,
      })
    })

    it('drops an unknown source', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      provider.requestTransform('ghost', 'code', 'extract', [])
      expect(binding.extract).not.toHaveBeenCalled()
      warn.mockRestore()
    })
  })

  describe('flush', () => {
    it('sends prose text under `content`', () => {
      provider.flush('p1', 'edited')
      expect(binding.updateBlock).toHaveBeenCalledWith('p1', 'prose', { content: 'edited' })
    })

    it('sends a source-bearing kind\'s text under `source`', () => {
      provider.flush('c1', 'x = 3')
      expect(binding.updateBlock).toHaveBeenCalledWith('c1', 'code', { source: 'x = 3' })
    })

    it('drops an unknown id', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      provider.flush('ghost', 'text')
      expect(binding.updateBlock).not.toHaveBeenCalled()
      warn.mockRestore()
    })
  })

  // ── The property that makes the whole thing a follower ─────────────────────

  it('NEVER writes to the model — every effect arrives as Go\'s echo', async () => {
    provider.requestAddBlock('code', { source: 'y' }, 'p1')
    provider.requestSetBlock('p1', { content: 'changed' })
    provider.requestRemoveBlock('c1')
    provider.requestSetOrder(['p2', 'p1', 'c1'])
    provider.requestTransform('c1', 'diagram', 'transform', [])
    provider.requestRetry('c1')
    provider.requestPersist()
    provider.flush('p1', 'typed')
    provider.flushContents('# raw')
    await provider.setContents('# raw')
    await provider.paste({ kind: 'smart', entries: [] }, 'p1')
    await provider.detectExtractions('code', [])

    expect(snapshot(model)).toEqual(before)
  })

  it('answers no correlation to its caller — the verbs are void', () => {
    expect(provider.requestAddBlock('code', {}, null)).toBeUndefined()
    expect(provider.requestSetBlock('p1', {})).toBeUndefined()
    expect(provider.requestRemoveBlock('c1')).toBeUndefined()
    expect(provider.requestSetOrder(['p2', 'p1', 'c1'])).toBeUndefined()
    expect(provider.requestTransform('c1', 'code', 'extract', [])).toBeUndefined()
    expect(provider.requestRetry('c1')).toBeUndefined()
    expect(provider.requestPersist()).toBeUndefined()
    expect(provider.flush('p1', 'x')).toBeUndefined()
    expect(provider.flushContents('x')).toBeUndefined()
  })

  it('swallows a declined verb rather than rejecting into the gesture', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const declining = new BlockProviderAdapter(seeded(), stubBinding({
      createBlock: () => Promise.resolve({ ok: false, error: 'no' }),
      setOrder: () => Promise.reject(new Error('socket gone')),
    }))
    expect(() => declining.requestAddBlock('code', {}, null)).not.toThrow()
    expect(() => declining.requestSetOrder(['p2', 'p1', 'c1'])).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    warn.mockRestore()
  })

  it('carries a newborn\'s OWN NAME out with the rest of its state', () => {
    // A block born in a lens names itself (issue #96): a UUIDv7 is unique without
    // coordination, so `attrs.id` is the durable id from the keystroke that made
    // the block, and Go validates and adopts it rather than minting a second one.
    // The adapter neither reads it nor knows it is there — it is block data like
    // any other attr, which is exactly why nothing here has to correlate.
    const born = '0191f0c2-2b4e-7a10-9c33-4d5e6f708192'
    provider.requestAddBlock('prose', { content: 'typed', id: born }, 'p1')
    expect(binding.createBlock).toHaveBeenCalledWith('prose', { content: 'typed', id: born }, 1)
  })

  // ── Queries ────────────────────────────────────────────────────────────────

  describe('paste', () => {
    it('anchors the paste at the slot after the anchor', async () => {
      await provider.paste({ kind: 'smart', entries: [{ mimeType: 'text/plain', content: 'hi' }] }, 'c1')
      expect(binding.paste).toHaveBeenCalledWith({
        kind: 'smart', entries: [{ mimeType: 'text/plain', content: 'hi' }], slice: [], index: 2,
      })
    })

    it('is ONE query — the four gestures differ only in the payload\'s kind', async () => {
      await provider.paste({ kind: 'slice', slice: [[{ mimeType: 'sieve/prose', content: 'a' }]] }, null)
      await provider.paste({ kind: 'native-drop', entries: [{ mimeType: 'text/uri-list', content: 'file:///x' }] }, null)
      await provider.paste({ kind: 'native-clipboard' }, null)
      expect(binding.paste.mock.calls.map((c) => c[0].kind))
        .toEqual(['slice', 'native-drop', 'native-clipboard'])
      // The kind Sieve cannot read carries nothing, and the emptiness IS the payload.
      expect(binding.paste.mock.calls[2][0].entries).toEqual([])
    })

    it.each([
      ['a created block', { outcome: 'block', kind: 'code', id: 'b9', rawYaml: 'kind: code\n' }, { outcome: 'block' }],
      ['a composed fragment', { outcome: 'content', html: '<a href="x">T</a>' }, { outcome: 'content', content: '<a href="x">T</a>' }],
      ['nothing Sieve wants', { outcome: 'none' }, { outcome: 'none' }],
      ['a declined paste', { outcome: 'none', error: 'boom' }, { outcome: 'none' }],
      ['an answer in no vocabulary at all', { outcome: 'wat' }, { outcome: 'none' }],
      ['an empty answer', {}, { outcome: 'none' }],
    ])('maps %s', async (_name, wire, want) => {
      const p = new BlockProviderAdapter(seeded(), stubBinding({ paste: () => Promise.resolve(wire) }))
      expect(await p.paste({ entries: [] }, null)).toEqual(want)
    })

    it('degrades a timeout to none, so the caller still replays the clipboard', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const p = new BlockProviderAdapter(seeded(), stubBinding({
        paste: () => Promise.reject(new Error('ws timeout: paste smart')),
      }))
      expect(await p.paste({ entries: [] }, null)).toEqual({ outcome: 'none' })
      warn.mockRestore()
    })

    it('strips the transport identifiers a lens has no use for', async () => {
      const p = new BlockProviderAdapter(seeded(), stubBinding({
        paste: () => Promise.resolve({ outcome: 'block', kind: 'web-clip', id: 'b1', rawYaml: 'x' }),
      }))
      expect(Object.keys(await p.paste({ entries: [] }, null))).toEqual(['outcome'])
    })
  })

  describe('detectExtractions', () => {
    it('asks in the offer vocabulary and answers the offers verbatim', async () => {
      const offers = [{ kind: 'code', actions: ['extract', 'transform'] }]
      const p = new BlockProviderAdapter(seeded(), stubBinding({ detectExtractions: () => Promise.resolve(offers) }))
      expect(await p.detectExtractions('prose', [{ mimeType: 'text/plain', content: 'x' }])).toEqual(offers)
    })

    it('degrades a failure to an empty offer list', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const p = new BlockProviderAdapter(seeded(), stubBinding({
        detectExtractions: () => Promise.reject(new Error('ws timeout')),
      }))
      expect(await p.detectExtractions('prose', [])).toEqual([])
      warn.mockRestore()
    })
  })
})
