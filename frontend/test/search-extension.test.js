// search-extension.test.js — regression coverage for the REAL Search TipTap
// extension (frontend/src/static/lens/extensions.js). search-overlay.test.js
// only exercises the overlay CHROME against a fully-faked editor/commands and
// never touches this file at all — so until now there was zero coverage of the
// actual match-scan / next-prev / scroll machinery.
//
// Builds a real @tiptap/core Editor with the real extension so the plugin's
// `apply` (match scan + index advance) and `view` (scroll trigger) hooks run
// for real, against real ProseMirror positions.
//
// Vendor seam: extensions.js reads `VENDOR.Plugin`/`VENDOR.Extension`/etc off
// `globalThis.TipTap` at MODULE-EVAL time (see tiptap-vendor.js doctrine
// comment). test/helpers/seed-vendor.js seeds permissive Proxy stand-ins for
// tests that only check wiring against a fake host — that's not enough here,
// this test drives a REAL functioning EditorView, so it seeds the REAL
// @tiptap/core / @tiptap/pm classes instead. The seed must land before
// extensions.js is evaluated, so it is a plain top-level statement and
// extensions.js is loaded via a dynamic import AFTER it (a static import of
// extensions.js would evaluate before this file's own top-level code runs,
// same trap seed-vendor.js's docstring warns about).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { Editor, Extension, Node } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import Highlight from '@tiptap/extension-highlight'

Object.assign(globalThis.TipTap, { Node, Extension, Plugin, PluginKey, Decoration, DecorationSet, Highlight })
const { Search } = await import('../src/static/lens/extensions.js')

let editor = null
afterEach(() => {
  if (editor) { editor.destroy(); editor = null }
  vi.restoreAllMocks()
})

function makeEditor(paragraphTexts) {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, Search],
    content: {
      type: 'doc',
      content: paragraphTexts.map((text) => ({
        type: 'paragraph',
        content: text ? [{ type: 'text', text }] : [],
      })),
    },
  })
  return editor
}

describe('Search extension — matching and decoration', () => {
  it('scans the doc and finds every case-insensitive occurrence', () => {
    makeEditor(['Hello World', 'another world here', 'no match line'])
    editor.commands.setSearchTerm('world')
    expect(editor.storage.search.results.length).toBe(2)
    expect(editor.storage.search.currentIndex).toBe(0)
  })

  it('decorates the current match with both classes, others with only the base class', () => {
    makeEditor(['world one', 'world two'])
    editor.commands.setSearchTerm('world')
    editor.commands.nextSearchResult()
    const decoSet = editor.view.someProp('decorations', (f) => f(editor.view.state))
    const decos = decoSet.find(0, editor.state.doc.content.size)
    const currentDeco = decos.find((d) => d.type.attrs.class.includes('search-result-current'))
    const otherDeco = decos.find((d) => d.type.attrs.class === 'search-result')
    expect(currentDeco).toBeTruthy()
    expect(otherDeco).toBeTruthy()
  })

  it('clearSearch empties the results', () => {
    makeEditor(['world one'])
    editor.commands.setSearchTerm('world')
    expect(editor.storage.search.results.length).toBe(1)
    editor.commands.clearSearch()
    expect(editor.storage.search.results.length).toBe(0)
  })
})

describe('Search extension — next/prev navigation (wraparound)', () => {
  it('nextSearchResult advances and wraps back to 0', () => {
    makeEditor(['world one', 'world two', 'world three'])
    editor.commands.setSearchTerm('world')
    expect(editor.storage.search.currentIndex).toBe(0)
    editor.commands.nextSearchResult()
    expect(editor.storage.search.currentIndex).toBe(1)
    editor.commands.nextSearchResult()
    expect(editor.storage.search.currentIndex).toBe(2)
    editor.commands.nextSearchResult()
    expect(editor.storage.search.currentIndex).toBe(0) // wraps forward
  })

  it('prevSearchResult retreats and wraps back to the last result', () => {
    makeEditor(['world one', 'world two', 'world three'])
    editor.commands.setSearchTerm('world')
    editor.commands.prevSearchResult()
    expect(editor.storage.search.currentIndex).toBe(2) // wraps backward
    editor.commands.prevSearchResult()
    expect(editor.storage.search.currentIndex).toBe(1)
  })
})

describe('Search extension — scroll on navigate (REGRESSION, issue #60)', () => {
  // "world" starts at column 6 of "hello world" / "another world here" — i.e.
  // strictly INSIDE the paragraph's text node, never at a node-start boundary.
  // The pre-fix implementation resolved the match position via
  // `view.nodeDOM(pos)`, which only returns a ViewDesc when pos sits exactly on
  // a child's start boundary; for a mid-text-node position it resolves to
  // null, so `dom && dom.scrollIntoView` was false and the scroll silently
  // never fired even though currentIndex advanced correctly and the highlight
  // moved (decorations are position-based, not DOM-node based, so they never
  // exposed the bug). This test fails against the pre-fix code (0 calls) and
  // passes against the fix (which resolves via domAtPos + walk-up-to-Element).
  it('scrolls to the current match when the search term is first set', () => {
    makeEditor(['hello world', 'another world here', 'world again'])
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView')
    editor.commands.setSearchTerm('world')
    expect(scrollSpy).toHaveBeenCalledTimes(1)
    // Must be a real Element (Text nodes have no scrollIntoView at all).
    expect(scrollSpy.mock.instances[0].nodeType).toBe(1)
    expect(scrollSpy).toHaveBeenLastCalledWith({ behavior: 'smooth', block: 'center' })
  })

  it('scrolls again on nextSearchResult, targeting an Element each time', () => {
    makeEditor(['hello world', 'another world here', 'world again'])
    editor.commands.setSearchTerm('world')
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView')
    editor.commands.nextSearchResult()
    expect(scrollSpy).toHaveBeenCalledTimes(1)
    expect(scrollSpy.mock.instances[0].nodeType).toBe(1)
  })

  it('scrolls again on prevSearchResult, targeting an Element each time', () => {
    makeEditor(['hello world', 'another world here', 'world again'])
    editor.commands.setSearchTerm('world')
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView')
    editor.commands.prevSearchResult()
    expect(scrollSpy).toHaveBeenCalledTimes(1)
    expect(scrollSpy.mock.instances[0].nodeType).toBe(1)
  })

  it('does not scroll when there are no results', () => {
    makeEditor(['nothing to find here'])
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView')
    editor.commands.setSearchTerm('world')
    expect(scrollSpy).not.toHaveBeenCalled()
  })
})
