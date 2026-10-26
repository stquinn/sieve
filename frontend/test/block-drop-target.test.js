// @ts-check
// BlockDropTarget — where a drop between top-level blocks lands, and the block a
// placement there follows.

import { describe, it, expect } from 'vitest'
import { build, schema } from './helpers/editor-fixture.js'
import { BlockDropTarget } from '../src/static/lens/document-editor/surfaces/block-drop-target.js'

// [p "one" b1][image i1][p "" — no id]
const doc = schema.nodes.doc.create(null, [build.p('one', 'b1'), build.image('i1'), build.p('', '')])
const p1 = doc.child(0).nodeSize
const img = doc.child(1).nodeSize

describe('BlockDropTarget.boundary', () => {
  it.each([
    ['before the first block is the front', 2, true, { pos: 0, afterBlockId: null }],
    ['after the first block follows it', 2, false, { pos: p1, afterBlockId: 'b1' }],
    ['before the image follows the block above it', p1, true, { pos: p1, afterBlockId: 'b1' }],
    ['after the image follows the image', p1, false, { pos: p1 + img, afterBlockId: 'i1' }],
    ['a block with no id is skipped back over', p1 + img + 1, false, { pos: doc.content.size, afterBlockId: 'i1' }],
    ['past the last block is the end', doc.content.size, true, { pos: doc.content.size, afterBlockId: 'i1' }],
  ])('%s', (_name, pos, before, want) => {
    expect(BlockDropTarget.boundary(doc, pos, before)).toEqual(want)
  })
})

describe('BlockDropTarget.boundaryAtCoords', () => {
  // The image's box spans y 100..200; the pointer's half of it picks the side.
  function view(pos) {
    return {
      state: { doc },
      posAtCoords: () => (pos === null ? null : { pos }),
      nodeDOM: () => ({ getBoundingClientRect: () => ({ top: 100, height: 100 }) }),
    }
  }

  it('the upper half of a block is the boundary before it', () => {
    expect(BlockDropTarget.boundaryAtCoords(view(p1), 0, 120)).toEqual({ pos: p1, afterBlockId: 'b1' })
  })

  it('the lower half of a block is the boundary after it', () => {
    expect(BlockDropTarget.boundaryAtCoords(view(p1), 0, 180)).toEqual({ pos: p1 + img, afterBlockId: 'i1' })
  })

  it('a point over no document position has no boundary', () => {
    expect(BlockDropTarget.boundaryAtCoords(view(null), 0, 120)).toBeNull()
  })
})
