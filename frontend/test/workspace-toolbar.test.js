// workspace-toolbar.test.js — the workspace toolbar and what fills it: the
// widget family (ToolbarButton / ToolbarLabel / ToolbarSeparator / ButtonGroup /
// ToolbarSelect), the ActionList a lens draws as buttons and as menu entries,
// the surfaces' groups, the WorkspaceToolbar drawing the active lens's answer
// (asked again on `toolbar-changed`, refreshed on the lens's RAW event stream),
// NoteEditor's answer button for button, and the one mode toggle every lens
// draws. Headless (happy-dom) with fake surfaces where a real one would mount
// ProseMirror.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { ToolbarButton, ToolbarLabel, ToolbarSeparator, ButtonGroup, ToolbarSelect } from '../src/static/renderers/toolbar-button.js'
import { ActionList } from '../src/static/renderers/action-list.js'
import { WorkspaceToolbar } from '../src/static/shell/workspace-toolbar.js'
import { WysiwygSurface } from '../src/static/lens/document-editor/surfaces/wysiwyg-surface.js'
import { MarkdownSurface } from '../src/static/lens/document-editor/surfaces/markdown-surface.js'
import { NoteEditor } from '../src/static/lens/document-editor/note-editor.js'
import { PromptEditor } from '../src/static/lens/prompt/prompt-editor.js'
import { BlockLens } from '../src/static/lens/block/block-lens.js'
import { BlockRecordSurface } from '../src/static/lens/block/block-record-surface.js'
import { DigitalNoteLens } from '../src/static/lens/ink/digital-note-lens.js'
import { AbstractSurface, SurfaceEvent } from '../src/static/lens/abstract-surface.js'
import { registerBlockKind } from '../src/static/renderers/block-kinds.js'
import { FakeInkProvider, UUID, exportPage, noteAttrs, settle } from './helpers/ink-lens-rig.js'

// wysiwyg-surface imports its app helpers from their owner modules; four of
// those owners (extensions.js, block-chrome.js, ai-target-decoration.js,
// prose-block.js) execute vendor calls at IMPORT time and would crash under the
// bare test/setup.js TipTap seed. This file never mounts a wysiwyg surface, so
// inert mocks satisfy the imports.
vi.mock('../src/static/lens/extensions.js', () => ({
  SelectionHighlight: {}, HighlightMark: {},
  AiShortcuts: { configure: () => ({}) },
  buildAiContext: vi.fn(), applyTargetHighlight: vi.fn(),
}))
vi.mock('../src/static/lens/document-editor/block-chrome.js', () => ({
  BlockChrome: {}, getBlockSelectionRange: vi.fn(),
}))
vi.mock('../src/static/lens/document-editor/surfaces/ai-target-decoration.js', () => ({ AiTargetDecoration: {} }))
vi.mock('../src/static/lens/document-editor/surfaces/prose-block.js', () => ({ BlockId: {} }))

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })

/** @returns {HTMLElement} the toolbar's host, in the document */
function host() {
  const el = document.createElement('div')
  el.id = 'editor-toolbar'
  document.body.appendChild(el)
  return el
}

/** @param {HTMLElement} el @param {string} id */
const click = (el, id) => /** @type {HTMLElement} */ (el.querySelector(`[id="${id}"]`)).dispatchEvent(new MouseEvent('click', { bubbles: true }))

// ── the widget family ─────────────────────────────────────────────────────────

describe('ToolbarButton', () => {
  it('builds its own <button> with id/title/icon and the tb-btn class', () => {
    const b = new ToolbarButton({ id: 'x', title: 'X', iconHtml: '<svg></svg>', onClick: () => {} })
    expect([b.el.tagName, b.el.id, b.el.title, b.el.className, b.el.innerHTML]).toEqual(['BUTTON', 'x', 'X', 'tb-btn', '<svg></svg>'])
  })

  it.each([
    ['an extra className after tb-btn', { className: 'tb-danger', iconHtml: '<svg></svg>' }, 'tb-btn tb-danger', ''],
    ['words, marked tb-text', { text: 'Copy page' }, 'tb-btn tb-text', 'Copy page'],
    ['words and a class', { text: '‹', className: 'tb-page-turn' }, 'tb-btn tb-text tb-page-turn', '‹'],
  ])('carries %s', (_name, spec, className, text) => {
    const b = new ToolbarButton({ onClick: () => {}, ...spec })
    expect([b.el.className, b.el.textContent]).toEqual([className, text])
  })

  it('click invokes onClick; mousedown is prevent-defaulted (focus guard)', () => {
    const onClick = vi.fn()
    const b = new ToolbarButton({ onClick })
    b.el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onClick).toHaveBeenCalledTimes(1)
    const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    b.el.dispatchEvent(md)
    expect(md.defaultPrevented).toBe(true)
  })

  it('refresh toggles .active from active() and disabled from enabled()', () => {
    let on = false
    let ok = true
    const b = new ToolbarButton({ onClick: () => {}, active: () => on, enabled: () => ok })
    b.refresh()
    expect([b.el.classList.contains('active'), b.el.disabled]).toEqual([false, false])
    on = true; ok = false; b.refresh()
    expect([b.el.classList.contains('active'), b.el.disabled, b.el.classList.contains('tb-disabled')]).toEqual([true, true, true])
  })
})

describe('ToolbarLabel and ToolbarSeparator', () => {
  it('a label is text that is not a button, read again on refresh', () => {
    let page = 1
    const label = new ToolbarLabel({ id: 'pos', text: () => `${page} / 2`, title: 'Page', live: true })
    expect([label.el.tagName, label.el.className, label.el.textContent, label.el.title, label.el.getAttribute('role')])
      .toEqual(['SPAN', 'tb-readout', '1 / 2', 'Page', 'status'])
    page = 2
    label.refresh()
    expect(label.el.textContent).toBe('2 / 2')
  })

  it('a separator is a tb-sep with nothing to refresh', () => {
    const sep = new ToolbarSeparator()
    expect(sep.el.className).toBe('tb-sep')
    expect(() => sep.refresh()).not.toThrow()
  })
})

describe('ButtonGroup', () => {
  it('appends its widgets in order into a .tb-group, buttons and labels alike', () => {
    const a = new ToolbarButton({ id: 'a', onClick: () => {} })
    const l = new ToolbarLabel({ id: 'l', text: () => '' })
    const g = new ButtonGroup([a, l])
    expect([g.el.className, [...g.el.children].map((c) => c.id), g.buttons.length]).toEqual(['tb-group', ['a', 'l'], 2])
  })

  it.each([
    ['a className after tb-group', { className: 'tb-ai-query' }, 'tb-group tb-ai-query', null],
    ['a label, as a named group', { label: 'Pages' }, 'tb-group', 'Pages'],
  ])('takes %s', (_name, opts, className, label) => {
    const g = new ButtonGroup([], opts)
    expect([g.el.className, g.el.getAttribute('aria-label')]).toEqual([className, label])
  })

  it('refresh fans out to every widget', () => {
    const a = new ToolbarButton({ onClick: () => {}, active: () => true })
    const b = new ToolbarButton({ onClick: () => {}, active: () => true })
    new ButtonGroup([a, b]).refresh()
    expect([a.el.classList.contains('active'), b.el.classList.contains('active')]).toEqual([true, true])
  })
})

describe('ToolbarSelect', () => {
  const OPTIONS = Object.freeze([{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta', mark: true }, { value: 'c', label: 'Gamma' }])
  /** @param {HTMLElement} el */
  const face = (el) => el.querySelector('.tb-select__face')?.textContent

  it.each([
    ["the chosen option's label", undefined, 'Alpha', 'Gamma'],
    ['what its face closure says', (/** @type {string} */ v) => () => `${v} of 3`, 'a of 3', 'c of 3'],
  ])('is a native <select> of its options, a marked one led by ●, its face saying %s', (_name, faceFor, before, after) => {
    let value = 'a'
    const s = new ToolbarSelect({ id: 'pick', title: 'Pick', options: OPTIONS, value: () => value, onChange: () => {}, face: faceFor && (() => faceFor(value)()) })
    expect([s.el.className, s.select.id, s.select.getAttribute('aria-label'), [...s.select.options].map((o) => o.textContent), s.select.value, face(s.el)])
      .toEqual(['tb-select', 'pick', 'Pick', ['Alpha', '● Beta', 'Gamma'], 'a', before])
    value = 'c'
    s.refresh()
    expect([s.select.value, face(s.el)]).toEqual(['c', after])
  })

  it.each([
    ['opened with the pointer, hands the keyboard back to what held it', true, 'lens'],
    ['chosen from the keyboard, keeps it', false, 'pick'],
  ])('tells onChange the value chosen and, %s', (_name, pointer, focused) => {
    const lens = document.createElement('div')
    lens.id = 'lens'
    lens.tabIndex = 0
    const s = new ToolbarSelect({ id: 'pick', options: OPTIONS, value: () => 'a', onChange: (v) => chosen.push(v) })
    /** @type {string[]} */ const chosen = []
    document.body.append(lens, s.el)
    lens.focus()
    if (pointer) s.select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    s.select.focus()
    s.select.value = 'b'
    s.select.dispatchEvent(new Event('change', { bubbles: true }))
    expect([chosen, document.activeElement?.id]).toEqual([['b'], focused])
  })
})

describe('ActionList', () => {
  const PAGE = 'page'
  const READING = 'reading'
  /** @param {{busy?: boolean, live?: boolean, label?: string}} state @param {string[]} ran */
  const list = (state, ran) => new ActionList([
    { id: 'copy', label: 'Copy page', title: 'Copy it', modes: [PAGE], run: () => ran.push('copy') },
    { id: 'open', label: 'Open in e-ink', modes: [PAGE, READING], enabled: () => !state.busy, run: () => ran.push('open') },
    { id: 'live', label: 'Go to Live', short: 'Live', className: 'tb-live', modes: [PAGE], applies: () => !!state.live, run: () => ran.push('live') },
    { id: 'read', label: () => String(state.label), modes: [READING], run: () => ran.push('read') },
  ])

  it.each([
    ['the page', PAGE, {}, ['copy', 'open'], ['Copy page', 'Open in e-ink']],
    ['the page, while live', PAGE, { live: true }, ['copy', 'open', 'live'], ['Copy page', 'Open in e-ink', 'Go to Live']],
    ['the reading', READING, { label: 'Read again' }, ['open', 'read'], ['Open in e-ink', 'Read again']],
  ])('offers in %s only the actions of that mode that apply now', (_name, mode, state, ids, labels) => {
    const actions = list(state, [])
    expect([actions.offered(mode).map((a) => a.id), actions.menuItems(mode).map((i) => /** @type {any} */ (i).label)]).toEqual([ids, labels])
    expect(actions.toolbarButtons(mode).map((b) => b.el.id)).toEqual(ids.map((id) => 'tb-' + id))
  })

  it('draws each as a toolbar button saying its short face, and as a menu entry saying its label, both running it', () => {
    /** @type {string[]} */ const ran = []
    const actions = list({ live: true }, ran)
    const live = actions.toolbarButtons(PAGE)[2]
    expect([live.el.textContent, live.el.className, actions.toolbarButtons(PAGE)[0].el.title]).toEqual(['Live', 'tb-btn tb-text tb-live', 'Copy it'])
    const copy = /** @type {any} */ (actions.menuItems(PAGE)[0])
    live.el.click()
    copy.action()
    expect(ran).toEqual(['live', 'copy'])
  })

  it('draws an action that cannot run disabled in both, read again each time it is drawn', () => {
    const state = { busy: true, label: 'Read this page' }
    const actions = list(state, [])
    const button = actions.toolbarButtons(READING)[0]
    button.refresh()
    expect([button.el.disabled, /** @type {any} */ (actions.menuItems(READING)[0]).disabled]).toEqual([true, true])
    state.busy = false
    state.label = 'Try again'
    button.refresh()
    expect([button.el.disabled, actions.menuItems(READING).map((i) => [/** @type {any} */ (i).label, /** @type {any} */ (i).disabled])])
      .toEqual([false, [['Open in e-ink', false], ['Try again', false]]])
  })

  it('is frozen: what was declared is what both draw', () => {
    const actions = list({}, [])
    expect([Object.isFrozen(actions.actions), Object.isFrozen(actions.actions[0]), Object.isFrozen(actions.actions[0].modes)]).toEqual([true, true, true])
  })
})

// ── surface.toolbarContents() ───────────────────────────────────────────────────

describe('surface.toolbarContents()', () => {
  it.each([
    ['AbstractSurface', () => new (class extends AbstractSurface { get mode() { return 'x' } })()],
    ['MarkdownSurface (formatting ABSENT, not dimmed)', () => new MarkdownSurface({ updateText: () => {}, softReload: () => {}, takeInsertPos: () => null, onSurfaceEvent: () => {} })],
    ['BlockRecordSurface', () => new BlockRecordSurface('blk-1')],
  ])('%s offers nothing', (_name, make) => {
    expect(make().toolbarContents()).toEqual([])
  })

  it('WysiwygSurface offers its four formatting groups: text, headings, lists, blocks', () => {
    const groups = new WysiwygSurface({ uuid: 'doc-1', onSurfaceEvent: () => {} }).toolbarContents()
    expect(groups.every((g) => g instanceof ButtonGroup)).toBe(true)
    expect(groups.map((g) => g.buttons.length)).toEqual([4, 3, 3, 3])
  })

  it('a WysiwygSurface formatting button refreshes without a live editor, never active', () => {
    const groups = new WysiwygSurface({ uuid: 'doc-1', onSurfaceEvent: () => {} }).toolbarContents()
    const bold = /** @type {ToolbarButton} */ (groups[0].buttons[0])
    bold.refresh()
    expect(bold.el.classList.contains('active')).toBe(false)
  })
})

// ── WorkspaceToolbar ──────────────────────────────────────────────────────────

/** A lens standing in for any: an answer the test sets, and a raw event stream it drives. */
class FakeLens {
  /** @type {Array<(e: any) => void>} */ listeners = []
  /** @type {any[]} */ items = []
  asked = 0
  toolbarContents() { this.asked++; return this.items }
  /** @param {(e: any) => void} fn */
  onEvent(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((l) => l !== fn) } }
  /** @param {any} event */
  fire(event) { for (const l of [...this.listeners]) l(event) }
}

/** @param {string} id @param {Partial<import('../src/static/renderers/toolbar-button.js').ToolbarButtonSpec>} [spec] */
const button = (id, spec = {}) => new ToolbarButton({ id, onClick: () => {}, ...spec })

describe('WorkspaceToolbar', () => {
  it("draws the lens's answer when shown, each item refreshed, and nothing for no lens", () => {
    const el = host()
    const lens = new FakeLens()
    lens.items = [new ButtonGroup([button('a', { active: () => true })]), new ToolbarSeparator(), new ButtonGroup([button('b')])]
    const toolbar = new WorkspaceToolbar(el)
    toolbar.show(lens)
    expect([[...el.children].map((c) => c.className), el.querySelector('#a')?.classList.contains('active')])
      .toEqual([['tb-group', 'tb-sep', 'tb-group'], true])
    toolbar.show(null)
    expect([el.childElementCount, toolbar.lens]).toEqual([0, null])
  })

  it('draws nothing for a lens that offers nothing, so no other lens\'s buttons are left behind', () => {
    const el = host()
    const note = new FakeLens()
    note.items = [new ButtonGroup([button('tb-ask-btn')])]
    const toolbar = new WorkspaceToolbar(el)
    toolbar.show(note)
    toolbar.show(new FakeLens())
    expect(el.childElementCount).toBe(0)
  })

  it('asks the lens again on toolbar-changed, and only then', () => {
    const el = host()
    const lens = new FakeLens()
    lens.items = [new ButtonGroup([button('one')])]
    new WorkspaceToolbar(el).show(lens)
    lens.items = [new ButtonGroup([button('two')])]
    lens.fire({ type: 'selection-changed' })
    lens.fire({ type: 'mode-changed', mode: 'markdown' })
    expect([lens.asked, el.querySelector('#one') !== null]).toEqual([1, true])
    lens.fire(SurfaceEvent.TOOLBAR_CHANGED)
    expect([lens.asked, el.querySelector('#one'), el.querySelector('#two') !== null]).toEqual([2, null, true])
  })

  it.each(['selection-changed', 'transaction', 'stats'])('refreshes what is drawn on the RAW stream: %s', (type) => {
    // A caret-only move arrives as selection-changed on the raw stream, which the
    // coalesced selection update drops: a bold button must follow it.
    const el = host()
    let active = false
    const lens = new FakeLens()
    lens.items = [new ButtonGroup([button('fmt', { active: () => active })])]
    new WorkspaceToolbar(el).show(lens)
    active = true
    lens.fire({ type })
    expect(el.querySelector('#fmt')?.classList.contains('active')).toBe(true)
  })

  it('follows only the lens it shows: a lens it has left repaints nothing', () => {
    const el = host()
    let active = false
    const first = new FakeLens()
    first.items = [new ButtonGroup([button('fmt', { active: () => active })])]
    const toolbar = new WorkspaceToolbar(el)
    toolbar.show(first)
    toolbar.show(new FakeLens())
    active = true
    first.fire(SurfaceEvent.TOOLBAR_CHANGED)
    expect([first.listeners.length, first.asked, el.childElementCount]).toEqual([0, 1, 0])
  })

  it('showing the lens it shows changes nothing', () => {
    const lens = new FakeLens()
    const toolbar = new WorkspaceToolbar(host())
    toolbar.show(lens)
    toolbar.show(lens)
    expect([lens.asked, lens.listeners.length]).toEqual([1, 1])
  })

  it('keeps keyboard focus on the item of the same id when the lens answers again', () => {
    const el = host()
    const lens = new FakeLens()
    lens.items = [new ButtonGroup([button('tb-page-next')])]
    new WorkspaceToolbar(el).show(lens)
    const next = /** @type {HTMLElement} */ (el.querySelector('#tb-page-next'))
    next.focus()
    lens.items = [new ButtonGroup([button('tb-page-prev'), button('tb-page-next')])]
    lens.fire(SurfaceEvent.TOOLBAR_CHANGED)
    expect(document.activeElement?.id).toBe('tb-page-next')
    expect(document.activeElement).toBe(el.querySelector('#tb-page-next'))
  })

  it('a null host makes every method a safe no-op', () => {
    const lens = new FakeLens()
    const toolbar = new WorkspaceToolbar(null)
    expect(() => { toolbar.show(lens); toolbar.render(); toolbar.refresh(); toolbar.show(null) }).not.toThrow()
    expect([lens.asked, lens.listeners.length]).toEqual([0, 0])
  })
})

// ── NoteEditor's answer ─────────────────────────────────────────────────────────

/** A surface that mounts nothing, offering one group whose button is named for its mode. */
class FakeSurface extends AbstractSurface {
  /** @param {string} mode */
  constructor(mode) { super(); this._mode = mode }
  get mode() { return this._mode }
  mount() {}
  unmount() {}
  applyContainerChange() {}
  paintContainer() {}
  flushPending() {}
  get body() { return this._mode === 'markdown' ? 'the body' : null }
  toolbarContents() { return this._mode === 'markdown' ? [] : [new ButtonGroup([button('fmt-' + this._mode)])] }
}

class FakeSurfaceNoteEditor extends NoteEditor {
  /** @param {string} mode */
  _createSurface(mode) { return new FakeSurface(mode) }
}

/** A block-capable container, as a document's provider is. */
function blockProvider() {
  return {
    getUuid: () => 'doc-1', getKind: () => 'note', getOrder: () => [], getBlock: () => null,
    subscribe: vi.fn(), unsubscribe: vi.fn(),
    requestAddBlock: vi.fn(), requestSetBlock: vi.fn(), requestRemoveBlock: vi.fn(),
    requestSetOrder: vi.fn(), requestTransform: vi.fn(), requestPersist: vi.fn(),
    getContents: vi.fn(() => Promise.resolve('the body')), setContents: vi.fn(() => Promise.resolve()), flushContents: vi.fn(),
  }
}

/** A NoteEditor presented in `mode`, shown by a WorkspaceToolbar. @param {string} [mode] */
function shownNote(mode = 'wysiwyg') {
  const el = host()
  const editor = new FakeSurfaceNoteEditor('doc-1', { provider: blockProvider() })
  const toolbar = new WorkspaceToolbar(el)
  toolbar.show(editor)
  editor.presentSurface(mode, document.createElement('div'), mode === 'markdown' ? 'the body' : null)
  return { el, editor, toolbar }
}

/** @param {HTMLElement} el @returns {string[]} every top-level item, a group as its buttons' ids or titles */
const layout = (el) => [...el.children].map((c) => (c.classList.contains('tb-sep')
  ? '|'
  : [...c.querySelectorAll('button')].map((b) => b.id || b.title).join(',')))

describe("NoteEditor's toolbar", () => {
  const prevWs = window.sieveWorkspace
  afterEach(() => { window.sieveWorkspace = prevWs })

  it('is the surface\'s groups, each with a separator after, then the mode toggle and spelling, insert, Explain and Ask, Help', () => {
    const { el } = shownNote()
    expect(layout(el)).toEqual([
      'fmt-wysiwyg', '|',
      'tb-toggle-mode-btn,tb-spellcheck-btn',
      'Insert code block,Insert diagram,tb-clip-btn,tb-attach-btn',
      'tb-explain-btn,tb-ask-btn',
      'tb-help-btn',
    ])
    expect([...el.children].map((c) => c.className).slice(2)).toEqual(['tb-group', 'tb-group', 'tb-group tb-ai-query', 'tb-group tb-help'])
  })

  it('is asked again when the mode flips: the markdown surface offers nothing and the toggle says the way back', async () => {
    const { el, editor } = shownNote()
    const toggle = () => /** @type {HTMLButtonElement} */ (el.querySelector('#tb-toggle-mode-btn'))
    expect(toggle().title).toBe('View Markdown Source')
    expect(await editor.setMode('markdown')).toBe(true)
    expect(layout(el)[0]).toBe('tb-toggle-mode-btn,tb-spellcheck-btn')
    expect([el.querySelector('.tb-sep'), toggle().title]).toEqual([null, 'Return to WYSIWYG'])
  })

  it('draws the mode toggle with the icon of the mode it shows', () => {
    window.SieveIcons = { markdown: '<svg data-icon="markdown"></svg>', eye: '<svg data-icon="eye"></svg>' }
    try {
      const { el } = shownNote()
      expect(el.querySelector('#tb-toggle-mode-btn')?.innerHTML).toContain('data-icon="markdown"')
      const md = shownNote('markdown')
      expect(md.el.querySelector('#tb-toggle-mode-btn')?.innerHTML).toContain('data-icon="eye"')
    } finally { delete window.SieveIcons }
  })

  it('the mode toggle toggles the editor it belongs to', () => {
    const { el, editor } = shownNote()
    const toggleMode = vi.spyOn(editor, 'toggleMode')
    click(el, 'tb-toggle-mode-btn')
    expect(toggleMode).toHaveBeenCalledTimes(1)
  })

  it('refreshes a formatting button on the raw stream', () => {
    const el = host()
    let active = false
    class ActiveSurface extends FakeSurface {
      toolbarContents() { return [new ButtonGroup([button('bold', { active: () => active })])] }
    }
    const editor = new (class extends NoteEditor { _createSurface(m) { return new ActiveSurface(m) } })('doc-1', { provider: blockProvider() })
    new WorkspaceToolbar(el).show(editor)
    editor.presentSurface('wysiwyg', document.createElement('div'), null)
    active = true
    editor.onSurfaceEvent({ type: 'selection-changed' })
    expect(el.querySelector('#bold')?.classList.contains('active')).toBe(true)
  })

  // Spelling is a WORKSPACE setting: the button reads and writes the host's, not
  // the editor's, and repaints itself on the press rather than waiting for the
  // editor's next event (a toggle fires none).
  it('the spellcheck button reflects the workspace setting and toggles it', () => {
    const spell = { enabled: true, toggled: 0, toggle() { this.enabled = !this.enabled; this.toggled++ } }
    window.sieveWorkspace = { spell }
    const { el } = shownNote()
    const btn = /** @type {HTMLElement} */ (el.querySelector('#tb-spellcheck-btn'))
    expect(btn.classList.contains('active')).toBe(true)
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect([spell.toggled, spell.enabled, btn.classList.contains('active')]).toEqual([1, false, false])
  })

  it('the spellcheck button is inert in a page with no workspace, never a throw', () => {
    window.sieveWorkspace = undefined
    const { el } = shownNote()
    const btn = /** @type {HTMLElement} */ (el.querySelector('#tb-spellcheck-btn'))
    expect(btn.classList.contains('active')).toBe(false)
    expect(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))).not.toThrow()
  })

  it.each([
    ['tb-ask-btn', 'open'],
    ['tb-explain-btn', 'explainActive'],
  ])('%s asks the Ask panel to %s', (id, verb) => {
    const askPanel = { open: vi.fn(), explainActive: vi.fn() }
    window.sieveWorkspace = { askPanel }
    const { el } = shownNote()
    click(el, id)
    expect(askPanel[/** @type {'open'|'explainActive'} */ (verb)]).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['tb-clip-btn', 'openWebClipDialog'],
    ['tb-attach-btn', 'beginFileAttach'],
  ])('%s asks the workspace to %s, naming no block kind', (id, verb) => {
    const ws = { openWebClipDialog: vi.fn(), beginFileAttach: vi.fn() }
    window.sieveWorkspace = ws
    const { el, editor } = shownNote()
    const createBlock = vi.spyOn(editor, 'createBlock')
    click(el, id)
    expect([ws[/** @type {'openWebClipDialog'|'beginFileAttach'} */ (verb)].mock.calls.length, createBlock.mock.calls.length]).toEqual([1, 0])
  })

  it.each([
    ['wysiwyg', 'Insert code block', [['code', {}]]],
    ['wysiwyg', 'Insert diagram', [['diagram', {}]]],
    ['markdown', 'Insert code block', []],
  ])('in %s, %s creates %j', (mode, title, calls) => {
    const { el, editor } = shownNote(mode)
    const createBlock = vi.spyOn(editor, 'createBlock').mockImplementation(() => {})
    const insert = /** @type {HTMLElement} */ ([...el.querySelectorAll('button')].find((b) => b.title === title))
    insert.click()
    expect(createBlock.mock.calls).toEqual(calls)
  })

  it('renders the registry icon for each insert kind', () => {
    registerBlockKind({ kind: 'code', native: false, renderer: { getIcon: () => '<svg data-icon="reg-code"></svg>' } })
    registerBlockKind({ kind: 'diagram', native: false, renderer: { getIcon: () => '<svg data-icon="reg-diagram"></svg>' } })
    const { el } = shownNote()
    const insert = [...el.querySelectorAll('.tb-group')[2].querySelectorAll('button')]
    expect([insert[0].innerHTML, insert[1].innerHTML]).toEqual(['<svg data-icon="reg-code"></svg>', '<svg data-icon="reg-diagram"></svg>'])
  })
})

// ── the one mode toggle ─────────────────────────────────────────────────────────

describe('the mode toggle', () => {
  /** @returns {Promise<{el: HTMLElement, lens: DigitalNoteLens}>} a Digital Note shown by a WorkspaceToolbar */
  async function shownInk() {
    const provider = new FakeInkProvider(noteAttrs(['p1']))
    provider.answers.set('p1', { page: exportPage([]), seq: 1 })
    const lens = new DigitalNoteLens(UUID, { provider })
    const el = host()
    new WorkspaceToolbar(el).show(lens)
    await lens.presentMode('page', document.body.appendChild(document.createElement('div')))
    await settle()
    return { el, lens }
  }

  it('is the same control for a note and a Digital Note: one button, last of the lens\'s own, stepping to the next mode', async () => {
    const note = shownNote()
    const ink = await shownInk()
    const toggles = [note.el, ink.el].map((el) => /** @type {HTMLButtonElement} */ (el.querySelector('#tb-toggle-mode-btn')))
    expect(toggles.map((t) => [t.tagName, t.className.split(' ')[0], t.closest('.tb-group')?.firstElementChild === t]))
      .toEqual([['BUTTON', 'tb-btn', true], ['BUTTON', 'tb-btn', true]])
    expect([toggles[0].title, toggles[1].textContent, toggles[1].title]).toEqual(['View Markdown Source', 'Reading', 'Show the page read as text and diagrams'])
    toggles[1].click()
    await settle()
    expect([ink.lens.mode, ink.el.querySelector('#tb-toggle-mode-btn')?.textContent]).toEqual(['reading', 'Page'])
  })

  it.each([
    ['a prompt', () => new PromptEditor('prompt:p', { provider: { getUuid: () => 'prompt:p', getOrder: () => [], getBlock: () => null, subscribe: vi.fn(), unsubscribe: vi.fn(), getContents: vi.fn(), setContents: vi.fn(), flushContents: vi.fn() } }), 'markdown', 'the prompt'],
    ['a block with no lens of its own', () => new BlockLens('blk-1', { provider: { getUuid: () => 'blk-1', getOrder: () => [], getBlock: () => null, subscribe: vi.fn(), unsubscribe: vi.fn() } }), null, null],
  ])('is offered by no lens of one mode, so %s puts nothing in the toolbar', (_name, make, mode, seed) => {
    const lens = make()
    const el = host()
    new WorkspaceToolbar(el).show(lens)
    if (mode) lens.presentSurface(mode, document.createElement('div'), seed)
    expect([lens.modeToggle(), lens.toolbarContents(), el.childElementCount]).toEqual([null, [], 0])
  })
})
