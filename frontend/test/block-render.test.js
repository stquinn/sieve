import { describe, it, expect } from 'vitest'
import { buildBlocksHTML } from '../src/static/block-render.js'

// mdRender stub: marks its input so we can assert WHICH text was rendered and
// that the prose wrapper / structured pass-through put it in the right place.
const md = (t) => `<R>${t}</R>`

describe('buildBlocksHTML', () => {
  it('wraps a prose block in a sieve-block-anchor carrying its id', () => {
    const html = buildBlocksHTML([{ kind: 'prose', id: 'pr-1', content: 'Hello' }], md)
    expect(html).toBe('<div data-type="sieve-block-anchor" data-id="pr-1"><R>Hello</R></div>')
  })

  it('emits data-aliases as a JSON array when present', () => {
    const html = buildBlocksHTML([{ kind: 'prose', id: 'pr-1', content: 'x', aliases: ['pr-0', 'pr-9'] }], md)
    expect(html).toContain('data-aliases="[&quot;pr-0&quot;,&quot;pr-9&quot;]"')
  })

  it('omits data-aliases when there are none', () => {
    const html = buildBlocksHTML([{ kind: 'prose', id: 'pr-1', content: 'x' }], md)
    expect(html).not.toContain('data-aliases')
  })

  it('renders a structured block through its serialised fence form, no anchor wrapper', () => {
    const html = buildBlocksHTML([{ kind: 'code', id: 'co-1', serialisedForm: '```code\nid: co-1\n```' }], md)
    expect(html).toBe('<R>```code\nid: co-1\n```</R>')
    expect(html).not.toContain('sieve-block-anchor')
  })

  it('escapes the id attribute', () => {
    const html = buildBlocksHTML([{ kind: 'prose', id: 'a"b', content: 'x' }], md)
    expect(html).toContain('data-id="a&quot;b"')
  })

  it('falls back to an empty paragraph for empty prose so the anchor is non-empty', () => {
    const html = buildBlocksHTML([{ kind: 'prose', id: 'pr-1', content: '' }], md)
    expect(html).toBe('<div data-type="sieve-block-anchor" data-id="pr-1"><p></p></div>')
  })

  it('joins multiple blocks in order with newlines', () => {
    const html = buildBlocksHTML([
      { kind: 'prose', id: 'pr-1', content: 'A' },
      { kind: 'code', id: 'co-1', serialisedForm: 'F' },
    ], md)
    expect(html).toBe('<div data-type="sieve-block-anchor" data-id="pr-1"><R>A</R></div>\n<R>F</R>')
  })
})
