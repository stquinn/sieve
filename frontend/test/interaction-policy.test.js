import { describe, it, expect } from 'vitest'
import { registerBlockKind } from '../src/static/block/block-kinds.js'
import {
  DEFAULT_POLICY, policyFor, classifyContext,
  indentInsertions, dedentDeletions, leadingIndentAt, smartHomeTarget,
} from '../src/static/editor/interaction-policy.js'

describe('policyFor', () => {
  it('merges a declared policy over defaults', () => {
    registerBlockKind({ kind: 'test-raw', native: false, renderer: {
      interactionPolicy: { rawText: true, indentWidth: 2, enterInsertsNewline: true },
    }})
    const p = policyFor('test-raw')
    expect(p.rawText).toBe(true)
    expect(p.indentWidth).toBe(2)
    expect(p.caretStop).toBe(false) // default survives
  })
  it('unknown kind gets pure defaults', () => {
    expect(policyFor('nope')).toEqual(DEFAULT_POLICY)
  })
})

describe('classifyContext', () => {
  it('sieve-code parent → kind code', () => {
    const c = classifyContext({ parentTypeName: 'sieve-code', ancestorTypeNames: [] })
    expect(c.kind).toBe('code')
  })
  it('paragraph inside listItem → prose, inList', () => {
    const c = classifyContext({ parentTypeName: 'paragraph', ancestorTypeNames: ['bulletList', 'listItem'] })
    expect(c.kind).toBe('prose')
    expect(c.inList).toBe(true)
    expect(c.inTable).toBe(false)
  })
  it('paragraph inside tableCell → inTable', () => {
    const c = classifyContext({ parentTypeName: 'paragraph', ancestorTypeNames: ['table', 'tableRow', 'tableCell'] })
    expect(c.inTable).toBe(true)
  })
  it('node selection on sieve-web-clip → kind web-clip, isNodeSelection', () => {
    const c = classifyContext({ parentTypeName: 'doc', ancestorTypeNames: [], nodeSelectionTypeName: 'sieve-web-clip' })
    expect(c.kind).toBe('web-clip')
    expect(c.isNodeSelection).toBe(true)
  })
})

describe('indent transforms', () => {
  const text = 'aa\n  bb\ncc'
  it('indentInsertions covers every selected line, descending', () => {
    const ins = indentInsertions(text, 0, text.length, 2)
    expect(ins).toEqual([{ pos: 8, insert: '  ' }, { pos: 3, insert: '  ' }, { pos: 0, insert: '  ' }])
  })
  it('collapsed caret inserts at the caret (VS Code semantics)', () => {
    expect(indentInsertions(text, 4, 4, 2)).toEqual([{ pos: 4, insert: '  ' }])
  })
  it('dedentDeletions removes at most w leading spaces per line', () => {
    const del = dedentDeletions(text, 0, text.length, 2)
    expect(del).toEqual([{ from: 3, to: 5 }]) // only line 2 has leading spaces
  })
})

describe('declared policies', () => {
  it('a raw-text declaration matches the code/diagram contract row', () => {
    registerBlockKind({ kind: 'code', native: false, renderer: {
      interactionPolicy: { rawText: true, indentWidth: 2, enterInsertsNewline: true, autoIndentOnEnter: true },
    }})
    const p = policyFor('code')
    expect(p.rawText).toBe(true)
    expect(p.indentWidth).toBe(2)
    expect(p.autoIndentOnEnter).toBe(true)
    expect(p.modEnterTogglesMode).toBe(false)
  })
})

describe('auto-indent + home', () => {
  it('leadingIndentAt copies the current line indent', () => {
    expect(leadingIndentAt('if x:\n    y = 1', 12)).toBe('    ')
    expect(leadingIndentAt('plain', 3)).toBe('')
  })
  it('smartHomeTarget toggles first-non-ws / 0', () => {
    expect(smartHomeTarget('    code', 8)).toBe(4)
    expect(smartHomeTarget('    code', 4)).toBe(0)
    expect(smartHomeTarget('nows', 2)).toBe(0)
  })
})
