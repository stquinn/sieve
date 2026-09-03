// @ts-check
// in-memory-container-provider.test.js — the DRAFT container (#118), held against
// the same expectations the wire-backed provider already meets.
//
// This is an EQUIVALENCE suite. Every behaviour a lens can observe through the
// wall is asserted twice: once against the real BlockProviderAdapter driven by
// the echoes Go would send, and once against the in-memory provider, which is
// its own authority. What the two arrangements share is the lens-visible half —
// bootstrap-on-subscribe, frozen reads, the anchor vocabulary, adopted
// lens-minted ids, the shape of the cue each verb produces. What they do NOT
// share is deliberate and asserted here too: the in-memory provider offers no
// paste, no extraction, no transform and no whole-content half, because
// omission is how a capability is declined.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ContainerModel } from '../src/static/container/container-model.js'
import { BlockProviderAdapter } from '../src/static/container/block-provider-adapter.js'
import { InMemoryContainerProvider } from '../src/static/container/in-memory-container-provider.js'
import { ContractViolation } from '../src/static/contract/sieve-block.js'
import { Ident } from '../src/static/ident/ident.js'
import { stubDocumentService } from './helpers/service-rig.js'

const SEED = Object.freeze([
  { id: 'p1', kind: 'prose', attrs: { content: 'one' } },
  { id: 'c1', kind: 'code', attrs: { source: 'x=1' } },
  { id: 'p2', kind: 'prose', attrs: { content: 'two' } },
])

/** A cue recorder — the whole of what a lens hears. */
function recorder() {
  /** @type {any[]} */ const cues = []
  return { cues, onChanged: (change) => cues.push(change) }
}

/**
 * The WIRE arrangement: the real provider over a follower model, plus the `echo`
 * a test plays to stand in for Go having accepted the verb. Nothing here is
 * optimistic — that is the point of the comparison.
 */
function wireArrangement() {
  const model = new ContainerModel('doc-1', 'note')
  model.applyLoad({ uuid: 'doc-1', blocks: SEED.map((b) => Object.assign({}, b)) })
  const documents = stubDocumentService()
  return { provider: new BlockProviderAdapter(model, documents), documents, echo: (f) => model.applyFrame(f) }
}

/** The DRAFT arrangement: the same seed, and no wire at all. */
function draftArrangement() {
  return {
    provider: new InMemoryContainerProvider({ uuid: 'doc-1', blocks: SEED.map((b) => Object.assign({}, b)) }),
    documents: null,
    echo: () => {},
  }
}

const ARRANGEMENTS = [
  { name: 'wire-backed', make: wireArrangement },
  { name: 'in-memory', make: draftArrangement },
]

// ── The half both providers answer identically ───────────────────────────────

describe.each(ARRANGEMENTS)('$name provider — the read minimum', ({ make }) => {
  /** @type {any} */ let provider

  beforeEach(() => { provider = make().provider })

  it('names its container', () => {
    expect(provider.getUuid()).toBe('doc-1')
    expect(typeof provider.getKind()).toBe('string')
  })

  it('states the child order', () => {
    expect(provider.getOrder()).toEqual(['p1', 'c1', 'p2'])
  })

  it('hands out FROZEN copies, never a live reference', () => {
    const block = provider.getBlock('c1')
    expect(Object.isFrozen(block)).toBe(true)
    expect(Object.isFrozen(block.attrs)).toBe(true)
    expect(provider.getBlock('c1')).not.toBe(block)
  })

  it('stamps a block\'s own id into its attrs bag', () => {
    expect(provider.getBlock('p1').attrs.id).toBe('p1')
  })

  it('answers null for a block it does not hold', () => {
    expect(provider.getBlock('ghost')).toBeNull()
  })

  it('cues a new subscriber with the whole container — bootstrap IS the first onChanged', () => {
    const lens = recorder()
    provider.subscribe(lens)
    expect(lens.cues).toEqual([{ blockIds: ['p1', 'c1', 'p2'], orderChanged: true, replaced: [] }])
  })

  it('stops cueing an unsubscribed listener', () => {
    const lens = recorder()
    provider.subscribe(lens)
    provider.unsubscribe(lens)
    lens.cues.length = 0
    provider.requestAddBlock('prose', { content: 'later' })
    expect(lens.cues).toEqual([])
  })
})

describe.each(ARRANGEMENTS)('$name provider — the verbs a lens may call', ({ make }) => {
  /** @type {any} */ let provider
  /** @type {ReturnType<typeof recorder>} */ let lens

  beforeEach(() => {
    provider = make().provider
    lens = recorder()
    provider.subscribe(lens)
    lens.cues.length = 0
  })

  it('answers no correlation — every verb is void', () => {
    expect(provider.requestAddBlock('prose', {}, null)).toBeUndefined()
    expect(provider.requestSetBlock('p1', {})).toBeUndefined()
    expect(provider.requestRemoveBlock('c1')).toBeUndefined()
    expect(provider.requestSetOrder(['p2', 'p1', 'c1'])).toBeUndefined()
    expect(provider.requestRetry('c1')).toBeUndefined()
    expect(provider.requestPersist()).toBeUndefined()
    expect(provider.flush('p1', 'x')).toBeUndefined()
  })

  it('refuses a kindless add', () => {
    expect(() => provider.requestAddBlock('', {})).toThrow(ContractViolation)
  })

  it('drops a verb naming a block it does not hold rather than throwing mid-gesture', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => provider.requestSetBlock('ghost', { content: 'x' })).not.toThrow()
    expect(() => provider.requestRemoveBlock('ghost')).not.toThrow()
    expect(() => provider.flush('ghost', 'x')).not.toThrow()
    expect(lens.cues).toEqual([])
    warn.mockRestore()
  })

})

// ── Where the two arrangements differ: WHO leads ─────────────────────────────

describe('the wire-backed provider follows — an intent reaches the lens as Go\'s echo', () => {
  it('writes nothing locally; the cue is the echo', () => {
    const { provider, echo } = wireArrangement()
    const lens = recorder()
    provider.subscribe(lens)
    lens.cues.length = 0

    provider.requestAddBlock('prose', { content: 'typed', id: 'p3' }, 'p1')
    expect(provider.getOrder()).toEqual(['p1', 'c1', 'p2'])
    expect(lens.cues).toEqual([])

    echo({ type: 'insert-block', id: 'p3', kind: 'prose', attrs: { content: 'typed' }, index: 1 })
    expect(provider.getOrder()).toEqual(['p1', 'p3', 'c1', 'p2'])
    expect(lens.cues).toEqual([{ blockIds: ['p3'], orderChanged: true, replaced: [] }])
  })
})

describe('the in-memory provider IS the authority — a draft has nothing behind it', () => {
  /** @type {InMemoryContainerProvider} */ let provider
  /** @type {ReturnType<typeof recorder>} */ let lens

  beforeEach(() => {
    provider = draftArrangement().provider
    lens = recorder()
    provider.subscribe(lens)
    lens.cues.length = 0
  })

  it('applies an add and echoes the SAME cue the wire path produces', () => {
    provider.requestAddBlock('prose', { content: 'typed', id: 'p3' }, 'p1')
    expect(provider.getOrder()).toEqual(['p1', 'p3', 'c1', 'p2'])
    expect(lens.cues).toEqual([{ blockIds: ['p3'], orderChanged: true, replaced: [] }])
    expect(provider.getBlock('p3')).toEqual({ id: 'p3', kind: 'prose', attrs: { content: 'typed', id: 'p3' } })
  })

  it('ADOPTS the id the lens minted — a block born in a lens keeps its name', () => {
    const born = Ident.mint()
    provider.requestAddBlock('prose', { content: 'typed', id: born })
    expect(provider.getOrder()[3]).toBe(born)
    expect(provider.getBlock(born).attrs.id).toBe(born)
  })

  it('mints a UUIDv7 for a block that arrives without one', () => {
    provider.requestAddBlock('prose', { content: 'unnamed' })
    const id = provider.getOrder()[3]
    expect(Ident.valid(id)).toBe(true)
  })

  it('appends for an omitted anchor and for one the container does not hold', () => {
    provider.requestAddBlock('prose', { id: 'a' })
    provider.requestAddBlock('prose', { id: 'b' }, 'ghost')
    expect(provider.getOrder()).toEqual(['p1', 'c1', 'p2', 'a', 'b'])
  })

  it('puts a null anchor at the FRONT — a place, not an absence', () => {
    provider.requestAddBlock('prose', { id: 'a' }, null)
    expect(provider.getOrder()).toEqual(['a', 'p1', 'c1', 'p2'])
  })

  it('MERGES a set-block patch — a delta never erases the keys it omits', () => {
    provider.requestSetBlock('c1', { source: 'x=2' })
    expect(provider.getBlock('c1').attrs).toEqual({ id: 'c1', source: 'x=2' })
    expect(lens.cues).toEqual([{ blockIds: ['c1'], orderChanged: false, replaced: [] }])
  })

  it('removes a block and says the order changed', () => {
    provider.requestRemoveBlock('c1')
    expect(provider.getOrder()).toEqual(['p1', 'p2'])
    expect(lens.cues).toEqual([{ blockIds: ['c1'], orderChanged: true, replaced: [] }])
  })

  it('installs a complete new order', () => {
    provider.requestSetOrder(['p2', 'p1', 'c1'])
    expect(provider.getOrder()).toEqual(['p2', 'p1', 'c1'])
    expect(lens.cues).toEqual([{ blockIds: [], orderChanged: true, replaced: [] }])
  })

  it('records a flushed buffer under the attr the kind keeps its text in', () => {
    provider.flush('p1', 'edited')
    provider.flush('c1', 'x = 3')
    expect(provider.getBlock('p1').attrs.content).toBe('edited')
    expect(provider.getBlock('c1').attrs.source).toBe('x = 3')
  })

  it('persists nowhere and retries nothing, quietly', () => {
    provider.requestPersist()
    provider.requestRetry('c1')
    expect(lens.cues).toEqual([])
  })

  it('names itself when it is given no name — a draft is a real container', () => {
    const bare = new InMemoryContainerProvider()
    expect(Ident.valid(bare.getUuid())).toBe(true)
    expect(bare.getOrder()).toEqual([])
  })

  it('calls itself a draft, so an affordance reading the container kind can tell', () => {
    expect(provider.getKind()).toBe('draft')
  })
})

// ── Capability is SHAPE ──────────────────────────────────────────────────────

describe('what the in-memory provider deliberately does NOT offer', () => {
  it.each(['paste', 'detectExtractions', 'requestTransform', 'getContents', 'setContents', 'flushContents'])(
    'has no %s — the absence is what removes the affordance riding it',
    (method) => {
      const provider = /** @type {any} */ (new InMemoryContainerProvider())
      expect(typeof provider[method]).toBe('undefined')
      expect(typeof (/** @type {any} */ (wireArrangement().provider))[method]).toBe('function')
    },
  )
})

// ── Subsequence order: a surface names only what it paints ───────────────────
//
// Both containers hold an attach element no surface draws, so the order a surface
// can state is a SUBSEQUENCE. Both read it the same way — the merge is the
// model's, and its readings are pinned in container-model.test.js. What is
// asserted here is the STATEMENT each arrangement ends up making: the draft
// installs it, the wire-backed provider sends it, and neither says anything at
// all when there is nothing to say.

const ELEMENT_SEED = Object.freeze([
  { id: 'b1', kind: 'prose', attrs: { content: 'one' } },
  { id: 'b2', kind: 'prose', attrs: { content: 'two' } },
  { id: 'at', kind: 'reference', attrs: { uri: 'sieve://x', rel: 'attach' } },
])

/** @returns {{provider: any, stated: () => string[]|null}} */
function draftHoldingAnElement() {
  const provider = new InMemoryContainerProvider({ blocks: ELEMENT_SEED.map((b) => Object.assign({}, b)) })
  const lens = recorder()
  provider.subscribe(lens)
  lens.cues.length = 0
  return { provider, stated: () => (lens.cues.length ? Array.from(provider.getOrder()) : null) }
}

/** @returns {{provider: any, stated: () => string[]|null}} */
function wireHoldingAnElement() {
  const model = new ContainerModel('doc-1', 'note')
  model.applyLoad({ uuid: 'doc-1', blocks: ELEMENT_SEED.map((b) => Object.assign({}, b)) })
  const documents = stubDocumentService()
  const calls = documents.setBlockOrder.mock.calls
  return {
    provider: new BlockProviderAdapter(model, documents),
    stated: () => (calls.length ? calls[calls.length - 1][1] : null),
  }
}

describe.each([
  { name: 'wire-backed', make: wireHoldingAnElement },
  { name: 'in-memory', make: draftHoldingAnElement },
])('$name requestSetOrder over a container holding blocks no surface draws', ({ make }) => {
  it.each([
    ['reorders the named subsequence, leaving the unnamed element in place', ['b2', 'b1'], ['b2', 'b1', 'at']],
    ['takes a statement naming every child as the full permutation', ['at', 'b2', 'b1'], ['at', 'b2', 'b1']],
    ['says nothing when the merge is the order already held', ['b1', 'b2'], null],
    ['says nothing about an empty statement', [], null],
    ['drops a statement naming an id the container does not hold', ['b2', 'stranger'], null],
  ])('%s', (_name, want, expected) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { provider, stated } = make()
    provider.requestSetOrder(want)
    expect(stated()).toEqual(expected)
    warn.mockRestore()
  })
})
