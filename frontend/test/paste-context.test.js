import { describe, it, expect } from 'vitest'
import { docWithCaret, docWithCaretNear, build } from './helpers/editor-fixture.js'
import { caretInRawTextBlock, caretInTableCell, caretInReadOnlyRegion } from '../src/static/lens/document-editor/paste-context.js'
import { registerBlockKind } from '../src/static/renderers/block-kinds.js'

// caretInRawTextBlock is the small pure predicate that tells the smart-paste
// handler to step aside: when the caret sits inside a code:true fenced block
// (code / diagram / log), a paste must be a literal text paste into that block,
// not a smart-paste that creates a new block.

describe('caretInRawTextBlock', () => {
  it('caret inside a code:true block → true (paste stays literal)', () => {
    const { editor } = docWithCaret([build.code('print(1)')], 0, 3)
    expect(caretInRawTextBlock(editor)).toBe(true)
  })

  it('caret inside prose → false (smart-paste runs)', () => {
    const { editor } = docWithCaret([build.p('hello world')], 0, 3)
    expect(caretInRawTextBlock(editor)).toBe(false)
  })
})

// A table cell takes inline text but no blocks, so a paste there is the native
// text paste prosemirror-tables merges into the cell.
describe('caretInTableCell', () => {
  it.each([
    ['a body cell', () => docWithCaretNear([build.table('t', 'cell')], 3), true],
    ['a header cell', () => docWithCaretNear([build.table('t', 'head', 'tableHeader')], 3), true],
    ['a top-level paragraph', () => docWithCaret([build.p('hello')], 0, 2), false],
    ['a list item', () => docWithCaretNear([build.bulletList('l', ['a'])], 3), false],
    ['a code block', () => docWithCaret([build.code('x')], 0, 1), false],
  ])('caret in %s → %s', (_label, make, expected) => {
    expect(caretInTableCell(make().editor)).toBe(expected)
  })
})

// A read-only region is what a kind DECLARES: `readOnlyText`, or an unconditional
// caret stop. Nothing pasted there lands, so the smart-paste steps aside and the
// region's node view consumes the paste (D3 web-clip body, D5 ai-block body).
describe('caretInReadOnlyRegion', () => {
  it.each([
    ['caretStop: true (web-clip, ai-block)', { caretStop: true }, true],
    ['readOnlyText (log)', { readOnlyText: true }, true],
    ["caretStop: 'render' (diagram)", { caretStop: 'render' }, false],
    ['no read-only declaration', {}, false],
  ])('caret in the body of a container declaring %s → %s', (_label, interactionPolicy, expected) => {
    registerBlockKind({ kind: 'web-clip', native: false, renderer: { interactionPolicy } })
    expect(caretInReadOnlyRegion(docWithCaretNear([build.webClip('w', 'clip body')], 3).editor)).toBe(expected)
  })

  it.each([
    ['a top-level paragraph', () => docWithCaret([build.p('hello')], 0, 2)],
    ['a table cell', () => docWithCaretNear([build.table('t', 'cell')], 3)],
    ['a code block', () => docWithCaret([build.code('x')], 0, 1)],
  ])('caret in %s → false', (_label, make) => {
    registerBlockKind({ kind: 'web-clip', native: false, renderer: { interactionPolicy: { caretStop: true } } })
    expect(caretInReadOnlyRegion(make().editor)).toBe(false)
  })
})

describe.each([caretInRawTextBlock, caretInTableCell, caretInReadOnlyRegion])('%o', (predicate) => {
  it('null / missing editor → false (no crash)', () => {
    expect(predicate(null)).toBe(false)
    expect(predicate({})).toBe(false)
  })
})
