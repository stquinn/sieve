// search-overlay.test.js — P4.C. The document search overlay is now a Workspace-
// owned child (shell/search-overlay.js). It builds no DOM in the constructor
// (vitest-safe), creates its overlay lazily on first toggle (document.body.append),
// and reaches the SURFACE search commands / storage via the TRANSITIONAL
// workspace.activeTab.editor.tiptap reach (null-guarded; retires with the bus in
// P4.E). Backs workspace.toggleSearch().
//
// PINNED QUIRK (§7, intentional — must NOT be "fixed"): a freshly JS-created
// overlay has style.display === '' (empty, not 'none'), so the FIRST toggle falls
// into the HIDE branch and only the SECOND toggle shows it. This test pins that
// behaviour verbatim.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SearchOverlay } from '../src/static/shell/search-overlay.js'

// A fake surface tiptap exposing the search commands + storage. Post-D-3 the
// overlay no longer reaches this directly — the fake EDITOR's search verbs (below)
// run these same command spies, so the existing assertions on
// `ws._tiptap.commands.*` still pin the behaviour the overlay ultimately drives.
function fakeTiptap() {
  return {
    commands: {
      setSearchTerm: vi.fn(),
      nextSearchResult: vi.fn(),
      prevSearchResult: vi.fn(),
      clearSearch: vi.fn(),
      focus: vi.fn(),
    },
    storage: { search: { results: ['a', 'b', 'c'], currentIndex: 1 } },
  }
}

// D-3: the overlay drives the ACTIVE EDITOR'S search verbs (never `ed.tiptap`).
// The fake editor exposes them; each runs the tiptap command spies (so the search
// commands are still asserted) and returns the current `{current,total}` stats the
// overlay renders. clearSearch folds in the editor refocus (the close gesture).
function fakeWorkspace({ tiptap = fakeTiptap(), mode = 'wysiwyg', editor = true } = {}) {
  const stats = () => {
    const s = tiptap.storage.search
    return { current: s.results.length > 0 ? s.currentIndex + 1 : 0, total: s.results.length }
  }
  const ed = editor ? {
    mode,
    searchTerm: vi.fn((t) => { tiptap.commands.setSearchTerm(t); return stats() }),
    searchNext: vi.fn(() => { tiptap.commands.nextSearchResult(); return stats() }),
    searchPrev: vi.fn(() => { tiptap.commands.prevSearchResult(); return stats() }),
    clearSearch: vi.fn(() => { tiptap.commands.clearSearch(); tiptap.commands.focus() }),
  } : null
  return {
    _tiptap: tiptap,
    _editor: ed,
    get activeTab() { return ed ? { editor: ed } : null },
  }
}

function overlayEl() { return document.querySelector('.editor-search-overlay') }

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('SearchOverlay — construction is headless-safe', () => {
  it('the constructor builds NO overlay DOM', () => {
    // eslint-disable-next-line no-new
    new SearchOverlay(fakeWorkspace())
    expect(overlayEl()).toBeNull()
  })

  it('toggle null-guards a missing active editor (builds DOM, no throw)', () => {
    const overlay = new SearchOverlay(fakeWorkspace({ editor: false }))
    expect(() => overlay.toggle()).not.toThrow()
  })
})

describe('SearchOverlay — the first-press quirk (PINNED, do NOT fix)', () => {
  it('the FIRST toggle HIDES (display:none) — the freshly-created overlay had display=""', () => {
    const ws = fakeWorkspace()
    const overlay = new SearchOverlay(ws)
    overlay.toggle()
    const el = overlayEl()
    expect(el).toBeTruthy()
    // First press fell into the hide branch: display forced to 'none'.
    expect(el.style.display).toBe('none')
    // And it cleared the (empty) search on the way through.
    expect(ws._tiptap.commands.clearSearch).toHaveBeenCalled()
  })

  it('the SECOND toggle SHOWS it (display:flex) and focuses the input', () => {
    const overlay = new SearchOverlay(fakeWorkspace())
    overlay.toggle()  // hide (quirk)
    overlay.toggle()  // show
    const el = overlayEl()
    expect(el.style.display).toBe('flex')
    expect(document.activeElement).toBe(el.querySelector('input'))
  })

  it('a THIRD toggle hides again (clears search)', () => {
    const ws = fakeWorkspace()
    const overlay = new SearchOverlay(ws)
    overlay.toggle() // hide
    overlay.toggle() // show
    ws._tiptap.commands.clearSearch.mockClear()
    overlay.toggle() // hide
    expect(overlayEl().style.display).toBe('none')
    expect(ws._tiptap.commands.clearSearch).toHaveBeenCalled()
  })
})

describe('SearchOverlay — find / next / prev / clear via surface commands', () => {
  // Reveal the overlay (two toggles past the quirk) and return its element.
  function shown(ws) {
    const overlay = new SearchOverlay(ws)
    overlay.toggle()
    overlay.toggle()
    return { overlay, el: overlayEl() }
  }

  it('typing in the input sets the search term and refreshes the stats', () => {
    const ws = fakeWorkspace()
    const { el } = shown(ws)
    const input = el.querySelector('input')
    input.value = 'needle'
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    // D-3: the overlay drives the EDITOR'S searchTerm verb (never ed.tiptap) …
    expect(ws._editor.searchTerm).toHaveBeenCalledWith('needle')
    // … which runs the surface search command …
    expect(ws._tiptap.commands.setSearchTerm).toHaveBeenCalledWith('needle')
    // … and returns stats the overlay renders (currentIndex 1 of 3 → '2/3').
    expect(el.querySelector('.editor-search__stats').textContent).toBe('2/3')
  })

  it('Enter → next result; Shift+Enter → previous result', () => {
    const ws = fakeWorkspace()
    const { el } = shown(ws)
    const input = el.querySelector('input')
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(ws._tiptap.commands.nextSearchResult).toHaveBeenCalled()
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }))
    expect(ws._tiptap.commands.prevSearchResult).toHaveBeenCalled()
  })

  it('the ↓ / ↑ buttons drive next / prev', () => {
    const ws = fakeWorkspace()
    const { el } = shown(ws)
    const btns = [...el.querySelectorAll('.editor-search__btn')]
    btns.find((b) => b.textContent === '↓').click()
    expect(ws._tiptap.commands.nextSearchResult).toHaveBeenCalled()
    btns.find((b) => b.textContent === '↑').click()
    expect(ws._tiptap.commands.prevSearchResult).toHaveBeenCalled()
  })

  it('the ✕ close button hides, clears the search, and refocuses the editor', () => {
    const ws = fakeWorkspace()
    const { el } = shown(ws)
    el.querySelector('.editor-search__close').click()
    expect(el.style.display).toBe('none')
    expect(ws._tiptap.commands.clearSearch).toHaveBeenCalled()
    expect(ws._tiptap.commands.focus).toHaveBeenCalled()
  })

  it('Escape hides, clears, and refocuses the editor', () => {
    const ws = fakeWorkspace()
    const { el } = shown(ws)
    el.querySelector('input').dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    expect(el.style.display).toBe('none')
    expect(ws._tiptap.commands.clearSearch).toHaveBeenCalled()
    expect(ws._tiptap.commands.focus).toHaveBeenCalled()
  })
})

describe('SearchOverlay — markdown mode is a stub (no surface commands)', () => {
  it('typing in markdown mode does NOT reach the surface search commands', () => {
    const tiptap = fakeTiptap()
    const ws = fakeWorkspace({ tiptap, mode: 'markdown' })
    const overlay = new SearchOverlay(ws)
    overlay.toggle(); overlay.toggle() // show
    const input = overlayEl().querySelector('input')
    input.value = 'x'
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    expect(tiptap.commands.setSearchTerm).not.toHaveBeenCalled()
    expect(overlayEl().querySelector('.editor-search__stats').textContent).toBe('0/0')
  })
})
