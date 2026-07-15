// insert-dialogs.test.js — P4.C/P4.F. The two URL insert dialogs (smart-card + web-clip)
// are now a Workspace-owned child (shell/insert-dialogs.js) — ONE class holding
// BOTH lazily-built <dialog>s. It builds no DOM in the constructor (vitest-safe),
// creates each dialog on first open (document.body.appendChild), validates the URL
// via the shared http/https gate, and inserts through the editor's ONE self-sufficient
// create path — AbstractEditor.createBlock(kind, attrs) (P4.F: no insert-pos dance,
// no shared bus). Backs workspace.openUrlCardDialog(url?) / openWebClipDialog(url?).
//
// The CONTRACT SHIFT pinned here (vs the old editor.js free functions): the insert
// guard is now "an active editor exists + (has editorPane OR markdown mode)" — the old
// currentUuid guard collapsed into "activeTab.editor exists" — and the create path
// is createBlock (index-native; derives the caret block index itself), not a
// captureInsertPos/setInsertPos/applyBlockOps dance.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { InsertDialogs } from '../src/static/shell/insert-dialogs.js'

// A fake editor exposing exactly the public AbstractEditor surface InsertDialogs
// touches: mode + editorPane (the insert guard) and createBlock (the ONE create path).
function fakeEditor({ mode = 'wysiwyg', hasEditorPane = true } = {}) {
  return {
    mode,
    editorPane: hasEditorPane ? {} : null,
    createBlock: vi.fn(),
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

describe('InsertDialogs — Web Clip dialog (Fetch / Summarise / Card)', () => {
  function openClip(editor) {
    const dialogs = new InsertDialogs(fakeWorkspace(editor))
    dialogs.openWebClip('https://clip.example')
    return document.querySelector('dialog.internalize-popup')
  }

  it('Fetch inserts a web-clip block with mode=fetch', () => {
    const editor = fakeEditor()
    const dialog = openClip(editor)
    const btns = dialog.querySelectorAll('.internalize-popup__btn')
    expect(btns.length).toBe(3) // Fetch / Summarise / Card
    ;[...btns].find((b) => b.textContent === 'Fetch').click()
    expect(editor.createBlock).toHaveBeenCalledWith('web-clip', { source: 'https://clip.example', mode: 'fetch' })
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

  it('an invalid URL blocks all three actions', () => {
    const editor = fakeEditor()
    const dialogs = new InsertDialogs(fakeWorkspace(editor))
    dialogs.openWebClip('javascript:alert(1)')
    const dialog = document.querySelector('dialog.internalize-popup')
    ;[...dialog.querySelectorAll('.internalize-popup__btn')].find((b) => b.textContent === 'Fetch').click()
    expect(editor.createBlock).not.toHaveBeenCalled()
    expect(dialog.querySelector('.internalize-popup__error').style.display).toBe('')
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
