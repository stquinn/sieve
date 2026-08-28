// @ts-check
// macro-catalog.test.js — the workspace's half of the `{` picker (#91 phase 2).
//
// The catalog is composed against the REAL renderer manifest, not a fixture: the
// kinds asserted here are the kinds the picker offers. What is pinned is the
// composition (every insertable kind, then the workspace's own Web Clip verb,
// then Attach File), the freshness of each read, and what a verb's acceptance
// COSTS — the token goes, the verb runs, and nothing is created until whatever
// it opens says so.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MacroCatalog } from '../src/static/shell/macro-catalog.js'
import { BlockMacro, ActionMacro } from '../src/static/shell/trigger-providers.js'
import { TriggerHost } from '../src/static/shell/trigger-host.js'

/** A workspace-shaped dialog host that RECORDS rather than opens. */
function dialogHost() {
  return { openWebClipDialog: vi.fn() }
}

/**
 * A document host that records both halves it could be asked for: the block it
 * was told to make, and the text range it was told to clear.
 */
class RecordingDocumentHost extends TriggerHost {
  constructor() {
    super()
    /** @type {Array<{kind: string, attrs: any, token: any}>} */ this.created = []
    /** @type {Array<[number, number, string]>} */ this.replaced = []
  }

  anchorElement() { return document.body }
  onKeyDown() { return () => {} }
  onDismiss() { return () => {} }
  createBlock(kind, attrs, token) { this.created.push({ kind, attrs, token }) }
  textAfter() { return '' }
  replaceRange(start, end, text) { this.replaced.push([start, end, text]) }
}

/** @param {any} macro @returns {import('../src/static/shell/trigger-providers.js').TriggerToken} */
function tokenFor(macro) {
  return Object.freeze({ provider: /** @type {any} */ (macro), start: 6, end: 10, prefix: 'web' })
}

/** @param {MacroCatalog} catalog @param {string} name */
function byName(catalog, name) {
  const found = catalog.list().find((m) => m.name === name)
  if (!found) throw new Error('no macro named ' + name)
  return found
}

describe('MacroCatalog — what the host offers the `{` picker', () => {
  it('leads with every insertable kind, in the vocabulary\'s own order', () => {
    const list = new MacroCatalog(dialogHost()).list()
    expect(list.slice(0, 3).map((m) => m.name)).toEqual(['code', 'diagram', 'log'])
    for (const macro of list.slice(0, 3)) expect(macro).toBeInstanceOf(BlockMacro)
  })

  it('follows them with the Web Clip verb it owns the dialog for, then Attach File', () => {
    const list = new MacroCatalog(dialogHost()).list()
    expect(list.slice(3).map((m) => m.name)).toEqual(['web-clip', 'image'])
    for (const macro of list.slice(3)) expect(macro).toBeInstanceOf(ActionMacro)
  })

  it('names each entry and says what it is', () => {
    for (const macro of new MacroCatalog(dialogHost()).list()) {
      expect(macro.label).toBeTruthy()
      expect(macro.description).toBeTruthy()
      expect(typeof macro.icon).toBe('string')
    }
  })

  it('mints its entries on every read — nothing accumulates and no defaults are shared', () => {
    const catalog = new MacroCatalog(dialogHost())
    const first = catalog.list()
    const second = catalog.list()
    expect(second.map((m) => m.name)).toEqual(first.map((m) => m.name))
    expect(second[0]).not.toBe(first[0])
  })

  it('is built before the dialogs are, and still reaches them — the verb is late-bound', () => {
    /** @type {any} */ const late = {}
    const catalog = new MacroCatalog(late)
    late.openWebClipDialog = vi.fn()
    byName(catalog, 'web-clip').run(/** @type {any} */ (new RecordingDocumentHost()), tokenFor(null))
    expect(late.openWebClipDialog).toHaveBeenCalledTimes(1)
  })
})

describe('MacroCatalog — accepting a URL verb', () => {
  it('clears the typed token FIRST, so a cancelled dialog leaves clean text', () => {
    const host = new RecordingDocumentHost()
    const dialogs = dialogHost()
    byName(new MacroCatalog(dialogs), 'web-clip').run(/** @type {any} */ (host), tokenFor(null))
    expect(host.replaced).toEqual([[6, 10, '']])
  })

  it('opens the web-clip dialog and creates NOTHING — the dialog owns the create', () => {
    const host = new RecordingDocumentHost()
    const dialogs = dialogHost()
    byName(new MacroCatalog(dialogs), 'web-clip').run(/** @type {any} */ (host), tokenFor(null))
    expect(dialogs.openWebClipDialog).toHaveBeenCalledTimes(1)
    expect(host.created).toEqual([])
  })

  it('opens the dialog with no prefill — a `{` gesture carries no URL', () => {
    const dialogs = dialogHost()
    byName(new MacroCatalog(dialogs), 'web-clip').run(/** @type {any} */ (new RecordingDocumentHost()), tokenFor(null))
    expect(dialogs.openWebClipDialog.mock.calls[0]).toEqual([])
  })
})

describe('MacroCatalog — accepting Attach File', () => {
  /** A workspace-shaped host with an active Tab whose editor records the
   *  toolbar's own capture call. */
  function attachHost(anchor = 'anchor-block-id') {
    return Object.assign(dialogHost(), {
      activeTab: { editor: { captureImageInsert: vi.fn(() => anchor) } },
    })
  }

  beforeEach(() => { document.body.innerHTML = '<input id="tb-attach-input" type="file">' })
  afterEach(() => {
    document.body.innerHTML = ''
    delete (/** @type {any} */ (window)).__sieveCapturedInsertAnchor
  })

  it('clears the typed token FIRST, exactly like the URL verbs', () => {
    const host = new RecordingDocumentHost()
    byName(new MacroCatalog(attachHost()), 'image').run(/** @type {any} */ (host), tokenFor(null))
    expect(host.replaced).toEqual([[6, 10, '']])
  })

  it('captures the insert anchor and clicks the hidden file input, mirroring the toolbar', () => {
    const dialogs = attachHost('the-anchor')
    const input = /** @type {HTMLInputElement} */ (document.getElementById('tb-attach-input'))
    const clickSpy = vi.spyOn(input, 'click')
    byName(new MacroCatalog(dialogs), 'image').run(/** @type {any} */ (new RecordingDocumentHost()), tokenFor(null))
    expect(dialogs.activeTab.editor.captureImageInsert).toHaveBeenCalledTimes(1)
    expect(/** @type {any} */ (window).__sieveCapturedInsertAnchor).toBe('the-anchor')
    expect(clickSpy).toHaveBeenCalledTimes(1)
  })

  it('creates nothing itself — the paste pipeline decides the block', () => {
    const host = new RecordingDocumentHost()
    byName(new MacroCatalog(attachHost()), 'image').run(/** @type {any} */ (host), tokenFor(null))
    expect(host.created).toEqual([])
  })

  it('no-ops without an active editor, having already cleared the token', () => {
    const host = new RecordingDocumentHost()
    const dialogs = Object.assign(dialogHost(), { activeTab: null })
    const input = /** @type {HTMLInputElement} */ (document.getElementById('tb-attach-input'))
    const clickSpy = vi.spyOn(input, 'click')
    byName(new MacroCatalog(dialogs), 'image').run(/** @type {any} */ (host), tokenFor(null))
    expect(host.replaced).toEqual([[6, 10, '']])
    expect(clickSpy).not.toHaveBeenCalled()
  })
})
