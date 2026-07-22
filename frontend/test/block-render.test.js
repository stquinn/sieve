import { describe, it, expect, beforeEach, vi } from 'vitest'

// buildBlocksHTML (block-render.js) builds a structured block's data-* div via
// buildSieveBlockHTML, a real ES import from sieve-block-extension.js (P4.E —
// retired the shared bus read). Mock the module (vi.hoisted survives
// vi.mock's factory hoisting) so this unit test stays free of the renderer
// registry — same intent as the old bus stub, real import in its place.
const mocks = vi.hoisted(() => ({
  buildSieveBlockHTML: vi.fn((kind, attrs) =>
    `<div data-type="sieve-${kind}" data-id="${(attrs && attrs.id) || ''}"></div>`
  ),
}))
vi.mock('../src/static/block/sieve-block-extension.js', () => ({
  buildSieveBlockHTML: mocks.buildSieveBlockHTML,
}))

const { buildBlocksHTML } = await import('../src/static/block/block-render.js')
// The render pipeline is envelope-native (issue #49 Phase 3): buildBlocksHTML
// consumes SieveBlock envelopes, reading the kind + the FLAT payload (properties
// bag). SieveBlock is the unmocked leaf type — never touches the extension module.
const { SieveBlock } = await import('../src/static/block/sieve-block.js')

// mdRender stub: marks its input so we can assert WHICH text was rendered.
const md = (t) => `<R>${t}</R>`

describe('buildBlocksHTML', () => {
  beforeEach(() => {
    mocks.buildSieveBlockHTML.mockClear()
  })

  // 2026-06-19 node-granular: a prose block renders as its NATIVE markdown nodes
  // (paragraph/heading/list/…), NOT a custom sieve-prose container. The block id
  // is carried onto the native node by renderBlocksIntoEditor (real DOM), so the
  // pure HTML builder emits no wrapper and no data-id — just the rendered markdown.
  it('renders a prose block as bare native markdown (no sieve-prose wrapper)', () => {
    const html = buildBlocksHTML([new SieveBlock('prose', { id: 'pr-1', content: 'Hello' })], md)
    expect(html).toBe('<R>Hello</R>')
    expect(html).not.toContain('sieve-prose')
  })

  it('renders multi-paragraph prose content verbatim (markdownit splits it into N nodes)', () => {
    // The stub does not split; the real markdownit produces <p>a</p><p>b</p>. We
    // assert the builder hands the WHOLE run to the renderer untouched — the split
    // into N top-level nodes is markdownit's job, observed at parse time.
    const html = buildBlocksHTML([new SieveBlock('prose', { id: 'pr-1', content: 'a\n\nb' })], md)
    expect(html).toBe('<R>a\n\nb</R>')
  })

  it('falls back to an empty paragraph for empty prose so it parses to a valid node', () => {
    const html = buildBlocksHTML([new SieveBlock('prose', { id: 'pr-1', content: '' })], md)
    expect(html).toBe('<p></p>')
  })

  it('builds a structured block from its attrs via buildSieveBlockHTML (no markdown)', () => {
    const html = buildBlocksHTML(
      [new SieveBlock('code', { id: 'co-1', source: 'x=1' })],
      md,
    )
    expect(mocks.buildSieveBlockHTML).toHaveBeenCalledTimes(1)
    expect(mocks.buildSieveBlockHTML).toHaveBeenCalledWith('code', { id: 'co-1', source: 'x=1' })
    expect(html).toBe('<div data-type="sieve-code" data-id="co-1"></div>')
    expect(html).not.toContain('sieve-prose')
  })

  it('joins multiple blocks in order with newlines', () => {
    const html = buildBlocksHTML([
      new SieveBlock('prose', { id: 'pr-1', content: 'A' }),
      new SieveBlock('code', { id: 'co-1' }),
    ], md)
    expect(html).toBe('<R>A</R>\n<div data-type="sieve-code" data-id="co-1"></div>')
  })
})
