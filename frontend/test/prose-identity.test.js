import { describe, it, expect } from 'vitest'

// D-r.7 piece 1 — identity unification. The prose identity attribute is unified
// from `blockId` to `id`, so EVERY block node (prose or structured sieve-*) is
// addressed by `attrs.id`. The change is confined to the PM node-attr layer: the
// DOM carrier stays `data-id` (a literal `id=` is intentionally NOT emitted to
// avoid duplicate-id collisions), and the on-disk markers carry the id VALUE, so
// the byte-stable round-trip is untouched.

// prose-block.js reads Extension/Plugin/PluginKey off the shared vendor bag
// (editor/surfaces/tiptap-vendor.js) at import time. Stub the minimum onto the shared bag
// test/setup.js seeded (mutate, never reassign — tiptap-vendor.js already
// captured a reference to it), then import once (modules are cached) to get the
// real ProseBlock / BlockId ES exports (the bus is retired).
Object.assign(globalThis.TipTap, {
  Extension: { create: (cfg) => cfg },
  Plugin: function (spec) { this.spec = spec },
  PluginKey: function (k) { this.k = k },
})
const { ProseBlock, BlockId } = await import('../src/static/block/prose-block.js')

describe('prose identity unification (blockId → id)', () => {
  it('the prose kind declares its identity attr as `id`', () => {
    expect(ProseBlock.identityAttr).toBe('id')
  })

  it('the global attribute is keyed `id`, not `blockId`', () => {
    const attrs = BlockId.addGlobalAttributes()[0].attributes
    expect(Object.keys(attrs)).toContain('id')
    expect(Object.keys(attrs)).not.toContain('blockId')
  })

  it('renderHTML binds the id to data-id (never a literal id=) and tags the shared block-node class, omitting both when empty', () => {
    const def = BlockId.addGlobalAttributes()[0].attributes.id
    expect(def.renderHTML({ id: 'pr-1' })).toEqual({ 'data-id': 'pr-1', class: 'block-node' })
    expect(def.renderHTML({ id: '' })).toEqual({})
  })

  it('parseHTML reads the id from data-id', () => {
    const def = BlockId.addGlobalAttributes()[0].attributes.id
    const el = { getAttribute: (k) => (k === 'data-id' ? 'pr-9' : null) }
    expect(def.parseHTML(el)).toBe('pr-9')
  })

  it('declares a transient `token` global attr that is never rendered to HTML or markdown', () => {
    const attrs = BlockId.addGlobalAttributes()[0].attributes
    expect(Object.keys(attrs)).toContain('token')
    expect(attrs.token.default).toBe('')
    expect(attrs.token.rendered).toBe(false)
  })

  it('renderHTML applies block-node to a pending (token-only) block too — no data-id — so padding does not pop in when the id acks', () => {
    const def = BlockId.addGlobalAttributes()[0].attributes.id
    expect(def.renderHTML({ id: '', token: 'tok-aa' })).toEqual({ class: 'block-node' })
    expect(def.renderHTML({ id: '', token: '' })).toEqual({})
    expect(def.renderHTML({ id: 'pr-1', token: 'tok-x' })).toEqual({ 'data-id': 'pr-1', class: 'block-node' })
  })
})

// Prose is a block like any other, so it answers the kind registry's icon lookup
// itself. Without its own getIcon it took the registry's generic fallback — the
// CODE icon — and any surface drawing a kind marker (the Ask footer's per-block
// chips, #82) called a paragraph a code block.
describe('the prose kind declares its own icon', () => {
  it('getSieveIcon("prose") is the prose glyph, not the code fallback', async () => {
    const { getSieveIcon } = await import('../src/static/block/block-kinds.js')
    window.SieveIcons = { code: '<svg id="code"/>', blockquote: '<svg id="prose"/>' }
    expect(ProseBlock.kind).toBe('prose')
    expect(getSieveIcon('prose')).toBe('<svg id="prose"/>')
  })
})
