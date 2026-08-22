// @ts-check
// sieve-block-for.test.js — issue #49 Phase 3: the sieveBlockFor seam's
// MIRROR-FIRST flip. The node's id resolves the BlockService's block cache (what
// Go holds); on a hit the mirror payload is the base with the kind-owned overlay
// applied on top (overlay wins). On a miss (no service / no id / never-seeded id)
// it falls back to SieveBlock.from(node) — the PM-resurrect path — which never
// writes the mirror. blockService is a tiny stub exposing only envelopeFor (the
// one method the seam calls), so this stays a pure unit of the choke point.

import { describe, it, expect } from 'vitest'
import { sieveBlockFor } from '../src/static/block/sieve-block-extension.js'
import { SieveBlock } from '../src/static/block/sieve-block.js'

/** @param {string} name @param {Record<string, any>} [attrs] */
const node = (name, attrs) => ({ type: { name }, attrs: attrs || {} })

describe('sieveBlockFor — mirror-first', () => {
  it('mirror HIT: builds from the mirror payload; the overlay wins over both mirror and node', () => {
    const mirror = new SieveBlock('code', { id: 'c1', source: 'FROM-GO', lang: 'js' })
    const bs = { envelopeFor: (/** @type {string} */ id) => (id === 'c1' ? mirror : null) }
    const env = sieveBlockFor(node('sieve-code', { id: 'c1', source: 'STALE-NODE' }), { source: 'LIVE' }, bs)
    expect(env).toBeInstanceOf(SieveBlock)
    expect(env.kind).toBe('code')            // kind from the mirror, not the node name
    expect(env.payload.lang).toBe('js')      // mirror payload carried through
    expect(env.payload.source).toBe('LIVE')  // overlay wins over the stale node attr
    expect(env).not.toBe(mirror)             // a fresh envelope is authored
    expect(mirror.payload.source).toBe('FROM-GO') // the mirror is NOT mutated (no write)
  })

  it('mirror HIT with no overlay: the mirror payload passes through unchanged', () => {
    const mirror = new SieveBlock('diagram', { id: 'd1', source: 'graph TD' })
    const bs = { envelopeFor: () => mirror }
    const env = sieveBlockFor(node('sieve-diagram', { id: 'd1' }), undefined, bs)
    expect(env.kind).toBe('diagram')
    expect(env.payload.source).toBe('graph TD')
  })

  it('mirror MISS (unknown id): resurrect fallback from the node, overlay still wins, no mirror write', () => {
    const calls = []
    const bs = { envelopeFor: (/** @type {string} */ id) => { calls.push(id); return null } }
    const env = sieveBlockFor(node('sieve-log', { id: 'l1', foo: 'bar' }), { source: 'LIVE' }, bs)
    expect(calls).toEqual(['l1'])            // the mirror was consulted
    expect(env.kind).toBe('log')             // derived from the node type name
    expect(env.payload.foo).toBe('bar')      // node attrs carried (resurrect)
    expect(env.payload.source).toBe('LIVE')  // overlay wins
    expect(env.payload.id).toBe('l1')
  })

  it('no blockService: resurrect fallback (never consults a mirror)', () => {
    const env = sieveBlockFor(node('sieve-code', { id: 'x1', source: 'NODE' }), { source: 'LIVE' })
    expect(env.kind).toBe('code')
    expect(env.payload.source).toBe('LIVE')
    expect(env.payload.id).toBe('x1')
  })

  it('no id on the node: resurrect fallback even with a service (envelopeFor is not called)', () => {
    const bs = { envelopeFor: () => { throw new Error('envelopeFor must not be called without an id') } }
    const env = sieveBlockFor(node('sieve-smart-image', {}), { src: '/img.png' }, bs)
    expect(env.kind).toBe('smart-image')
    expect(env.payload.src).toBe('/img.png')
  })
})
