import { describe, it, expect, beforeEach } from 'vitest'
import { BlockSelection } from '../src/static/lens/document-editor/block-selection.js'

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

// A minimal Selection stand-in. focusNode defaults to the anchor — a highlight
// that stays where it started — so only the tests that care state it.
const sel = (opts) => ({
  isCollapsed: false, toString: () => opts.text,
  anchorNode: opts.anchor, focusNode: opts.focus || opts.anchor, ...opts,
})

describe('domSelectionTextInside', () => {
  let els
  beforeEach(() => { document.body.innerHTML = ''; els = block() })

  it('returns the highlighted text when the selection is inside the block (anchor is a text node)', () => {
    expect(BlockSelection.textInside(sel({ text: 'log line', anchor: els.textNode }), els.b)).toBe('log line')
  })

  it('returns the highlighted text when the anchor is an element inside the block', () => {
    expect(BlockSelection.textInside(sel({ text: 'x', anchor: els.cell }), els.b)).toBe('x')
  })

  it('returns empty when the selection is outside the block', () => {
    const other = document.createElement('div')
    document.body.appendChild(other)
    expect(BlockSelection.textInside(sel({ text: 'x', anchor: other }), els.b)).toBe('')
  })

  it('returns empty for a collapsed selection', () => {
    expect(BlockSelection.textInside({ isCollapsed: true, toString: () => '', anchorNode: els.textNode }, els.b)).toBe('')
  })

  it('returns empty for a whitespace-only highlight', () => {
    expect(BlockSelection.textInside(sel({ text: '   \n ', anchor: els.textNode }), els.b)).toBe('')
  })

  it('returns empty for a missing selection or block', () => {
    expect(BlockSelection.textInside(null, els.b)).toBe('')
    expect(BlockSelection.textInside(sel({ text: 'x', anchor: els.textNode }), null)).toBe('')
  })
})

// unownedText is textInside NARROWED to the regions a DOM highlight is the only
// reading of. Text PM owns has a document range, and reading such a highlight off
// the DOM reports the WHOLE highlight for every node it touches — which is how
// text/plain came to repeat itself across a multi-node selection (#160).
describe('unownedText', () => {
  // A block with both kinds of region: a read-only one (contenteditable="false",
  // an ai-block question title) and PM's own editable body.
  function regions() {
    document.body.innerHTML = ''
    const b = document.createElement('div')
    b.className = 'sieve-block'
    const title = document.createElement('div')
    title.setAttribute('contenteditable', 'false')
    const titleText = document.createTextNode('the question')
    title.appendChild(titleText)
    const body = document.createElement('div')
    const bodyText = document.createTextNode('the answer')
    body.appendChild(bodyText)
    b.appendChild(title)
    b.appendChild(body)
    document.body.appendChild(b)
    return { b, title, titleText, body, bodyText }
  }

  let els
  beforeEach(() => { els = regions() })

  it('returns the highlighted text for a highlight confined to a read-only region', () => {
    expect(BlockSelection.unownedText(sel({ text: 'question', anchor: els.titleText }), els.b))
      .toBe('question')
  })

  it('returns empty for a highlight in PM-owned content — the document range is the truth', () => {
    expect(BlockSelection.unownedText(sel({ text: 'answer', anchor: els.bodyText }), els.b)).toBe('')
  })

  it('returns empty when the highlight escapes the read-only region it started in', () => {
    const escaping = sel({ text: 'question\nthe answer', anchor: els.titleText, focus: els.bodyText })
    expect(BlockSelection.unownedText(escaping, els.b)).toBe('')
  })

  it('treats a whole block rendered read-only as one unowned region', () => {
    const atom = document.createElement('div')
    atom.setAttribute('contenteditable', 'false')
    const text = document.createTextNode('a card')
    atom.appendChild(text)
    document.body.appendChild(atom)
    expect(BlockSelection.unownedText(sel({ text: 'card', anchor: text }), atom)).toBe('card')
  })

  it('returns empty whenever textInside does — outside the block, collapsed, blank', () => {
    const outside = document.createElement('div')
    outside.setAttribute('contenteditable', 'false')
    document.body.appendChild(outside)
    expect(BlockSelection.unownedText(sel({ text: 'x', anchor: outside }), els.b)).toBe('')
    expect(BlockSelection.unownedText(null, els.b)).toBe('')
    expect(BlockSelection.unownedText(sel({ text: '  ', anchor: els.titleText }), els.b)).toBe('')
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
    expect(BlockSelection.blockRange(domSel, er, blocks)).toEqual({ from: 10, to: 20 })
  })

  it('returns null when er already covers the highlighted block (PM owns the text — leave er alone)', () => {
    const { blocks, tnodeB } = twoBlocks()
    const er = { from: 10, to: 20 } // PM selection already on block B (e.g. its PM response body)
    const domSel = sel({ text: 'q', anchor: tnodeB })
    expect(BlockSelection.blockRange(domSel, er, blocks)).toBeNull()
  })

  it('returns null for a collapsed / whitespace-only / missing selection', () => {
    const { blocks } = twoBlocks()
    const er = { from: 0, to: 10 }
    expect(BlockSelection.blockRange({ isCollapsed: true, toString: () => '' }, er, blocks)).toBeNull()
    expect(BlockSelection.blockRange(sel({ text: '   ', anchor: blocks[1].dom }), er, blocks)).toBeNull()
    expect(BlockSelection.blockRange(null, er, blocks)).toBeNull()
  })

  it('returns null when the highlight is in no sieve block', () => {
    const { blocks } = twoBlocks()
    const outside = document.createElement('div'); document.body.appendChild(outside)
    const er = { from: 0, to: 10 }
    expect(BlockSelection.blockRange(sel({ text: 'x', anchor: outside }), er, blocks)).toBeNull()
  })
})

// ONE reading of "what the user selected": the clipboard and the Ask panel's
// label both ask here, so they cannot disagree about the same selection. The
// separator is the caller's — '\n' joins clipboard text, ' ' keeps a label to
// one line.
describe('selectedText', () => {
  const doc = {
    textBetween: (from, to, separator) => `[${from},${to}|${separator === '\n' ? 'nl' : separator}]`,
  }

  it('reads the document range with the separator the caller asked for', () => {
    expect(BlockSelection.selectedText(doc, { from: 4, to: 9 }, null, '\n')).toBe('[4,9|nl]')
    expect(BlockSelection.selectedText(doc, { from: 4, to: 9 }, null, ' ')).toBe('[4,9| ]')
  })

  it('prefers a DOM highlight — a region PM does not own has no range to read', () => {
    expect(BlockSelection.selectedText(doc, { from: 4, to: 9 }, 'highlighted', '\n')).toBe('highlighted')
  })

  it('is empty for a collapsed or inverted range', () => {
    expect(BlockSelection.selectedText(doc, { from: 7, to: 7 }, null, '\n')).toBe('')
    expect(BlockSelection.selectedText(doc, { from: 9, to: 4 }, null, '\n')).toBe('')
  })
})
