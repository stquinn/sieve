import { describe, it, expect } from 'vitest'
import { docWithCaret, build } from './helpers/editor-fixture.js'
import { caretInRawTextBlock } from '../src/static/editor/paste-context.js'

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

  it('null / missing editor → false (no crash)', () => {
    expect(caretInRawTextBlock(null)).toBe(false)
    expect(caretInRawTextBlock({})).toBe(false)
  })
})
