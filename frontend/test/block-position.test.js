import { describe, it, expect } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { blockIndexForInsert, docPosForBlockIndex, blockIndexAfter, blockIndexAt, enclosingBlockId } from '../src/static/editor/surfaces/block-position.js'

// Schema with doc that accepts both block-group nodes (paragraph/heading/codeBlock)
// and sieveBlock-group nodes (sieve-diagram, sieve-prose).
const schema = new Schema({
  nodes: {
    doc: { content: '(block | sieveBlock)+' },
    'sieve-diagram': {
      group: 'sieveBlock',
      attrs: { id: { default: '' } },
      toDOM: () => ['div', { 'data-type': 'sieve-diagram' }],
    },
    'sieve-prose': {
      group: 'sieveBlock',
      content: 'block+',
      attrs: { id: { default: '' } },
      toDOM: () => ['div', { 'data-type': 'sieve-prose' }, 0],
    },
    paragraph: {
      group: 'block',
      content: 'inline*',
      toDOM: () => ['p', 0],
    },
    heading: {
      group: 'block',
      content: 'inline*',
      attrs: { level: { default: 1 } },
      toDOM: (node) => ['h' + node.attrs.level, 0],
    },
    codeBlock: {
      group: 'block',
      content: 'text*',
      code: true,
      attrs: { id: { default: '' } },
      toDOM: () => ['pre', ['code', 0]],
    },
    text: { group: 'inline' },
  },
})

const n = schema.nodes

function p(text) {
  if (text) return n.paragraph.create(null, schema.text(text))
  return n.paragraph.create()
}

function diag(id) {
  return n['sieve-diagram'].create({ id })
}

function proseWrap(id, ...children) {
  return n['sieve-prose'].create({ id }, children)
}

function code(id) {
  return n.codeBlock.create({ id: id || '' })
}

// Build doc: [p1, p2, sieve-diagram(id='di-39ad'), p3, p4]
// Sizes: paragraph wraps inline* — an empty paragraph = nodeSize 2
// paragraph('X') => nodeSize 3 (1 text char + 2 wrapper)
function buildExtractDoc() {
  return n.doc.create(null, [
    p('A'),  // child 0, nodeSize 3
    p('B'),  // child 1, nodeSize 3
    diag('di-39ad'),  // child 2, nodeSize 2 (leaf atom)
    p('C'),  // child 3, nodeSize 3
    p('D'),  // child 4, nodeSize 3
  ])
}

// ── blockIndexAfter ───────────────────────────────────────────────────────────

describe('blockIndexAfter', () => {
  it('returns the index immediately after the matching top-level node', () => {
    const doc = buildExtractDoc()
    // sieve-diagram is child 2, so index after it = 3
    expect(blockIndexAfter(doc, 'di-39ad')).toBe(3)
  })

  it('returns -1 for a blockId that does not exist', () => {
    const doc = buildExtractDoc()
    expect(blockIndexAfter(doc, 'missing')).toBe(-1)
  })

  it('returns 1 for the first child (index 0) → after = 1', () => {
    // Use a doc with one sieve-diagram as child 0
    const doc = n.doc.create(null, [diag('di-0001'), p('X'), p('Y')])
    expect(blockIndexAfter(doc, 'di-0001')).toBe(1)
  })

  it('returns childCount for the last child', () => {
    const doc = buildExtractDoc()
    // p('D') is child 4 (index 4) but has id '' — not a Sieve id
    // Use a diagram at the end
    const doc2 = n.doc.create(null, [p('A'), p('B'), diag('di-last')])
    expect(blockIndexAfter(doc2, 'di-last')).toBe(3) // childCount = 3
  })

  it('does NOT walk nested descendants — only direct children', () => {
    // sieve-prose wrapping a codeBlock with id='inner-id'
    // blockIndexAfter should NOT find 'inner-id' since it's not a direct child
    const doc = n.doc.create(null, [
      proseWrap('pr-outer', code('inner-id')),
      p('X'),
    ])
    expect(blockIndexAfter(doc, 'inner-id')).toBe(-1)
  })
})

// ── docPosForBlockIndex ───────────────────────────────────────────────────────

describe('docPosForBlockIndex', () => {
  it('returns position at start of block 3 (p3), which is after p1+p2+diagram', () => {
    const doc = buildExtractDoc()
    // p('A') nodeSize=3, p('B') nodeSize=3, diag nodeSize=1 (atom leaf) → total=7
    // Block 3 starts at pos 7
    const idx = blockIndexAfter(doc, 'di-39ad') // = 3
    const pos = docPosForBlockIndex(doc, idx)
    expect(pos).toBe(7) // 3+3+1 = 7
  })

  it('returns 0 for index 0 (start of doc)', () => {
    const doc = buildExtractDoc()
    expect(docPosForBlockIndex(doc, 0)).toBe(0)
  })

  it('returns doc.content.size for idx >= childCount', () => {
    const doc = buildExtractDoc()
    expect(docPosForBlockIndex(doc, doc.childCount)).toBe(doc.content.size)
    expect(docPosForBlockIndex(doc, 99)).toBe(doc.content.size)
  })

  it('returns doc.content.size for null idx', () => {
    const doc = buildExtractDoc()
    expect(docPosForBlockIndex(doc, null)).toBe(doc.content.size)
  })

  it('returns doc.content.size for a NEGATIVE idx (e.g. a missed lookup), not 0/doc-start', () => {
    const doc = buildExtractDoc()
    expect(docPosForBlockIndex(doc, -1)).toBe(doc.content.size)
  })
})

// ── blockIndexForInsert ───────────────────────────────────────────────────────

describe('blockIndexForInsert', () => {
  it('returns childCount when pos is null (append)', () => {
    const doc = buildExtractDoc()
    expect(blockIndexForInsert(doc, null)).toBe(doc.childCount)
  })

  it('returns 0 when pos is at the very start (pos=0)', () => {
    const doc = buildExtractDoc()
    // pos=0 is before everything, no children end at or before 0
    expect(blockIndexForInsert(doc, 0)).toBe(0)
  })

  it('returns correct index for a position at the start of the fourth child', () => {
    const doc = buildExtractDoc()
    // p('A')=3, p('B')=3, diag=1 → child 3 (p3) starts at offset 7.
    // i=0: offset=3 <=7 → idx=1; i=1: offset=6 <=7 → idx=2; i=2: offset=7 <=7 → idx=3; i=3: offset=10 >7 → break
    expect(blockIndexForInsert(doc, 7)).toBe(3)
  })

  it('accepts an object with .from field (sieveInsertPos from-range form)', () => {
    const doc = buildExtractDoc()
    expect(blockIndexForInsert(doc, { from: 3, to: 3 })).toBe(1)
  })
})

// ── enclosingBlockId ──────────────────────────────────────────────────────────

describe('enclosingBlockId', () => {
  it('(a) returns own id when a top-level atom node (diagram) is the enclosing block', () => {
    const doc = n.doc.create(null, [diag('di-abc'), p('X')])
    // sieve-diagram is an atom leaf: nodeSize=1, occupies range [0, 1)
    // pos=0 is within [0,1) so enclosingBlockId returns 'di-abc'
    expect(enclosingBlockId(doc, 0)).toBe('di-abc')
    // pos=1 starts p('X'), so returns '' (paragraph has no id attr)
    expect(enclosingBlockId(doc, 1)).toBe('')
  })

  it('(b) returns wrapper prose id when a codeBlock with empty id is nested inside sieve-prose', () => {
    // sieve-prose(id='pr-xyz') > codeBlock(id='')
    const proseNode = proseWrap('pr-xyz', code(''))
    const doc = n.doc.create(null, [p('before'), proseNode, p('after')])
    // p('before') nodeSize = 2 + text('before').size = 2 + 6 = 8
    // proseNode: starts at offset 8, nodeSize=4 (2 wrapper + codeBlock nodeSize=2)
    // Any pos in [8, 12) is within proseNode
    const proseOffset = p('before').nodeSize // 8
    const posInsideProse = proseOffset + 1 // 9 = inside sieve-prose range [8,12)
    expect(enclosingBlockId(doc, posInsideProse)).toBe('pr-xyz')
  })

  it('returns empty string when the top-level node has no id attr', () => {
    const doc = n.doc.create(null, [p('X'), p('Y')])
    // paragraph has no id attr
    expect(enclosingBlockId(doc, 1)).toBe('')
  })
})

// ── blockIndexAt ─────────────────────────────────────────────────────────────
// The POSITION-native anchor lookup (#67): where a range source lives, there is
// no block id to resolve — a prose link's paragraph may not even have been
// minted one yet.

describe('blockIndexAt', () => {
  it('returns the index of the top-level block containing the position', () => {
    const doc = n.doc.create(null, [p('one'), p('two'), p('three')])
    expect(blockIndexAt(doc, 0)).toBe(0)
    expect(blockIndexAt(doc, 2)).toBe(0)   // inside 'one'
    expect(blockIndexAt(doc, 5)).toBe(1)   // inside 'two'  (starts at 5)
    expect(blockIndexAt(doc, 11)).toBe(2)  // inside 'three'(starts at 10)
  })

  it('returns -1 for a position past the end of the document', () => {
    const doc = n.doc.create(null, [p('one')])
    expect(blockIndexAt(doc, doc.content.size)).toBe(-1)
  })

  it('resolves an atom block by its own single position', () => {
    const doc = n.doc.create(null, [diag('di-1'), p('after')])
    expect(blockIndexAt(doc, 0)).toBe(0)
    expect(blockIndexAt(doc, 1)).toBe(1)
  })

  it('is the walk enclosingBlockId is built on (same block, same answer)', () => {
    const doc = n.doc.create(null, [p('one'), diag('di-2')])
    expect(blockIndexAt(doc, 5)).toBe(1)
    expect(enclosingBlockId(doc, 5)).toBe('di-2')
  })
})
