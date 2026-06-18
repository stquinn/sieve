import { describe, it, expect, beforeEach } from 'vitest'
import { buildBlocksHTML } from '../src/static/block-render.js'

// mdRender stub: marks its input so we can assert WHICH text was rendered and
// that the prose wrapper put it in the right place.
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
  it('wraps a prose block in a sieve-prose carrying its id', () => {
    const html = buildBlocksHTML([{ kind: 'prose', id: 'pr-1', content: 'Hello' }], md)
    expect(html).toBe('<div data-type="sieve-prose" data-id="pr-1"><R>Hello</R></div>')
  })

  it('emits data-aliases as a JSON array when present', () => {
    const html = buildBlocksHTML([{ kind: 'prose', id: 'pr-1', content: 'x', aliases: ['pr-0', 'pr-9'] }], md)
    expect(html).toContain('data-aliases="[&quot;pr-0&quot;,&quot;pr-9&quot;]"')
  })

  it('omits data-aliases when there are none', () => {
    const html = buildBlocksHTML([{ kind: 'prose', id: 'pr-1', content: 'x' }], md)
    expect(html).not.toContain('data-aliases')
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

  it('escapes the id attribute', () => {
    const html = buildBlocksHTML([{ kind: 'prose', id: 'a"b', content: 'x' }], md)
    expect(html).toContain('data-id="a&quot;b"')
  })

  it('falls back to an empty paragraph for empty prose so the anchor is non-empty', () => {
    const html = buildBlocksHTML([{ kind: 'prose', id: 'pr-1', content: '' }], md)
    expect(html).toBe('<div data-type="sieve-prose" data-id="pr-1"><p></p></div>')
  })

  it('joins multiple blocks in order with newlines', () => {
    const html = buildBlocksHTML([
      { kind: 'prose', id: 'pr-1', content: 'A' },
      { kind: 'code', id: 'co-1', attrs: { id: 'co-1' } },
    ], md)
    expect(html).toBe('<div data-type="sieve-prose" data-id="pr-1"><R>A</R></div>\n<div data-type="sieve-code" data-id="co-1"></div>')
  })
})
