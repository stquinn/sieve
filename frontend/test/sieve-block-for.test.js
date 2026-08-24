// @ts-check
// sieve-block-for.test.js — the sieveBlockFor seam's MODEL-FIRST resolution
// (issue #96). The node's id resolves the mounted container's follower model
// (what Go holds); on a hit the container's attrs are the base with the
// kind-owned overlay applied on top (overlay wins). On a miss — no provider, no
// id, an id the container does not hold — it falls back to SieveBlock.from(node),
// the PM-resurrect path.
//
// The provider is a tiny stub exposing only getBlock (the one method the seam
// calls), so this stays a pure unit of the choke point.

import { describe, it, expect } from 'vitest'
import { sieveBlockFor } from '../src/static/lens/document-editor/surfaces/sieve-block-extension.js'
import { SieveBlock } from '../src/static/contract/sieve-block.js'

/** @param {string} name @param {Record<string, any>} [attrs] */
const node = (name, attrs) => ({ type: { name }, attrs: attrs || {} })

describe('sieveBlockFor — model-first', () => {
  it('container HIT: builds from the container attrs; the overlay wins over both container and node', () => {
    const held = Object.freeze({ id: 'c1', kind: 'code', attrs: Object.freeze({ id: 'c1', source: 'FROM-GO', lang: 'js' }) })
    const provider = { getBlock: (/** @type {string} */ id) => (id === 'c1' ? held : null) }
    const env = sieveBlockFor(node('sieve-code', { id: 'c1', source: 'STALE-NODE' }), { source: 'LIVE' }, provider)
    expect(env).toBeInstanceOf(SieveBlock)
    expect(env.kind).toBe('code')            // kind from the container, not the node name
    expect(env.payload.lang).toBe('js')      // container attrs carried through
    expect(env.payload.source).toBe('LIVE')  // overlay wins over the stale node attr
    expect(held.attrs.source).toBe('FROM-GO') // the container's copy is NOT mutated
  })

  it('container HIT with no overlay: the container attrs pass through unchanged', () => {
    const held = { id: 'd1', kind: 'diagram', attrs: { id: 'd1', source: 'graph TD' } }
    const provider = { getBlock: () => held }
    const env = sieveBlockFor(node('sieve-diagram', { id: 'd1' }), undefined, provider)
    expect(env.kind).toBe('diagram')
    expect(env.payload.source).toBe('graph TD')
  })

  it('container MISS (unknown id): resurrect fallback from the node, overlay still wins', () => {
    /** @type {string[]} */ const calls = []
    const provider = { getBlock: (/** @type {string} */ id) => { calls.push(id); return null } }
    const env = sieveBlockFor(node('sieve-log', { id: 'l1', foo: 'bar' }), { source: 'LIVE' }, provider)
    expect(calls).toEqual(['l1'])            // the container was consulted
    expect(env.kind).toBe('log')             // derived from the node type name
    expect(env.payload.foo).toBe('bar')      // node attrs carried (resurrect)
    expect(env.payload.source).toBe('LIVE')  // overlay wins
    expect(env.payload.id).toBe('l1')
  })

  it('no provider: resurrect fallback (never consults a container)', () => {
    const env = sieveBlockFor(node('sieve-code', { id: 'x1', source: 'NODE' }), { source: 'LIVE' })
    expect(env.kind).toBe('code')
    expect(env.payload.source).toBe('LIVE')
    expect(env.payload.id).toBe('x1')
  })

  it('no id on the node: resurrect fallback even with a provider (getBlock is not called)', () => {
    const provider = { getBlock: () => { throw new Error('getBlock must not be called without an id') } }
    const env = sieveBlockFor(node('sieve-smart-image', {}), { src: '/img.png' }, provider)
    expect(env.kind).toBe('smart-image')
    expect(env.payload.src).toBe('/img.png')
  })
})
