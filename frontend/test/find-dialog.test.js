// @ts-check
// find-dialog.test.js — the find bar's own logic. NEW FILE because FindDialog is
// a genuinely new unit: the workspace chrome that owns the find feature's
// lifecycle, the two different replaces, and where the reader stands.
//
// Everything it talks to is faked, because everything it talks to belongs to
// someone else: the MOUNT carries the wire (the control frame, the answered
// spend) and the EDITOR carries the drawing (the count, the current match).
// What is left — and what is under test — is the bar's own decisions: when a
// search is sent, what a replace is gated on, and which keys it answers.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FindDialog } from '../src/static/shell/find-dialog.js'
import { Feature } from '../src/static/generated/protocol.js'

/** The lens's answers about what it has drawn, and the verbs the bar drives. */
function fakeEditor(position = { current: 0, total: 0 }) {
  /** @type {Array<(e: any) => void>} */ const listeners = []
  return {
    position: position,
    findPosition: vi.fn(function () { return this.position }),
    findStep: vi.fn(),
    currentFindMark: vi.fn(function () {
      return this.position.total ? { blockId: 'b1', quote: 'the', occurrence: 0, grain: 'literal' } : null
    }),
    flushEdits: vi.fn(),
    focus: vi.fn(),
    onEvent: vi.fn((/** @type {any} */ fn) => { listeners.push(fn); return () => {} }),
    /** @param {any} e */
    emit: (e) => { for (const fn of listeners) fn(e) },
  }
}

/** The host's door to one container's wire. */
function fakeMount(uuid = 'doc-1') {
  /** @type {Array<(outcome: string) => void>} */ const settle = []
  return {
    getUuid: () => uuid,
    setFeature: vi.fn(),
    replaceText: vi.fn(() => new Promise((resolve) => settle.push(resolve))),
    /** Settles the oldest in-flight spend. @param {string} [outcome] */
    answer: (outcome = 'ok') => { const r = settle.shift(); if (r) r(outcome) },
    inFlight: () => settle.length,
  }
}

/** The workspace as the bar sees it: which tab is active, and the announcement
 *  that it changed — the seam the host already offers its chrome children. */
function staged(position) {
  const editor = fakeEditor(position)
  const mount = fakeMount()
  /** @type {Array<(tab: any) => void>} */ const listeners = []
  const ws = /** @type {any} */ ({
    activeTab: { editor: editor, mount: mount },
    onActiveTabChanged: (/** @type {any} */ fn) => { listeners.push(fn); return () => {} },
    /** Activates a tab the way the host does: point at it, then say so.
     *  @param {any} tab */
    activate: (tab) => { ws.activeTab = tab; for (const fn of listeners) fn(tab) },
  })
  return { dialog: new FindDialog(ws), editor: editor, mount: mount, ws: ws }
}

/** The bar's own controls, by their accessible names. */
const control = (label) => /** @type {HTMLElement} */ (document.querySelector('[aria-label="' + label + '"]'))
const termInput = () => /** @type {HTMLInputElement} */ (control('Find'))
const replaceInput = () => /** @type {HTMLInputElement} */ (control('Replace with'))
const countText = () => /** @type {HTMLElement} */ (document.querySelector('.editor-find__count')).textContent

/** @param {HTMLElement} el @param {string} key @param {{shiftKey?: boolean, keyCode?: number}} [mods] */
const press = (el, key, mods = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: key, bubbles: true, cancelable: true }, mods)))

beforeEach(() => { vi.useFakeTimers(); document.body.innerHTML = '' })
afterEach(() => { vi.useRealTimers() })

describe('FindDialog — switching the feature on and off', () => {
  it('opening sends the search on the container that is open, without waiting for a debounce', () => {
    const { dialog, mount } = staged()
    dialog.open()
    expect(mount.setFeature).toHaveBeenCalledWith(Feature.FIND, true, { term: '', caseSensitive: false })
  })

  it('typing settles into ONE search', () => {
    const { dialog, mount } = staged()
    dialog.open()
    mount.setFeature.mockClear()
    termInput().value = 't'
    termInput().dispatchEvent(new Event('input'))
    termInput().value = 'th'
    termInput().dispatchEvent(new Event('input'))
    termInput().value = 'the'
    termInput().dispatchEvent(new Event('input'))
    expect(mount.setFeature).not.toHaveBeenCalled()

    vi.advanceTimersByTime(250)
    expect(mount.setFeature).toHaveBeenCalledTimes(1)
    expect(mount.setFeature).toHaveBeenCalledWith(Feature.FIND, true, { term: 'the', caseSensitive: false })
  })

  it('the case toggle is a parameters change like any other, and says so to a reader', () => {
    const { dialog, mount } = staged()
    dialog.open()
    termInput().value = 'the'
    mount.setFeature.mockClear()
    control('Match case').click()
    expect(control('Match case').getAttribute('aria-pressed')).toBe('true')

    vi.advanceTimersByTime(250)
    expect(mount.setFeature).toHaveBeenCalledWith(Feature.FIND, true, { term: 'the', caseSensitive: true })
  })

  it('an emptied term still goes as an enabled search — that is what clears the highlights', () => {
    const { dialog, mount } = staged()
    dialog.open()
    termInput().value = ''
    termInput().dispatchEvent(new Event('input'))
    vi.advanceTimersByTime(250)
    expect(mount.setFeature).toHaveBeenLastCalledWith(Feature.FIND, true, { term: '', caseSensitive: false })
  })

  it('closing switches the feature OFF, and drops a search that had not been sent yet', () => {
    const { dialog, mount } = staged()
    dialog.open()
    termInput().value = 'the'
    termInput().dispatchEvent(new Event('input'))
    mount.setFeature.mockClear()

    dialog.close()
    expect(mount.setFeature).toHaveBeenCalledTimes(1)
    expect(mount.setFeature).toHaveBeenCalledWith(Feature.FIND, false, {})

    vi.advanceTimersByTime(250)
    expect(mount.setFeature).toHaveBeenCalledTimes(1)
  })

  it('closing a closed bar says nothing, and toggling walks between the two', () => {
    const { dialog, mount } = staged()
    dialog.close()
    expect(mount.setFeature).not.toHaveBeenCalled()

    dialog.toggle()
    expect(dialog.isOpen).toBe(true)
    dialog.toggle()
    expect(dialog.isOpen).toBe(false)
    expect(mount.setFeature).toHaveBeenLastCalledWith(Feature.FIND, false, {})
  })

  it('following the reader to another tab switches the old container OFF and the new one ON', () => {
    const { dialog, mount, ws } = staged()
    dialog.open()
    termInput().value = 'the'
    mount.setFeature.mockClear()

    const second = fakeMount('doc-2')
    ws.activeTab = { editor: fakeEditor({ current: 0, total: 0 }), mount: second }
    termInput().dispatchEvent(new Event('input'))
    vi.advanceTimersByTime(250)

    expect(mount.setFeature).toHaveBeenCalledWith(Feature.FIND, false, {})
    expect(second.setFeature).toHaveBeenCalledWith(Feature.FIND, true, { term: 'the', caseSensitive: false })

    dialog.close()
    expect(second.setFeature).toHaveBeenLastCalledWith(Feature.FIND, false, {})
    expect(mount.setFeature).toHaveBeenCalledTimes(1)
  })

  it('follows the reader on the next VERB too, with nothing typed at all', () => {
    const { dialog, mount, ws } = staged({ current: 1, total: 3 })
    dialog.open()
    termInput().value = 'the'
    mount.setFeature.mockClear()

    const second = fakeMount('doc-2')
    const secondEditor = fakeEditor({ current: 1, total: 5 })
    ws.activeTab = { editor: secondEditor, mount: second }

    dialog.next()
    expect(mount.setFeature).toHaveBeenCalledWith(Feature.FIND, false, {})
    expect(second.setFeature).toHaveBeenCalledWith(Feature.FIND, true, { term: 'the', caseSensitive: false })
    expect(secondEditor.findStep).toHaveBeenCalledWith(1)
    expect(countText()).toBe('1 of 5')
  })

  it('follows the reader the moment a tab is ACTIVATED, with no verb at all', () => {
    const { dialog, mount, ws } = staged({ current: 1, total: 3 })
    dialog.open()
    termInput().value = 'the'
    mount.setFeature.mockClear()

    const second = fakeMount('doc-2')
    ws.activate({ editor: fakeEditor({ current: 1, total: 5 }), mount: second })

    // Left switched on, the old container keeps its highlights while the reader
    // looks at another document — and the count says nothing about what is on
    // screen.
    expect(mount.setFeature).toHaveBeenCalledWith(Feature.FIND, false, {})
    expect(second.setFeature).toHaveBeenCalledWith(Feature.FIND, true, { term: 'the', caseSensitive: false })
    expect(countText()).toBe('1 of 5')
  })

  it('a tab activated under a CLOSED bar switches nothing on', () => {
    const { dialog, mount, ws } = staged()
    dialog.open()
    dialog.close()
    mount.setFeature.mockClear()

    const second = fakeMount('doc-2')
    ws.activate({ editor: fakeEditor(), mount: second })
    expect(second.setFeature).not.toHaveBeenCalled()
    expect(mount.setFeature).not.toHaveBeenCalled()
  })

  it('does nothing at all when no container is mounted', () => {
    const { dialog, ws } = staged()
    ws.activate(null)
    expect(() => { dialog.open(); dialog.next(); dialog.replaceOne(); dialog.replaceAll(); dialog.close() }).not.toThrow()
  })
})

describe('FindDialog — walking the matches', () => {
  it('next and prev step the lens, which is what knows where the reader stands', () => {
    const { dialog, editor } = staged({ current: 1, total: 3 })
    dialog.open()
    dialog.next()
    expect(editor.findStep).toHaveBeenCalledWith(1)
    dialog.prev()
    expect(editor.findStep).toHaveBeenCalledWith(-1)
  })

  it('a closed bar OPENS instead of walking — the reader asked to find', () => {
    const { dialog, editor } = staged()
    dialog.next()
    expect(dialog.isOpen).toBe(true)
    expect(editor.findStep).not.toHaveBeenCalled()
  })

  it('shows the count the lens reports, and repaints it when the marks change', () => {
    const { dialog, editor } = staged({ current: 0, total: 0 })
    dialog.open()
    expect(countText()).toBe('0 of 0')
    // A reader who is not looking at the count — typing, or on a screen reader —
    // is the one who most needs it said.
    expect(document.querySelector('.editor-find__count')?.getAttribute('aria-live')).toBe('polite')

    editor.position = { current: 2, total: 7 }
    editor.emit({ type: 'marks-changed', feature: Feature.FIND })
    expect(countText()).toBe('2 of 7')
  })

  it('ignores another producer\'s findings — its count is not this bar\'s subject', () => {
    const { dialog, editor } = staged({ current: 1, total: 1 })
    dialog.open()
    editor.position = { current: 4, total: 9 }
    editor.emit({ type: 'marks-changed', feature: Feature.SPELL_CHECK })
    expect(countText()).toBe('1 of 1')
  })

  /** @type {Array<[string, string, {shiftKey?: boolean, keyCode?: number}, string]>} */
  const keys = [
    ['Enter walks forward', 'Enter', {}, 'next'],
    ['Shift+Enter walks back', 'Enter', { shiftKey: true }, 'prev'],
    ['Escape closes and hands the caret back', 'Escape', {}, 'close'],
    ['a tab chord is left to the browser\'s own focus order', 'Tab', { keyCode: 9 }, 'none'],
    ['and so is the shift chord WebKitGTK delivers as ISO_Left_Tab', 'ISO_Left_Tab', { shiftKey: true, keyCode: 9 }, 'none'],
  ]

  for (const [name, key, mods, effect] of keys) {
    it(name, () => {
      const { dialog, editor } = staged({ current: 1, total: 3 })
      dialog.open()
      editor.findStep.mockClear()
      press(termInput(), key, mods)

      if (effect === 'next') expect(editor.findStep).toHaveBeenCalledWith(1)
      if (effect === 'prev') expect(editor.findStep).toHaveBeenCalledWith(-1)
      if (effect === 'close') {
        expect(dialog.isOpen).toBe(false)
        // The bar took the keyboard; closing gives it back, or the reader types
        // into nothing.
        expect(editor.focus).toHaveBeenCalledTimes(1)
      }
      if (effect === 'none') {
        expect(editor.findStep).not.toHaveBeenCalled()
        expect(dialog.isOpen).toBe(true)
      }
    })
  }
})

describe('FindDialog — the two replaces', () => {
  it('replace-one hands over in-flight text — NOT a disk write — then spends the match', async () => {
    const { dialog, editor, mount } = staged({ current: 1, total: 3 })
    dialog.open()
    replaceInput().value = 'a'
    dialog.replaceOne()

    expect(editor.flushEdits).toHaveBeenCalledTimes(1)
    expect(mount.replaceText).toHaveBeenCalledWith(
      { blockId: 'b1', quote: 'the', occurrence: 0, grain: 'literal' }, 'a')
  })

  it('replace-one is ACK-GATED: disarmed in flight, re-armed on the answer', async () => {
    const { dialog, mount } = staged({ current: 1, total: 3 })
    dialog.open()
    const button = /** @type {HTMLButtonElement} */ (control('Replace this match'))
    expect(button.disabled).toBe(false)

    dialog.replaceOne()
    expect(button.disabled).toBe(true)
    dialog.replaceOne() // hammering the button spends nothing more
    expect(mount.replaceText).toHaveBeenCalledTimes(1)

    mount.answer('ok')
    await vi.waitFor(() => expect(button.disabled).toBe(false))
  })

  it('a spend that throws where it was called leaves the verb armed, not wedged', () => {
    const { dialog, mount } = staged({ current: 1, total: 3 })
    dialog.open()
    const button = /** @type {HTMLButtonElement} */ (control('Replace this match'))
    mount.replaceText.mockImplementationOnce(() => { throw new Error('contract violation') })

    expect(() => dialog.replaceOne()).toThrow()
    // Nothing is in flight, so nothing is being waited for: the gate that would
    // have been lifted by an answer was never dropped.
    expect(button.disabled).toBe(false)
    dialog.replaceOne()
    expect(mount.replaceText).toHaveBeenCalledTimes(2)
  })

  it('re-arms on a stale answer too — nothing was written, and the refreshed marks re-offer', async () => {
    const { dialog, mount } = staged({ current: 1, total: 3 })
    dialog.open()
    const button = /** @type {HTMLButtonElement} */ (control('Replace this match'))
    dialog.replaceOne()
    mount.answer('stale')
    await vi.waitFor(() => expect(button.disabled).toBe(false))
  })

  it('offers no replace, and spends nothing, where there is nothing to stand on', () => {
    const { dialog, mount } = staged({ current: 0, total: 0 })
    dialog.open()
    expect(/** @type {HTMLButtonElement} */ (control('Replace this match')).disabled).toBe(true)
    dialog.replaceOne()
    expect(mount.replaceText).not.toHaveBeenCalled()
  })

  it('replace-all rides the control frame and awaits nothing', () => {
    const { dialog, mount } = staged({ current: 1, total: 3 })
    dialog.open()
    termInput().value = 'the'
    replaceInput().value = 'a'
    mount.setFeature.mockClear()

    dialog.replaceAll()
    expect(mount.setFeature).toHaveBeenCalledWith(Feature.FIND, true, {
      term: 'the', caseSensitive: false, replacement: 'a', replaceAll: true,
    })
    expect(mount.replaceText).not.toHaveBeenCalled()
  })

  it('replace-all is ungated: a second press is another act, and finds nothing left', () => {
    const { dialog, mount } = staged({ current: 1, total: 3 })
    dialog.open()
    termInput().value = 'the'
    mount.setFeature.mockClear()
    dialog.replaceAll()
    dialog.replaceAll()
    expect(mount.setFeature).toHaveBeenCalledTimes(2)
  })

  /** @type {Array<[string, string, {current: number, total: number}]>} */
  const noReplaceAll = [
    ['nothing typed to find', '', { current: 0, total: 0 }],
    ['a term the lens resolved no match for', 'the', { current: 0, total: 0 }],
  ]

  for (const [name, term, position] of noReplaceAll) {
    it('replace-all does nothing with ' + name, () => {
      const { dialog, mount } = staged(position)
      dialog.open()
      termInput().value = term
      mount.setFeature.mockClear()
      dialog.replaceAll()
      expect(mount.setFeature).not.toHaveBeenCalled()
      expect(/** @type {HTMLButtonElement} */ (control('Replace every match')).disabled).toBe(true)
    })
  }

  it('offers both replaces only while the lens is drawing something to replace', () => {
    const { dialog, editor } = staged({ current: 0, total: 0 })
    dialog.open()
    expect(/** @type {HTMLButtonElement} */ (control('Replace every match')).disabled).toBe(true)

    editor.position = { current: 1, total: 2 }
    editor.emit({ type: 'marks-changed', feature: Feature.FIND })
    expect(/** @type {HTMLButtonElement} */ (control('Replace every match')).disabled).toBe(false)
    expect(/** @type {HTMLButtonElement} */ (control('Replace this match')).disabled).toBe(false)
  })

  it('Enter in the replacement box replaces rather than walking', () => {
    const { dialog, editor, mount } = staged({ current: 1, total: 3 })
    dialog.open()
    editor.findStep.mockClear()
    press(replaceInput(), 'Enter')
    expect(mount.replaceText).toHaveBeenCalledTimes(1)
    expect(editor.findStep).not.toHaveBeenCalled()
  })
})

// ── The bar's chrome ────────────────────────────────────────────────────────
// Where its controls sit and where the bar itself hangs. The POSITION is CSS —
// the bar is laid out against the pane's box — so what is assertable here is
// which box it hangs in, and that the close button is one of row 1's controls
// rather than an ornament floating over them.

describe('FindDialog — the bar\'s chrome', () => {
  /** The editor column the app renders around the mounted lens. */
  function editorColumn() {
    const col = document.createElement('div')
    col.id = 'editor-col'
    document.body.appendChild(col)
    return col
  }

  /** Every row's controls, by accessible name — the count has none. */
  const rows = () => Array.from(document.querySelectorAll('.editor-find__row'))
    .map((row) => Array.from(row.children).map((cell) => cell.getAttribute('aria-label')))

  it('is THREE rows: the term, the search, the write', () => {
    const { dialog } = staged()
    dialog.open()
    expect(rows()).toEqual([
      ['Find', 'Close find'],
      ['Match case', 'Find previous', 'Find next', null],
      ['Replace with', 'Replace this match', 'Replace every match'],
    ])
  })

  it('gives the term its own row, so the box the reader types in is the widest thing in the bar', () => {
    const { dialog } = staged()
    dialog.open()
    expect(termInput().parentElement).toBe(document.querySelector('.editor-find__row'))
    // The way out takes the same cell shape as every other button, so the row
    // is one height and the ✕ is a control rather than an ornament.
    expect(control('Close find').className).toBe('editor-find__btn')
  })

  it('hangs in the EDITOR COLUMN: the document\'s corner, clear of the meta panel', () => {
    const col = editorColumn()
    const { dialog } = staged()
    dialog.open()
    expect(col.querySelector('.editor-find-bar')).not.toBeNull()
  })

  it('re-hangs in the column that is there NOW — the pane is re-rendered under it', () => {
    const first = editorColumn()
    const { dialog } = staged()
    dialog.open()
    dialog.close()
    first.remove()
    const second = editorColumn()
    dialog.open()
    expect(second.querySelector('.editor-find-bar')).not.toBeNull()
  })

  it('falls back to the body where no editor column is mounted', () => {
    const { dialog } = staged()
    dialog.open()
    expect(/** @type {HTMLElement} */ (document.querySelector('.editor-find-bar')).parentElement).toBe(document.body)
  })
})
