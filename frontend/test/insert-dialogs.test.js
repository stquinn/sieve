// insert-dialogs.test.js — P4.C/P4.F. The two URL insert dialogs (the smart-card
// one and the four-rung "Insert from URL" ladder) are now a Workspace-owned child
// (shell/insert-dialogs.js) — ONE class holding BOTH lazily-built <dialog>s. It
// builds no DOM in the constructor (vitest-safe), creates each dialog on first open
// (document.body.appendChild), validates the URL via the shared http/https gate, and
// inserts through the editor's own verbs. Backs workspace.openUrlCardDialog(url?) /
// openWebClipDialog(url?).
//
// The CONTRACT SHIFT pinned here (vs the old editor.js free functions): the insert
// guard is now "an active editor exists + (has editorPane OR markdown mode)" — the old
// currentUuid guard collapsed into "activeTab.editor exists" — and the create path
// is createBlock (index-native; derives the caret block index itself), not a
// captureInsertPos/setInsertPos/applyBlockOps dance.
//
// TWO editor verbs, pinned here because the asymmetry is deliberate (#67): the three
// block rungs call createBlock; the LINK rung calls insertLink, because a link is an
// inline mark with no block to create. The ladder's ORDER is pinned too — it reads
// as one dial (Link · Card · Summarise · Fetch: least of the page in the document to
// most), not four unrelated buttons.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { InsertDialogs } from '../src/static/shell/insert-dialogs.js'

// A fake editor exposing exactly the public AbstractEditor surface InsertDialogs
// touches: mode + editorPane (the insert guard), createBlock (the block create path)
// and insertLink (the inline one).
function fakeEditor({ mode = 'wysiwyg', hasEditorPane = true } = {}) {
  return {
    mode,
    editorPane: hasEditorPane ? {} : null,
    createBlock: vi.fn(),
    insertLink: vi.fn(() => Promise.resolve(true)),
  }
}

function fakeWorkspace(editor) {
  return {
    _editor: editor,
    get activeTab() { return this._editor ? { editor: this._editor } : null },
  }
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('InsertDialogs — construction is headless-safe', () => {
  it('the constructor builds NO DOM (no dialog appended on new)', () => {
    const before = document.querySelectorAll('dialog').length
    // eslint-disable-next-line no-new
    new InsertDialogs(fakeWorkspace(fakeEditor()))
    expect(document.querySelectorAll('dialog').length).toBe(before)
  })

  it('open verbs null-guard a missing active editor (no throw, no dialog crash)', () => {
    const dialogs = new InsertDialogs(fakeWorkspace(null))
    expect(() => { dialogs.openUrlCard(); dialogs.openWebClip() }).not.toThrow()
  })
})

describe('InsertDialogs — URL Card dialog', () => {
  it('openUrlCard lazily builds a single <dialog> and prefills the url input', () => {
    const dialogs = new InsertDialogs(fakeWorkspace(fakeEditor()))
    dialogs.openUrlCard('https://example.com/a')
    const dialog = document.querySelector('dialog.internalize-popup')
    expect(dialog).toBeTruthy()
    expect(dialog.querySelector('input').value).toBe('https://example.com/a')
    // A second open reuses the same dialog (lazy, single instance).
    dialogs.openUrlCard('https://example.com/b')
    expect(document.querySelectorAll('dialog').length).toBe(1)
  })

  it('a valid URL + Insert Card inserts a smart-card block through the editor methods', () => {
    const editor = fakeEditor()
    const dialogs = new InsertDialogs(fakeWorkspace(editor))
    dialogs.openUrlCard()
    const dialog = document.querySelector('dialog.internalize-popup')
    dialog.querySelector('input').value = 'https://good.example'
    // The single footer button is the Insert Card action.
    dialog.querySelector('.internalize-popup__btn').click()

    expect(editor.createBlock).toHaveBeenCalledWith('smart-card', { href: 'https://good.example' })
  })

  it('an invalid URL shows the error row and does NOT insert', () => {
    const editor = fakeEditor()
    const dialogs = new InsertDialogs(fakeWorkspace(editor))
    dialogs.openUrlCard()
    const dialog = document.querySelector('dialog.internalize-popup')
    dialog.querySelector('input').value = 'ftp://nope'
    dialog.querySelector('.internalize-popup__btn').click()

    expect(dialog.querySelector('.internalize-popup__error').style.display).toBe('')
    expect(editor.createBlock).not.toHaveBeenCalled()
  })

  it('garbage (unparseable) URL is rejected, no insert', () => {
    const editor = fakeEditor()
    const dialogs = new InsertDialogs(fakeWorkspace(editor))
    dialogs.openUrlCard()
    const dialog = document.querySelector('dialog.internalize-popup')
    dialog.querySelector('input').value = 'not a url at all'
    dialog.querySelector('.internalize-popup__btn').click()
    expect(editor.createBlock).not.toHaveBeenCalled()
  })
})

describe('InsertDialogs — Insert from URL ladder (Link / Card / Summarise / Fetch)', () => {
  function openClip(editor) {
    const dialogs = new InsertDialogs(fakeWorkspace(editor))
    dialogs.openWebClip('https://clip.example')
    return document.querySelector('dialog.internalize-popup')
  }

  it('is titled for what it offers, not for one of its rungs', () => {
    const dialog = openClip(fakeEditor())
    expect(dialog.querySelector('.ask-popup__label').textContent).toBe('Insert from URL')
  })

  it('the footer is the LADDER, in order: Link · Card · Summarise · Fetch', () => {
    const dialog = openClip(fakeEditor())
    const labels = [...dialog.querySelectorAll('.internalize-popup__btn')].map((b) => b.textContent)
    expect(labels).toEqual(['Link', 'Card', 'Summarise', 'Fetch'])
  })

  it('Link inserts through editor.insertLink — NOT createBlock (a mark, not a block)', () => {
    const editor = fakeEditor()
    const dialog = openClip(editor)
    ;[...dialog.querySelectorAll('.internalize-popup__btn')].find((b) => b.textContent === 'Link').click()
    expect(editor.insertLink).toHaveBeenCalledWith('https://clip.example')
    expect(editor.createBlock).not.toHaveBeenCalled()
  })

  it('Fetch inserts a web-clip block with mode=fetch', () => {
    const editor = fakeEditor()
    const dialog = openClip(editor)
    ;[...dialog.querySelectorAll('.internalize-popup__btn')].find((b) => b.textContent === 'Fetch').click()
    expect(editor.createBlock).toHaveBeenCalledWith('web-clip', { source: 'https://clip.example', mode: 'fetch' })
    expect(editor.insertLink).not.toHaveBeenCalled()
  })

  it('Summarise inserts a web-clip block with mode=summarise', () => {
    const editor = fakeEditor()
    const dialog = openClip(editor)
    ;[...dialog.querySelectorAll('.internalize-popup__btn')].find((b) => b.textContent === 'Summarise').click()
    expect(editor.createBlock).toHaveBeenCalledWith('web-clip', { source: 'https://clip.example', mode: 'summarise' })
  })

  it('the Card button routes to the SAME smart-card create path', () => {
    const editor = fakeEditor()
    const dialog = openClip(editor)
    ;[...dialog.querySelectorAll('.internalize-popup__btn')].find((b) => b.textContent === 'Card').click()
    expect(editor.createBlock).toHaveBeenCalledWith('smart-card', { href: 'https://clip.example' })
  })

  it('an invalid URL blocks every rung', () => {
    const editor = fakeEditor()
    const dialogs = new InsertDialogs(fakeWorkspace(editor))
    dialogs.openWebClip('javascript:alert(1)')
    const dialog = document.querySelector('dialog.internalize-popup')
    const btns = [...dialog.querySelectorAll('.internalize-popup__btn')]
    btns.forEach((b) => b.click())
    expect(editor.createBlock).not.toHaveBeenCalled()
    expect(editor.insertLink).not.toHaveBeenCalled()
    expect(dialog.querySelector('.internalize-popup__error').style.display).toBe('')
    expect(dialog.querySelector('.internalize-popup__error').textContent).toContain('valid http')
  })

  // A link is a MARK: markdown source mode has nowhere to put one (the user types
  // the markdown there). The rung must SAY so, not close on a silent no-op — while
  // the three block rungs keep working in that mode.
  it('Link in markdown mode explains itself instead of silently doing nothing', () => {
    const editor = fakeEditor({ mode: 'markdown', hasEditorPane: false })
    const dialog = openClip(editor)
    ;[...dialog.querySelectorAll('.internalize-popup__btn')].find((b) => b.textContent === 'Link').click()
    expect(editor.insertLink).not.toHaveBeenCalled()
    const err = dialog.querySelector('.internalize-popup__error')
    expect(err.style.display).toBe('')
    expect(err.textContent).toContain('rich-text')
    expect(dialog.open).toBe(true)   // stays put rather than closing on a no-op
  })

  it('the block rungs still insert in markdown mode', () => {
    const editor = fakeEditor({ mode: 'markdown', hasEditorPane: false })
    const dialog = openClip(editor)
    ;[...dialog.querySelectorAll('.internalize-popup__btn')].find((b) => b.textContent === 'Card').click()
    expect(editor.createBlock).toHaveBeenCalledWith('smart-card', { href: 'https://clip.example' })
  })
})

describe('InsertDialogs — insert guard (CONTRACT SHIFT)', () => {
  it('inserts in markdown mode even with no editorPane surface', () => {
    const editor = fakeEditor({ mode: 'markdown', hasEditorPane: false })
    const dialogs = new InsertDialogs(fakeWorkspace(editor))
    dialogs.openUrlCard()
    const dialog = document.querySelector('dialog.internalize-popup')
    dialog.querySelector('input').value = 'https://ok.example'
    dialog.querySelector('.internalize-popup__btn').click()
    expect(editor.createBlock).toHaveBeenCalled()
  })

  it('does NOT insert when there is neither an editorPane surface nor markdown mode', () => {
    const editor = fakeEditor({ mode: 'wysiwyg', hasEditorPane: false })
    const dialogs = new InsertDialogs(fakeWorkspace(editor))
    dialogs.openUrlCard()
    const dialog = document.querySelector('dialog.internalize-popup')
    dialog.querySelector('input').value = 'https://ok.example'
    dialog.querySelector('.internalize-popup__btn').click()
    expect(editor.createBlock).not.toHaveBeenCalled()
  })
})
