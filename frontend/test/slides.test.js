// @ts-check
// slides.test.js — slide markers and Presentation Mode (#178).
//
// THE REAL STACK, AND THE SHIPPING NODE. A live Editor with tiptap-markdown, the
// `slideMarker` node from `SlideMarker.node()` and the `SlideFocus` plugin, both
// read out of the modules that ship.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Editor } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import './helpers/real-vendor.js'
import { SlideMarker } from '../src/static/lens/document-editor/surfaces/slide-marker.js'
import { SlideFocus } from '../src/static/lens/document-editor/surfaces/slide-focus.js'

/** @type {any} */
let editor

beforeEach(() => {
  editor = new Editor({
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      Markdown.configure({ html: true, transformPastedText: true }),
      SlideMarker.node(),
      SlideFocus.extension(),
    ],
    content: '',
  })
})

afterEach(() => {
  if (editor && !editor.isDestroyed) editor.destroy()
})

/** The top-level node names. @returns {string[]} */
function names() {
  /** @type {string[]} */
  const out = []
  editor.state.doc.forEach((/** @type {any} */ n) => { out.push(n.type.name) })
  return out
}

/** The text of the top-level nodes NOT hidden with the caret at `head`.
 *  @param {number} head @returns {string[]} */
function visibleAt(head) {
  const doc = editor.state.doc
  const hidden = new Set(SlideFocus.hiddenRanges(doc, head).map((r) => r.from))
  /** @type {string[]} */
  const out = []
  doc.forEach((/** @type {any} */ n, /** @type {number} */ pos) => { if (!hidden.has(pos)) out.push(n.textContent) })
  return out
}

/** The position just inside the first top-level textblock whose text is `text`.
 *  @param {string} text @returns {number} */
function posOf(text) {
  let at = -1
  editor.state.doc.forEach((/** @type {any} */ n, /** @type {number} */ pos) => {
    if (at < 0 && n.textContent === text) at = pos + 1
  })
  return at
}

const DECK = '# Title\n\n<!-- SLIDE MARKER -->\n\nOne\n\n<!-- SLIDE MARKER -->\n\nTwo\n\nTwo more'

describe('SlideMarker markdown', () => {
  it.each([
    ['canonical', '<!-- SLIDE MARKER -->'],
    ['lower case', '<!-- slide marker -->'],
    ['short form', '<!--slide-->'],
    ['extra spacing', '<!--   Slide    Marker   -->'],
  ])('reads the %s spelling as a marker and writes it canonically', (_label, comment) => {
    editor.commands.setContent(`Before\n\n${comment}\n\nAfter`)
    expect(names()).toEqual(['paragraph', 'slideMarker', 'paragraph'])
    expect(editor.storage.markdown.getMarkdown()).toBe('Before\n\n<!-- SLIDE MARKER -->\n\nAfter')
  })

  it('a marker alone round-trips byte for byte', () => {
    editor.commands.setContent(SlideMarker.MARKDOWN)
    expect(names()[0]).toBe('slideMarker')
    expect(editor.storage.markdown.getMarkdown()).toBe(SlideMarker.MARKDOWN)
  })

  it('leaves every other HTML comment alone', () => {
    editor.commands.setContent('Before\n\n<!-- slides are fun -->\n\nAfter')
    expect(names()).not.toContain('slideMarker')
  })

  it.each([
    ['a canonical marker', DECK, true],
    ['a lenient spelling', 'Before\n\n  <!--slide-->\n', true],
    ['no marker', '# Title\n\nJust prose', false],
    ['another comment', '<!-- slides are fun -->', false],
    ['a marker inside a line', 'text <!-- SLIDE MARKER --> text', false],
  ])('containsMarker finds %s in raw markdown: %s', (_label, markdown, found) => {
    expect(SlideMarker.containsMarker(markdown)).toBe(found)
  })
})

describe('SlideFocus', () => {
  it.each([
    ['before the first marker', 'Title', ['Title']],
    ['between markers', 'One', ['One']],
    ['on the last slide', 'Two more', ['Two', 'Two more']],
  ])('with the caret %s, only its slide is visible', (_label, text, visible) => {
    editor.commands.setContent(DECK)
    expect(visibleAt(posOf(text))).toEqual(visible)
  })

  it('a document with no markers is one slide', () => {
    editor.commands.setContent('')
    expect(SlideFocus.hasMarkers(editor.state.doc)).toBe(false)
    expect(SlideFocus.slideAt(editor.state.doc, 1)).toEqual({ start: 0, end: editor.state.doc.content.size })
    expect(SlideFocus.hiddenRanges(editor.state.doc, 1)).toEqual([])
  })

  it('hasMarkers is true once the document holds a marker', () => {
    editor.commands.setContent(DECK)
    expect(SlideFocus.hasMarkers(editor.state.doc)).toBe(true)
  })

  it('draws nothing hidden until presenting, and every off-slide node once it is', () => {
    editor.commands.setContent(DECK)
    editor.commands.setTextSelection(posOf('One'))
    expect(editor.view.dom.querySelectorAll('.slide-hidden').length).toBe(0)
    SlideFocus.setPresenting(editor.view, true)
    expect(SlideFocus.isPresenting(editor.state)).toBe(true)
    expect(editor.view.dom.querySelectorAll('.slide-hidden').length).toBe(5)
    SlideFocus.setPresenting(editor.view, false)
    expect(editor.view.dom.querySelectorAll('.slide-hidden').length).toBe(0)
  })

  it.each([
    ['forward', 'One', 'Two'],
    ['backward', 'Two', 'One'],
  ])('a NodeSelection on a hidden marker moves %s to the next slide\'s text', (_dir, from, to) => {
    editor.commands.setContent(DECK)
    SlideFocus.setPresenting(editor.view, true)
    const start = posOf(from)
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, start)))
    // the marker between `One` and `Two`
    const marker = posOf('Two') - 2
    expect(editor.state.doc.nodeAt(marker).type.name).toBe('slideMarker')
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, marker)))
    const sel = editor.state.selection
    expect(sel instanceof TextSelection).toBe(true)
    expect(editor.state.doc.resolve(sel.head).parent.textContent).toBe(to)
  })

  it('leaves a marker NodeSelection alone when not presenting', () => {
    editor.commands.setContent(DECK)
    const marker = posOf('Two') - 2
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, marker)))
    expect(editor.state.selection.node.type.name).toBe('slideMarker')
  })
})
