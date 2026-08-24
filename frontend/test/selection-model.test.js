// selection-model.test.js — P3.A unit tests for the SelectionModel core.
// Imports the REAL class (dual-use ES module). The model takes PLAIN raw
// descriptors (no PM node) and owns a frozen SelectionContext: it normalizes +
// freezes, coalesces caret-only noise (silent update, still pullable), pushes on
// meaningful/identity change only, injects the immutable docUuid, and runs an
// onUpdate registry with per-listener exception isolation.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SelectionModel } from '../src/static/lens/document-editor/selection-model.js'

const UUID = 'doc-uuid-1'

// A raw descriptor the surface would hand in (see WysiwygSurface.feedSelection).
// docUuid/focusZone are NOT the surface's to set — the model owns them.
function raw(overrides = {}) {
  return Object.assign({
    selectionType: 'caret',
    caret: 5,
    range: { from: 5, to: 5 },
    selectedText: null,
    blockId: 'b1',
    blockIds: ['b1'],
    blockKind: 'prose',
    ref: null,
    // P3.E: the block's own inner cursor (opaque, caret-like); null for a plain
    // prose caret. Excluded from the meaningful diff — a change to it alone is silent.
    blockCursor: null,
    // P3.C: the surface resolves the AI target and hands it in (label lives inside).
    target: { kind: 'document', ref: 'doc', range: null, label: 'Document' },
  }, overrides)
}

describe('SelectionModel — initial context (P3.A)', () => {
  it('starts with a frozen none context for the injected docUuid', () => {
    const m = new SelectionModel(UUID)
    const ctx = m.getContext()
    expect(ctx).toEqual({
      docUuid: UUID,
      selectionType: 'none',
      caret: null,
      range: null,
      selectedText: null,
      blockId: null,
      blockIds: [],
      blockKind: null,
      ref: null,
      focusZone: 'editor',
      // P3.E: no block hosts an inner cursor at 'none'.
      blockCursor: null,
      // P3.C: 'none'/initial ⇒ the document target (label ALWAYS present).
      target: { kind: 'document', ref: 'doc', range: null, label: 'Document' },
      // issue #51: no scroll report has arrived yet.
      scroll: null,
    })
  })

  it('requires a docUuid', () => {
    expect(() => new SelectionModel('')).toThrow()
    expect(() => new SelectionModel()).toThrow()
  })

  it('freezes the context, its range object, and its blockIds array', () => {
    const m = new SelectionModel(UUID)
    m.ingest(raw({ selectionType: 'range', selectedText: 'hi', range: { from: 2, to: 4 }, blockIds: ['b1', 'b2'] }))
    const ctx = m.getContext()
    expect(Object.isFrozen(ctx)).toBe(true)
    expect(Object.isFrozen(ctx.range)).toBe(true)
    expect(Object.isFrozen(ctx.blockIds)).toBe(true)
    // Strict mode (ES modules): mutation throws.
    expect(() => { ctx.selectionType = 'none' }).toThrow()
    expect(() => { ctx.range.from = 99 }).toThrow()
    expect(() => { ctx.blockIds.push('x') }).toThrow()
  })
})

describe('SelectionModel — selectionType classification (P3.A)', () => {
  it('trusts the descriptor selectionType for none/caret/range/block', () => {
    const m = new SelectionModel(UUID)
    m.ingest(raw({ selectionType: 'none', caret: null, range: null, blockId: null, blockIds: [] }))
    expect(m.getContext().selectionType).toBe('none')
    m.ingest(raw({ selectionType: 'caret' }))
    expect(m.getContext().selectionType).toBe('caret')
    m.ingest(raw({ selectionType: 'range', selectedText: 'sel', range: { from: 1, to: 3 } }))
    expect(m.getContext().selectionType).toBe('range')
    m.ingest(raw({ selectionType: 'block', blockId: 'b9', blockIds: ['b9'] }))
    expect(m.getContext().selectionType).toBe('block')
  })

  it('a range carries selectedText; a caret has null selectedText', () => {
    const m = new SelectionModel(UUID)
    m.ingest(raw({ selectionType: 'range', selectedText: 'the words', range: { from: 1, to: 10 } }))
    expect(m.getContext().selectedText).toBe('the words')
    m.ingest(raw({ selectionType: 'caret', selectedText: null }))
    expect(m.getContext().selectedText).toBeNull()
  })
})

describe('SelectionModel — docUuid injection + immutability (P3.A)', () => {
  it('always injects the constructor docUuid, ignoring any in the descriptor', () => {
    const m = new SelectionModel(UUID)
    m.ingest(Object.assign(raw(), { docUuid: 'evil-other-uuid' }))
    expect(m.getContext().docUuid).toBe(UUID)
  })

  it('never changes docUuid across ingests', () => {
    const m = new SelectionModel(UUID)
    m.ingest(raw({ blockId: 'a' }))
    m.ingest(raw({ blockId: 'b' }))
    m.setFocusZone('ask')
    expect(m.getContext().docUuid).toBe(UUID)
  })
})

describe('SelectionModel — meaningful-change coalescing (P3.A)', () => {
  it('caret-only move within the same block does NOT emit but IS pullable', () => {
    const m = new SelectionModel(UUID)
    const fn = vi.fn()
    m.ingest(raw({ caret: 5, range: { from: 5, to: 5 } })) // establish baseline (emits)
    m.onUpdate(fn)
    m.ingest(raw({ caret: 8, range: { from: 8, to: 8 } })) // same block, new caret
    expect(fn).not.toHaveBeenCalled()
    // …but the pull reflects the new caret + range.
    expect(m.getContext().caret).toBe(8)
    expect(m.getContext().range).toEqual({ from: 8, to: 8 })
  })

  it('a blockCursor-only change does NOT emit but IS pullable (caret-like)', () => {
    const m = new SelectionModel(UUID)
    const fn = vi.fn()
    m.ingest(raw({ blockCursor: { start: 1, end: 1 } })) // baseline (emits)
    m.onUpdate(fn)
    // Only the block's inner cursor moved; every meaningful key is identical.
    m.ingest(raw({ blockCursor: { start: 9, end: 9 } }))
    expect(fn).not.toHaveBeenCalled()
    // …but the pull reflects the new inner cursor (silent, still pullable).
    expect(m.getContext().blockCursor).toEqual({ start: 9, end: 9 })
  })

  it('a blockId change emits', () => {
    const m = new SelectionModel(UUID)
    m.ingest(raw({ blockId: 'b1', blockIds: ['b1'] }))
    const fn = vi.fn()
    m.onUpdate(fn)
    m.ingest(raw({ blockId: 'b2', blockIds: ['b2'] }))
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn.mock.calls[0][0].blockId).toBe('b2')
  })

  it('a selectionType change emits', () => {
    const m = new SelectionModel(UUID)
    m.ingest(raw({ selectionType: 'caret' }))
    const fn = vi.fn()
    m.onUpdate(fn)
    m.ingest(raw({ selectionType: 'range', selectedText: 'x', range: { from: 5, to: 6 } }))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('a selectedText change (same range identity) emits', () => {
    const m = new SelectionModel(UUID)
    m.ingest(raw({ selectionType: 'range', selectedText: 'aaa', range: { from: 1, to: 4 } }))
    const fn = vi.fn()
    m.onUpdate(fn)
    m.ingest(raw({ selectionType: 'range', selectedText: 'bbb', range: { from: 1, to: 4 } }))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('a blockKind change emits', () => {
    const m = new SelectionModel(UUID)
    m.ingest(raw({ blockKind: 'prose' }))
    const fn = vi.fn()
    m.onUpdate(fn)
    m.ingest(raw({ blockKind: 'code' }))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('a ref change emits', () => {
    const m = new SelectionModel(UUID)
    m.ingest(raw({ ref: null }))
    const fn = vi.fn()
    m.onUpdate(fn)
    m.ingest(raw({ ref: 'anchor-9' }))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('an identical re-ingest does not emit', () => {
    const m = new SelectionModel(UUID)
    m.ingest(raw())
    const fn = vi.fn()
    m.onUpdate(fn)
    m.ingest(raw())
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('SelectionModel — blockIds array-equality diff (P3.A)', () => {
  it('same members (same order) → no emit', () => {
    const m = new SelectionModel(UUID)
    m.ingest(raw({ blockId: 'b1', blockIds: ['b1', 'b2'], selectionType: 'range', selectedText: 's', range: { from: 1, to: 9 } }))
    const fn = vi.fn()
    m.onUpdate(fn)
    // caret/range shift but the spanned blocks are identical → coalesced.
    m.ingest(raw({ blockId: 'b1', blockIds: ['b1', 'b2'], selectionType: 'range', selectedText: 's', range: { from: 2, to: 8 } }))
    expect(fn).not.toHaveBeenCalled()
  })

  it('different members → emit', () => {
    const m = new SelectionModel(UUID)
    m.ingest(raw({ blockId: 'b1', blockIds: ['b1', 'b2'], selectionType: 'range', selectedText: 's', range: { from: 1, to: 9 } }))
    const fn = vi.fn()
    m.onUpdate(fn)
    m.ingest(raw({ blockId: 'b1', blockIds: ['b1', 'b2', 'b3'], selectionType: 'range', selectedText: 's', range: { from: 1, to: 15 } }))
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('SelectionModel — focus zone (P3.A)', () => {
  it('setFocusZone changes the zone and emits (glow depends on it)', () => {
    const m = new SelectionModel(UUID)
    m.ingest(raw())
    const fn = vi.fn()
    m.onUpdate(fn)
    m.setFocusZone('ask')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(m.getContext().focusZone).toBe('ask')
  })

  it('setFocusZone to the SAME zone does not emit', () => {
    const m = new SelectionModel(UUID)
    m.setFocusZone('ask')
    const fn = vi.fn()
    m.onUpdate(fn)
    m.setFocusZone('ask')
    expect(fn).not.toHaveBeenCalled()
  })

  it('the focus zone rides through subsequent ingests (persists)', () => {
    const m = new SelectionModel(UUID)
    m.setFocusZone('ask')
    m.ingest(raw({ blockId: 'b1' }))
    expect(m.getContext().focusZone).toBe('ask')
  })
})

describe('SelectionModel — scroll (issue #51: caret-class, pullable not pushed)', () => {
  it('setScroll updates the pullable context but does NOT emit — the constraint most likely to regress', () => {
    const m = new SelectionModel(UUID)
    m.ingest(raw()) // establish a baseline selection
    const fn = vi.fn()
    m.onUpdate(fn)
    m.setScroll(842)
    expect(fn).not.toHaveBeenCalled()
    expect(m.getContext().scroll).toBe(842)
  })

  it('a subsequent scroll value keeps updating silently', () => {
    const m = new SelectionModel(UUID)
    m.setScroll(100)
    const fn = vi.fn()
    m.onUpdate(fn)
    m.setScroll(250)
    expect(fn).not.toHaveBeenCalled()
    expect(m.getContext().scroll).toBe(250)
  })

  it('the same scroll value is a no-op (no redundant commit)', () => {
    const m = new SelectionModel(UUID)
    m.setScroll(100)
    const fn = vi.fn()
    m.onUpdate(fn)
    m.setScroll(100)
    expect(fn).not.toHaveBeenCalled()
    expect(m.getContext().scroll).toBe(100)
  })

  it('a null value is ignored (no report yet ≠ a report of null)', () => {
    const m = new SelectionModel(UUID)
    m.setScroll(100)
    m.setScroll(null)
    expect(m.getContext().scroll).toBe(100)
  })

  it('an unrelated selection ingest does NOT reset scroll (it is not on the descriptor)', () => {
    const m = new SelectionModel(UUID)
    m.setScroll(842)
    m.ingest(raw({ blockId: 'other-block' })) // a real caret move (emits, unrelated to scroll)
    expect(m.getContext().scroll).toBe(842)
  })

  it('setFocusZone carries scroll through unchanged', () => {
    const m = new SelectionModel(UUID)
    m.setScroll(500)
    m.setFocusZone('ask')
    expect(m.getContext().scroll).toBe(500)
  })
})

describe('SelectionModel — subscribe/unsubscribe + isolation (P3.A)', () => {
  it('onUpdate returns an unsubscribe that stops delivery', () => {
    const m = new SelectionModel(UUID)
    const fn = vi.fn()
    const off = m.onUpdate(fn)
    m.ingest(raw({ blockId: 'x' }))
    expect(fn).toHaveBeenCalledTimes(1)
    off()
    m.ingest(raw({ blockId: 'y' }))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('delivers the frozen context to listeners', () => {
    const m = new SelectionModel(UUID)
    let received = null
    m.onUpdate((ctx) => { received = ctx })
    m.ingest(raw({ blockId: 'z' }))
    expect(received).not.toBeNull()
    expect(Object.isFrozen(received)).toBe(true)
    expect(received.blockId).toBe('z')
  })

  it('isolates a throwing listener from the others', () => {
    const m = new SelectionModel(UUID)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const good = vi.fn()
    m.onUpdate(() => { throw new Error('boom') })
    m.onUpdate(good)
    expect(() => m.ingest(raw({ blockId: 'q' }))).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
    errSpy.mockRestore()
  })
})
