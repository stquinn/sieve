// @ts-check
// slides.test.js — slide markers and Presentation Mode (#178).
//
// THE REAL STACK, AND THE SHIPPING NODES. A live Editor with tiptap-markdown,
// the markdown extensions the WYSIWYG surface loads, `proseGroup`, every Sieve
// block node as the live registry mints it (so each kind draws through its real
// NodeView), the `slideMarker` node and the `SlideFocus` plugin.

import './helpers/real-vendor.js'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Editor, Node, mergeAttributes } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'
import { Table } from '@tiptap/extension-table'
import { TableRow } from '@tiptap/extension-table-row'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableCell } from '@tiptap/extension-table-cell'
import { TaskList } from '@tiptap/extension-task-list'
import { TaskItem } from '@tiptap/extension-task-item'
import { DOMParser } from '@tiptap/pm/model'
import { NodeSelection, Selection, TextSelection } from '@tiptap/pm/state'
import { SlideMarker } from '../src/static/lens/document-editor/surfaces/slide-marker.js'
import { SlideFocus } from '../src/static/lens/document-editor/surfaces/slide-focus.js'
import { BlockImage } from '../src/static/lens/document-editor/surfaces/block-image.js'
import { ProseGroup } from '../src/static/lens/document-editor/surfaces/prose-group.js'
import { getSieveNodes } from '../src/static/lens/document-editor/surfaces/sieve-block-extension.js'
import { listBlockKinds } from '../src/static/renderers/block-kinds.js'

Object.assign(/** @type {any} */ (globalThis).TipTap, { mergeAttributes, ProseMirrorDOMParser: DOMParser })
// DiagramRenderer injects a real <script> when window.mermaid is absent.
Object.assign(window, {
  mermaid: {
    initialize() {},
    render() { return Promise.resolve({ svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }) },
  },
})

/** The structured kinds, each registered by its node-view module. */
const SIEVE_KINDS = Object.freeze(['code', 'diagram', 'log', 'smart-image', 'smart-card', 'web-clip', 'ai-block', 'reference'])
for (const kind of SIEVE_KINDS) await import(`../src/static/lens/document-editor/surfaces/node-views/${kind}-node-view.js`)

/** @type {any} */
let editor

beforeEach(() => {
  editor = new Editor({
    extensions: [
      Node.create({ name: 'doc', topNode: true, content: '(block | sieveBlock)+' }),
      StarterKit.configure({ document: false, codeBlock: false, trailingNode: false }),
      Table, TableRow, TableHeader, TableCell,
      BlockImage.node(),
      TaskList, TaskItem.configure({ nested: true }),
      ProseGroup,
      ...getSieveNodes(),
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

/** What the document reads as between `from` and `to`: text, with an atom
 *  read as its node name and block boundaries as `|`.
 *  @param {number} from @param {number} to @returns {string} */
function textOf(from, to) {
  return editor.state.doc.textBetween(from, to, '|', (/** @type {any} */ leaf) => leaf.isText ? leaf.text : leaf.type.name)
}

/** What is left drawn with the caret at `head`: the document read through the
 *  gaps between the ranges SlideFocus hides.
 *  @param {number} head @returns {string} */
function visibleAt(head) {
  const doc = editor.state.doc
  /** @type {string[]} */
  const parts = []
  let at = 0
  for (const r of SlideFocus.hiddenRanges(doc, head)) {
    if (r.from > at) parts.push(textOf(at, r.from))
    at = Math.max(at, r.to)
  }
  if (doc.content.size > at) parts.push(textOf(at, doc.content.size))
  return parts.filter(Boolean).join('|')
}

/** The position just inside the first textblock, at any depth, whose text is `text`.
 *  @param {string} text @returns {number} */
function posOf(text) {
  let at = -1
  editor.state.doc.descendants((/** @type {any} */ n, /** @type {number} */ pos) => {
    if (at < 0 && n.isTextblock && n.textContent === text) at = pos + 1
    return at < 0
  })
  return at
}

/** The positions of the top-level slide markers. @returns {number[]} */
function topMarkers() {
  /** @type {number[]} */
  const out = []
  editor.state.doc.forEach((/** @type {any} */ n, /** @type {number} */ pos) => { if (n.type.name === SlideMarker.NAME) out.push(pos) })
  return out
}

/** Puts the caret at the first valid position at or after `pos`. @param {number} pos */
function caretAt(pos) {
  const doc = editor.state.doc
  editor.view.dispatch(editor.state.tr.setSelection(Selection.near(doc.resolve(pos), 1)))
}

/** The deck every coverage row is the middle slide of. @param {string} row */
const deckOf = (row) => `# Title\n\n${SlideMarker.MARKDOWN}\n\n${row}\n\n${SlideMarker.MARKDOWN}\n\nLast`

/** A deck as JSON whose middle slide is one Sieve block of `kind`. @param {string} kind */
function sieveDeck(kind) {
  const schema = editor.schema
  const type = schema.nodes['sieve-' + kind]
  const body = type.isLeaf ? null : type.inlineContent ? schema.text('source') : schema.nodes.paragraph.create(null, schema.text('body'))
  const block = type.createAndFill({ id: `0198c1a0-0001-7000-8000-0000000001${SIEVE_KINDS.indexOf(kind)}0`, kind }, body)
  const text = (/** @type {string} */ t) => [{ type: 'text', text: t }]
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: text('Title') },
      { type: SlideMarker.NAME },
      block.toJSON(),
      { type: SlideMarker.NAME },
      { type: 'paragraph', content: text('Last') },
    ],
  }
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

/** Every markdown construct, as the middle slide of a deck, in the form
 *  tiptap-markdown writes it. */
const MARKDOWN_ROWS = Object.freeze([
  ['headings', '# One\n\n## Two\n\n### Three'],
  ['inline marks', 'Plain **bold** *italic* `code` [link](https://example.com)'],
  ['bullet list', '- one\n- two'],
  ['ordered list', '1. one\n2. two'],
  ['task list', '- [ ] todo\n\n- [x] done'],
  ['blockquote', '> quoted'],
  ['table', '| a | b |\n| --- | --- |\n| 1 | 2 |'],
  ['horizontal rule', '---'],
  ['image', '![alt](a.png)'],
  ['hard break', 'line one\\\nline two'],
  ['several paragraphs', 'One\n\nTwo'],
])

describe('Presentation Mode coverage: every row is the middle slide of a deck', () => {
  /** Asserts a deck already loaded: the middle slide alone shows with the caret
   *  in it, and neither neighbour does. */
  function assertSlides() {
    const [first, second] = topMarkers()
    expect([first, second].every((p) => p >= 0)).toBe(true)
    const middle = textOf(first + 1, second)
    expect(middle).not.toBe('')
    expect(visibleAt(first + 1)).toBe(middle)
    expect(visibleAt(posOf('Title'))).toBe('Title')
    expect(visibleAt(posOf('Last'))).toBe('Last')
  }

  it.each(MARKDOWN_ROWS)('%s', (_name, row) => {
    const deck = deckOf(row)
    editor.commands.setContent(deck)
    assertSlides()
    expect(editor.storage.markdown.getMarkdown()).toBe(deck)
  })

  // A block's markdown is Go's (TestDocumentCodec_SlideMarkerProseSpan); here
  // each kind draws through its real NodeView, and the hiding must reach it.
  it.each(SIEVE_KINDS)('sieve-%s', (kind) => {
    editor.commands.setContent(sieveDeck(kind))
    assertSlides()
    const [first] = topMarkers()
    const blockPos = first + 1
    SlideFocus.setPresenting(editor.view, true)
    caretAt(posOf('Title'))
    const dom = /** @type {HTMLElement} */ (editor.view.nodeDOM(blockPos))
    expect(dom.getAttribute('data-kind')).toBe(kind)
    expect(dom.classList.contains('slide-hidden')).toBe(true)
    // an inline display beats the .slide-hidden rule
    expect(dom.style.display).toBe('')
    caretAt(blockPos)
    expect(/** @type {HTMLElement} */ (editor.view.nodeDOM(blockPos)).classList.contains('slide-hidden')).toBe(false)
  })

  it('has a row for every registered block kind', () => {
    const covered = new Set([...SIEVE_KINDS, 'prose'])
    expect(listBlockKinds().filter((k) => !covered.has(k))).toEqual([])
  })

  /** One prose block that parsed to several nodes, holding the whole deck. */
  const groupDeck = () => ({
    type: 'doc',
    content: [{
      type: 'proseGroup',
      attrs: { id: '0198c1a0-0001-7000-8000-000000000301' },
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
        { type: SlideMarker.NAME },
        { type: 'paragraph', content: [{ type: 'text', text: 'One' }] },
        { type: SlideMarker.NAME },
        { type: 'paragraph', content: [{ type: 'text', text: 'Last' }] },
      ],
    }],
  })

  it('a prose group splits at the markers among its children', () => {
    editor.commands.setContent(groupDeck())
    expect(names()).toEqual(['proseGroup'])
    expect(SlideFocus.hasMarkers(editor.state.doc)).toBe(true)
    expect(visibleAt(posOf('Title'))).toBe('Title')
    expect(visibleAt(posOf('One'))).toBe('One')
    expect(visibleAt(posOf('Last'))).toBe('Last')
    expect(editor.storage.markdown.getMarkdown()).toBe(deckOf('One'))
  })

  it.each([
    ['a list item', `- one\n\n  ${SlideMarker.MARKDOWN}\n\n- two`],
    ['a blockquote', `> one\n>\n> ${SlideMarker.MARKDOWN}\n>\n> two`],
  ])('a marker inside %s is not a boundary, and is hidden while presenting', (_where, markdown) => {
    editor.commands.setContent(markdown)
    let nested = -1
    editor.state.doc.descendants((/** @type {any} */ n, /** @type {number} */ pos) => { if (n.type.name === SlideMarker.NAME) nested = pos })
    expect(nested).toBeGreaterThan(0)
    expect(SlideFocus.hasMarkers(editor.state.doc)).toBe(false)
    expect(SlideFocus.hiddenRanges(editor.state.doc, posOf('one'))).toEqual([{ from: nested, to: nested + 1 }])
    expect(visibleAt(posOf('one'))).toBe(visibleAt(posOf('two')))
    expect(editor.storage.markdown.getMarkdown()).toBe(markdown)
  })

  it('two adjacent markers make an empty slide between them', () => {
    const deck = `One\n\n${SlideMarker.MARKDOWN}\n\n${SlideMarker.MARKDOWN}\n\nTwo`
    editor.commands.setContent(deck)
    const [first, second] = topMarkers()
    expect(second).toBe(first + 1)
    expect(SlideFocus.slideAt(editor.state.doc, second)).toEqual({ start: second, end: second })
    expect(visibleAt(second)).toBe('')
    expect(visibleAt(posOf('One'))).toBe('One')
    expect(visibleAt(posOf('Two'))).toBe('Two')
    expect(editor.storage.markdown.getMarkdown()).toBe(deck)
  })

  it('a marker as the first and as the last node bounds one slide', () => {
    const deck = `${SlideMarker.MARKDOWN}\n\nOnly\n\n${SlideMarker.MARKDOWN}`
    editor.commands.setContent(deck)
    expect(names()).toEqual(['slideMarker', 'paragraph', 'slideMarker'])
    expect(visibleAt(posOf('Only'))).toBe('Only')
    expect(editor.storage.markdown.getMarkdown()).toBe(deck)
  })
})

describe('insertSlideMarker', () => {
  /** The position inside the first empty paragraph. @returns {number} */
  const emptyLine = () => {
    let at = -1
    editor.state.doc.forEach((/** @type {any} */ n, /** @type {number} */ pos) => { if (at < 0 && n.isTextblock && !n.content.size) at = pos + 1 })
    return at
  }

  it.each([
    ['on an empty last line', '<p>One</p><p></p>', emptyLine, '', ['paragraph', 'slideMarker', 'paragraph']],
    ['on an empty line before more text', '<p>One</p><p></p><p>Next</p>', emptyLine, 'Next', ['paragraph', 'slideMarker', 'paragraph']],
    ['at the end of a line', '<p>One</p>', () => posOf('One') + 3, '', ['paragraph', 'slideMarker', 'paragraph']],
  ])('%s puts the caret on the line below the marker, never on it', (_case, content, caret, lineBelow, shape) => {
    editor.commands.setContent(content)
    editor.commands.setTextSelection(caret())
    editor.commands.insertSlideMarker()
    const sel = editor.state.selection
    expect(sel instanceof TextSelection).toBe(true)
    expect(sel.$from.parent.textContent).toBe(lineBelow)
    expect(sel.$from.before() > 0 && editor.state.doc.resolve(sel.$from.before()).nodeBefore.type.name).toBe('slideMarker')
    expect(names()).toEqual(shape)
    editor.commands.insertContent('x')
    expect(SlideFocus.hasMarkers(editor.state.doc)).toBe(true)
  })
})

describe('SlideFocus', () => {

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

  /** Sends a keydown through the view's handleKeyDown chain.
   *  @param {string} key @param {KeyboardEventInit} [mods] @returns {boolean} handled */
  function press(key, mods = {}) {
    const event = new KeyboardEvent('keydown', { key, ...mods })
    return !!editor.view.someProp('handleKeyDown', (/** @type {any} */ f) => f(editor.view, event))
  }

  /** The text of the textblock holding the caret. @returns {string} */
  const caretText = () => editor.state.doc.resolve(editor.state.selection.head).parent.textContent

  it.each([
    ['PageDown', {}, 'One', 'Two'],
    ['PageUp', {}, 'Two more', 'One'],
    ['ArrowDown', { ctrlKey: true }, 'Title', 'One'],
    ['ArrowUp', { ctrlKey: true }, 'One', 'Title'],
    ['ArrowDown', { metaKey: true }, 'One', 'Two'],
    ['ArrowUp', { metaKey: true }, 'Two', 'One'],
    ['End', { ctrlKey: true }, 'Title', 'Two'],
    ['Home', { ctrlKey: true }, 'Two more', 'Title'],
  ])('%s %o while presenting moves the caret from %s to the start of the slide holding %s', (key, mods, from, to) => {
    editor.commands.setContent(DECK)
    SlideFocus.setPresenting(editor.view, true)
    editor.commands.setTextSelection(posOf(from))
    expect(press(key, mods)).toBe(true)
    expect(caretText()).toBe(to)
    expect(editor.state.selection.head).toBe(posOf(to))
  })

  it.each([
    ['PageDown', 'Two more'],
    ['PageUp', 'Title'],
  ])('%s at the end of the deck is swallowed and leaves the caret', (key, at) => {
    editor.commands.setContent(DECK)
    SlideFocus.setPresenting(editor.view, true)
    editor.commands.setTextSelection(posOf(at))
    expect(press(key)).toBe(true)
    expect(caretText()).toBe(at)
  })

  it.each([
    ['not presenting', 'PageDown', {}, false],
    ['Shift', 'PageDown', { shiftKey: true }, true],
    ['plain ArrowDown', 'ArrowDown', {}, true],
    ['plain End', 'End', {}, true],
    ['Mod+Shift', 'ArrowDown', { ctrlKey: true, shiftKey: true }, true],
  ])('%s does not turn the slide', (_case, key, mods, presenting) => {
    editor.commands.setContent(DECK)
    SlideFocus.setPresenting(editor.view, presenting)
    editor.commands.setTextSelection(posOf('One'))
    press(key, mods)
    expect(caretText()).toBe('One')
  })

  it('an empty slide is neither counted nor stopped on', () => {
    editor.commands.setContent(`${SlideMarker.MARKDOWN}\n\nOne\n\n${SlideMarker.MARKDOWN}\n\n${SlideMarker.MARKDOWN}\n\nTwo`)
    SlideFocus.setPresenting(editor.view, true)
    expect(SlideFocus.slides(editor.state.doc).length).toBe(2)
    editor.commands.setTextSelection(posOf('One'))
    expect(SlideFocus.place(editor.state)).toEqual({ index: 1, count: 2 })
    press('PageDown')
    expect(caretText()).toBe('Two')
    expect(SlideFocus.place(editor.state)).toEqual({ index: 2, count: 2 })
  })

  it('draws the deck counter only while presenting, following the caret', () => {
    editor.commands.setContent(DECK)
    editor.commands.setTextSelection(posOf('One'))
    const counter = editor.view.dom.parentNode.querySelector('.slide-counter')
    expect(counter.hidden).toBe(true)
    SlideFocus.setPresenting(editor.view, true)
    expect(counter.hidden).toBe(false)
    expect(counter.textContent).toBe('2 / 3')
    press('PageDown')
    expect(counter.textContent).toBe('3 / 3')
    SlideFocus.setPresenting(editor.view, false)
    expect(counter.hidden).toBe(true)
    editor.destroy()
    expect(counter.isConnected).toBe(false)
  })

  it.each([
    ['each counted slide', DECK, [2, 3]],
    ['not an empty slide', `One\n\n${SlideMarker.MARKDOWN}\n\n${SlideMarker.MARKDOWN}\n\nTwo`, [2]],
    ['the first slide after a leading marker', `${SlideMarker.MARKDOWN}\n\nOnly`, [1]],
  ])('numbers the marker that starts %s, as the counter does', (_case, deck, numbers) => {
    editor.commands.setContent(deck)
    expect(SlideFocus.numberedMarkers(editor.state.doc).map((m) => m.number)).toEqual(numbers)
    const drawn = [...editor.view.dom.querySelectorAll('[data-slide-marker][data-slide]')].map((el) => Number(el.getAttribute('data-slide')))
    expect(drawn).toEqual(numbers)
  })

  it('renumbers the markers when the document changes', () => {
    editor.commands.setContent(DECK)
    editor.commands.setTextSelection(posOf('One') + 3)
    editor.commands.insertSlideMarker()
    expect(SlideFocus.numberedMarkers(editor.state.doc).map((m) => m.number)).toEqual([2, 3, 4])
  })

  it('leaves a marker NodeSelection alone when not presenting', () => {
    editor.commands.setContent(DECK)
    const marker = posOf('Two') - 2
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, marker)))
    expect(editor.state.selection.node.type.name).toBe('slideMarker')
  })
})
