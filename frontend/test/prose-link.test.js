// prose-link.test.js — links as ordinary markdown, made reachable (#67).
//
// Two affordances land here and they share one owner, ProseLink:
//   A. a prose link can be CONVERTED (right-click → Convert to Card / Web Clip).
//      Its playback is NOT the block Transform every other source uses — a link
//      has no block id, and its enclosing block is the whole paragraph, so
//      replacing that would destroy the sentence around it. The rule is:
//      consume the link's range, create the block AFTER the paragraph, drop the
//      paragraph if the delete emptied it.
//   B. a link's URL can be SEEN and EDITED (Mod+K / the context menu), and a
//      selection can BECOME one — the only creation path in WYSIWYG.
//
// The load-bearing, easy-to-get-silently-wrong pieces pinned here:
//   • contentEntries carries a text/html <a href> view. A rendered link's plain
//     text is the LABEL ALONE, so a text/plain-only entry set has no URL in it
//     anywhere and Go's ContentEntry.Link() finds nothing → ZERO offers, no
//     error, nothing in the menu.
//   • the verb a range source plays back is `extract` (additive), while the MENU
//     keeps the "Convert to …" wording it was offered. WHERE the new block lands
//     is the host's arithmetic against the container's order — not this lens's.
//   • the consuming deletes are ordinary TRACKED prose edits (undo sanctity).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'

// AbstractEditor statically imports the side-effect extension modules, which
// build Extension.create() at module-eval time off the vendor bag (shell.test.js
// carries the same note). These tests never mount a real WysiwygSurface — the
// fake surface hands over a REAL TipTap editor as its editorPane — so inert
// stubs satisfy the imports. block-position stays REAL: its index math is
// exactly what the playback under test uses.
vi.mock('../src/static/lens/extensions.js', () => ({
  SelectionHighlight: {}, HighlightMark: {},
  AiShortcuts: { configure: () => ({}) },
  buildAiContext: vi.fn(() => ({ blockRef: 'doc', contextLabel: 'x' })),
  applyTargetHighlight: vi.fn(),
}))
vi.mock('../src/static/lens/document-editor/block-chrome.js', () => ({ BlockChrome: {}, getBlockSelectionRange: vi.fn() }))
vi.mock('../src/static/lens/document-editor/surfaces/ai-target-decoration.js', () => ({ AiTargetDecoration: {} }))
vi.mock('../src/static/lens/document-editor/surfaces/prose-block.js', () => ({ BlockId: {} }))

import { ProseLink } from '../src/static/lens/document-editor/surfaces/prose-link.js'
import { LINK_OPTIONS } from '../src/static/lens/document-editor/surfaces/wysiwyg-surface.js'
import { AbstractEditor } from '../src/static/lens/abstract-editor.js'
import { AbstractSurface } from '../src/static/lens/document-editor/surfaces/abstract-surface.js'
import { LinkEditDialog } from '../src/static/ui/link-edit-dialog.js'

// ── Harness ──────────────────────────────────────────────────────────────────

/** A real TipTap editor with the SHIPPING link config. */
function makePane(markdown) {
  return new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ link: LINK_OPTIONS, codeBlock: false, trailingNode: false }),
      Markdown.configure({ html: true, transformPastedText: true }),
    ],
    content: markdown,
  })
}

/** The fake surface: a REAL TipTap pane plus a flush recorder. */
class PaneSurface extends AbstractSurface {
  constructor(pane) { super(); this.pane = pane; this.flushCount = 0 }
  get mode() { return 'wysiwyg' }
  get editorPane() { return this.pane }
  mount() {}
  unmount() {}
  applyContainerChange() {}
  paintContainer() {}
  flushPending() { this.flushCount++ }
}

/** An editor whose surface hands over `pane`, with a recording provider. */
function makeEditor(pane) {
  const sent = []
  const provider = {
    requestAddBlock() {},
    requestTransform: (blockId, targetKind, operation, entries) =>
      sent.push({ blockId, targetKind, operation, entries }),
    subscribe() {}, unsubscribe() {},
    getUuid: () => 'doc-1', getKind: () => 'note', getOrder: () => [], getBlock: () => null,
  }
  class TestEditor extends AbstractEditor {
    _createSurface() { return new PaneSurface(pane) }
  }
  const ed = new TestEditor('doc-1', { provider })
  const surface = ed.presentSurface('wysiwyg', document.createElement('div'), null)
  return { ed, sent, surface }
}

/** Caret at a document position. */
function caretAt(pane, pos) {
  pane.commands.setTextSelection(pos)
}

/** The doc position of the first character of `needle` in the doc's text. */
function posOf(pane, needle) {
  let found = -1
  pane.state.doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return
    const i = node.text.indexOf(needle)
    if (i >= 0) found = pos + i
  })
  return found
}

let pane = null
afterEach(() => { if (pane) { pane.destroy(); pane = null } })

// ── ProseLink: resolution + views ────────────────────────────────────────────

describe('ProseLink resolves the link the selection is about', () => {
  it('finds the mark under a caret inside the label', () => {
    pane = makePane('A [titled link](https://example.com/x) inside a sentence.')
    caretAt(pane, posOf(pane, 'titled') + 2)
    const link = ProseLink.forSelection(pane.view)
    expect(link).not.toBeNull()
    expect(link.href).toBe('https://example.com/x')
    expect(link.label).toBe('titled link')
    expect(link.isNew).toBe(false)
  })

  it('the range covers exactly the link text — nothing of the sentence around it', () => {
    pane = makePane('A [titled link](https://example.com/x) inside a sentence.')
    caretAt(pane, posOf(pane, 'titled') + 2)
    const link = ProseLink.forSelection(pane.view)
    expect(pane.state.doc.textBetween(link.from, link.to, '')).toBe('titled link')
  })

  it('finds the mark with the caret at the very END of the label (inclusive:false)', () => {
    pane = makePane('[Sieve](https://example.com/docs) trails off')
    const link = ProseLink.at(pane.view, posOf(pane, 'Sieve') + 'Sieve'.length)
    expect(link?.href).toBe('https://example.com/docs')
  })

  it('a plain-text caret with no mark is not a link', () => {
    pane = makePane('just words here')
    caretAt(pane, 4)
    expect(ProseLink.forSelection(pane.view)).toBeNull()
  })

  it('a non-empty text selection is a link-to-be (isNew) — the creation path', () => {
    pane = makePane('select these words')
    const start = posOf(pane, 'these')
    pane.commands.setTextSelection({ from: start, to: start + 'these words'.length })
    const link = ProseLink.forSelection(pane.view)
    expect(link.isNew).toBe(true)
    expect(link.href).toBe('')
    expect(link.label).toBe('these words')
  })

  it('a whitespace-only selection is not a link-to-be', () => {
    pane = makePane('a  b')
    pane.commands.setTextSelection({ from: 2, to: 3 })
    expect(ProseLink.forSelection(pane.view)).toBeNull()
  })
})

describe('ProseLink.contentEntries — the views Go reads the href from', () => {
  it('carries a text/html <a href> view (WITHOUT it, detection sees no link at all)', () => {
    pane = makePane('[Example](https://example.com/page?a=1)')
    caretAt(pane, posOf(pane, 'Example') + 1)
    const entries = ProseLink.forSelection(pane.view).contentEntries()
    const html = entries.find((e) => e.mimeType === 'text/html')
    expect(html).toBeDefined()
    expect(html.content).toContain('href="https://example.com/page?a=1"')
    expect(html.content).toContain('>Example<')
  })

  it('every entry it sends contains the href — the plain-text view is the markdown form', () => {
    pane = makePane('[Example](https://example.com/page)')
    caretAt(pane, posOf(pane, 'Example') + 1)
    const entries = ProseLink.forSelection(pane.view).contentEntries()
    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) expect(e.content).toContain('https://example.com/page')
    expect(entries.find((e) => e.mimeType === 'text/plain').content)
      .toBe('[Example](https://example.com/page)')
  })

  it('escapes the label and href into the HTML view', () => {
    pane = makePane('[Tom & "Jerry"](https://example.com/?x=1&y=2)')
    caretAt(pane, posOf(pane, 'Tom') + 1)
    const html = ProseLink.forSelection(pane.view).contentEntries()
      .find((e) => e.mimeType === 'text/html').content
    expect(html).toBe('<a href="https://example.com/?x=1&amp;y=2">Tom &amp; &quot;Jerry&quot;</a>')
  })
})

// ── ProseLink.apply — an ordinary prose edit, round-tripping through markdown ──

describe('ProseLink.apply writes the link as ordinary markdown', () => {
  it('edits an existing link\'s URL in place, label untouched', () => {
    pane = makePane('go [here](https://old.example.com) now')
    caretAt(pane, posOf(pane, 'here') + 1)
    ProseLink.forSelection(pane.view).apply('https://new.example.com', 'here')
    expect(pane.storage.markdown.getMarkdown()).toBe('go [here](https://new.example.com) now')
  })

  it('retitles a link (URL and label both replaced)', () => {
    pane = makePane('go [here](https://old.example.com) now')
    caretAt(pane, posOf(pane, 'here') + 1)
    ProseLink.forSelection(pane.view).apply('https://new.example.com', 'there')
    expect(pane.storage.markdown.getMarkdown()).toBe('go [there](https://new.example.com) now')
  })

  it('CREATES a link from selected text (the missing creation path)', () => {
    pane = makePane('read the docs today')
    const start = posOf(pane, 'the docs')
    pane.commands.setTextSelection({ from: start, to: start + 'the docs'.length })
    const link = ProseLink.forSelection(pane.view)
    expect(link.isNew).toBe(true)
    link.apply('https://example.com/docs', 'the docs')
    expect(pane.storage.markdown.getMarkdown()).toBe('read [the docs](https://example.com/docs) today')
  })

  it('a blank title falls back to the URL as the label', () => {
    pane = makePane('x')
    pane.commands.setTextSelection({ from: 1, to: 2 })
    ProseLink.forSelection(pane.view).apply('https://example.com/u', '')
    // label === href, so the serialiser emits the equivalent autolink form.
    expect(pane.state.doc.textContent).toBe('https://example.com/u')
    expect(pane.storage.markdown.getMarkdown()).toBe('<https://example.com/u>')
  })

  it('a blank href is refused (no mark, no text damage)', () => {
    pane = makePane('leave me alone')
    pane.commands.setTextSelection({ from: 1, to: 6 })
    expect(ProseLink.forSelection(pane.view).apply('', 'x')).toBe(false)
    expect(pane.storage.markdown.getMarkdown()).toBe('leave me alone')
  })

  it('the edit is UNDOABLE — it is a tracked prose edit, not a reload', () => {
    pane = makePane('go [here](https://old.example.com) now')
    caretAt(pane, posOf(pane, 'here') + 1)
    ProseLink.forSelection(pane.view).apply('https://new.example.com', 'here')
    pane.commands.undo()
    expect(pane.storage.markdown.getMarkdown()).toBe('go [here](https://old.example.com) now')
  })
})

// ── The shared dialog ────────────────────────────────────────────────────────

describe('LinkEditDialog — ONE dialog, every consumer', () => {
  afterEach(() => { LinkEditDialog.shared().close() })

  it('prefills both fields and hands back the trimmed pair on Save', async () => {
    const saved = []
    LinkEditDialog.shared().open({
      href: 'https://a.example.com', label: 'A', onSave: (h, l) => saved.push([h, l]),
    })
    const dlg = document.querySelector('dialog.link-edit-popup')
    const inputs = dlg.querySelectorAll('.block-edit-popup__input')
    expect(inputs[0].value).toBe('https://a.example.com')
    expect(inputs[1].value).toBe('A')
    inputs[0].value = '  https://b.example.com  '
    inputs[1].value = '  B  '
    dlg.querySelector('.ask-popup__send').click()
    expect(saved).toEqual([['https://b.example.com', 'B']])
  })

  it('a blank title falls back to the URL before the consumer ever sees it', () => {
    const saved = []
    LinkEditDialog.shared().open({ href: 'https://a.example.com', label: 'A', onSave: (h, l) => saved.push([h, l]) })
    const dlg = document.querySelector('dialog.link-edit-popup')
    const inputs = dlg.querySelectorAll('.block-edit-popup__input')
    inputs[1].value = ''
    dlg.querySelector('.ask-popup__send').click()
    expect(saved).toEqual([['https://a.example.com', 'https://a.example.com']])
  })

  it('a blank URL never reaches the consumer (the dialog stays open)', () => {
    const saved = []
    LinkEditDialog.shared().open({ href: '', label: 'A', onSave: (h, l) => saved.push([h, l]) })
    const dlg = document.querySelector('dialog.link-edit-popup')
    dlg.querySelector('.ask-popup__send').click()
    expect(saved).toEqual([])
  })

  it('is a singleton — a second open reuses the SAME <dialog> element', () => {
    LinkEditDialog.shared().open({ href: 'https://a', onSave: () => {} })
    LinkEditDialog.shared().open({ href: 'https://b', onSave: () => {} })
    expect(document.querySelectorAll('dialog.link-edit-popup').length).toBe(1)
  })
})

// ── The Convert playback: consume the range, create after the paragraph ──────

describe('converting a prose link (#67 playback)', () => {
  const ENTRIES = [{ mimeType: 'text/html', content: '<a href="https://example.com/x">T</a>' }]

  /** Fires the menu's dispatch for a link at `label`, exactly as the menu does. */
  function convert(ed, pane, label) {
    caretAt(pane, posOf(pane, label) + 1)
    const link = ProseLink.forSelection(pane.view)
    return ed.extract({
      blockId: 'prose-1',
      targetKind: 'smart-card',
      operation: 'transform',        // the verb the MENU was offered
      entries: ENTRIES,
      sourceRange: link.range,
      context: {},
    })
  }

  it('a link ALONE in its paragraph: the paragraph goes, the block takes its slot', async () => {
    pane = makePane('first para\n\n[T](https://example.com/x)\n\nlast para')
    const { ed, sent } = makeEditor(pane)
    await convert(ed, pane, 'T')

    // The link's paragraph was the doc's 2nd block and is gone; the new block
    // takes its place, so the result is NOT "link + block".
    expect(pane.state.doc.childCount).toBe(2)
    expect(pane.storage.markdown.getMarkdown()).toBe('first para\n\nlast para')
    expect(sent).toHaveLength(1)
  })

  it('a link MID-SENTENCE: only the link is consumed, the sentence survives', async () => {
    pane = makePane('see [T](https://example.com/x) for details')
    const { ed, sent } = makeEditor(pane)
    await convert(ed, pane, 'T')

    expect(pane.storage.markdown.getMarkdown()).toBe('see  for details')
    expect(pane.state.doc.childCount).toBe(1)
    // WHERE it lands is not stated here: the verb names the SOURCE BLOCK, and the
    // host resolves that to a position against the container's own order.
    expect(sent[0].blockId).toBe('prose-1')
  })

  it('plays back the ADDITIVE verb — a range source has no block to replace', async () => {
    pane = makePane('see [T](https://example.com/x) for details')
    const { ed, sent } = makeEditor(pane)
    await convert(ed, pane, 'T')
    expect(sent[0].operation).toBe('extract')
    expect(sent[0].targetKind).toBe('smart-card')
    expect(sent[0].entries).toEqual(ENTRIES)
  })

  it('flushes the block-sync so Go applies the prose delete BEFORE the create', async () => {
    pane = makePane('see [T](https://example.com/x) for details')
    const { ed, sent, surface } = makeEditor(pane)
    await convert(ed, pane, 'T')
    expect(surface.flushCount).toBe(1)
    expect(sent).toHaveLength(1)
  })

  it('the consume is UNDOABLE (tracked prose edits, never addToHistory:false)', async () => {
    pane = makePane('see [T](https://example.com/x) for details')
    const { ed } = makeEditor(pane)
    await convert(ed, pane, 'T')
    pane.commands.undo()
    expect(pane.storage.markdown.getMarkdown()).toBe('see [T](https://example.com/x) for details')
  })

  it('keeps a SOLE emptied paragraph (deleting the doc\'s only child is invalid)', async () => {
    pane = makePane('[T](https://example.com/x)')
    const { ed, sent } = makeEditor(pane)
    await convert(ed, pane, 'T')
    expect(pane.state.doc.childCount).toBe(1)
    expect(sent).toHaveLength(1)
  })

  it('leaves ordinary block sources on the in-place TRANSFORM verb', async () => {
    pane = makePane('hello')
    const { ed, sent } = makeEditor(pane)
    await ed.extract({ blockId: 'blk-1', targetKind: 'smart-card', operation: 'transform', entries: ENTRIES })
    expect(sent[0].operation).toBe('transform')
    expect(sent[0].blockId).toBe('blk-1')
  })
})
