// @ts-check
// block-provider-adapter.test.js — the WRITE half of the wall (issue #96 P4a).
//
// The adapter is held against a STUB DocumentService rather than a socket, because
// what is under test is the wall: facade verb in, the container's own uuid and the
// service's verb out, and nothing written to the model on the way past. The frames
// those calls produce are pinned separately, by the service rig — here the service
// is the boundary.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ContainerModel } from '../src/static/container/container-model.js'
import { BlockProviderAdapter } from '../src/static/container/block-provider-adapter.js'
import { ProviderAdapter } from '../src/static/container/provider-adapter.js'
import { ContractViolation } from '../src/static/contract/sieve-block.js'
import { stubDocumentService as stubDocuments } from './helpers/service-rig.js'

const UUID = 'doc-1'

/** A model holding p1 (prose), c1 (code), p2 (prose) in that order. */
function seeded(uuid = UUID) {
  const model = new ContainerModel(uuid, 'note')
  model.applyLoad({
    uuid: uuid,
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
  /** @type {any} */ let documents
  /** @type {BlockProviderAdapter} */ let provider
  /** @type {any} */ let before

  beforeEach(() => {
    model = seeded()
    documents = stubDocuments()
    provider = new BlockProviderAdapter(model, documents)
    before = snapshot(model)
  })

  it('demands both halves', () => {
    expect(() => new BlockProviderAdapter(seeded(), /** @type {any} */ (null))).toThrow(ContractViolation)
    expect(() => new BlockProviderAdapter(/** @type {any} */ (null), stubDocuments())).toThrow(ContractViolation)
  })

  it('is a ContainerProvider, so a read-only mount and a writing one share one read surface', () => {
    expect(provider).toBeInstanceOf(ProviderAdapter)
    expect(provider.getUuid()).toBe(UUID)
    expect(provider.getOrder()).toEqual(['p1', 'c1', 'p2'])
  })

  // The service is stateless and speaks for every open container, so possession of
  // a provider is authorization for exactly one: the uuid on every verb is the
  // MODEL's, and two providers over one service cannot reach each other's document.
  it('names its own container on every verb, from the model it follows', () => {
    const other = new BlockProviderAdapter(seeded('doc-2'), documents)
    provider.requestRetry('c1')
    other.requestRetry('c1')
    expect(documents.retry.mock.calls).toEqual([[UUID, 'c1'], ['doc-2', 'c1']])
  })

  // ── Verbs ───────────────────────────────────────────────────────────────────

  describe('requestAddBlock', () => {
    // The anchor travels AS AN ID. Go resolves it against the authoritative tree,
    // so the four statements below are translations, never lookups — which is the
    // point: an id this model has not been told about yet still goes out intact.
    it.each([
      ['an id the container holds', 'p1', { afterBlockId: 'p1' }],
      ['an id the container has never seen', 'ghost', { afterBlockId: 'ghost' }],
      ['no anchor at all — Go appends', undefined, {}],
      ['null, the FRONT — a real place, not "wherever"', null, { atFront: true }],
    ])('sends %s', (_name, afterBlockId, want) => {
      provider.requestAddBlock('code', { source: 'y=2' }, afterBlockId)
      expect(documents.createBlock).toHaveBeenCalledWith(UUID, 'code', { source: 'y=2' }, want)
    })

    it('never consults the follower model for a position', () => {
      const order = vi.spyOn(model, 'getOrder')
      provider.requestAddBlock('prose', {}, 'p1')
      expect(order).not.toHaveBeenCalled()
      order.mockRestore()
    })

    it('refuses a kindless add', () => {
      expect(() => provider.requestAddBlock('', {})).toThrow(ContractViolation)
    })
  })

  describe('requestSetBlock', () => {
    it('sends the patch under the kind the model holds', () => {
      provider.requestSetBlock('c1', { source: 'x=2' })
      expect(documents.updateBlock).toHaveBeenCalledWith(UUID, 'c1', 'code', { source: 'x=2' })
    })

    it('drops an unknown id rather than throwing mid-gesture', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(() => provider.requestSetBlock('ghost', { content: 'x' })).not.toThrow()
      expect(documents.updateBlock).not.toHaveBeenCalled()
      warn.mockRestore()
    })
  })

  describe('requestRemoveBlock', () => {
    it('names the block to Go and says nothing else', () => {
      provider.requestRemoveBlock('c1')
      expect(documents.deleteBlock).toHaveBeenCalledWith(UUID, 'c1')
      // Not an order restatement: removal is its own verb, so nothing describes
      // the container's remaining contents on the way out.
      expect(documents.setBlockOrder).not.toHaveBeenCalled()
    })

    it('drops an id this container does not hold rather than throwing mid-gesture', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(() => provider.requestRemoveBlock('ghost')).not.toThrow()
      expect(documents.deleteBlock).not.toHaveBeenCalled()
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
    // Go still requires the full permutation, and the client still computes it —
    // by merging what the lens can name into the order the follower holds. The
    // merge itself is the model's, and its readings are pinned there; what these
    // pin is that the COMPLETE result is what goes out.
    it.each([
      ['a full permutation', ['p1', 'p2', 'c1'], ['p1', 'p2', 'c1']],
      ['a subsequence, into the slots those ids occupy', ['p2', 'p1'], ['p2', 'c1', 'p1']],
    ])('sends the complete order for %s', (_name, want, sent) => {
      provider.requestSetOrder(want)
      expect(documents.setBlockOrder).toHaveBeenCalledWith(UUID, sent)
    })

    it.each([
      ['the order the container already holds', ['p1', 'c1', 'p2']],
      ['a subsequence that merges to no change', ['p1', 'p2']],
      ['an empty statement', []],
    ])('says nothing for %s', (_name, want) => {
      provider.requestSetOrder(want)
      expect(documents.setBlockOrder).not.toHaveBeenCalled()
    })

    it('drops the whole statement when it names a block the container does not hold', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      provider.requestSetOrder(['p1', 'c1', 'ghost'])
      expect(documents.setBlockOrder).not.toHaveBeenCalled()
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
      expect(documents.retry).toHaveBeenCalledWith(UUID, 'c1')
    })

    it('drops an id this container does not hold', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      provider.requestRetry('ghost')
      expect(documents.retry).not.toHaveBeenCalled()
      warn.mockRestore()
    })
  })

  describe('requestReplaceText', () => {
    const anchor = { locator: 'content', quote: 'teh', occurrence: 1, grain: 'word', start: 12, end: 15, class: 'prose', suggestions: ['the'] }

    // The MARK travels, not a payload: turning one into the frame's fields is the
    // service's single mapping, and its guards are pinned in mount-binding.test.js,
    // where a real wire is on the other end.
    it('hands over the mark as it stands, with the block it belongs to on it', () => {
      provider.requestReplaceText('p1', anchor, 'the')
      expect(documents.replaceText).toHaveBeenCalledWith(UUID, Object.assign({}, anchor, { blockId: 'p1' }), 'the')
    })

    it('writes NOTHING to the model — the correction arrives as Go\'s own echo', () => {
      provider.requestReplaceText('p1', anchor, 'the')
      expect(snapshot(model)).toEqual(before)
    })

    it('drops an id this container does not hold', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      provider.requestReplaceText('ghost', anchor, 'the')
      expect(documents.replaceText).not.toHaveBeenCalled()
      warn.mockRestore()
    })

    it('is SILENT on a stale anchor, and warns only on a failure', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const stale = seeded()
      const staleDocuments = stubDocuments({ replaceText: vi.fn(() => Promise.resolve('stale')) })
      new BlockProviderAdapter(stale, /** @type {any} */ (staleDocuments)).requestReplaceText('p1', anchor, 'the')
      await Promise.resolve()
      expect(warn).not.toHaveBeenCalled()

      const failed = stubDocuments({ replaceText: vi.fn(() => Promise.resolve('error')) })
      new BlockProviderAdapter(seeded(), /** @type {any} */ (failed)).requestReplaceText('p1', anchor, 'the')
      await Promise.resolve()
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })
  })

  describe('requestPersist', () => {
    it('asks the container to reach disk, naming no block', () => {
      provider.requestPersist()
      expect(documents.persist).toHaveBeenCalledWith(UUID)
      // Persist is not a flush: nothing about any block's text goes out with it.
      expect(documents.updateBlock).not.toHaveBeenCalled()
    })
  })

  describe('whole-content (a document carries BOTH extensions)', () => {
    it('reads the container\'s authoritative text', async () => {
      expect(await provider.getContents()).toBe('# doc')
      expect(documents.getContents).toHaveBeenCalledWith(UUID)
    })

    it('hands the whole container back and answers when Go has taken it', async () => {
      await provider.setContents('# edited')
      expect(documents.setContents).toHaveBeenCalledWith(UUID, '# edited')
    })

    it('flushes an in-flight buffer WITHOUT asking for a re-parse', () => {
      provider.flushContents('# half typed')
      expect(documents.flushContents).toHaveBeenCalledWith(UUID, '# half typed')
      expect(documents.setContents).not.toHaveBeenCalled()
    })
  })

  describe('requestTransform', () => {
    it('names the source and no position — where an additive result lands is Go\'s', () => {
      const entries = [{ mimeType: 'text/plain', content: '```go\nx := 1\n```' }]
      provider.requestTransform('c1', 'diagram', 'transform', entries)
      expect(documents.extract).toHaveBeenCalledWith(UUID, 'c1', 'diagram', 'transform', entries)
    })

    it('drops an unknown source', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      provider.requestTransform('ghost', 'code', 'extract', [])
      expect(documents.extract).not.toHaveBeenCalled()
      warn.mockRestore()
    })
  })

  describe('flush', () => {
    it('sends prose text under `content`', () => {
      provider.flush('p1', 'edited')
      expect(documents.updateBlock).toHaveBeenCalledWith(UUID, 'p1', 'prose', { content: 'edited' })
    })

    it('sends a source-bearing kind\'s text under `source`', () => {
      provider.flush('c1', 'x = 3')
      expect(documents.updateBlock).toHaveBeenCalledWith(UUID, 'c1', 'code', { source: 'x = 3' })
    })

    it('drops an unknown id', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      provider.flush('ghost', 'text')
      expect(documents.updateBlock).not.toHaveBeenCalled()
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
    const declining = new BlockProviderAdapter(seeded(), stubDocuments({
      createBlock: () => Promise.resolve({ ok: false, error: 'no' }),
      setBlockOrder: () => Promise.reject(new Error('socket gone')),
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
    expect(documents.createBlock).toHaveBeenCalledWith(UUID, 'prose', { content: 'typed', id: born }, { afterBlockId: 'p1' })
  })

  // ── Queries ────────────────────────────────────────────────────────────────

  describe('paste', () => {
    it('carries the anchor id, leaving the position to Go', async () => {
      await provider.paste({ kind: 'smart', entries: [{ mimeType: 'text/plain', content: 'hi' }] }, 'c1')
      expect(documents.paste).toHaveBeenCalledWith(UUID, {
        kind: 'smart', entries: [{ mimeType: 'text/plain', content: 'hi' }], slice: [], anchor: { afterBlockId: 'c1' },
      })
    })

    it('is ONE query — the four gestures differ only in the payload\'s kind', async () => {
      await provider.paste({ kind: 'slice', slice: [[{ mimeType: 'sieve/prose', content: 'a' }]] }, null)
      await provider.paste({ kind: 'native-drop', entries: [{ mimeType: 'text/uri-list', content: 'file:///x' }] }, null)
      await provider.paste({ kind: 'native-clipboard' }, null)
      expect(documents.paste.mock.calls.map((c) => c[1].kind))
        .toEqual(['slice', 'native-drop', 'native-clipboard'])
      // The kind Sieve cannot read carries nothing, and the emptiness IS the payload.
      expect(documents.paste.mock.calls[2][1].entries).toEqual([])
    })

    it.each([
      ['a created block', { outcome: 'block', kind: 'code', id: 'b9', rawYaml: 'kind: code\n' }, { outcome: 'block' }],
      ['a composed fragment', { outcome: 'content', html: '<a href="x">T</a>' }, { outcome: 'content', content: '<a href="x">T</a>' }],
      ['nothing Sieve wants', { outcome: 'none' }, { outcome: 'none' }],
      ['a declined paste', { outcome: 'none', error: 'boom' }, { outcome: 'none' }],
      ['an answer in no vocabulary at all', { outcome: 'wat' }, { outcome: 'none' }],
      ['an empty answer', {}, { outcome: 'none' }],
    ])('maps %s', async (_name, wire, want) => {
      const p = new BlockProviderAdapter(seeded(), stubDocuments({ paste: () => Promise.resolve(wire) }))
      expect(await p.paste({ entries: [] }, null)).toEqual(want)
    })

    it('degrades a timeout to none, so the caller still replays the clipboard', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const p = new BlockProviderAdapter(seeded(), stubDocuments({
        paste: () => Promise.reject(new Error('ws timeout: paste smart')),
      }))
      expect(await p.paste({ entries: [] }, null)).toEqual({ outcome: 'none' })
      warn.mockRestore()
    })

    it('strips the transport identifiers a lens has no use for', async () => {
      const p = new BlockProviderAdapter(seeded(), stubDocuments({
        paste: () => Promise.resolve({ outcome: 'block', kind: 'web-clip', id: 'b1', rawYaml: 'x' }),
      }))
      expect(Object.keys(await p.paste({ entries: [] }, null))).toEqual(['outcome'])
    })
  })

  describe('detectExtractions', () => {
    it('asks in the offer vocabulary and answers the offers verbatim', async () => {
      const offers = [{ kind: 'code', actions: ['extract', 'transform'] }]
      const p = new BlockProviderAdapter(seeded(), stubDocuments({ detectExtractions: () => Promise.resolve(offers) }))
      expect(await p.detectExtractions('prose', [{ mimeType: 'text/plain', content: 'x' }])).toEqual(offers)
    })

    it('degrades a failure to an empty offer list', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const p = new BlockProviderAdapter(seeded(), stubDocuments({
        detectExtractions: () => Promise.reject(new Error('ws timeout')),
      }))
      expect(await p.detectExtractions('prose', [])).toEqual([])
      warn.mockRestore()
    })
  })
})
