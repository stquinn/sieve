import { describe, it, expect, beforeEach } from 'vitest'
import { domSelectionTextInside } from '../src/static/block/sieve-block-extension.js'

// On copy, text/plain + text/html must follow a native DOM highlight inside a
// block's custom region (the log Explore table) — where PM's selection is a
// whole-block NodeSelection that knows nothing of the highlight. sieve/slice +
// sieve/<kind> still carry the whole block (asserted by the copy handler, not here).

function block() {
  const b = document.createElement('div')
  b.className = 'sieve-block'
  const table = document.createElement('div')
  const cell = document.createElement('div')
  const textNode = document.createTextNode('selected log line')
  cell.appendChild(textNode)
  table.appendChild(cell)
  b.appendChild(table)
  document.body.appendChild(b)
  return { b, cell, textNode }
}

// A minimal Selection stand-in (the helper only reads isCollapsed/toString/anchorNode).
const sel = (opts) => ({ isCollapsed: false, toString: () => opts.text, anchorNode: opts.anchor, ...opts })

describe('domSelectionTextInside', () => {
  let els
  beforeEach(() => { document.body.innerHTML = ''; els = block() })

  it('returns the highlighted text when the selection is inside the block (anchor is a text node)', () => {
    expect(domSelectionTextInside(sel({ text: 'log line', anchor: els.textNode }), els.b)).toBe('log line')
  })

  it('returns the highlighted text when the anchor is an element inside the block', () => {
    expect(domSelectionTextInside(sel({ text: 'x', anchor: els.cell }), els.b)).toBe('x')
  })

  it('returns empty when the selection is outside the block', () => {
    const other = document.createElement('div')
    document.body.appendChild(other)
    expect(domSelectionTextInside(sel({ text: 'x', anchor: other }), els.b)).toBe('')
  })

  it('returns empty for a collapsed selection', () => {
    expect(domSelectionTextInside({ isCollapsed: true, toString: () => '', anchorNode: els.textNode }, els.b)).toBe('')
  })

  it('returns empty for a whitespace-only highlight', () => {
    expect(domSelectionTextInside(sel({ text: '   \n ', anchor: els.textNode }), els.b)).toBe('')
  })

  it('returns empty for a missing selection or block', () => {
    expect(domSelectionTextInside(null, els.b)).toBe('')
    expect(domSelectionTextInside(sel({ text: 'x', anchor: els.textNode }), null)).toBe('')
  })
})
