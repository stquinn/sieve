import { describe, it, expect, beforeEach } from 'vitest'
import { buildBlocksHTML } from '../src/static/block-render.js'

// mdRender stub: marks its input so we can assert WHICH text was rendered.
const md = (t) => `<R>${t}</R>`

describe('buildBlocksHTML', () => {
  // Structured blocks build their data-* div from attrs via the shared
  // buildSieveBlockHTML (the same builder the fence rule uses). Stub it so this
  // unit test stays free of the renderer registry; assert it gets the attrs.
  let sieveCalls
  beforeEach(() => {
    sieveCalls = []
    globalThis.window = globalThis.window || globalThis
    window.TipTap = window.TipTap || {}
    window.TipTap.buildSieveBlockHTML = (kind, attrs, sf) => {
      sieveCalls.push([kind, attrs, sf])
      return `<div data-type="sieve-${kind}" data-id="${(attrs && attrs.id) || ''}"></div>`
    }
  })

  // 2026-06-19 node-granular: a prose block renders as its NATIVE markdown nodes
  // (paragraph/heading/list/…), NOT a custom sieve-prose container. The block id
  // is carried onto the native node by renderBlocksIntoEditor (real DOM), so the
  // pure HTML builder emits no wrapper and no data-id — just the rendered markdown.
  it('renders a prose block as bare native markdown (no sieve-prose wrapper)', () => {
    const html = buildBlocksHTML([{ kind: 'prose', id: 'pr-1', content: 'Hello' }], md)
    expect(html).toBe('<R>Hello</R>')
    expect(html).not.toContain('sieve-prose')
  })

  it('renders multi-paragraph prose content verbatim (markdownit splits it into N nodes)', () => {
    // The stub does not split; the real markdownit produces <p>a</p><p>b</p>. We
    // assert the builder hands the WHOLE run to the renderer untouched — the split
    // into N top-level nodes is markdownit's job, observed at parse time.
    const html = buildBlocksHTML([{ kind: 'prose', id: 'pr-1', content: 'a\n\nb' }], md)
    expect(html).toBe('<R>a\n\nb</R>')
  })

  it('falls back to an empty paragraph for empty prose so it parses to a valid node', () => {
    const html = buildBlocksHTML([{ kind: 'prose', id: 'pr-1', content: '' }], md)
    expect(html).toBe('<p></p>')
  })

  it('builds a structured block from its attrs via buildSieveBlockHTML (no markdown)', () => {
    const html = buildBlocksHTML(
      [{ kind: 'code', id: 'co-1', attrs: { id: 'co-1', source: 'x=1' }, serialisedForm: '```code\nid: co-1\n```' }],
      md,
    )
    expect(sieveCalls).toHaveLength(1)
    expect(sieveCalls[0][0]).toBe('code')
    expect(sieveCalls[0][1]).toEqual({ id: 'co-1', source: 'x=1' })
    expect(html).toBe('<div data-type="sieve-code" data-id="co-1"></div>')
    expect(html).not.toContain('sieve-prose')
  })

  it('joins multiple blocks in order with newlines', () => {
    const html = buildBlocksHTML([
      { kind: 'prose', id: 'pr-1', content: 'A' },
      { kind: 'code', id: 'co-1', attrs: { id: 'co-1' } },
    ], md)
    expect(html).toBe('<R>A</R>\n<div data-type="sieve-code" data-id="co-1"></div>')
  })
})
