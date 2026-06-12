import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { docWithCaret, build } from './helpers/editor-fixture.js'

let capture, restore
beforeEach(async () => {
  global.window.TipTap = global.window.TipTap || {}
  await import('../src/static/focus-context.js')
  capture = window.TipTap.captureFocusContext
  restore = window.TipTap.restoreFocusContext
  document.body.innerHTML = ''
})
afterEach(() => { document.body.innerHTML = '' })

describe('captureFocusContext', () => {
  it('no focused block → editor selection {kind,from,to}', () => {
    const { editor } = docWithCaret([build.p('hello world')], 0, 3)
    const ctx = capture(editor)
    expect(ctx.kind).toBe('editor')
    expect(ctx.from).toBe(editor.state.selection.from)
    expect(ctx.to).toBe(editor.state.selection.to)
  })

  it('focused .sieve-block__edit → block kind + textarea token', () => {
    const host = document.createElement('div')
    host.setAttribute('data-id', 'code-7')
    const ta = document.createElement('textarea')
    ta.className = 'sieve-block__edit'
    ta.value = 'print(1)'
    host.appendChild(ta)
    document.body.appendChild(host)
    ta.focus()
    ta.selectionStart = ta.selectionEnd = 5

    const ctx = capture(null)
    expect(ctx.kind).toBe('block')
    expect(ctx.blockId).toBe('code-7')
    expect(ctx.token.start).toBe(5)
    expect(ctx.token.end).toBe(5)
  })

  it('per-flavour hook overrides the generic textarea read', () => {
    const host = document.createElement('div')
    host.setAttribute('data-id', 'blk-9')
    host.__sieveFocus = { capture: () => ({ pane: 'stdout', line: 12 }) }
    const ta = document.createElement('textarea')
    ta.className = 'sieve-block__edit'
    host.appendChild(ta)
    document.body.appendChild(host)
    ta.focus()

    const ctx = capture(null)
    expect(ctx.kind).toBe('block')
    expect(ctx.token).toEqual({ pane: 'stdout', line: 12 })
  })
})

describe('restoreFocusContext', () => {
  it('block ctx → focuses the block textarea and restores selection', () => {
    const host = document.createElement('div')
    host.setAttribute('data-id', 'code-7')
    const ta = document.createElement('textarea')
    ta.className = 'sieve-block__edit'
    ta.value = 'print(1)'
    host.appendChild(ta)
    document.body.appendChild(host)

    restore(null, { kind: 'block', blockId: 'code-7', token: { start: 3, end: 6 } })
    expect(document.activeElement).toBe(ta)
    expect(ta.selectionStart).toBe(3)
    expect(ta.selectionEnd).toBe(6)
  })

  it('block ctx → per-flavour restore hook is used when present', () => {
    const host = document.createElement('div')
    host.setAttribute('data-id', 'blk-9')
    let restored = null
    host.__sieveFocus = { restore: (t) => { restored = t } }
    document.body.appendChild(host)

    restore(null, { kind: 'block', blockId: 'blk-9', token: { pane: 'stdout' } })
    expect(restored).toEqual({ pane: 'stdout' })
  })

  it('clamps a stale token past the textarea length', () => {
    const host = document.createElement('div')
    host.setAttribute('data-id', 'code-7')
    const ta = document.createElement('textarea')
    ta.className = 'sieve-block__edit'
    ta.value = 'ab'
    host.appendChild(ta)
    document.body.appendChild(host)

    restore(null, { kind: 'block', blockId: 'code-7', token: { start: 99, end: 99 } })
    expect(ta.selectionStart).toBe(2)
    expect(ta.selectionEnd).toBe(2)
  })
})
