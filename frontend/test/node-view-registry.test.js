import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { NodeViewRegistry } from '../src/static/block/sieve-block-extension.js'

// node-view-registry.test.js — the typed registry that replaced the former
// `export let registerSieveRenderer` + registration-IIFE rebinding (issue #49
// P5). Exercises register/lookup, prose-first ordering, duplicate-kind
// (last-wins) semantics, the data-* builder, and the "nothing registers without
// a runtime" no-op — the exact property the old IIFE's early return provided.
//
// A FAKE TipTap runtime is seeded onto the shared globalThis.TipTap bag (the
// same object tiptap-vendor.js captured; test/setup.js installs it). Node.create
// is stubbed to return a marker so registration needs no real ProseMirror.

const VENDOR = /** @type {any} */ (globalThis).TipTap

function seedRuntime() {
  VENDOR.Node = { create: (cfg) => ({ __node: cfg.name }) }
  VENDOR.mergeAttributes = (a, b) => Object.assign({}, a, b)
}

// A minimal adapter — registration only reads nodeConfig (Object.assign); the
// makeNodeView/callbacks are never invoked by the stubbed Node.create.
const adapter = (extra) => Object.assign({ makeNodeView: () => ({ dom: null }) }, extra)

afterEach(() => { delete VENDOR.Node; delete VENDOR.mergeAttributes })

describe('NodeViewRegistry — register + lookup', () => {
  beforeEach(seedRuntime)

  it('registers a kind and returns its adapter via adapterFor', () => {
    const reg = new NodeViewRegistry()
    const a = adapter({ nodeConfig: { atom: true } })
    reg.register('code', a)
    expect(reg.adapterFor('code')).toBe(a)
    expect(reg.adapterFor('missing')).toBeUndefined()
  })

  it('nodes() lists every minted node, sieve-prose FIRST (auto-fill order)', () => {
    const reg = new NodeViewRegistry()
    reg.register('code', adapter())
    reg.register('prose', adapter())
    reg.register('diagram', adapter())
    const names = reg.nodes().map((n) => n.__node)
    expect(names[0]).toBe('sieve-prose')       // prose leads the sieveBlock group
    expect(names).toContain('sieve-code')
    expect(names).toContain('sieve-diagram')
    expect(names.length).toBe(3)
  })

  it('duplicate kind is last-wins (matches the old nodeRegistry[kind] overwrite)', () => {
    const reg = new NodeViewRegistry()
    const first = adapter({ tag: 'A' })
    const second = adapter({ tag: 'B' })
    reg.register('code', first)
    reg.register('code', second)
    expect(reg.adapterFor('code')).toBe(second)
    expect(reg.nodes().filter((n) => n.__node === 'sieve-code').length).toBe(1)
  })

  it('buildBlockHTML builds the data-* div from an adapter + properties map', () => {
    const reg = new NodeViewRegistry()
    reg.register('code', adapter())
    const html = reg.buildBlockHTML('code', { id: 'c1', status: 'COMPLETE' })
    expect(html).toContain('data-type="sieve-code"')
    expect(html).toContain('data-kind="code"')
    expect(html).toContain('data-id="c1"')
    expect(html).toContain('data-status="COMPLETE"')
  })

  it('buildBlockHTML returns empty for an unknown kind or id-less data', () => {
    const reg = new NodeViewRegistry()
    reg.register('code', adapter())
    expect(reg.buildBlockHTML('nope', { id: 'x' })).toBe('')
    expect(reg.buildBlockHTML('code', {})).toBe('')
  })
})

describe('NodeViewRegistry — no runtime', () => {
  it('register is an inert no-op when the TipTap runtime is absent', () => {
    delete VENDOR.Node
    const reg = new NodeViewRegistry()
    reg.register('code', adapter())
    expect(reg.adapterFor('code')).toBeUndefined()
    expect(reg.nodes()).toEqual([])
  })
})
