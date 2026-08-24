import { describe, it, expect, beforeEach } from 'vitest'
import { BlockSelection } from '../src/static/lens/document-editor/block-selection.js'

// A click anywhere in a block makes it the caret/selection owner — EXCEPT on
// interactive controls / chrome, inside editable text (PM owns the caret there),
// or when a text drag-select sits inside the block (copy).

function build() {
  const block = document.createElement('div')
  block.className = 'sieve-block'

  const header = document.createElement('div')
  header.className = 'sieve-block__header'
  const headerBtn = document.createElement('div') // e.g. a column-toggle badge (a div, not a <button>)
  headerBtn.className = 'badge'
  header.appendChild(headerBtn)

  const body = document.createElement('div')
  const table = document.createElement('div') // log Explore table — a plain custom region
  const cell = document.createElement('div')
  table.appendChild(cell)
  const button = document.createElement('button')
  const input = document.createElement('input')
  body.appendChild(table)
  body.appendChild(button)
  body.appendChild(input)

  const contentDOM = document.createElement('code') // editable raw text
  const textNode = document.createElement('span')
  contentDOM.appendChild(textNode)

  block.appendChild(header)
  block.appendChild(body)
  block.appendChild(contentDOM)
  document.body.appendChild(block)
  return { block, header, headerBtn, table, cell, button, input, contentDOM, textNode }
}

describe('shouldClaimBlockSelection', () => {
  let els
  beforeEach(() => {
    document.body.innerHTML = ''
    els = build()
  })

  const collapsed = { isCollapsed: true }

  it('claims the block for a plain click on a custom region (log Explore cell)', () => {
    expect(BlockSelection.shouldClaim(els.cell, els.block, els.contentDOM, collapsed)).toBe(true)
  })

  it('does NOT claim when clicking an interactive control (button / input)', () => {
    expect(BlockSelection.shouldClaim(els.button, els.block, els.contentDOM, collapsed)).toBe(false)
    expect(BlockSelection.shouldClaim(els.input, els.block, els.contentDOM, collapsed)).toBe(false)
  })

  it('does NOT claim when clicking anywhere in the header/chrome (even a non-button control)', () => {
    expect(BlockSelection.shouldClaim(els.headerBtn, els.block, els.contentDOM, collapsed)).toBe(false)
  })

  it('does NOT claim when clicking inside editable text (contentDOM) — PM owns the caret', () => {
    expect(BlockSelection.shouldClaim(els.textNode, els.block, els.contentDOM, collapsed)).toBe(false)
  })

  it('does NOT claim while a text drag-select sits inside the block (copy)', () => {
    const dragSel = { isCollapsed: false, anchorNode: els.cell }
    expect(BlockSelection.shouldClaim(els.cell, els.block, els.contentDOM, dragSel)).toBe(false)
  })

  it('still claims when a text selection exists but OUTSIDE this block', () => {
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    const otherSel = { isCollapsed: false, anchorNode: outside }
    expect(BlockSelection.shouldClaim(els.cell, els.block, els.contentDOM, otherSel)).toBe(true)
  })

  it('claims for an atom block with no contentDOM', () => {
    expect(BlockSelection.shouldClaim(els.cell, els.block, null, collapsed)).toBe(true)
  })

  it('ignores a target outside the block', () => {
    const stray = document.createElement('div')
    document.body.appendChild(stray)
    expect(BlockSelection.shouldClaim(stray, els.block, els.contentDOM, collapsed)).toBe(false)
  })
})
