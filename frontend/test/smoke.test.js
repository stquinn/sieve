import { describe, it, expect } from 'vitest'
import { docWithCaret, build } from './helpers/editor-fixture.js'

describe('fixture harness', () => {
  it('builds a doc with a caret', () => {
    const { editor } = docWithCaret([build.p('hello')], 0, 1)
    expect(editor.state.doc.childCount).toBe(1)
    expect(editor.state.selection.empty).toBe(true)
  })
})
