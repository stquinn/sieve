// link-mark-roundtrip.test.js — the `link` mark must survive BOTH directions of
// the markdown round-trip (issue #67).
//
// WHY THIS EXISTS. Links are ordinary markdown, not Sieve blocks
// (docs/design/archive/specs/2026-07-27-inline-block-removal-links-decision.md). That
// decision is a silent no-op unless the editor SCHEMA carries a `link` mark:
// StarterKit used to be configured `link: false`, so ProseMirror parsed
// `<p><a href="…">T</a></p>` down to `<p>T</p>` and the href was destroyed on the
// first load — exactly the "links disappear" symptom #67 reports, and a data-loss
// regression no other test would catch (nothing throws; the href is just gone).
//
// The test drives the REAL stack — a live Editor with the SHIPPING StarterKit
// link options (LINK_OPTIONS, imported from the surface so a config change here
// cannot drift from what ships) plus tiptap-markdown — and pins:
//   load      markdown `[Title](url)` → a link mark carrying the href
//   serialize link mark → markdown `[Title](url)`
//   the flags Go's paste ownership depends on (autolink/linkOnPaste off).
//
// Mirrors prose-group-roundtrip.test.js: element:null so onBeforeCreate wires
// editor.storage.markdown without a DOM mount.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Editor } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'
// seed-vendor FIRST: wysiwyg-surface transitively imports the side-effect
// extension modules that build Extension.create(...) at module-eval time.
import './helpers/seed-vendor.js'
import { LINK_OPTIONS } from '../src/static/lens/document-editor/surfaces/wysiwyg-surface.js'

/** @type {any} */
let editor

beforeAll(() => {
  editor = new Editor({
    element: null,
    extensions: [
      StarterKit.configure({ link: LINK_OPTIONS, codeBlock: false }),
      Markdown.configure({ html: true, transformPastedText: true }),
    ],
    content: '',
  })
})

afterAll(() => {
  editor?.destroy()
})

/** The first link mark in the doc, or null. @returns {any} */
function firstLinkMark(ed) {
  let found = null
  ed.state.doc.descendants((node) => {
    if (found) return false
    const m = (node.marks || []).find((mk) => mk.type.name === 'link')
    if (m) found = m
  })
  return found
}

describe('the link mark round-trips through tiptap-markdown (#67)', () => {
  it('the schema HAS a link mark (the regression that silently eats hrefs)', () => {
    expect(editor.schema.marks.link).toBeDefined()
  })

  it('LOAD: markdown `[Title](url)` becomes a link mark carrying the href', () => {
    editor.commands.setContent('[Sieve](https://example.com/docs)')
    const mark = firstLinkMark(editor)
    expect(mark).not.toBeNull()
    expect(mark.attrs.href).toBe('https://example.com/docs')
    expect(editor.state.doc.textContent).toBe('Sieve')
  })

  it('LOAD: an <a> in HTML content becomes a link mark (the block-render.js path)', () => {
    // block-render.js renders prose markdown to HTML and lets PM's DOMParser
    // build the nodes — so the <a> → mark step is the one that actually runs
    // on document load.
    editor.commands.setContent('<p>see <a href="https://example.com/a">this</a></p>')
    expect(firstLinkMark(editor)?.attrs.href).toBe('https://example.com/a')
  })

  it('SERIALIZE: a link mark comes back out as `[Title](url)`', () => {
    editor.commands.setContent('[Sieve](https://example.com/docs)')
    expect(editor.storage.markdown.getMarkdown()).toBe('[Sieve](https://example.com/docs)')
  })

  it('ROUND-TRIP: markdown in, identical markdown out, href intact', () => {
    const md = 'A [titled link](https://example.com/x?y=1) inside a sentence.'
    editor.commands.setContent(md)
    expect(firstLinkMark(editor)?.attrs.href).toBe('https://example.com/x?y=1')
    expect(editor.storage.markdown.getMarkdown()).toBe(md)
  })

  it('a bare URL is NOT auto-linked on load — Go decides what becomes a link', () => {
    // linkify stays off in the Markdown config and autolink is off in
    // LINK_OPTIONS, so prose the user typed is left exactly as written.
    editor.commands.setContent('visit https://example.com/bare now')
    expect(firstLinkMark(editor)).toBeNull()
    expect(editor.storage.markdown.getMarkdown()).toBe('visit https://example.com/bare now')
  })
})

// ── The PASTE path: Go's `content` outcome (#67) ───────────────────────────────
// A URL paste is a Go round-trip that answers {outcome:'content', html:'<a …>…</a>'}
// and the WYSIWYG surface inserts THAT fragment at the caret
// (wysiwyg-surface.js #handleSmartPaste). Two things have to hold for the result to
// be a usable link rather than a trap, and neither is obvious from the config:
// the fragment must parse to a MARK (not flat text), and the caret must land
// OUTSIDE the mark so the next keystroke is ordinary prose.
describe('inserting Go\'s link fragment at the caret (#67 paste)', () => {
  it('the <a> fragment becomes a link MARK, not plain text', () => {
    editor.commands.setContent('')
    editor.commands.insertContent('<a href="https://example.com">Example Domain</a>')
    expect(firstLinkMark(editor)?.attrs.href).toBe('https://example.com')
    expect(editor.state.doc.textContent).toBe('Example Domain')
  })

  it('TYPING immediately after the pasted link produces UNLINKED text', () => {
    // The trap this pins shut: a caret left INSIDE the mark turns every following
    // keystroke into more link text, and the href silently swallows the sentence.
    // tr.insertText is the real typing path — it inherits `storedMarks` or, absent
    // those, the marks at the caret, so this exercises the mechanism a keypress uses
    // rather than asserting a config flag. It holds because TipTap's Link mark is
    // `inclusive: false`: a mark ending AT the caret is not among $from.marks().
    editor.commands.setContent('')
    editor.commands.insertContent('<a href="https://example.com">Example Domain</a>')
    editor.view.dispatch(editor.state.tr.insertText(' and more'))
    // Were the caret inside the mark, this would serialise as
    // `[Example Domain and more](https://example.com)`.
    expect(editor.storage.markdown.getMarkdown())
      .toBe('[Example Domain](https://example.com) and more')
  })

  it('the link mark is inclusive:false — the property the caret escape rests on', () => {
    expect(editor.schema.marks.link.spec.inclusive).toBe(false)
  })
})

describe('LINK_OPTIONS — the shipping configuration', () => {
  it('never opens on click (a navigating webview would replace the Wails app)', () => {
    expect(LINK_OPTIONS.openOnClick).toBe(false)
  })

  it('leaves paste and typing to Go (no linkOnPaste, no autolink)', () => {
    expect(LINK_OPTIONS.linkOnPaste).toBe(false)
    expect(LINK_OPTIONS.autolink).toBe(false)
  })

  it('carries the prose-link class the Mod+Click handler and editor.css key off', () => {
    expect(LINK_OPTIONS.HTMLAttributes.class).toBe('prose-link')
  })

  it('renders no target="_blank"/rel — a webview must never be asked for a new window', () => {
    editor.commands.setContent('[Sieve](https://example.com/docs)')
    const attrs = firstLinkMark(editor).attrs
    expect(attrs.target).toBeNull()
    expect(attrs.rel).toBeNull()
    expect(attrs.class).toBe('prose-link')
  })

  it('is frozen (a shared value, docs/how-to-idiomatic-js.md §3)', () => {
    expect(Object.isFrozen(LINK_OPTIONS)).toBe(true)
    expect(Object.isFrozen(LINK_OPTIONS.HTMLAttributes)).toBe(true)
  })
})
