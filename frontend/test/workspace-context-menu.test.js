// @ts-check
// workspace-context-menu.test.js — WHICH MOUNT A RIGHT-CLICK BELONGS TO IS A
// FACT ABOUT THE GESTURE (#118 3c).
//
// The host has two instruments on the page — the tab's document and the panel's
// draft — and the menu is raised over exactly one of them. Resolving that from a
// hardcoded mount id plus "the active tab" is what left the composer showing the
// browser's own menu: it is not in that element and its lens is not that editor.
//
// So the resolution walks the MOUNTED LENSES and asks which one's fixture
// contains the target. A lens publishes the element it was mounted in, so this
// names no mount, and a third arrangement needs no third listener.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The Workspace pulls its children at module-eval; SieveTab drags in the editor →
// TipTap chain, which the bare test vendor bag cannot build. None of them
// participates in the resolution — the lenses are handed in directly.
vi.mock('../src/static/shell/tab.js', () => ({
  SieveTab: class {
    constructor(uuid) { this.uuid = uuid; this.editor = null; this.mount = null }
    // Activating a tab points the host's selection stream at it.
    onSelectionUpdate() { return () => {} }
    getSelectionContext() { return null }
  },
}))
vi.mock('../src/static/shell/ask-panel.js', () => ({
  AskPanel: class { constructor() { this.composer = { editor: null } } },
}))
vi.mock('../src/static/shell/insert-dialogs.js', () => ({ InsertDialogs: class {} }))
vi.mock('../src/static/shell/search-overlay.js', () => ({ SearchOverlay: class {} }))
vi.mock('../src/static/shell/status-bar.js', () => ({ StatusBar: class {} }))
vi.mock('../src/static/shell/sidebar-view.js', () => ({
  SidebarView: class { attach() { return this } },
}))
vi.mock('../src/static/shell/command-badges.js', () => ({ CommandBadges: class {} }))

import { SieveWorkspace } from '../src/static/shell/workspace.js'

/** A lens as the resolution reads one: mounted, in an element, over a pane. */
function lensIn(el, name) {
  return { isMounted: true, host: el, editorPane: { name } }
}

/** @param {string} id @returns {HTMLElement} */
function mountEl(id) {
  const el = document.createElement('div')
  el.id = id
  const inner = document.createElement('p')
  el.appendChild(inner)
  document.body.appendChild(el)
  return el
}

/** Every menu the host raised in one test. The listener is named so it can be
 *  taken off again: the workspace's own document listeners outlive their test,
 *  and a second recorder would count one gesture twice. */
const record = (e) => raised.push(/** @type {any} */ (e).detail)

/** @type {any} */ let ws
/** @type {any[]} */ let raised
/** @type {HTMLElement} */ let noteMount
/** @type {HTMLElement} */ let draftMount
/** @type {HTMLElement} */ let outside

beforeEach(() => {
  document.body.innerHTML = ''
  noteMount = mountEl('note-mount')
  draftMount = mountEl('draft-mount')
  outside = mountEl('sidebar')
  raised = []
  document.addEventListener('sieve:contextmenu', record)
  ws = new SieveWorkspace()
  ws.bootChrome()
  ws.bootEditorLifecycle()
})

afterEach(() => {
  document.removeEventListener('sieve:contextmenu', record)
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

/** Right-clicks inside `el` and reports whether the browser's own menu survived. */
function rightClick(el) {
  const target = el.firstElementChild || el
  const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return { nativeSuppressed: event.defaultPrevented }
}

/** The tab's document lens, mounted. */
function mountNote() {
  const lens = lensIn(noteMount, 'note')
  ws.openTab('u-1').editor = lens
  return lens
}

/** The panel's draft lens, mounted. */
function mountDraft() {
  const lens = lensIn(draftMount, 'draft')
  ws.askPanel.composer.editor = lens
  return lens
}

describe('a right-click is resolved to the mount it happened in', () => {
  it('in the document mount, it carries the TAB\'s pane', () => {
    const note = mountNote()
    mountDraft()
    expect(rightClick(noteMount).nativeSuppressed).toBe(true)
    expect(raised).toHaveLength(1)
    expect(raised[0].context).toEqual({ type: 'editor', editor: note.editorPane })
  })

  it('in the draft, it carries the COMPOSER\'s pane — the bug that shipped the native menu', () => {
    mountNote()
    const draft = mountDraft()
    expect(rightClick(draftMount).nativeSuppressed).toBe(true)
    expect(raised).toHaveLength(1)
    expect(raised[0].context).toEqual({ type: 'editor', editor: draft.editorPane })
  })

  it('outside every mount, the browser keeps its own menu and nothing is raised', () => {
    mountNote()
    mountDraft()
    expect(rightClick(outside).nativeSuppressed).toBe(false)
    expect(raised).toHaveLength(0)
  })

  it('in a mount whose lens is NOT mounted, nothing is claimed', () => {
    const note = mountNote()
    note.isMounted = false
    expect(rightClick(noteMount).nativeSuppressed).toBe(false)
    expect(raised).toHaveLength(0)
  })

  it('with no draft mounted at all, the document mount still answers', () => {
    const note = mountNote()
    expect(rightClick(noteMount).nativeSuppressed).toBe(true)
    expect(raised[0].context.editor).toBe(note.editorPane)
  })

  it('with only a draft mounted, the draft answers with no tab open', () => {
    const draft = mountDraft()
    expect(rightClick(draftMount).nativeSuppressed).toBe(true)
    expect(raised[0].context.editor).toBe(draft.editorPane)
  })
})

// A sieve block raises its OWN menu from its node view and stops the event; the
// suppression still has to happen, or the browser's menu lands on top of it.
describe('a sieve block inside a mount keeps its own menu', () => {
  it('the native menu is suppressed but no editor menu is raised', () => {
    mountNote()
    const block = document.createElement('div')
    block.className = 'sieve-block'
    noteMount.appendChild(block)
    const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    block.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(raised).toHaveLength(0)
  })
})
