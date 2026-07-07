import { describe, it, expect, beforeEach } from 'vitest'
import { domSelectionTextInside, domSelectionBlockRange } from '../src/static/block/sieve-block-extension.js'

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

// domSelectionBlockRange re-targets the copy loop when a highlight lives in a
// block's READ-ONLY region (the ai-block question title — contentEditable=false
// DOM PM cannot track). PM's selection stays on a STALE block there, so copy would
// grab the previously-selected block; this points the loop at the right one.
describe('domSelectionBlockRange (bug 3: copy the highlighted block, not the stale one)', () => {
  // Two ai-block DOMs: block A (prev, PM selection points here) and block B (the
  // one whose question title the user highlighted).
  function twoBlocks() {
    document.body.innerHTML = ''
    const domA = document.createElement('div'); domA.className = 'sieve-ai-block'
    const domB = document.createElement('div'); domB.className = 'sieve-ai-block'
    const titleB = document.createElement('div'); titleB.className = 'sieve-block__heading'
    const tnodeB = document.createTextNode('question with    spaces')
    titleB.appendChild(tnodeB); domB.appendChild(titleB)
    document.body.appendChild(domA); document.body.appendChild(domB)
    // from/to are opaque PM positions; only ordering/containment matter here.
    return {
      blocks: [{ from: 0, to: 10, dom: domA }, { from: 10, to: 20, dom: domB }],
      tnodeB,
    }
  }

  it('re-targets to the highlighted block when PM (er) points at a DIFFERENT, stale block', () => {
    const { blocks, tnodeB } = twoBlocks()
    // PM selection (er) is a NodeSelection on block A — the reported failure.
    const er = { from: 0, to: 10 }
    const domSel = sel({ text: 'question with    spaces', anchor: tnodeB })
    expect(domSelectionBlockRange(domSel, er, blocks)).toEqual({ from: 10, to: 20 })
  })

  it('returns null when er already covers the highlighted block (PM owns the text — leave er alone)', () => {
    const { blocks, tnodeB } = twoBlocks()
    const er = { from: 10, to: 20 } // PM selection already on block B (e.g. its PM response body)
    const domSel = sel({ text: 'q', anchor: tnodeB })
    expect(domSelectionBlockRange(domSel, er, blocks)).toBeNull()
  })

  it('returns null for a collapsed / whitespace-only / missing selection', () => {
    const { blocks } = twoBlocks()
    const er = { from: 0, to: 10 }
    expect(domSelectionBlockRange({ isCollapsed: true, toString: () => '' }, er, blocks)).toBeNull()
    expect(domSelectionBlockRange(sel({ text: '   ', anchor: blocks[1].dom }), er, blocks)).toBeNull()
    expect(domSelectionBlockRange(null, er, blocks)).toBeNull()
  })

  it('returns null when the highlight is in no sieve block', () => {
    const { blocks } = twoBlocks()
    const outside = document.createElement('div'); document.body.appendChild(outside)
    const er = { from: 0, to: 10 }
    expect(domSelectionBlockRange(sel({ text: 'x', anchor: outside }), er, blocks)).toBeNull()
  })
})
