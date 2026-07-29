import { describe, it, expect } from 'vitest'
import { registerBlockKind } from '../src/static/block/block-kinds.js'
import {
  DEFAULT_POLICY, CODE_TEXT_POLICY, policyFor, classifyContext,
  indentInsertions, dedentDeletions, leadingIndentAt, smartHomeTarget,
  textInputEdit, applyTextEdit, pairDeleteEdit, pairExpandEdit, handleSubstitutionGuard,
} from '../src/static/editor/interaction-policy.js'

describe('policyFor', () => {
  it('merges a declared policy over defaults', () => {
    registerBlockKind({ kind: 'test-raw', native: false, renderer: {
      interactionPolicy: { tabIndents: true, indentWidth: 2, enterInsertsNewline: true },
    }})
    const p = policyFor('test-raw')
    expect(p.tabIndents).toBe(true)
    expect(p.indentWidth).toBe(2)
    expect(p.caretStop).toBe(false) // default survives
  })
  it('unknown kind gets pure defaults', () => {
    expect(policyFor('nope')).toEqual(DEFAULT_POLICY)
  })
  it('expandable defaults false and merges when declared', () => {
    expect(DEFAULT_POLICY.expandable).toBe(false)
    registerBlockKind({ kind: 'test-expand', native: false, renderer: {
      interactionPolicy: { expandable: true },
    }})
    expect(policyFor('test-expand').expandable).toBe(true)
    expect(policyFor('nope').expandable).toBe(false)
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
  it('native codeBlock → kind code (both code surfaces share one policy)', () => {
    const c = classifyContext({ parentTypeName: 'codeBlock', ancestorTypeNames: [] })
    expect(c.kind).toBe('code')
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
  it('the code preset matches the code/diagram contract row', () => {
    registerBlockKind({ kind: 'code', native: false, renderer: {
      interactionPolicy: { ...CODE_TEXT_POLICY },
    }})
    const p = policyFor('code')
    expect(p.tabIndents).toBe(true)
    expect(p.smartHome).toBe(true)
    expect(p.indentWidth).toBe(2)
    expect(p.autoIndentOnEnter).toBe(true)
    expect(p.modEnterTogglesMode).toBe(false)
  })

  it('a kind can override any single line of the preset after the spread', () => {
    registerBlockKind({ kind: 'test-preset-override', native: false, renderer: {
      interactionPolicy: { ...CODE_TEXT_POLICY, indentWidth: 4, smartHome: false },
    }})
    const p = policyFor('test-preset-override')
    expect(p.indentWidth).toBe(4)
    expect(p.smartHome).toBe(false)
    expect(p.tabIndents).toBe(true) // rest of the preset survives
  })

  it('the preset is frozen — spreading it can never mutate the shared object', () => {
    expect(Object.isFrozen(CODE_TEXT_POLICY)).toBe(true)
  })

  // Guards the drift that let readOnlyText sit in DEFAULT_POLICY with a live
  // branch and no real declarer: every default key must be one policyFor emits.
  it('every DEFAULT_POLICY key survives the merge for an undeclared kind', () => {
    const p = policyFor('nope')
    for (const k of Object.keys(DEFAULT_POLICY)) expect(p).toHaveProperty(k)
  })

  it('CODE_TEXT_POLICY declares only keys DEFAULT_POLICY knows', () => {
    for (const k of Object.keys(CODE_TEXT_POLICY)) expect(DEFAULT_POLICY).toHaveProperty(k)
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

// Every case goes through applyTextEdit — the SAME applier the markdown
// textarea uses — so these assert the shipped transform, not a restatement.
// Built from the preset directly, not via policyFor('code') — registration
// happens inside an it() above, so a lookup here would race the suite order.
const CODE = { ...DEFAULT_POLICY, ...CODE_TEXT_POLICY }
const PROSE_ONLY = { ...DEFAULT_POLICY, surroundSelection: true }

/** @returns {string} text with | at the caret, or |sel| around a selection */
function run(text, from, to, ch, policy) {
  const edit = textInputEdit(text, from, to, ch, policy)
  if (!edit) return null
  const r = applyTextEdit(text, edit)
  const lo = Math.min(r.caret, r.head)
  const hi = Math.max(r.caret, r.head)
  return lo === hi
    ? r.text.slice(0, lo) + '|' + r.text.slice(lo)
    : r.text.slice(0, lo) + '|' + r.text.slice(lo, hi) + '|' + r.text.slice(hi)
}

describe('surround selection', () => {
  it('wraps the selection and keeps it selected, for every pair', () => {
    expect(run('hello world', 0, 5, '"', CODE)).toBe('"|hello|" world')
    expect(run('hello world', 0, 5, "'", CODE)).toBe("'|hello|' world")
    expect(run('hello world', 0, 5, '`', CODE)).toBe('`|hello|` world')
    expect(run('hello world', 0, 5, '(', CODE)).toBe('(|hello|) world')
    expect(run('hello world', 0, 5, '[', CODE)).toBe('[|hello|] world')
    expect(run('hello world', 0, 5, '{', CODE)).toBe('{|hello|} world')
  })
  it('stays selected so the gesture nests', () => {
    const once = textInputEdit('abc', 0, 3, '(', CODE)
    const r1 = applyTextEdit('abc', once)
    expect(r1.text).toBe('(abc)')
    const r2 = applyTextEdit(r1.text, textInputEdit(r1.text, r1.caret, r1.head, '[', CODE))
    expect(r2.text).toBe('([abc])')
  })
  it('is inert for a non-pair character', () => {
    expect(run('hello', 0, 5, 'x', CODE)).toBe(null)
  })
  it('prose gets surround without autoclose', () => {
    expect(run('hello', 0, 5, '(', PROSE_ONLY)).toBe('(|hello|)')
    expect(run('hello', 5, 5, '(', PROSE_ONLY)).toBe(null) // collapsed → native
  })
  it('a kind declaring neither flag is entirely native', () => {
    expect(run('hello', 0, 5, '(', DEFAULT_POLICY)).toBe(null)
  })
})

describe('autoclose', () => {
  it('inserts the pair at a collapsed caret', () => {
    expect(run('', 0, 0, '(', CODE)).toBe('(|)')
    expect(run('x = ', 4, 4, '[', CODE)).toBe('x = [|]')
  })
  it('does NOT close against a following word character', () => {
    expect(run('foo', 0, 0, '(', CODE)).toBe(null)
  })
  it('DOES close before whitespace, EOF, or a closing bracket', () => {
    expect(run(' foo', 0, 0, '(', CODE)).toBe('(|) foo')
    expect(run('f()', 2, 2, '[', CODE)).toBe('f([|])')
  })
  it('a quote never opens against a word on its LEFT (apostrophes)', () => {
    expect(run('don', 3, 3, "'", CODE)).toBe(null)
    expect(run('say ', 4, 4, "'", CODE)).toBe("say '|'")
  })
  it('types OVER an existing closer instead of doubling it', () => {
    expect(run('()', 1, 1, ')', CODE)).toBe('()|')
    expect(run('""', 1, 1, '"', CODE)).toBe('""|')
  })
  it('type-over wins over autoclose for symmetric pairs', () => {
    // `"` both opens and closes; with one already at the caret, move past it.
    expect(run('a""', 2, 2, '"', CODE)).toBe('a""|')
  })
})

describe('pair deletion + Enter expansion', () => {
  it('backspace between an empty pair deletes both halves', () => {
    const edit = pairDeleteEdit('a()b', 2, 2)
    expect(applyTextEdit('a()b', edit).text).toBe('ab')
  })
  it('backspace is inert when the pair is not empty', () => {
    expect(pairDeleteEdit('a(x)b', 2, 2)).toBe(null)
  })
  it('backspace is inert on a mismatched pair', () => {
    expect(pairDeleteEdit('a(]b', 2, 2)).toBe(null)
  })
  it('Enter inside an empty pair expands to a block at the line indent', () => {
    const text = '  if x {}'
    const r = applyTextEdit(text, pairExpandEdit(text, 8, 8, 2))
    expect(r.text).toBe('  if x {\n    \n  }')
    expect(r.text.slice(0, r.caret)).toBe('  if x {\n    ') // caret on the body line
  })
  it('Enter expansion is inert when not between a pair', () => {
    expect(pairExpandEdit('if x {', 6, 6, 2)).toBe(null)
  })
})

describe('OS text-substitution guard', () => {
  const ev = (inputType) => {
    let prevented = false
    return { inputType, preventDefault: () => { prevented = true }, wasPrevented: () => prevented }
  }
  it('cancels insertReplacementText where the kind declares the guard', () => {
    const e = ev('insertReplacementText')
    expect(handleSubstitutionGuard(e, CODE)).toBe(true)
    expect(e.wasPrevented()).toBe(true)
  })
  it('leaves ordinary typing and deliberate pastes alone', () => {
    expect(handleSubstitutionGuard(ev('insertText'), CODE)).toBe(false)
    expect(handleSubstitutionGuard(ev('insertFromPaste'), CODE)).toBe(false)
  })
  it('is inert for kinds that do not declare it (prose keeps smart quotes)', () => {
    const e = ev('insertReplacementText')
    expect(handleSubstitutionGuard(e, DEFAULT_POLICY)).toBe(false)
    expect(e.wasPrevented()).toBe(false)
  })
})
