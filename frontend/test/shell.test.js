// shell.test.js — unit tests for the Workspace/Tab/Editor shell.
// Imports the REAL classes from src/static/shell/*.js (dual-use ES modules —
// same pattern as block-position.js), so class drift is caught by the suite.
//
// AN EDITOR IS A LENS (issue #96): it is constructed against ONE container
// PROVIDER and holds no transport at all, so these tests hand it a fake provider
// and assert the VERBS it calls — never a frame. The wire's own surface (frames,
// correlation, channel liveness) is document-wire.test.js's; the host's half of a
// mount is mount-binding.test.js's. Nothing here opens a socket.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// P4.E: NoteEditor → WysiwygSurface now statically imports the three side-effect
// extension modules (Search/BlockChrome/AiTargetDecoration build Extension.create
// at module-eval time), which would throw against the bare test/setup.js vendor
// bag. These tests never mount a real WysiwygSurface (they use fake surfaces), so
// inert stubs satisfy the imports; the pure position helpers (ai-target /
// block-position) the editor really calls stay REAL.
vi.mock('../src/static/lens/extensions.js', () => ({
  Search: {}, SelectionHighlight: {}, HighlightMark: {},
  AiShortcuts: { configure: () => ({}) },
  // askAi imports these (was the shared bus): buildAiContext is pure over
  // context.target; applyTargetHighlight is spied to assert the ranged D-5 call.
  buildAiContext: vi.fn((context) => ({ blockRef: (context && context.target && context.target.ref) || 'doc', contextLabel: 'x' })),
  applyTargetHighlight: vi.fn(),
}))
vi.mock('../src/static/lens/document-editor/block-chrome.js', () => ({
  BlockChrome: {}, getBlockSelectionRange: vi.fn(),
}))
vi.mock('../src/static/lens/document-editor/surfaces/ai-target-decoration.js', () => ({ AiTargetDecoration: {} }))
vi.mock('../src/static/lens/document-editor/surfaces/prose-block.js', () => ({ BlockId: {} }))
// P4.E: AbstractEditor's insert-position math now imports these (was the shared bus).
// Mock them so the insert-position + askAi tests drive the delegation via vi.mocked.
vi.mock('../src/static/lens/document-editor/surfaces/ai-target.js', () => ({
  blockInsertPos: vi.fn(() => 42),
}))
vi.mock('../src/static/lens/document-editor/surfaces/block-position.js', () => ({
  blockIndexForInsert: vi.fn(() => 3),
  emptyParagraphAnchor: vi.fn(() => null),
  docPosForBlockIndex: vi.fn(),
  blockIndexAfter: vi.fn(),
  blockIndexAt: vi.fn(() => -1),
  enclosingBlockId: vi.fn(),
}))

import { SieveEditor } from '../src/static/lens/document-editor/editor-shell.js'
import { SieveTab } from '../src/static/shell/tab.js'
import { SieveWorkspace } from '../src/static/shell/workspace.js'
import { AbstractEditor } from '../src/static/lens/abstract-editor.js'
import { NoteEditor } from '../src/static/lens/document-editor/note-editor.js'
import { PromptEditor } from '../src/static/lens/prompt/prompt-editor.js'
import { AbstractSurface } from '../src/static/lens/document-editor/surfaces/abstract-surface.js'
import { EditorMode } from '../src/static/lens/document-editor/editor-mode.js'
import { blockInsertPos } from '../src/static/lens/document-editor/surfaces/ai-target.js'
import { blockIndexForInsert, emptyParagraphAnchor } from '../src/static/lens/document-editor/surfaces/block-position.js'
import { buildAiContext, applyTargetHighlight } from '../src/static/lens/extensions.js'
import { MountBinding } from '../src/static/shell/mount-binding.js'
import { ContainerModelFeed } from '../src/static/container/container-model-feed.js'
import { serviceRig, FakeSocket } from './helpers/service-rig.js'

// ── Test doubles ─────────────────────────────────────────────────────────────

/**
 * A REAL MountBinding over a channel-less transport — the host's half of a mount,
 * as the shell actually builds it. Channel-less because these tests are about the
 * shell's plumbing, not the wire: nothing here needs a socket, and a mount that
 * opened one would put a second document channel in the suite.
 * @param {string} uuid @param {string} [kind]
 */
function hostMount(uuid = 'u', kind = 'note') {
  const { documentService } = serviceRig({ uuid: null })
  return new MountBinding(uuid, documentService, new ContainerModelFeed(documentService), kind)
}

/**
 * A fake container provider — the whole Lens↔Host wall as a test double, with
 * the block extension AND the whole-content one, which is exactly what a
 * DOCUMENT's provider carries. Reads answer from a scriptable order/blocks pair;
 * every verb is a spy; `cue` fires the change each subscriber hears.
 *
 * The three underscore-prefixed members are the TEST's handles on it, not
 * contract — a lens never sees them.
 */
function fakeProvider(overrides = {}) {
  /** @type {any[]} */ const listeners = []
  const order = []
  /** @type {Record<string, any>} */ const blocks = {}
  return Object.assign({
    getUuid: () => 'u',
    getKind: () => 'note',
    getOrder: () => order,
    getBlock: (id) => blocks[id] || null,
    // Subscribing CUES immediately with the whole container — bootstrap is just
    // the first onChanged, and a lens that painted differently at open would be
    // two painting paths.
    subscribe: vi.fn((l) => { listeners.push(l); l.onChanged({ blockIds: order.slice(), orderChanged: true }) }),
    unsubscribe: vi.fn((l) => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1) }),
    requestAddBlock: vi.fn(),
    requestSetBlock: vi.fn(),
    requestRemoveBlock: vi.fn(),
    requestSetOrder: vi.fn(),
    requestTransform: vi.fn(),
    requestRetry: vi.fn(),
    requestPersist: vi.fn(),
    paste: vi.fn(() => Promise.resolve({ outcome: 'none' })),
    detectExtractions: vi.fn(() => Promise.resolve([])),
    flush: vi.fn(),
    getContents: vi.fn(() => Promise.resolve('FROM GO')),
    setContents: vi.fn(() => Promise.resolve()),
    flushContents: vi.fn(),
    _order: order,
    _blocks: blocks,
    _cue: (change) => listeners.slice().forEach((l) => l.onChanged(change)),
    _listeners: listeners,
  }, overrides)
}

/**
 * A container that speaks whole-content and NOTHING else — a prompt's. The block
 * verbs are absent rather than stubbed: that absence IS the capability
 * declaration a lens reads.
 */
function wholeContentProvider(overrides = {}) {
  const p = fakeProvider(overrides)
  for (const verb of ['requestAddBlock', 'requestSetBlock', 'requestRemoveBlock',
    'requestSetOrder', 'requestTransform', 'requestRetry', 'requestPersist',
    'paste', 'detectExtractions', 'flush']) delete p[verb]
  return p
}

// A fake input surface implementing the AbstractSurface contract, recording
// lifecycle + ops into a shared ordered log (P2.B).
class FakeSurface extends AbstractSurface {
  constructor(mode, log = []) {
    super()
    this._mode = mode
    this.log = log
    this.mounted = false
    this.unmountCount = 0
    this.mountArgs = null
    this.changes = []
    this.bodyValue = 'the body'
    this.editorPaneValue = mode === 'wysiwyg' ? { fake: 'tiptap' } : null
    this.flushCount = 0
  }
  get mode() { return this._mode }
  get editorPane() { return this.mounted ? this.editorPaneValue : null }
  get body() { return this._mode === 'markdown' ? this.bodyValue : null }
  mount(rootEl, content) { this.mounted = true; this.mountArgs = [rootEl, content]; this.log.push('mount:' + this._mode) }
  unmount() { this.mounted = false; this.unmountCount++; this.log.push('unmount:' + this._mode) }
  // The ONE inbound path: a container cue names ids, and the surface re-reads
  // them off the provider. Recorded so the tests can assert what arrived.
  applyContainerChange(change, provider) { this.changes.push(change); this.log.push('cue') }
  flushPending() { this.flushCount++; this.log.push('flush:' + this._mode) }
  // reload() calls these polymorphically (wysiwyg → paintContainer from the model,
  // markdown → replaceBody with the host's body). Recorders for those tests.
  paintContainer(provider) { this.painted = provider; this.log.push('paint') }
  replaceBody(body) { this.replacedBody = body; this.bodyValue = body }
  // P3.A: raw selection descriptor the editor pulls on a selection/transaction/
  // focus event. `feedDescriptor` lets a test script what the surface reports.
  feedSelection() { this.feedCount = (this.feedCount || 0) + 1; return this.feedDescriptor || null }
}

// P2.C.2: the injected-factory seam died — editors construct their own surfaces
// (protected _createSurface, the type-defining repertoire). Tests exercise the
// REAL editor types through that protected contract via a subclass mixin
// (no-construction-seams rule; tests use the public/protected contract). The
// override records every surface into `made` and logs lifecycle order into
// `surfaceLog`. P4.F: the `services` bag is dissolved — the surface calls the
// editor's public API directly (onSurfaceEvent / setRawContent), which tests
// drive by calling those editor methods on `ed`.
function withFakeSurfaces(Base) {
  return class extends Base {
    surfaceLog = []
    made = []
    _createSurface(mode) {
      const s = new FakeSurface(mode, this.surfaceLog)
      this.made.push(s)
      return s
    }
  }
}
const FakeSurfaceEditor = withFakeSurfaces(AbstractEditor)
const FakeSurfaceSieveEditor = withFakeSurfaces(SieveEditor) // P1 alias kept exercised
const FakeSurfaceNoteEditor = withFakeSurfaces(NoteEditor)

// Builds a NoteEditor over a fake container — its ONE business dependency, plus
// the host's loader. The _createSurface override records every surface it makes
// into `made` and logs lifecycle order into `log`.
function noteRig(uuid = 'n', options = {}) {
  const provider = options.provider || fakeProvider()
  const loadContainer = options.loadContainer || vi.fn(() => Promise.resolve({ body: '', version: 0, scroll: 0 }))
  const ed = new FakeSurfaceNoteEditor(uuid, Object.assign({}, options, {
    provider, loadContainer, toolbar: options.toolbar !== undefined ? options.toolbar : null,
  }))
  return { ed, provider, loadContainer, log: ed.surfaceLog, made: ed.made }
}

function makeNote(uuid = 'n', options = {}) { return noteRig(uuid, options).ed }

// ── P1: shell skeleton ───────────────────────────────────────────────────────

describe('SieveEditor (P1 identity, P2.B surface-derived)', () => {
  it('exposes uuid via getter', () => {
    const ed = new SieveEditor('abc-123')
    expect(ed.uuid).toBe('abc-123')
  })

  it('mode defaults to wysiwyg with no surface, and derives from the mounted surface', () => {
    const ed = new FakeSurfaceSieveEditor('abc-123')
    expect(ed.mode).toBe('wysiwyg')
    ed.presentSurface('markdown', document.createElement('div'), 'body')
    expect(ed.mode).toBe('markdown') // live derivation
  })

  it('editorPane is null with no surface and derives from the mounted surface', () => {
    const ed = new FakeSurfaceSieveEditor('abc-123')
    expect(ed.editorPane).toBeNull()
    ed.presentSurface('wysiwyg', document.createElement('div'), { body: '', blocks: [] })
    expect(ed.editorPane).toEqual({ fake: 'tiptap' })
  })

  it('throws if uuid missing', () => {
    expect(() => new SieveEditor('')).toThrow('uuid is required')
  })
})

describe('SieveTab', () => {
  it('exposes uuid', () => {
    const tab = new SieveTab('tab-uuid')
    expect(tab.uuid).toBe('tab-uuid')
  })

  it('editor is null before attachEditor', () => {
    const tab = new SieveTab('tab-uuid')
    expect(tab.editor).toBeNull()
  })

  it('attachEditor sets the editor', () => {
    const tab = new SieveTab('tab-uuid')
    const ed = new SieveEditor('tab-uuid')
    tab.attachEditor(ed)
    expect(tab.editor).toBe(ed)
  })

  it('attachEditor rejects non-SieveEditor values', () => {
    const tab = new SieveTab('tab-uuid')
    expect(() => tab.attachEditor({ uuid: 'tab-uuid' })).toThrow('expected SieveEditor')
  })

  it('detachEditor clears the editor', () => {
    const tab = new SieveTab('tab-uuid')
    const ed = new SieveEditor('tab-uuid')
    tab.attachEditor(ed)
    tab.detachEditor()
    expect(tab.editor).toBeNull()
  })

  it('throws if uuid missing', () => {
    expect(() => new SieveTab('')).toThrow('uuid is required')
  })

  // ── P2.D: SieveTab owns #mode (retires the tabModes module global) ────────────

  it('mode defaults to wysiwyg', () => {
    const tab = new SieveTab('tab-uuid')
    expect(tab.mode).toBe(EditorMode.WYSIWYG)
  })

  it('recordMode updates the mode (the load-path seed)', () => {
    const tab = new SieveTab('tab-uuid')
    tab.recordMode(EditorMode.MARKDOWN)
    expect(tab.mode).toBe(EditorMode.MARKDOWN)
  })

  it('attachEditor subscribes to the editor stream; a mode-changed event records the tab mode', () => {
    const tab = new SieveTab('tab-uuid')
    const ed = new SieveEditor('tab-uuid')
    let emit
    ed.onEvent = (fn) => { emit = fn; return () => { emit = null } }
    tab.attachEditor(ed)
    expect(tab.mode).toBe(EditorMode.WYSIWYG)
    emit({ type: 'mode-changed', mode: EditorMode.MARKDOWN })
    expect(tab.mode).toBe(EditorMode.MARKDOWN)
  })

  it('non-mode events do not disturb the recorded mode', () => {
    const tab = new SieveTab('tab-uuid')
    const ed = new SieveEditor('tab-uuid')
    let emit
    ed.onEvent = (fn) => { emit = fn; return () => {} }
    tab.attachEditor(ed)
    tab.recordMode(EditorMode.MARKDOWN)
    emit({ type: 'doc-changed' })
    expect(tab.mode).toBe(EditorMode.MARKDOWN)
  })

  it('detachEditor unsubscribes from the editor stream', () => {
    const tab = new SieveTab('tab-uuid')
    const ed = new SieveEditor('tab-uuid')
    let emit
    let unsubscribed = false
    ed.onEvent = (fn) => { emit = fn; return () => { unsubscribed = true; emit = null } }
    tab.attachEditor(ed)
    tab.detachEditor()
    expect(unsubscribed).toBe(true)
  })

  it('the tab mode survives detach (client-side record persists across tab switch)', () => {
    const tab = new SieveTab('tab-uuid')
    const ed = new SieveEditor('tab-uuid')
    ed.onEvent = (fn) => { return () => {} }
    tab.attachEditor(ed)
    tab.recordMode(EditorMode.MARKDOWN)
    tab.detachEditor()
    expect(tab.mode).toBe(EditorMode.MARKDOWN)
  })
})

describe('SieveWorkspace', () => {
  let ws

  beforeEach(() => { ws = new SieveWorkspace() })

  it('activeTab is null initially', () => {
    expect(ws.activeTab).toBeNull()
  })

  it('openTab creates and activates a tab', () => {
    const tab = ws.openTab('doc-1')
    expect(tab).toBeInstanceOf(SieveTab)
    expect(tab.uuid).toBe('doc-1')
    expect(ws.activeTab).toBe(tab)
  })

  it('openTab is idempotent for same uuid', () => {
    const t1 = ws.openTab('doc-1')
    const t2 = ws.openTab('doc-1')
    expect(t1).toBe(t2)
  })

  it('openTab switches activeTab', () => {
    ws.openTab('doc-1')
    const t2 = ws.openTab('doc-2')
    expect(ws.activeTab).toBe(t2)
  })

  it('openTab throws on empty uuid', () => {
    expect(() => ws.openTab('')).toThrow('uuid is required')
  })

  it('getTab returns existing tab or null', () => {
    expect(ws.getTab('doc-1')).toBeNull()
    const tab = ws.openTab('doc-1')
    expect(ws.getTab('doc-1')).toBe(tab)
  })

  it('closeTab removes the tab', () => {
    ws.openTab('doc-1')
    ws.closeTab('doc-1')
    expect(ws.getTab('doc-1')).toBeNull()
  })

  it('closeTab clears activeTab when active tab is closed', () => {
    ws.openTab('doc-1')
    ws.closeTab('doc-1')
    expect(ws.activeTab).toBeNull()
  })

  it('closeTab does not clear activeTab when a different tab is closed', () => {
    ws.openTab('doc-1')
    ws.openTab('doc-2') // doc-2 is now active
    ws.closeTab('doc-1')
    expect(ws.activeTab?.uuid).toBe('doc-2')
  })

  it('closeTab of unknown uuid is a no-op', () => {
    ws.openTab('doc-1')
    ws.closeTab('nope')
    expect(ws.activeTab?.uuid).toBe('doc-1')
  })

  it('onActiveTabChanged fires on openTab', () => {
    const calls = []
    ws.onActiveTabChanged(tab => calls.push(tab?.uuid ?? null))
    ws.openTab('doc-1')
    expect(calls).toEqual(['doc-1'])
  })

  it('onActiveTabChanged fires with null on closeTab of active tab', () => {
    ws.openTab('doc-1')
    const calls = []
    ws.onActiveTabChanged(tab => calls.push(tab?.uuid ?? null))
    ws.closeTab('doc-1')
    expect(calls).toEqual([null])
  })

  it('onActiveTabChanged unsubscribe stops notifications', () => {
    const calls = []
    const unsub = ws.onActiveTabChanged(tab => calls.push(tab?.uuid ?? null))
    ws.openTab('doc-1')
    unsub()
    ws.openTab('doc-2')
    expect(calls).toEqual(['doc-1']) // only the first
  })

  it('module side effects expose the window globals editor.js relies on', () => {
    expect(window.sieveWorkspace).toBeInstanceOf(SieveWorkspace)
    expect(window.SieveTab).toBe(SieveTab)
    expect(window.SieveEditor).toBe(SieveEditor)
    expect(window.SieveSurface).toBe(AbstractSurface)
  })

  it('workspace.activeTab.editor.uuid chain works', () => {
    const tab = ws.openTab('chain-test')
    const ed = new SieveEditor('chain-test')
    tab.attachEditor(ed)
    expect(ws.activeTab.editor.uuid).toBe('chain-test')
  })
})

// ── P2.A: AbstractEditor hierarchy owns WS + save + doc/dirty state ──────────────

describe('AbstractEditor (P2.A base, P2.B surfaces)', () => {
  it('flushSave is concrete on the base (P2.B.2); destroy unmounts the surface', async () => {
    const ed = new FakeSurfaceEditor('u')
    const root = document.createElement('div')
    const surface = ed.presentSurface('markdown', root, 'x')
    // Disconnected editor: flushPending fires on the surface, and the save is
    // fire-and-forget — the promise is already settled.
    await expect(ed.flushSave()).resolves.toBeUndefined()
    expect(surface.flushCount).toBe(1)
    expect(() => ed.destroy()).not.toThrow()
    expect(surface.unmountCount).toBe(1)
    expect(ed.surface).toBeNull()
  })

  it('tracks dirty state', () => {
    const ed = new AbstractEditor('u')
    expect(ed.isDirty).toBe(false)
    ed.markDirty()
    expect(ed.isDirty).toBe(true)
    ed.clearDirty()
    expect(ed.isDirty).toBe(false)
  })

  it('NoteEditor and PromptEditor are AbstractEditor instances', () => {
    expect(makeNote('n')).toBeInstanceOf(AbstractEditor)
    expect(new PromptEditor('prompt:p')).toBeInstanceOf(AbstractEditor)
  })

  it('a whole-content container has no mode to flip to — setMode resolves false', async () => {
    // Not a PromptEditor override: the base reads its CAPABILITY off the provider
    // it was handed. A container with no block extension is its text and nothing
    // else, so there is no second shape to present it in.
    const ed = new PromptEditor('prompt:p', { provider: wholeContentProvider() })
    await expect(ed.setMode('wysiwyg')).resolves.toBe(false)
  })
})

describe('AbstractEditor surface events + domain API (P2.B / P4.F)', () => {
  // P4.F: the surface calls the editor's PUBLIC API directly (no services bag) —
  // onSurfaceEvent is the SurfaceListener handler, applyBlockOps/updateText are the
  // domain methods. Tests drive them by calling those methods on `ed`, exactly as
  // the surface now does.
  function rig() {
    const ed = new FakeSurfaceEditor('u')
    ed.presentSurface('markdown', document.createElement('div'), 'x')
    return { ed }
  }

  it('forwards surface notifications to registered listeners; unsubscribe stops them', () => {
    const { ed } = rig()
    const seen = []
    // P4.D: a doc-changed ALSO produces a follow-up `stats` event on the same
    // stream — filter it out; this test is about the forward/unsubscribe mechanism.
    const unsub = ed.onEvent((ev) => { if (ev.type !== 'stats') seen.push(ev.type) })
    ed.onSurfaceEvent({ type: 'doc-changed' })
    expect(seen).toEqual(['doc-changed'])
    unsub()
    ed.onSurfaceEvent({ type: 'selection-changed' })
    expect(seen).toEqual(['doc-changed']) // unsubscribed
  })

  it('a doc-changed marks the editor dirty and dispatches sieve:meta-dirty{dirty:true}', () => {
    // P4.D regression guard: the retired legacyChromeFanout dispatched the
    // dirty:true signal on doc-changed (the saved fact dispatches dirty:false). Its
    // consumers are the StatusBar save slot + the meta-dirty-dot; without this the
    // save indicators are "always green".
    const { ed } = rig()
    expect(ed.isDirty).toBe(false)
    let dirtyDetail = null
    const handler = (e) => { dirtyDetail = e.detail }
    document.addEventListener('sieve:meta-dirty', handler)
    try {
      ed.onSurfaceEvent({ type: 'doc-changed' })
      expect(ed.isDirty).toBe(true)
      expect(dirtyDetail).toEqual({ dirty: true })
    } finally {
      document.removeEventListener('sieve:meta-dirty', handler)
    }
  })

  it('a doc-projected refreshes stats but leaves the editor CLEAN (#90)', () => {
    // The NodeView body projection materialises the server's own body markdown into
    // the doc after the mount's suppression window closes. It grows the document —
    // so the word count must follow it — but the user has authored nothing, and
    // dirtying here is what made every freshly opened note show the dirty dot.
    const { ed } = rig()
    const seen = []
    ed.onEvent((ev) => seen.push(ev.type))
    let metaFired = false
    const handler = () => { metaFired = true }
    document.addEventListener('sieve:meta-dirty', handler)
    try {
      ed.onSurfaceEvent({ type: 'doc-projected' })
      expect(ed.isDirty).toBe(false)
      expect(metaFired).toBe(false)
      expect(seen).toEqual(['doc-projected', 'stats'])
    } finally {
      document.removeEventListener('sieve:meta-dirty', handler)
    }
  })

  it('a throwing listener does not break the other registrants', () => {
    const { ed } = rig()
    const seen = []
    ed.onEvent(() => { throw new Error('boom') })
    ed.onEvent((ev) => { if (ev.type !== 'stats') seen.push(ev.type) })
    expect(() => ed.onSurfaceEvent({ type: 'doc-changed' })).not.toThrow()
    expect(seen).toEqual(['doc-changed'])
  })

  it('base setRawContent/createBlock DROP domain output (disconnected prompt behavior)', () => {
    const { ed } = rig()
    expect(() => ed.setRawContent('md')).not.toThrow()
    expect(() => ed.createBlock('code', {})).not.toThrow()
  })

  it('onSurfaceEvent for a NON doc-changed event feeds + emits only (no dirty, no meta-dirty)', () => {
    // The doc-changed branch (dirty + meta-dirty{dirty:true}) is exclusive; a
    // selection-changed is forwarded to registrants but must NOT dirty the doc.
    const { ed } = rig()
    const seen = []
    ed.onEvent((ev) => { if (ev.type !== 'stats') seen.push(ev.type) })
    let metaFired = false
    const handler = () => { metaFired = true }
    document.addEventListener('sieve:meta-dirty', handler)
    try {
      ed.onSurfaceEvent({ type: 'selection-changed' })
      expect(seen).toEqual(['selection-changed']) // emitted
      expect(ed.isDirty).toBe(false)              // NOT marked dirty
      expect(metaFired).toBe(false)               // NO meta-dirty dispatch
    } finally {
      document.removeEventListener('sieve:meta-dirty', handler)
    }
  })
})

describe('AbstractEditor SelectionModel wiring (P3.A)', () => {
  // Mounts a fake surface and returns handles to drive its notify + script its
  // feedSelection descriptor.
  function rig(mode = 'wysiwyg') {
    const ed = new FakeSurfaceEditor('u')
    ed.presentSurface(mode, document.createElement('div'), 'x')
    return { ed, surface: () => ed.surface, notify: () => ed.onSurfaceEvent.bind(ed) }
  }

  it('exposes an initial none SelectionContext for the editor uuid', () => {
    const ed = new FakeSurfaceEditor('doc-9')
    const ctx = ed.getSelectionContext()
    expect(ctx.docUuid).toBe('doc-9')
    expect(ctx.selectionType).toBe('none')
    expect(ctx.focusZone).toBe('editor')
    expect(Object.isFrozen(ctx)).toBe(true)
  })

  it('feeds the model on selection-changed → getSelectionContext reflects the descriptor', () => {
    const { ed, surface, notify } = rig()
    surface().feedDescriptor = { selectionType: 'caret', caret: 3, range: { from: 3, to: 3 }, blockId: 'b1', blockIds: ['b1'], blockKind: 'prose' }
    notify()({ type: 'selection-changed' })
    const ctx = ed.getSelectionContext()
    expect(ctx.blockId).toBe('b1')
    expect(ctx.caret).toBe(3)
    expect(ctx.selectionType).toBe('caret')
  })

  it('feeds on transaction and on focus-changed too', () => {
    const { ed, surface, notify } = rig()
    surface().feedDescriptor = { selectionType: 'block', blockId: 'bt', blockIds: ['bt'], blockKind: 'code', caret: 1, range: { from: 0, to: 2 } }
    notify()({ type: 'transaction' })
    expect(ed.getSelectionContext().blockId).toBe('bt')
    surface().feedDescriptor = { selectionType: 'block', blockId: 'bf', blockIds: ['bf'], blockKind: 'code', caret: 1, range: { from: 0, to: 2 } }
    notify()({ type: 'focus-changed' })
    expect(ed.getSelectionContext().blockId).toBe('bf')
  })

  it('does NOT feed the model on doc-changed (not a selection event)', () => {
    const { ed, surface, notify } = rig()
    notify()({ type: 'doc-changed' })
    expect(surface().feedCount).toBeUndefined() // feedSelection never called
    expect(ed.getSelectionContext().selectionType).toBe('none')
  })

  it('onSelectionUpdate fires on a meaningful change and still runs the legacy onEvent fan-out', () => {
    const { ed, surface, notify } = rig()
    const selUpdates = []
    const events = []
    ed.onSelectionUpdate((ctx) => selUpdates.push(ctx.blockId))
    ed.onEvent((ev) => events.push(ev.type))
    surface().feedDescriptor = { selectionType: 'caret', caret: 1, range: { from: 1, to: 1 }, blockId: 'b1', blockIds: ['b1'], blockKind: 'prose' }
    notify()({ type: 'selection-changed' })
    expect(selUpdates).toEqual(['b1'])
    // The raw selection-changed still reaches onEvent (legacy fan-out preserved);
    // P3.B ALSO bridges the model push as a selection-update on the same stream.
    expect(events).toContain('selection-changed')
    expect(events).toContain('selection-update')
  })

  it('a caret-only move within the same block does not fire onSelectionUpdate but is pullable', () => {
    const { ed, surface, notify } = rig()
    surface().feedDescriptor = { selectionType: 'caret', caret: 1, range: { from: 1, to: 1 }, blockId: 'b1', blockIds: ['b1'], blockKind: 'prose' }
    notify()({ type: 'selection-changed' }) // baseline
    const selUpdates = []
    ed.onSelectionUpdate((ctx) => selUpdates.push(ctx.caret))
    surface().feedDescriptor = { selectionType: 'caret', caret: 4, range: { from: 4, to: 4 }, blockId: 'b1', blockIds: ['b1'], blockKind: 'prose' }
    notify()({ type: 'selection-changed' })
    expect(selUpdates).toEqual([]) // coalesced
    expect(ed.getSelectionContext().caret).toBe(4) // but pullable
  })

  it('markdown surface focus-changed derives the markdown focus zone', () => {
    const { ed, surface, notify } = rig('markdown')
    surface().feedDescriptor = { selectionType: 'none' }
    notify()({ type: 'focus-changed' })
    expect(ed.getSelectionContext().focusZone).toBe('markdown')
  })
})

// ── P3.B: the push plumbing editor → tab → workspace ─────────────────────────────

describe('AbstractEditor selection-update onEvent bridge (P3.B)', () => {
  // Mounts a fake surface + scripts feedSelection; drives notify to push the model.
  function rig() {
    const ed = new FakeSurfaceEditor('u')
    ed.presentSurface('wysiwyg', document.createElement('div'), 'x')
    return { ed, surface: () => ed.surface, notify: () => ed.onSurfaceEvent.bind(ed) }
  }

  it("the model's meaningful push emits {type:'selection-update', context} on onEvent", () => {
    const { ed, surface, notify } = rig()
    const events = []
    ed.onEvent((ev) => events.push(ev))
    surface().feedDescriptor = { selectionType: 'caret', caret: 1, range: { from: 1, to: 1 }, blockId: 'b1', blockIds: ['b1'], blockKind: 'prose' }
    notify()({ type: 'selection-changed' })
    // BOTH the raw selection-changed (legacy fan-out food) and the model bridge event.
    const bridge = events.find((e) => e.type === 'selection-update')
    expect(bridge).toBeTruthy()
    expect(bridge.context.blockId).toBe('b1')
    expect(bridge.context.docUuid).toBe('u')
    expect(events.map((e) => e.type)).toContain('selection-changed')
  })

  it('a coalesced caret-only move does NOT emit a selection-update onEvent', () => {
    const { ed, surface, notify } = rig()
    surface().feedDescriptor = { selectionType: 'caret', caret: 1, range: { from: 1, to: 1 }, blockId: 'b1', blockIds: ['b1'], blockKind: 'prose' }
    notify()({ type: 'selection-changed' }) // baseline (fires once)
    const bridges = []
    ed.onEvent((ev) => { if (ev.type === 'selection-update') bridges.push(ev) })
    surface().feedDescriptor = { selectionType: 'caret', caret: 4, range: { from: 4, to: 4 }, blockId: 'b1', blockIds: ['b1'], blockKind: 'prose' }
    notify()({ type: 'selection-changed' })
    expect(bridges).toEqual([]) // coalesced — no meaningful change
  })
})

describe('SieveTab selection forwarding — the presence seam, host-ward', () => {
  // Presence flows the OPPOSITE way to everything else at the wall: the lens
  // ADVERTISES what it is looking at and the host listens. The listener is the
  // MOUNT, and the tab republishes what the mount hears — which is why the tab's
  // registry outlives the editor that fed it (a mode flip builds a new lens
  // against the same container).
  //
  // A mount is a real MountBinding here rather than a stub: it IS the
  // SelectionListener, and a test that faked it would be asserting the wiring
  // against its own idea of the seam.

  /** A tab with a mount attached, and the lens's advertise function. */
  function mountedTab(uuid = 'u') {
    const tab = new SieveTab(uuid)
    tab.attachMount(hostMount(uuid))
    return { tab, advertise: (ctx) => tab.mount.onSelectionChanged(ctx) }
  }

  it('republishes the advert the mounted lens made', () => {
    const { tab, advertise } = mountedTab()
    const seen = []
    tab.onSelectionUpdate((ctx) => seen.push(ctx))
    advertise({ blockId: 'b1', docUuid: 'u' })
    expect(seen).toEqual([{ blockId: 'b1', docUuid: 'u' }])
  })

  it('a lens registers the MOUNT as its selection listener when it attaches', () => {
    // The wiring under test: the tab hands the editor its mount, so the editor's
    // own SelectionModel push lands on the seam without either end naming the other.
    const { tab } = mountedTab()
    const ed = new FakeSurfaceEditor('u')
    tab.attachEditor(ed)
    ed.presentSurface('wysiwyg', document.createElement('div'), null)
    const seen = []
    tab.onSelectionUpdate((ctx) => seen.push(ctx.blockId))
    ed.surface.feedDescriptor = { selectionType: 'caret', caret: 1, range: { from: 1, to: 1 }, blockId: 'b1', blockIds: ['b1'], blockKind: 'prose' }
    ed.onSurfaceEvent({ type: 'selection-changed' })
    expect(seen).toEqual(['b1'])
  })

  it('a Tab-level listener survives an editor swap — the registry belongs to the TAB', () => {
    const { tab, advertise } = mountedTab()
    const seen = []
    tab.onSelectionUpdate((ctx) => seen.push(ctx.blockId))
    tab.attachEditor(new FakeSurfaceEditor('u'))
    advertise({ blockId: 'from-a' })
    tab.detachEditor()
    tab.attachEditor(new FakeSurfaceEditor('u'))
    advertise({ blockId: 'from-b' })
    expect(seen).toEqual(['from-a', 'from-b'])
  })

  it('the pull answers the last advert, from the mount', () => {
    const { tab, advertise } = mountedTab()
    expect(tab.getSelectionContext()).toBeNull()
    advertise({ blockId: 'b1' })
    expect(tab.getSelectionContext()).toEqual({ blockId: 'b1' })
  })

  it('detachMount ends the forward — the tab holds nothing for a container it closed', () => {
    const tab = new SieveTab('u')
    const mount = hostMount('u')
    tab.attachMount(mount)
    const seen = []
    tab.onSelectionUpdate((ctx) => seen.push(ctx.blockId))
    tab.detachMount()
    mount.onSelectionChanged(/** @type {any} */ ({ blockId: 'after-close' }))
    expect(seen).toEqual([])
    expect(tab.getSelectionContext()).toBeNull()
  })

  it('unsubscribe stops selection delivery', () => {
    const { tab, advertise } = mountedTab()
    const seen = []
    const unsub = tab.onSelectionUpdate((ctx) => seen.push(ctx.blockId))
    advertise({ blockId: 'b1' })
    unsub()
    advertise({ blockId: 'b2' })
    expect(seen).toEqual(['b1'])
  })

  it('a throwing selection listener does not break the others', () => {
    const { tab, advertise } = mountedTab()
    const seen = []
    tab.onSelectionUpdate(() => { throw new Error('boom') })
    tab.onSelectionUpdate((ctx) => seen.push(ctx.blockId))
    expect(() => advertise({ blockId: 'b1' })).not.toThrow()
    expect(seen).toEqual(['b1'])
  })
})

describe('SieveWorkspace.onSelectionUpdate republish (P3.B)', () => {
  // The whole presence chain, exercised through REAL objects: the mount is the
  // lens's SelectionListener, the tab republishes what the mount heard, and the
  // workspace republishes the ACTIVE tab's stream. push() enters at the seam a
  // lens would use.
  function open(ws, uuid, ctx = null) {
    const tab = ws.openTab(uuid)
    const mount = hostMount(uuid)
    tab.attachMount(mount)
    if (ctx) mount.onSelectionChanged(ctx)
    return { push: (c) => mount.onSelectionChanged(c) }
  }

  // Re-activates an ALREADY-open tab (the same-uuid re-activation flow). This is
  // the switch where the D4 synth fires: the target tab's mount already holds an
  // advert.
  function switchTo(ws, uuid) { ws.openTab(uuid) }

  it('republishes the ACTIVE tab pushes to onSelectionUpdate subscribers', () => {
    const ws = new SieveWorkspace()
    const active = open(ws, 'doc-a')
    const seen = []
    ws.onSelectionUpdate((ctx) => seen.push(ctx && ctx.blockId))
    active.push({ blockId: 'b1' })
    expect(seen).toEqual(['b1'])
  })

  it('a BACKGROUND tab push does NOT reach onSelectionUpdate', () => {
    const ws = new SieveWorkspace()
    const a = open(ws, 'doc-a')
    const b = open(ws, 'doc-b') // b now active, a background
    const seen = []
    ws.onSelectionUpdate((ctx) => seen.push(ctx && ctx.blockId))
    a.push({ blockId: 'from-bg' }) // background — ignored
    b.push({ blockId: 'from-active' })
    expect(seen).toEqual(['from-active'])
  })

  it('unsubscribe stops delivery', () => {
    const ws = new SieveWorkspace()
    const a = open(ws, 'doc-a')
    const seen = []
    const unsub = ws.onSelectionUpdate((ctx) => seen.push(ctx && ctx.blockId))
    a.push({ blockId: 'b1' })
    unsub()
    a.push({ blockId: 'b2' })
    expect(seen).toEqual(['b1'])
  })

  it('D4: switching to a tab whose editor has a context synthesizes an immediate republish', () => {
    const ws = new SieveWorkspace()
    open(ws, 'doc-a', { blockId: 'a-ctx' })
    open(ws, 'doc-b', { blockId: 'b-ctx' }) // both open+attached; b active
    const seen = []
    ws.onSelectionUpdate((ctx) => seen.push(ctx && ctx.blockId))
    switchTo(ws, 'doc-a') // re-activate the already-attached A → synth a-ctx now
    expect(seen).toEqual(['a-ctx'])
  })

  it('D4: active → null (teardown) emits a null context', () => {
    const ws = new SieveWorkspace()
    open(ws, 'doc-a', { blockId: 'a-ctx' })
    const seen = []
    ws.onSelectionUpdate((ctx) => seen.push(ctx))
    ws.closeTab('doc-a') // active closed → null
    expect(seen).toEqual([null])
  })

  it('D4 null-guard: switching to a tab whose lens has advertised nothing synthesizes nothing', () => {
    const ws = new SieveWorkspace()
    open(ws, 'doc-a', null) // mounted, but the lens has made no advert yet
    const seen = []
    ws.onSelectionUpdate((ctx) => seen.push(ctx))
    // the tab is already active from open(); switch to a second advert-less tab.
    open(ws, 'doc-b', null)
    expect(seen).toEqual([]) // nothing to synthesize
  })

  it('after a switch, the OLD tab is unsubscribed (no leak)', () => {
    const ws = new SieveWorkspace()
    const a = open(ws, 'doc-a')
    const b = open(ws, 'doc-b') // now b active, a should be unsubscribed
    const seen = []
    ws.onSelectionUpdate((ctx) => seen.push(ctx && ctx.blockId))
    a.push({ blockId: 'stale' }) // a is background AND unsubscribed
    b.push({ blockId: 'live' })
    expect(seen).toEqual(['live'])
  })
})

describe('AbstractEditor.presentSurface (P2.B lifecycle)', () => {
  it('mounts via _createSurface and stores the root', () => {
    const ed = new FakeSurfaceEditor('u')
    const root = document.createElement('div')
    const s = ed.presentSurface('markdown', root, 'seed')
    expect(ed.made).toEqual([s])
    expect(s.mountArgs).toEqual([root, 'seed'])
    expect(ed.surface).toBe(s)
  })

  it('unmounts the previous surface BEFORE mounting the next', () => {
    const ed = new FakeSurfaceEditor('u')
    const root = document.createElement('div')
    ed.presentSurface('markdown', root, 'seed')
    ed.presentSurface('wysiwyg', root, { body: '', blocks: [] })
    expect(ed.surfaceLog).toEqual(['mount:markdown', 'unmount:markdown', 'mount:wysiwyg'])
  })

  it('presentSurface on the abstract base throws — the repertoire lives on concrete types', () => {
    const ed = new AbstractEditor('u')
    expect(() => ed.presentSurface('markdown', document.createElement('div'), '')).toThrow('_createSurface')
  })
})

describe('SieveTab.createEditor factory (P2.A)', () => {
  it('creates a NoteEditor for a note uuid', () => {
    const tab = new SieveTab('note-1')
    expect(tab.createEditor('note-1', { provider: fakeProvider(), toolbar: null })).toBeInstanceOf(NoteEditor)
  })

  it('creates a PromptEditor for a prompt: uuid', () => {
    const tab = new SieveTab('prompt:daily')
    expect(tab.createEditor('prompt:daily', { provider: wholeContentProvider() })).toBeInstanceOf(PromptEditor)
  })

  it('constructing a lens opens NOTHING — the container was mounted before it existed', () => {
    // The lens holds one object, and that object is not a socket. Which container
    // it edits, and when that container's channel opens, are decided by the host
    // (activateDocument → MountBinding) before this constructor runs.
    FakeSocket.reset()
    new SieveTab('note-2').createEditor('note-2', { provider: fakeProvider(), toolbar: null })
    new SieveTab('prompt:x').createEditor('prompt:x', { provider: wholeContentProvider() })
    expect(FakeSocket.instances).toEqual([])
  })
})

describe('NoteEditor lifecycle — a lens holds no wire (issue #96)', () => {
  it('destroy unmounts the active surface and drops the container subscription', () => {
    const { ed, made, provider } = noteRig('n')
    ed.presentSurface('markdown', document.createElement('div'), 'x')
    expect(provider.subscribe).toHaveBeenCalledTimes(1)
    ed.destroy()
    expect(made[0].unmountCount).toBe(1)
    expect(ed.surface).toBeNull()
    // A lens hands back only what it took. Closing the container's channel and
    // discarding its model are the MOUNT's, and a lens that did either would be
    // deciding the lifetime of something it does not own.
    expect(provider.unsubscribe).toHaveBeenCalledWith(ed)
  })

  it('a second destroy is inert', () => {
    const { ed, made } = noteRig('n')
    ed.presentSurface('markdown', document.createElement('div'), 'x')
    ed.destroy()
    expect(() => ed.destroy()).not.toThrow()
    expect(made[0].unmountCount).toBe(1)
  })
})

// ── P2.B: setMode — the awaited in-place surface swap ───────────────────────────

describe('NoteEditor.setMode — the flip is ONE lens using both of its container\'s vocabularies', () => {
  afterEach(() => vi.useRealTimers())

  /** A promise a test settles by hand, so a flip can be held mid-air. */
  function deferred() {
    let resolve, reject
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }

  function flipRig(startMode = 'markdown') {
    const rig = noteRig('n')
    const root = document.createElement('div')
    rig.ed.presentSurface(startMode, root, startMode === 'markdown' ? 'seed' : null)
    rig.log.length = 0 // drop setup entries; tests assert the flip only
    return Object.assign(rig, { root })
  }

  it('markdown→wysiwyg: flushes, hands the WHOLE buffer back, and paints from the reparse', async () => {
    const rig = flipRig('markdown')
    rig.made[0].bodyValue = 'LIVE BODY'
    const held = deferred()
    rig.provider.setContents.mockReturnValue(held.promise)

    const flip = rig.ed.setMode('wysiwyg')
    // Flush first: the buffer Go is handed must be the one the user is looking at.
    expect(rig.log[0]).toBe('flush:markdown')
    expect(rig.provider.setContents).toHaveBeenCalledWith('LIVE BODY')
    // Nothing is torn down until Go has taken it — stay-on-failure.
    expect(rig.made[0].unmountCount).toBe(0)

    held.resolve()
    await expect(flip).resolves.toBe(true)
    expect(rig.log).toEqual(['flush:markdown', 'unmount:markdown', 'mount:wysiwyg', 'cue'])
    expect(rig.made[0].unmountCount).toBe(1) // exactly once
    // The new surface mounts EMPTY and is painted by its bootstrap cue: Go's
    // reparse reached the model, and the subscription is the one painting path.
    // Passing blocks through the flip would be a second one.
    expect(rig.made[1].mountArgs).toEqual([rig.root, null])
    expect(rig.made[1].changes).toHaveLength(1)
    expect(rig.ed.mode).toBe('wysiwyg')
  })

  it('wysiwyg→markdown: flushes, asks for the container\'s own projection, mounts it', async () => {
    const rig = flipRig('wysiwyg')
    rig.provider.getContents.mockResolvedValue('FROM GO')
    const flip = rig.ed.setMode('markdown')
    expect(rig.log[0]).toBe('flush:wysiwyg')
    await expect(flip).resolves.toBe(true)
    expect(rig.provider.getContents).toHaveBeenCalledTimes(1)
    expect(rig.log).toEqual(['flush:wysiwyg', 'unmount:wysiwyg', 'mount:markdown', 'cue'])
    // The projection is Go's — the frontend never serialises a document.
    expect(rig.made[1].mountArgs).toEqual([rig.root, 'FROM GO'])
    expect(rig.ed.mode).toBe('markdown')
  })

  it('a projection that never arrives leaves the editor exactly where it was', async () => {
    const rig = flipRig('wysiwyg')
    rig.provider.getContents.mockRejectedValue(new Error('ws timeout: enter-markdown'))
    await expect(rig.ed.setMode('markdown')).rejects.toThrow('ws timeout')
    expect(rig.made).toHaveLength(1)           // no new surface was ever created
    expect(rig.made[0].unmountCount).toBe(0)   // the old one never unmounted
    expect(rig.made[0].mounted).toBe(true)
    expect(rig.ed.mode).toBe('wysiwyg')        // stay-on-failure
  })

  it('a late projection is dropped — the failed flip took its continuation with it', async () => {
    const rig = flipRig('wysiwyg')
    const held = deferred()
    rig.provider.getContents.mockReturnValue(held.promise)
    const flip = rig.ed.setMode('markdown')
    const assertion = expect(flip).rejects.toThrow('gone')
    held.reject(new Error('gone'))
    await assertion
    expect(rig.made).toHaveLength(1)
    expect(rig.ed.mode).toBe('wysiwyg')
  })

  it('setMode with a value not in EditorMode resolves false and asks the container nothing', async () => {
    const rig = flipRig('markdown')
    await expect(rig.ed.setMode('markdwon')).resolves.toBe(false)
    expect(rig.provider.getContents).not.toHaveBeenCalled()
    expect(rig.provider.setContents).not.toHaveBeenCalled()
    expect(rig.made).toHaveLength(1)
    expect(rig.ed.mode).toBe('markdown')
  })

  it('setMode to the current mode is a no-op resolving false', async () => {
    const rig = flipRig('markdown')
    await expect(rig.ed.setMode('markdown')).resolves.toBe(false)
    expect(rig.log).toEqual([])
  })

  it('setMode with no surface mounted is a no-op resolving false', async () => {
    await expect(noteRig('n').ed.setMode('markdown')).resolves.toBe(false)
  })

  it('a WHOLE-CONTENT container has no second shape — the flip is refused by TYPE', async () => {
    // The refusal is not a uuid test or a subclass override: the provider carries
    // no block extension, so there is no block tree to present.
    const ed = new FakeSurfaceEditor('prompt:p', { provider: wholeContentProvider() })
    ed.presentSurface('markdown', document.createElement('div'), 'x')
    await expect(ed.setMode('wysiwyg')).resolves.toBe(false)
  })

  it('reentrant setMode while a flip is in flight coalesces to the same promise', async () => {
    const rig = flipRig('markdown')
    const held = deferred()
    rig.provider.setContents.mockReturnValue(held.promise)
    const first = rig.ed.setMode('wysiwyg')
    const second = rig.ed.setMode('wysiwyg')
    expect(second).toBe(first)
    expect(rig.provider.setContents).toHaveBeenCalledTimes(1)
    held.resolve()
    await first
    expect(rig.made).toHaveLength(2) // exactly one new surface
  })

  it('destroy mid-flight: the flip dies without mounting anything', async () => {
    const rig = flipRig('markdown')
    const held = deferred()
    rig.provider.setContents.mockReturnValue(held.promise)
    const flip = rig.ed.setMode('wysiwyg')
    const assertion = expect(flip).rejects.toThrow()
    rig.ed.destroy()
    held.reject(new Error('editor destroyed'))
    await assertion
    expect(rig.made).toHaveLength(1) // no wysiwyg surface ever created
  })
})

// ── The ONE inbound path: the container cue ─────────────────────────────────────

describe('AbstractEditor.onChanged — origin-blind, and the only way in', () => {
  it('subscribing CUES immediately, so the mount IS the paint', () => {
    // Bootstrap is just the first onChanged. The surface mounts empty and the cue
    // paints it from the model the host already seeded — one painting path, with
    // no separate "initial render" to keep in step with the repaint.
    const { ed, made, provider } = noteRig('n')
    ed.presentSurface('wysiwyg', document.createElement('div'), null)
    expect(provider.subscribe).toHaveBeenCalledWith(ed)
    expect(made[0].log).toEqual(['mount:wysiwyg', 'cue'])
  })

  it('hands the cue AND the provider to the surface, which re-reads what changed', () => {
    const { ed, made, provider } = noteRig('n')
    ed.presentSurface('wysiwyg', document.createElement('div'), null)
    made[0].changes.length = 0
    provider._cue({ blockIds: ['b1', 'b2'], orderChanged: false })
    expect(made[0].changes).toEqual([{ blockIds: ['b1', 'b2'], orderChanged: false }])
  })

  it('says nothing about WHO changed the container — one repaint story, not one per origin', () => {
    // A cue from this lens\'s own verb, another lens, a finished AI job and the
    // watcher are the same event, and the contract cannot even express which was
    // which. This test exists to pin that absence.
    const { ed, made, provider } = noteRig('n')
    ed.presentSurface('wysiwyg', document.createElement('div'), null)
    made[0].changes.length = 0
    ed.createBlock('code', {}, 'b1')
    provider._cue({ blockIds: ['new-1'], orderChanged: true })
    expect(Object.keys(made[0].changes[0])).toEqual(['blockIds', 'orderChanged'])
  })

  it('a cue with no surface mounted is dropped safely', () => {
    const { ed } = noteRig('n')
    expect(() => ed.onChanged({ blockIds: ['b1'], orderChanged: false })).not.toThrow()
  })

  it('presenting a NEW surface drops the old subscription first', () => {
    // A torn-down surface that stayed subscribed would be cued into a DOM it no
    // longer owns.
    const { ed, provider } = noteRig('n')
    ed.presentSurface('wysiwyg', document.createElement('div'), null)
    ed.presentSurface('markdown', document.createElement('div'), 'x')
    expect(provider.unsubscribe).toHaveBeenCalledWith(ed)
    expect(provider.subscribe).toHaveBeenCalledTimes(2)
    expect(provider._listeners).toEqual([ed]) // subscribed exactly once, still
  })

  it('cues are HELD while a whole-container load is mid-flight', async () => {
    // A cue arriving mid-load names blocks against a model halfway through being
    // reset; reacting piecemeal would author tracked edits the user never made.
    // The repaint at the end of the load is the whole answer.
    let release
    const rig = noteRig('n', { loadContainer: vi.fn(() => new Promise((r) => { release = r })) })
    rig.ed.presentSurface('wysiwyg', document.createElement('div'), null)
    rig.made[0].changes.length = 0
    const reloading = rig.ed.reload()
    rig.provider._cue({ blockIds: ['mid-load'], orderChanged: false })
    expect(rig.made[0].changes).toEqual([])
    release({ body: '', version: 3 })
    await reloading
    expect(rig.made[0].painted).toBe(rig.provider)
  })
})

// ── flush/save routing ──────────────────────────────────────────────────────────

describe('flushSave routing — in-flight text down, then persist', () => {
  it('a NoteEditor flushes the active surface BEFORE asking the container to persist', () => {
    const { ed, made, log, provider } = noteRig('n')
    ed.presentSurface('markdown', document.createElement('div'), 'x')
    log.length = 0
    ed.flushSave()
    expect(made[0].flushCount).toBe(1)
    expect(log[0]).toBe('flush:markdown')
    expect(provider.requestPersist).toHaveBeenCalledTimes(1)
  })

  it('flushSave with no surface still asks the container to persist', () => {
    const { ed, provider } = noteRig('n')
    ed.flushSave()
    expect(provider.requestPersist).toHaveBeenCalledTimes(1)
  })

  it('a bare lens (no container) drops both halves rather than throwing', async () => {
    const ed = new FakeSurfaceEditor('u')
    ed.presentSurface('markdown', document.createElement('div'), 'x')
    await expect(ed.flushSave()).resolves.toBeUndefined()
  })

  it('a PROMPT persists by STATING ITSELF — the buffer IS the container', async () => {
    // requestPersist would be asking a container to write down what it holds, and
    // what a prompt holds is whatever this lens last said it was.
    const provider = wholeContentProvider()
    const ed = new (withFakeSurfaces(PromptEditor))('prompt:p', { provider })
    const surface = ed.presentSurface('markdown', document.createElement('div'), 'seed')
    surface.bodyValue = 'prompt body'
    await ed.flushSave()
    expect(provider.setContents).toHaveBeenCalledWith('prompt body')
  })

  it('a prompt does NOT clear its own dirty state — the saved fact does, for every type alike', async () => {
    const provider = wholeContentProvider()
    const ed = new (withFakeSurfaces(PromptEditor))('prompt:p', { provider })
    ed.presentSurface('markdown', document.createElement('div'), 'seed')
    ed.markDirty()
    await ed.flushSave()
    expect(ed.isDirty).toBe(true)
    document.dispatchEvent(new CustomEvent('sieve:container-saved', { detail: { uuid: 'prompt:p' } }))
    expect(ed.isDirty).toBe(false)
    ed.destroy()
  })

  it('PromptEditor mode is markdown by default (fixed)', () => {
    expect(new PromptEditor('prompt:p').mode).toBe('markdown')
  })

  it('a prompt skips the save while a whole-container load is mid-flight', async () => {
    // A save now would race the re-render; isSaveSuppressed is the same flag that
    // holds the container cues.
    let release
    const provider = wholeContentProvider()
    const ed = new (withFakeSurfaces(PromptEditor))('prompt:p', {
      provider, loadContainer: vi.fn(() => new Promise((r) => { release = r })),
    })
    ed.presentSurface('markdown', document.createElement('div'), 'seed')
    const reloading = ed.reload()
    expect(ed.isSaveSuppressed()).toBe(true)
    await ed.flushSave()
    expect(provider.setContents).not.toHaveBeenCalled()
    release({ body: 'x' })
    await reloading
    expect(ed.isSaveSuppressed()).toBe(false)
  })
})

// ── P2.A fix wave: workspace-owned editor lifecycle (the ONE teardown path) ──────

describe('SieveWorkspace.activateDocument editor lifecycle (P2.A fix wave)', () => {
  beforeEach(() => FakeSocket.reset())

  // A Workspace whose ContainerTransport socketFactory records open/close ordering
  // into a shared log (the seam moved off editor options onto the wire owner);
  // wsUrlFor embeds the uuid, so log entries identify the document.
  function loggingWorkspace(log) {
    return new SieveWorkspace({
      socketFactory: (url) => {
        const s = new FakeSocket(url)
        log.push('open:' + url)
        const origClose = s.close.bind(s)
        s.close = () => {
          if (!s.closed) log.push('close:' + s.url)
          origClose()
        }
        return s
      },
      wsUrlFor: (uuid) => 'ws://test/api/ws/document/' + uuid,
    })
  }
  const edOpts = { onServerMessage: () => {} }

  it("tab switch: A's socket closes before B's opens, exactly once", () => {
    const log = []
    const w = loggingWorkspace(log)
    const tabA = w.activateDocument('doc-a', edOpts)
    FakeSocket.instances[0].driveOpen()
    const tabB = w.activateDocument('doc-b', edOpts)

    expect(log).toEqual([
      'open:ws://test/api/ws/document/doc-a',
      'close:ws://test/api/ws/document/doc-a',
      'open:ws://test/api/ws/document/doc-b',
    ]) // A closed BEFORE B opened; A closed exactly once
    expect(tabA.editor).toBeNull() // detached after destroy
    expect(tabB.editor).toBeInstanceOf(NoteEditor)
    expect(w.activeTab).toBe(tabB)
  })

  it('same-uuid re-activation keeps the editor instance and its socket', () => {
    const log = []
    const w = loggingWorkspace(log)
    const tab1 = w.activateDocument('doc-a', edOpts)
    const ed1 = tab1.editor
    FakeSocket.instances[0].driveOpen()

    const tab2 = w.activateDocument('doc-a', edOpts)
    expect(tab2).toBe(tab1)
    expect(tab2.editor).toBe(ed1) // same instance — no destroy, no new socket
    expect(log.filter((e) => e.startsWith('close:')).length).toBe(0)
    expect(FakeSocket.instances.length).toBe(1)
  })

  it('teardown to empty: single destroy, tab closed, no throw; repeat is a no-op', () => {
    const log = []
    const w = loggingWorkspace(log)
    w.activateDocument('doc-a', edOpts)
    FakeSocket.instances[0].driveOpen()

    expect(() => w.activateDocument('', edOpts)).not.toThrow()
    expect(log.filter((e) => e.startsWith('close:')).length).toBe(1) // exactly one close
    expect(w.getTab('doc-a')).toBeNull()
    expect(w.activeTab).toBeNull()

    // Second teardown with nothing open must not throw or close anything else.
    expect(() => w.activateDocument('', edOpts)).not.toThrow()
    expect(log.filter((e) => e.startsWith('close:')).length).toBe(1)
  })

  it('re-activating a tab whose lens died out of band RETIRES the old mount', () => {
    // An editor torn down out of band leaves the tab holding a mount with no lens
    // on it. The next activation must make that mount give the channel up, not
    // merely stop pointing at it: a mount that still believes it owns a container
    // will close that container's socket when anything gets round to tearing it
    // down — out from under the lens now using it.
    const log = []
    const w = loggingWorkspace(log)
    const tab = w.activateDocument('doc-a', edOpts)
    FakeSocket.instances[0].driveOpen()
    tab.editor.destroy()
    tab.detachEditor()          // what an OOB swap leaves behind
    const stale = tab.mount

    w.activateDocument('doc-a', edOpts)
    expect(tab.mount).not.toBe(stale)
    const live = FakeSocket.instances[FakeSocket.instances.length - 1]
    stale.close()
    expect(live.closed).toBe(false)
  })

  it('prompt tabs participate without ever touching a socket', () => {
    const log = []
    const w = loggingWorkspace(log)
    w.activateDocument('doc-a', edOpts)
    const promptTab = w.activateDocument('prompt:p', edOpts)

    expect(promptTab.editor).toBeInstanceOf(PromptEditor)
    expect(log.filter((e) => e.startsWith('close:')).length).toBe(1) // note's socket closed on switch
    expect(FakeSocket.instances.length).toBe(1) // no socket created for the prompt
  })
})

// ── P4.F: the editor.js BOOT/LIFECYCLE half moved onto SieveWorkspace ────────────
// activeEditor / initEditor / #syncShell / routeServerMessage / onEditorModeEvent /
// flushSave were editor.js free functions + module vars; they are now Workspace
// methods (editor.js is DELETED). These pin the load-bearing invariants the move
// had to preserve: the initEditor staleness guard and onEditorModeEvent attach-once.
describe('SieveWorkspace editor lifecycle (P4.F — moved from editor.js)', () => {
  let origFetch
  beforeEach(() => { FakeSocket.reset(); origFetch = global.fetch })
  afterEach(() => { global.fetch = origFetch; vi.restoreAllMocks(); document.body.classList.remove('markdown-mode') })

  it('activeEditor mirrors activeTab.editor and is null-safe', () => {
    const w = new SieveWorkspace()
    expect(w.activeEditor).toBeNull() // no active tab
    const tab = w.openTab('doc-a')
    expect(w.activeEditor).toBeNull() // tab open, no editor attached yet
    const ed = new SieveEditor('doc-a')
    tab.attachEditor(ed)
    expect(w.activeEditor).toBe(ed)
  })

  it('flushSave resolves quietly with no active editor, else delegates', async () => {
    const w = new SieveWorkspace()
    await expect(w.flushSave()).resolves.toBeUndefined()
    const tab = w.openTab('doc-a')
    const ed = new SieveEditor('doc-a')
    ed.flushSave = vi.fn(() => Promise.resolve('flushed'))
    tab.attachEditor(ed)
    await expect(w.flushSave()).resolves.toBe('flushed')
  })

  it('routeServerMessage alerts only on an error message', () => {
    const w = new SieveWorkspace()
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    w.routeServerMessage({ type: 'error', message: 'boom' })
    expect(alertSpy).toHaveBeenCalledWith('boom')
    w.routeServerMessage({ type: 'insert-block' }) // non-error is ignored
    expect(alertSpy).toHaveBeenCalledTimes(1)
  })

  it('onEditorModeEvent: mode-changed toggles body class + reloads tabs', () => {
    const w = new SieveWorkspace()
    const tab = w.openTab('doc-a')
    const ed = new SieveEditor('doc-a')
    tab.attachEditor(ed)
    Object.defineProperty(ed, 'mode', { get: () => 'markdown', configurable: true })
    const loadSpy = vi.spyOn(w, 'loadTabs').mockReturnValue(Promise.resolve())
    w.onEditorModeEvent({ type: 'mode-changed' })
    expect(document.body.classList.contains('markdown-mode')).toBe(true)
    expect(loadSpy).toHaveBeenCalledOnce()
  })

  it('onEditorModeEvent: mode-change-failed alerts the stay-on-failure message', () => {
    const w = new SieveWorkspace()
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    w.onEditorModeEvent({ type: 'mode-change-failed', mode: 'wysiwyg', error: new Error('x') })
    expect(alertSpy).toHaveBeenCalledWith('Mode switch failed — staying in wysiwyg mode.')
  })

  it('initEditor: a superseded in-flight load is dropped (staleness guard)', async () => {
    const w = new SieveWorkspace()
    /** @type {Record<string, (body: string) => void>} */
    const resolvers = {}
    global.fetch = vi.fn((url) => new Promise((res) => {
      const uuid = decodeURIComponent(url.split('uuid=')[1])
      resolvers[uuid] = (body) => res({ json: () => Promise.resolve({ body, blocks: [] }) })
    }))
    const mount = document.createElement('div')

    w.initEditor(mount, 'prompt:a', 'markdown') // load A pending, currentUuid='prompt:a'
    w.initEditor(mount, 'prompt:b', 'markdown') // supersedes A, currentUuid='prompt:b'
    const edB = w.activeEditor
    const present = vi.spyOn(edB, 'presentSurface').mockImplementation(() => {})

    resolvers['prompt:a']('A') // resolve the STALE load
    await new Promise((r) => setTimeout(r, 0))
    expect(present).not.toHaveBeenCalled() // guard dropped it; edB untouched

    resolvers['prompt:b']('B') // resolve the CURRENT load
    await new Promise((r) => setTimeout(r, 0))
    expect(present).toHaveBeenCalledOnce() // current load presented into edB
  })

  it('initEditor: onEditorModeEvent attaches ONCE per editor instance (no re-subscribe on same-uuid re-init)', () => {
    const w = new SieveWorkspace()
    global.fetch = vi.fn(() => new Promise(() => {})) // load never resolves; only the sync subscribe path matters
    const onEventSpy = vi.spyOn(PromptEditor.prototype, 'onEvent')
    const mount = document.createElement('div')

    w.initEditor(mount, 'prompt:a', 'markdown')
    const afterFirst = onEventSpy.mock.calls.length // Tab.attachEditor + #syncShell subscribed
    expect(afterFirst).toBeGreaterThan(0)
    w.initEditor(mount, 'prompt:a', 'markdown') // same uuid: editor + subscription KEPT
    expect(onEventSpy.mock.calls.length).toBe(afterFirst) // no new subscription — mode-changed won't double-fire
  })
})

// Deletion is an accomplished server-side fact broadcast on the workspace wire.
// The workspace RECONCILES against it: whatever it still holds for that uuid —
// the editor (whose destroy closes the document socket) and the tab bookkeeping
// — goes away. Nothing here performs a deletion, so the handler must be
// idempotent and must tolerate a tab the response's OOB editor swap already
// tore down.
describe('SieveWorkspace container-deleted reconciliation (shell/workspace.js bootEditorLifecycle)', () => {
  beforeEach(() => FakeSocket.reset())

  /**
   * A tab holding what the shell holds: a real MOUNT with a live container
   * channel, and a lens constructed against its provider. The channel is the
   * MOUNT's — closing it is a host act, and the lens has no say in it — so this
   * is what the reconciliation has to reach.
   */
  const withEditor = (w, uuid) => {
    const tab = w.openTab(uuid)
    const mount = hostMount(uuid)
    mount.openChannel(/** @type {any} */ ({ onMessage: () => {} }))
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1]
    tab.attachMount(mount)
    const editor = new FakeSurfaceNoteEditor(uuid, { provider: mount.provider, toolbar: null })
    const destroy = vi.spyOn(editor, 'destroy')
    tab.attachEditor(editor)
    return { tab, editor, destroy, socket }
  }

  it('drops the named document: its lens is destroyed, its channel closed, its tab gone', () => {
    const w = new SieveWorkspace()
    w.bootEditorLifecycle()
    const { destroy, socket } = withEditor(w, 'doc-a')

    document.dispatchEvent(new CustomEvent('sieve:container-deleted', { detail: { uuid: 'doc-a' } }))
    expect(destroy).toHaveBeenCalledOnce()
    expect(socket.closed).toBe(true)
    expect(w.getTab('doc-a')).toBeNull()
  })

  it('leaves every other document alone', () => {
    const w = new SieveWorkspace()
    w.bootEditorLifecycle()
    const survivor = withEditor(w, 'doc-keep')
    withEditor(w, 'doc-gone')

    document.dispatchEvent(new CustomEvent('sieve:container-deleted', { detail: { uuid: 'doc-gone' } }))
    expect(survivor.destroy).not.toHaveBeenCalled()
    expect(survivor.socket.closed).toBe(false)
    expect(w.getTab('doc-keep')).not.toBeNull()
  })

  it('is idempotent: an unknown uuid, a repeat, and a uuid-less event are all no-ops', () => {
    const w = new SieveWorkspace()
    w.bootEditorLifecycle()
    const closeTab = vi.spyOn(w, 'closeTab')
    const { destroy } = withEditor(w, 'doc-a')

    const deleted = (uuid) =>
      document.dispatchEvent(new CustomEvent('sieve:container-deleted', { detail: { uuid } }))
    deleted('doc-a')
    deleted('doc-a')          // the news arrives twice — the second finds nothing
    expect(destroy).toHaveBeenCalledOnce()

    closeTab.mockClear()
    deleted('never-opened')   // a uuid this window never held reaches no bookkeeping
    expect(closeTab).not.toHaveBeenCalled()

    document.dispatchEvent(new CustomEvent('sieve:container-deleted', { detail: {} }))
    document.dispatchEvent(new CustomEvent('sieve:container-deleted'))
    document.dispatchEvent(new CustomEvent('sieve:invalidate-notes'))
    expect(closeTab).not.toHaveBeenCalled()
  })

  // The ORDINARY loopback order, not an edge case: the delete handler emits the
  // frame before it renders, so the requesting window normally reconciles while
  // the deleted note's editor is still MOUNTED and active. Nothing may throw and
  // the surface must actually come down — the response's OOB swap mounts a fresh
  // one for the new active tab straight afterwards.
  it('tears down the ACTIVE note while its surface is still mounted', () => {
    const w = new SieveWorkspace()
    w.bootEditorLifecycle()
    const { editor, socket } = withEditor(w, 'doc-active')
    const surface = editor.presentSurface('wysiwyg', document.createElement('div'), null)
    expect(w.activeTab?.uuid).toBe('doc-active')
    expect(surface.mounted).toBe(true)

    expect(() => document.dispatchEvent(
      new CustomEvent('sieve:container-deleted', { detail: { uuid: 'doc-active' } }),
    )).not.toThrow()

    expect(surface.unmountCount).toBe(1)
    expect(surface.mounted).toBe(false)
    expect(socket.closed).toBe(true)
    expect(w.getTab('doc-active')).toBeNull()
    expect(w.activeTab).toBeNull()
  })

  it('tolerates the ACTIVE note whose editor the OOB swap already destroyed', () => {
    const w = new SieveWorkspace()
    w.bootEditorLifecycle()
    const { tab, editor } = withEditor(w, 'doc-active')
    editor.destroy()
    tab.detachEditor()   // what activateDocument leaves behind after the swap

    expect(() => document.dispatchEvent(
      new CustomEvent('sieve:container-deleted', { detail: { uuid: 'doc-active' } }),
    )).not.toThrow()
    expect(w.getTab('doc-active')).toBeNull()
    expect(w.activeTab).toBeNull()
  })

  it('a background reconciliation leaves the active tab standing', () => {
    const w = new SieveWorkspace()
    w.bootEditorLifecycle()
    w.openTab('doc-bg')
    w.openTab('doc-active')   // the later open is the active one

    document.dispatchEvent(new CustomEvent('sieve:container-deleted', { detail: { uuid: 'doc-bg' } }))
    expect(w.activeTab?.uuid).toBe('doc-active')

    document.dispatchEvent(new CustomEvent('sieve:container-deleted', { detail: { uuid: 'doc-active' } }))
    expect(w.activeTab).toBeNull()
  })
})

describe('the wall is the whole surface (issue #96)', () => {
  it('no editor type exposes a transport, a wire verb, or a document position', () => {
    const note = makeNote('n')
    const prompt = new PromptEditor('prompt:p', { provider: wholeContentProvider() })
    for (const ed of [note, prompt]) {
      const it = /** @type {any} */ (ed)
      // Transport, and the retired editor-owned wire verbs.
      for (const name of ['wsSend', 'wsSendAndAwait', '_wsSend', '_awaitReply', 'applyServerOp',
        'applyBlockOps', 'updateText', 'flush', 'enterMarkdown', 'enterWysiwyg', 'retryBlockJob',
        'copyAsMarkdown', 'softReload']) {
        expect(typeof it[name]).not.toBe('function')
      }
      // And no INDEX arithmetic: an anchor is a block id, and turning one into a
      // position is the host's, against its own follower model.
      for (const name of ['insertIndexForBlock', 'commitInsertIndex', 'peekInsertIndex', 'setInsertPos', 'takeInsertPos']) {
        expect(typeof it[name]).not.toBe('function')
      }
      // The surviving lens surface is uniform across the hierarchy.
      for (const name of ['extract', 'flushSave', 'createBlock', 'setRawContent', 'reload', 'onChanged']) {
        expect(typeof it[name]).toBe('function')
      }
    }
    note.destroy(); prompt.destroy()
  })

  it('a lens holds exactly ONE business object, and that object is the provider', () => {
    const provider = fakeProvider()
    const ed = makeNote('n', { provider })
    expect(ed.provider).toBe(provider)
    expect(ed.canEditBlocks).toBe(true)
    ed.destroy()
  })

  it('capability is READ off the provider, never declared by the type', () => {
    // Hand a NoteEditor a whole-content-only container and its block verbs are
    // simply absent — which is why a prompt gets a different type rather than a flag.
    const ed = makeNote('n', { provider: wholeContentProvider() })
    expect(ed.canEditBlocks).toBe(false)
    expect(() => ed.createBlock('code', {})).not.toThrow()
    ed.destroy()
  })
})

// ── A container with no block tree: every block verb is absent, not stubbed ──────

describe('a WHOLE-CONTENT lens (the prompt pseudo-document)', () => {
  it('constructs without touching a socket — the host mounted the container already', () => {
    FakeSocket.reset()
    new PromptEditor('prompt:x', { provider: wholeContentProvider() })
    expect(FakeSocket.instances).toEqual([])
  })

  it('createBlock is a silent no-op — there is no block tree to add to', () => {
    const provider = wholeContentProvider()
    const ed = new PromptEditor('prompt:x', { provider })
    expect(() => ed.createBlock('code', {})).not.toThrow()
  })

  it('setRawContent is the whole-content FLUSH — keep this, do not re-parse it', () => {
    // Deliberately not setContents: that one means "the text is the document now",
    // and a half-typed break-glass buffer is exactly what must not be re-parsed.
    const provider = wholeContentProvider()
    const ed = new PromptEditor('prompt:x', { provider })
    ed.setRawContent('# hello')
    expect(provider.flushContents).toHaveBeenCalledWith('# hello')
    expect(provider.setContents).not.toHaveBeenCalled()
  })

  it('a bare lens (no container at all) drops every verb quietly', async () => {
    const ed = new PromptEditor('prompt:x')
    expect(() => ed.setRawContent('# x')).not.toThrow()
    expect(() => ed.createBlock('code', {})).not.toThrow()
    await expect(ed.flushSave()).resolves.toBeUndefined()
  })
})

describe('dirty-state transitions (P2.A)', () => {

  it('an editor clears dirty on ITS OWN uuid\'s container-saved fact, and ignores another\'s', () => {
    const events = []
    const handler = (e) => events.push(e.detail.dirty)
    document.addEventListener('sieve:meta-dirty', handler)
    try {
      // A uuid no other test built an editor for: editors leak across cases in
      // this file, and one holding the same uuid would answer the same fact.
      const uuid = 'dirty-transitions-own-uuid'
      const ed = makeNote(uuid)
      ed.markDirty()
      expect(ed.isDirty).toBe(true)

      // Another document saving is not this document saving.
      document.dispatchEvent(new CustomEvent('sieve:container-saved', { detail: { uuid: 'someone-else' } }))
      expect(ed.isDirty).toBe(true)
      expect(events).not.toContain(false)

      const saved = []
      const onSaved = (e) => saved.push(e.detail.uuid)
      document.addEventListener('editor:saved', onSaved)
      try {
        document.dispatchEvent(new CustomEvent('sieve:container-saved', { detail: { uuid: uuid } }))
        expect(ed.isDirty).toBe(false)
        expect(events).toContain(false)
        expect(saved).toEqual([uuid])
      } finally { document.removeEventListener('editor:saved', onSaved) }

      // A torn-down editor stops listening: it no longer presents that uuid.
      ed.markDirty()
      ed.destroy()
      document.dispatchEvent(new CustomEvent('sieve:container-saved', { detail: { uuid: uuid } }))
      expect(ed.isDirty).toBe(true)
    } finally {
      document.removeEventListener('sieve:meta-dirty', handler)
    }
  })

  it('a prompt states itself and clears dirty on the FACT, not on the answer', () => {
    const provider = wholeContentProvider()
    const ed = new (withFakeSurfaces(PromptEditor))('prompt:p', { provider })
    ed.presentSurface('markdown', document.createElement('div'), 'b')
    ed.markDirty()
    ed.flushSave()
    expect(provider.setContents).toHaveBeenCalled()
    // Go taking the buffer is not the saved-signal — a prompt hears the same
    // workspace fact a note does, and that is the only thing that clears it.
    expect(ed.isDirty).toBe(true)
    document.dispatchEvent(new CustomEvent('sieve:container-saved', { detail: { uuid: 'prompt:p' } }))
    expect(ed.isDirty).toBe(false)
    ed.destroy()
  })
})

describe('saveAndSettle — the wait for the save to LAND', () => {
  /** Live `sieve:container-saved` listeners, so a wait that leaks one is visible. */
  let live
  beforeEach(() => {
    live = new Set()
    const add = document.addEventListener.bind(document)
    const remove = document.removeEventListener.bind(document)
    vi.spyOn(document, 'addEventListener').mockImplementation((t, f, o) => {
      if (t === 'sieve:container-saved') live.add(f)
      return add(t, f, o)
    })
    vi.spyOn(document, 'removeEventListener').mockImplementation((t, f, o) => {
      if (t === 'sieve:container-saved') live.delete(f)
      return remove(t, f, o)
    })
  })
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  const fire = (uuid, version) =>
    document.dispatchEvent(new CustomEvent('sieve:container-saved', { detail: { uuid, version } }))

  it('settles on a NEWER version of its own uuid — not another uuid, not a version it already knew', async () => {
    const ed = makeNote('settle-newer')
    ed.seedVersion(4)
    const waiting = live.size

    let settled = false
    const landed = ed.saveAndSettle(60000).then(() => { settled = true })
    expect(live.size).toBe(waiting + 1)

    fire('someone-else', 99)  // another document's save is not this one's
    fire('settle-newer', 4)   // the version this editor already had
    fire('settle-newer', 3)   // a debounce write that was in flight when it asked
    await Promise.resolve()
    expect(settled).toBe(false)

    fire('settle-newer', 5)
    await landed
    expect(live.size).toBe(waiting) // and the wait took its listener with it
  })

  it('settles at graceMs when no fact arrives, and leaves no listener behind', async () => {
    vi.useFakeTimers()
    const ed = makeNote('settle-grace')
    ed.seedVersion(1)
    const waiting = live.size

    const landed = ed.saveAndSettle(3000)
    expect(live.size).toBe(waiting + 1)
    await vi.advanceTimersByTimeAsync(3000)
    await landed
    expect(live.size).toBe(waiting)
  })

  it('registers its listener BEFORE it asks, so a save that lands in the same tick settles it', async () => {
    vi.useFakeTimers()
    const ed = makeNote('settle-loopback')
    ed.seedVersion(1)
    // A loopback save fast enough to announce itself inside flushSave's own tick.
    ed.flushSave = () => { fire('settle-loopback', 2); return Promise.resolve() }

    // No timer is advanced, so only the listener can have settled this: had it
    // been registered after the ask, the fact would have been gone by then.
    await ed.saveAndSettle(60000)
  })

  it('settles an UNVERSIONED container on its uuid alone — a prompt reports no version to compare', async () => {
    const ed = makeNote('settle-unversioned')
    const waiting = live.size

    const landed = ed.saveAndSettle(60000)
    fire('settle-unversioned', 0)
    await landed
    expect(live.size).toBe(waiting)
  })
})

// ── P2.C: EditorMode + editor-bound commands + workspace chrome delegation ─────

describe('EditorMode (P2.C)', () => {
  it('is frozen and enumerates exactly the two modes', () => {
    expect(Object.isFrozen(EditorMode)).toBe(true)
    expect(EditorMode).toEqual({ WYSIWYG: 'wysiwyg', MARKDOWN: 'markdown' })
    expect(window.SieveEditorMode).toBe(EditorMode)
  })
})

describe('AbstractEditor.toggleMode (P2.C — binary-flip sugar over setMode)', () => {
  // Like flipRig, plus an unfiltered event collector so specs can assert the
  // producer emissions (mode-changed / mode-change-failed) exactly.
  function modeRig(startMode = 'markdown') {
    const rig = noteRig('n')
    const root = document.createElement('div')
    rig.ed.presentSurface(startMode, root, startMode === 'markdown' ? 'seed' : null)
    const events = []
    // presentSurface (the flip mount) also emits a `stats` event; these tests pin
    // the mode-changed/failed emissions only — filter stats out.
    rig.ed.onEvent((ev) => { if (ev.type !== 'stats') events.push(ev) })
    return Object.assign(rig, { root, events })
  }

  it("derives the target from the current mode and returns setMode's promise", async () => {
    const rig = modeRig('markdown')
    await expect(rig.ed.toggleMode()).resolves.toBe(true)
    expect(rig.provider.setContents).toHaveBeenCalledTimes(1)
    expect(rig.ed.mode).toBe(EditorMode.WYSIWYG)
  })

  it('emits mode-changed with the NEW mode exactly once on a successful flip', async () => {
    const rig = modeRig('markdown')
    await rig.ed.toggleMode()
    expect(rig.events).toEqual([{ type: 'mode-changed', mode: 'wysiwyg' }])
  })

  it('a direct setMode caller also produces the mode-changed emission (producer lives in the flip path)', async () => {
    const rig = modeRig('markdown')
    await rig.ed.setMode('wysiwyg')
    expect(rig.events).toEqual([{ type: 'mode-changed', mode: 'wysiwyg' }])
  })

  it('on failure: rejects and emits mode-change-failed once with the UNCHANGED mode', async () => {
    const rig = modeRig('markdown')
    rig.provider.setContents.mockRejectedValue(new Error('ws timeout: enter-wysiwyg'))
    await expect(rig.ed.toggleMode()).rejects.toThrow('ws timeout')
    expect(rig.events).toEqual([
      { type: 'mode-change-failed', mode: 'markdown', error: expect.any(Error) },
    ])
    expect(rig.ed.mode).toBe(EditorMode.MARKDOWN) // stay-on-failure
  })

  it('a no-op toggle (no surface mounted) resolves false and emits nothing', async () => {
    const rig = noteRig('n')
    const events = []
    rig.ed.onEvent((ev) => events.push(ev))
    await expect(rig.ed.toggleMode()).resolves.toBe(false)
    expect(events).toEqual([])
  })

  it('a whole-content container: toggleMode resolves false and emits nothing', async () => {
    const ed = new (withFakeSurfaces(PromptEditor))('prompt:p', { provider: wholeContentProvider() })
    ed.presentSurface('markdown', document.createElement('div'), 'x')
    const events = []
    ed.onEvent((ev) => events.push(ev))
    await expect(ed.toggleMode()).resolves.toBe(false)
    expect(events).toEqual([])
    ed.destroy()
  })

  it('reentrant toggleMode coalesces onto the in-flight flip and emits mode-changed ONCE', async () => {
    const rig = modeRig('markdown')
    let release
    rig.provider.setContents.mockReturnValue(new Promise((r) => { release = r }))
    const first = rig.ed.toggleMode()
    expect(rig.ed.toggleMode()).toBe(first)
    expect(rig.provider.setContents).toHaveBeenCalledTimes(1)
    release()
    await first
    expect(rig.events).toEqual([{ type: 'mode-changed', mode: 'wysiwyg' }])
  })
})

describe('AbstractEditor.toggleAiBlocks (P2.C)', () => {
  function rigWithRoot() {
    const ed = new FakeSurfaceEditor('u')
    const root = document.createElement('div')
    ed.presentSurface('markdown', root, 'x')
    return { ed, root }
  }

  it('starts showing AI blocks — no class before any toggle', () => {
    const { root } = rigWithRoot()
    expect(root.classList.contains('hide-ai-blocks')).toBe(false)
  })

  it('first toggle hides: adds hide-ai-blocks to the editor root and returns false', () => {
    const { ed, root } = rigWithRoot()
    expect(ed.toggleAiBlocks()).toBe(false)
    expect(root.classList.contains('hide-ai-blocks')).toBe(true)
  })

  it('second toggle shows again: class removed, returns true', () => {
    const { ed, root } = rigWithRoot()
    ed.toggleAiBlocks()
    expect(ed.toggleAiBlocks()).toBe(true)
    expect(root.classList.contains('hide-ai-blocks')).toBe(false)
  })

  it('without a mounted root it flips state without throwing', () => {
    const ed = new AbstractEditor('u')
    expect(() => ed.toggleAiBlocks()).not.toThrow()
  })

  it('state is per-editor: toggling one editor does not touch another root', () => {
    const a = rigWithRoot()
    const b = rigWithRoot()
    a.ed.toggleAiBlocks()
    expect(a.root.classList.contains('hide-ai-blocks')).toBe(true)
    expect(b.root.classList.contains('hide-ai-blocks')).toBe(false)
  })

  it('presentSurface clears a stale hide-ai-blocks class a previous editor left on the mount root (P2.C.2)', () => {
    const root = document.createElement('div')
    root.classList.add('hide-ai-blocks') // stale — THIS editor never toggled
    const ed = new FakeSurfaceEditor('u')
    ed.presentSurface('markdown', root, 'x')
    expect(root.classList.contains('hide-ai-blocks')).toBe(false)
  })

  it('presentSurface KEEPS hide-ai-blocks for an editor that toggled hidden (remount is state-driven, not a blind clear)', () => {
    const root = document.createElement('div')
    const ed = new FakeSurfaceEditor('u')
    ed.presentSurface('markdown', root, 'x')
    ed.toggleAiBlocks() // hide
    expect(root.classList.contains('hide-ai-blocks')).toBe(true)
    ed.presentSurface('markdown', root, 'x') // remount (flip-path parity)
    expect(root.classList.contains('hide-ai-blocks')).toBe(true)
  })
})

// ── AbstractEditor.createBlock — the ONE create path, said in BLOCK IDS ─────────
// A lens never computes a document position. What it has is a caret or a drop
// coordinate; what the wall accepts is an ANCHOR, and the anchor vocabulary is
// three-valued: `undefined` = "no anchor, append", `null` = "the front", an id =
// "after that one". Turning an id into a position is the host's arithmetic
// against its own follower model.
describe('AbstractEditor.createBlock (block-id-anchored; the host resolves the position)', () => {
  beforeEach(() => {
    vi.mocked(blockInsertPos).mockClear().mockImplementation(() => 42)
    vi.mocked(blockIndexForInsert).mockClear().mockReturnValue(3)
    vi.mocked(emptyParagraphAnchor).mockClear().mockReturnValue(null)
  })

  /** A wysiwyg lens whose fake editorPane carries a doc of id-bearing children. */
  function wysiwygEd(ids = ['b0', 'b1', 'b2', 'b3', 'b4']) {
    const rig = noteRig('u')
    rig.ed.presentSurface('wysiwyg', document.createElement('div'), null)
    const children = ids.map((id) => ({ attrs: { id } }))
    rig.ed.surface.editorPaneValue = {
      state: { doc: { childCount: children.length, child: (i) => children[i] } },
    }
    return rig
  }

  it('no anchor → DERIVES one from the caret, and states it as an id', () => {
    // blockIndexForInsert is mocked to 3, so the new block follows the child at
    // index 2 — the anchor the caret named, never the index itself.
    const rig = wysiwygEd()
    rig.ed.createBlock('code', {})
    expect(rig.provider.requestAddBlock).toHaveBeenCalledWith('code', {}, 'b2')
  })

  it('defaults attrs to {} when omitted', () => {
    const rig = wysiwygEd()
    rig.ed.createBlock('code')
    expect(rig.provider.requestAddBlock).toHaveBeenCalledWith('code', {}, expect.anything())
  })

  it('an EXPLICIT anchor is passed through untouched — no caret is read', () => {
    const rig = wysiwygEd()
    rig.ed.createBlock('code', {}, 'b7')
    expect(rig.provider.requestAddBlock).toHaveBeenCalledWith('code', {}, 'b7')
    expect(blockIndexForInsert).not.toHaveBeenCalled()
  })

  it('null means the FRONT of the container — a real place, not "wherever"', () => {
    const rig = wysiwygEd()
    rig.ed.createBlock('code', {}, null)
    expect(rig.provider.requestAddBlock).toHaveBeenCalledWith('code', {}, null)
  })

  it('walks BACK past a node with no id — the trailing surface cannot anchor anything', () => {
    const rig = wysiwygEd()
    rig.ed.surface.editorPaneValue.state.doc.child = (i) => (i === 2 ? { attrs: {} } : { attrs: { id: 'b' + i } })
    rig.ed.createBlock('code', {})
    expect(rig.provider.requestAddBlock).toHaveBeenCalledWith('code', {}, 'b1')
  })

  it('diagram with no source defaults attrs.mode to edit', () => {
    const rig = wysiwygEd()
    rig.ed.createBlock('diagram')
    expect(rig.provider.requestAddBlock).toHaveBeenCalledWith('diagram', { mode: 'edit' }, expect.anything())
  })

  it('diagram WITH a source keeps its attrs (no mode override)', () => {
    const rig = wysiwygEd()
    rig.ed.createBlock('diagram', { source: 'graph TD' })
    expect(rig.provider.requestAddBlock).toHaveBeenCalledWith('diagram', { source: 'graph TD' }, expect.anything())
  })

  it('markdown mode has no caret to read, so a dialog insert APPENDS', () => {
    const rig = noteRig('u')
    rig.ed.presentSurface('markdown', document.createElement('div'), 'body')
    expect(() => rig.ed.createBlock('smart-card', { href: 'https://x' })).not.toThrow()
    expect(rig.provider.requestAddBlock).toHaveBeenCalledWith('smart-card', { href: 'https://x' }, undefined)
  })

  it('a container with no block extension gets no verb at all', () => {
    const provider = wholeContentProvider()
    const ed = makeNote('u', { provider })
    expect(() => ed.createBlock('code', {})).not.toThrow()
    ed.destroy()
  })
})

// ── AbstractEditor.askAi — the SINGLE AI-job seam, PURE over context ────────────
// ONE method for both ask and explain (they differ only by type + whether a
// question exists). It is a pure operator over the SelectionContext the caller
// PASSES — the context the panel LAST RENDERED, i.e. the label the user saw.
// buildAiContext (ref), the == highlight (context.target.range) and the ANCHOR
// (context.blockIds) all derive from that context, NEVER a live re-read: a live
// read would race the label (panel shows target C1, editor acts on drifted C2).

describe('AbstractEditor.askAi (the single AI-job seam, pure over context)', () => {
  // A wysiwyg lens with a scripted selection descriptor + a fake editorPane
  // carrying the handles askAi touches (state/view/commands). buildAiContext +
  // applyTargetHighlight are module-mocked (top of file).
  function seamRig(mode = 'wysiwyg', target = { kind: 'block', ref: 'co-9', label: 'Code Block' }) {
    const rig = noteRig('u')
    const ed = rig.ed
    ed.presentSurface(mode, document.createElement('div'), mode === 'markdown' ? 'md body' : null)
    if (mode === 'wysiwyg') ed.surface.editorPaneValue = {
      state: { doc: { textContent: 'doc text', childCount: 3, child: (i) => ({ attrs: { id: 'b' + i } }) }, selection: { to: 5 } },
      view: {},
      commands: { focus: vi.fn(), setTextSelection: vi.fn() },
      isActive: () => false,
    }
    // Seed a resolved AI target + block ids into the SelectionModel via the descriptor.
    ed.surface.feedDescriptor = {
      selectionType: 'block', blockId: 'b1', blockIds: ['b1'], blockKind: 'code',
      caret: 1, range: { from: 1, to: 3 }, target,
    }
    ed.onSurfaceEvent({ type: 'selection-changed' })
    return Object.assign(rig, { ed })
  }

  beforeEach(() => {
    vi.mocked(buildAiContext).mockClear()
    vi.mocked(applyTargetHighlight).mockClear()
  })

  it('anchors the answer after the context target\'s BLOCK, flushes first, then creates', async () => {
    const rig = seamRig('wysiwyg', { kind: 'block', ref: 'co-9', label: 'Code Block' })
    const flushSave = vi.spyOn(rig.ed, 'flushSave')
    const createBlock = vi.spyOn(rig.ed, 'createBlock')
    await rig.ed.askAi({ type: 'ask', question: 'why?' })
    // The anchor is the context's stable BLOCK ID — no live caret read, and no
    // position: turning that id into one is the host's, through the verb.
    expect(createBlock).toHaveBeenCalledWith('ai-block', { type: 'ASK', ref: 'co-9', question: 'why?' }, 'b1')
    expect(rig.provider.requestAddBlock).toHaveBeenCalledWith('ai-block', { type: 'ASK', ref: 'co-9', question: 'why?' }, 'b1')
    expect(flushSave).toHaveBeenCalled()                  // flush BEFORE create
    expect(flushSave.mock.invocationCallOrder[0]).toBeLessThan(createBlock.mock.invocationCallOrder[0])
  })

  it('no context block id → no anchor; createBlock derives one from the caret', async () => {
    const rig = seamRig('wysiwyg', { kind: 'document', ref: '', label: 'Document' })
    const createBlock = vi.spyOn(rig.ed, 'createBlock').mockImplementation(() => {})
    await rig.ed.askAi({ type: 'ask', question: 'q', context: { blockIds: [], target: { kind: 'document', ref: '', label: 'Document' } } })
    expect(createBlock.mock.calls[0][2]).toBeUndefined()
  })

  it('PURITY: acts on the PASSED context, NEVER the editor live selection (anti-race)', async () => {
    // Live selection resolves to co-live / block b1 …
    const rig = seamRig('wysiwyg', { kind: 'block', ref: 'co-live', label: 'Live' })
    // … but the caller passes a DIFFERENT context — what the panel actually rendered.
    const passed = {
      blockIds: ['bPanel'], blockId: 'bPanel', caret: 2,
      target: { kind: 'block', ref: 'co-panel', range: { from: 2, to: 4 }, label: 'Panel' },
    }
    await rig.ed.askAi({ type: 'ask', question: 'q', context: passed })
    expect(buildAiContext).toHaveBeenCalledWith(passed)
    const [, attrs, anchor] = rig.provider.requestAddBlock.mock.calls[0]
    expect(attrs.ref).toBe('co-panel')  // the panel's ref, not the live co-live
    expect(anchor).toBe('bPanel')       // the panel's anchor, not the live b1
  })

  it('selection target: highlights the CONTEXT target range (not the live selection)', async () => {
    const rig = seamRig('wysiwyg')
    const passed = {
      blockIds: ['b1'], blockId: 'b1', caret: 3,
      target: { kind: 'selection', ref: 'pr-1', range: { from: 5, to: 9 }, label: 'Paragraph' },
    }
    await rig.ed.askAi({ type: 'ask', question: 'q', context: passed })
    expect(applyTargetHighlight).toHaveBeenCalledWith(rig.ed.surface.editorPaneValue, { from: 5, to: 9 })
  })

  it('block target carries no == extent → no highlight', async () => {
    const rig = seamRig('wysiwyg', { kind: 'block', ref: 'co-9', label: 'Code Block' })
    await rig.ed.askAi({ type: 'ask', question: 'q' })
    expect(applyTargetHighlight).not.toHaveBeenCalled()
  })

  it('explain: type is EXPLAIN and the question defaults to empty', async () => {
    const rig = seamRig('wysiwyg', { kind: 'block', ref: 'pr-1', label: 'Paragraph' })
    await rig.ed.askAi({ type: 'explain', context: rig.ed.getSelectionContext() })
    expect(rig.provider.requestAddBlock).toHaveBeenCalledWith('ai-block', { type: 'EXPLAIN', ref: 'pr-1', question: '' }, 'b1')
  })

  it('explain in markdown mode is a NO-OP (no inline target to explain)', async () => {
    const rig = seamRig('markdown', { kind: 'document', ref: '', label: 'Document' })
    await rig.ed.askAi({ type: 'explain', context: rig.ed.getSelectionContext() })
    expect(rig.provider.requestAddBlock).not.toHaveBeenCalled()
  })

  it('ask in markdown mode still asks — no block ids there, so the answer appends', async () => {
    const rig = seamRig('markdown', { kind: 'document', ref: '', label: 'Document' })
    await rig.ed.askAi({ type: 'ask', question: 'q', context: { blockIds: [], blockId: null, target: { kind: 'document', ref: '', label: 'Document' } } })
    expect(rig.provider.requestAddBlock).toHaveBeenCalledWith('ai-block', { type: 'ASK', ref: 'doc', question: 'q' }, undefined)
  })

  it('falls back to a "doc" ref when buildAiContext yields no blockRef', async () => {
    const rig = seamRig('wysiwyg', { kind: 'document', ref: '', label: 'Document' })
    vi.mocked(buildAiContext).mockReturnValueOnce({})   // no blockRef
    await rig.ed.askAi({ type: 'ask', question: 'q' })
    expect(rig.provider.requestAddBlock.mock.calls[0][1].ref).toBe('doc')
  })

  it('an attachment manifest rides as a plain attr; absent IS the empty case', async () => {
    const rig = seamRig('wysiwyg', { kind: 'block', ref: 'co-9', label: 'Code Block' })
    await rig.ed.askAi({ type: 'ask', question: 'q', attachments: [{ uri: 'container:x', title: 'X' }] })
    expect(rig.provider.requestAddBlock.mock.calls[0][1].attachments).toEqual([{ uri: 'container:x', title: 'X' }])
    rig.provider.requestAddBlock.mockClear()
    await rig.ed.askAi({ type: 'ask', question: 'q', attachments: [] })
    expect(rig.provider.requestAddBlock.mock.calls[0][1]).not.toHaveProperty('attachments')
  })
})

// ── The insert ANCHOR family: where a new block goes, said in block ids ────────
// A lens never computes a document position for Go. What it knows is WHICH BLOCK
// the new one should follow, and the host turns that into a position against its
// own follower model. Everything here is the translation between the two things
// the lens genuinely has — a caret, or a drop coordinate — and the one thing the
// wall accepts: an anchor id.
//
// The vocabulary is three-valued, and the three values are different statements:
// `undefined` = "no anchor, append"; `null` = "the front"; an id = "after that one".

// A recording fake editorPane: a doc of id-bearing children, a fresh `tr` per read
// whose delete records (from,to) and whose meta stays whatever the code sets it to,
// and a view that records dispatched trs.
function fakeAnchorPane(children) {
  const dispatched = []
  const makeTr = () => {
    const meta = {}
    return {
      deletedRange: null,
      delete(from, to) { this.deletedRange = { from, to }; return this },
      setMeta(k, v) { meta[k] = v; return this },
      getMeta(k) { return meta[k] },
    }
  }
  let currentTr = makeTr()
  const doc = {
    childCount: children.length,
    child(i) { return children[i] },
    forEach(fn) { let off = 0; children.forEach((n, i) => { fn(n, off, i); off += n.nodeSize }) },
  }
  return { dispatched, state: { doc, get tr() { currentTr = makeTr(); return currentTr } }, view: { dispatch(tr) { dispatched.push(tr) } } }
}

/** A top-level prose node: its id, its text (emptiness) and its nodeSize. */
function pnode({ id = '', text = '', size = 2 } = {}) {
  return { attrs: { id }, textContent: text, nodeSize: size, type: { name: 'paragraph' } }
}

// A minimal surface exposing an injected editorPane + a flushPending recorder, so
// an AbstractEditor's anchor methods have a live `this.editorPane` / `this.surface`.
class AnchorSurface extends AbstractSurface {
  constructor(editorPane) { super(); this._tt = editorPane; this.flushCount = 0 }
  get mode() { return 'wysiwyg' }
  get editorPane() { return this.mounted ? this._tt : null }
  mount() { this.mounted = true }
  unmount() { this.mounted = false }
  applyContainerChange() {}
  flushPending() { this.flushCount++ }
  feedSelection() { return null }
}

class AnchorEditor extends AbstractEditor {
  constructor(uuid, editorPane, options) { super(uuid, options); this._tt = editorPane }
  _createSurface() { return new AnchorSurface(this._tt) }
}

function anchorEditor(children = [pnode({ id: 'a', text: 'a' }), pnode({ id: 'b', text: 'b' })]) {
  const pane = fakeAnchorPane(children)
  const ed = new AnchorEditor('u', pane, { provider: fakeProvider() })
  ed.presentSurface('wysiwyg', document.createElement('div'), null)
  return { ed, pane }
}

describe('AbstractEditor insert anchors — the caret becomes a block id', () => {
  beforeEach(() => {
    vi.mocked(blockInsertPos).mockImplementation(() => 42)
    vi.mocked(blockIndexForInsert).mockReturnValue(2)
    vi.mocked(emptyParagraphAnchor).mockReturnValue(null)
  })

  it('captureInsertPos delegates to the blockInsertPos helper (block placement)', () => {
    const { ed } = anchorEditor()
    expect(ed.captureInsertPos()).toBe(42)
    expect(blockInsertPos).toHaveBeenCalledWith(expect.anything())
  })

  it('with NO empty-paragraph anchor: the id of the block the caret follows, no dispatch', () => {
    const { ed, pane } = anchorEditor()
    expect(ed.insertAnchorForBlock()).toBe('b') // index 2 → the child before it
    expect(pane.dispatched).toEqual([])
  })

  it('index 0 is NULL — the front of the container, not "wherever"', () => {
    const { ed } = anchorEditor()
    vi.mocked(blockIndexForInsert).mockReturnValue(0)
    expect(ed.insertAnchorForBlock()).toBeNull()
  })

  it('an empty-paragraph anchor is CONSUMED as a PLAIN TRACKED delete, and the new block takes its slot', () => {
    const { ed, pane } = anchorEditor([pnode({ id: 'a', text: 'a' }), pnode({ id: 'blank' }), pnode({ id: 'c', text: 'c' })])
    vi.mocked(emptyParagraphAnchor).mockReturnValue({ from: 2, to: 4, index: 1 })
    expect(ed.insertAnchorForBlock()).toBe('a') // the block before the freed slot
    expect(pane.dispatched).toHaveLength(1)
    expect(pane.dispatched[0].deletedRange).toEqual({ from: 2, to: 4 })
    // THE UNDO GUARD: the empty-paragraph delete is an ORDINARY tracked prose
    // edit — never addToHistory:false, never a reload.
    expect(pane.dispatched[0].getMeta('addToHistory')).toBeUndefined()
    expect(ed.surface.flushCount).toBe(1)
  })

  it('a sole-block doc keeps its paragraph (deleting the only child is schema-invalid)', () => {
    const { ed, pane } = anchorEditor([pnode({ id: 'only' })])
    vi.mocked(emptyParagraphAnchor).mockReturnValue({ from: 0, to: 2, index: 0 })
    expect(ed.insertAnchorForBlock()).toBeNull() // index 0 → the front
    expect(pane.dispatched).toEqual([])
  })

  it('insertAnchorAt(pos) commits an EXPLICIT position — the drop-coordinate path', () => {
    const { ed } = anchorEditor()
    expect(ed.insertAnchorAt(99)).toBe('b')
    expect(blockIndexForInsert).toHaveBeenCalledWith(expect.anything(), 99)
  })

  it('captureImageInsert anchors WITHOUT consuming — a cancelled upload must leave the blank line', () => {
    const { ed, pane } = anchorEditor()
    expect(ed.captureImageInsert()).toBe('b')
    expect(pane.dispatched).toEqual([])
  })

  it('with no mounted surface every anchor is "append", and nothing throws', () => {
    const ed = new AnchorEditor('u', fakeAnchorPane([]), { provider: fakeProvider() })
    expect(ed.insertAnchorForBlock()).toBeUndefined()
    expect(ed.insertAnchorAt(1)).toBeUndefined()
    expect(ed.captureImageInsert()).toBeUndefined()
    expect(ed.captureInsertPos()).toBeNull()
  })
})

// ── issue #33: deferred empty-paragraph consumption (peek / consume split) ──────
// The paste/drop path must NOT eat the caret's blank line before the server
// confirms a block match. The dialog/createBlock path consumes EAGERLY — correct
// there, because that call point IS the confirmation. But a smart-paste commits
// before knowing the outcome: on no-match PM remaps the now-orphaned caret into
// the adjacent code:true block and the fallback insertContent() prepends the text
// there. peekInsertAnchor is the SIDE-EFFECT-FREE half (anchor + a HANDLE);
// consumeInsertAnchor defers the delete to the `block` outcome, locating the
// paragraph BY ID — never by a captured position, which an arrival can shift.
//
// The paragraph being held open is a PLACEHOLDER, not an identity. That is why it
// stayed its own mechanism when block identity stopped needing one.
describe('AbstractEditor deferred anchor consume (issue #33)', () => {
  beforeEach(() => {
    vi.mocked(blockInsertPos).mockImplementation(() => 42)
    vi.mocked(blockIndexForInsert).mockReturnValue(2)
    vi.mocked(emptyParagraphAnchor).mockReturnValue(null)
  })

  it('peek with NO anchor → the plain anchor id, NO dispatch (side-effect-free)', () => {
    const { ed, pane } = anchorEditor()
    const peek = ed.peekInsertAnchorForBlock()
    expect(peek.afterBlockId).toBe('b')
    expect(peek.anchor).toBeNull()
    expect(pane.dispatched).toEqual([]) // THE FIX: no eager delete at peek
  })

  it('peek with an empty-paragraph anchor → the freed slot plus a HANDLE, NO dispatch', () => {
    const { ed, pane } = anchorEditor([pnode({ id: 'a', text: 'a' }), pnode({ id: 'p-1' }), pnode({ id: 'c', text: 'code', size: 4 })])
    vi.mocked(emptyParagraphAnchor).mockReturnValue({ from: 2, to: 4, index: 1 })
    const peek = ed.peekInsertAnchorForBlock()
    expect(peek.afterBlockId).toBe('a')
    expect(peek.anchor).toEqual({ id: 'p-1' })
    expect(pane.dispatched).toEqual([]) // deferred — nothing deleted yet
  })

  it('peek on a sole-block doc yields NO handle (the blank line is kept)', () => {
    const { ed } = anchorEditor([pnode({ id: 'p-1' })])
    vi.mocked(emptyParagraphAnchor).mockReturnValue({ from: 0, to: 2, index: 0 })
    const peek = ed.peekInsertAnchorForBlock()
    expect(peek.afterBlockId).toBeNull()
    expect(peek.anchor).toBeNull()
  })

  it('consume deletes the paragraph located BY ID as a PLAIN TRACKED edit + flushPending', () => {
    const { ed, pane } = anchorEditor([pnode({ id: 'a', text: 'a' }), pnode({ id: 'p-1' }), pnode({ id: 'c', text: 'code', size: 4 })])
    ed.consumeInsertAnchor({ id: 'p-1' })
    expect(pane.dispatched).toHaveLength(1)
    expect(pane.dispatched[0].deletedRange).toEqual({ from: 2, to: 4 }) // child[1] follows child[0] (size 2)
    expect(pane.dispatched[0].getMeta('addToHistory')).toBeUndefined()  // undo sanctity
    expect(ed.surface.flushCount).toBe(1)
  })

  it('consume is a no-op when the handle is null (the no-match / error path)', () => {
    const { ed, pane } = anchorEditor([pnode({ id: 'p-1' }), pnode({ id: 'c', text: 'code', size: 4 })])
    ed.consumeInsertAnchor(null)
    expect(pane.dispatched).toEqual([])
  })

  it('consume is a no-op when the id is not found', () => {
    const { ed, pane } = anchorEditor([pnode({ id: 'other' }), pnode({ id: 'c', text: 'code', size: 4 })])
    ed.consumeInsertAnchor({ id: 'p-1' })
    expect(pane.dispatched).toEqual([])
  })

  it('consume never deletes the doc sole child', () => {
    const { ed, pane } = anchorEditor([pnode({ id: 'p-1' })])
    ed.consumeInsertAnchor({ id: 'p-1' })
    expect(pane.dispatched).toEqual([])
  })

  it('consume skips a paragraph that is no longer empty (typed into before the answer came)', () => {
    const { ed, pane } = anchorEditor([pnode({ id: 'a', text: 'a' }), pnode({ id: 'p-1', text: 'typed' }), pnode({ id: 'c', text: 'code', size: 4 })])
    ed.consumeInsertAnchor({ id: 'p-1' })
    expect(pane.dispatched).toEqual([])
  })
})

// ── The whole-container reload ─────────────────────────────────────────────────
// ONLY for genuine LOADS (an AI whole-document answer, a restore) — never for an
// ordinary change, which arrives as a cue and is placed as a tracked transaction.
// A whole repaint is addToHistory:false by construction and so WIPES UNDO HISTORY.
describe('AbstractEditor.reload — the host loads, the lens repaints once', () => {
  class ReloadSurface extends AbstractSurface {
    constructor(mode) { super(); this._mode = mode; this.painted = null; this.replaced = null }
    get mode() { return this._mode }
    get editorPane() { return this._mode === 'wysiwyg' ? { fake: true } : null }
    get body() { return this._mode === 'markdown' ? 'md' : null }
    mount() { this.mounted = true }
    unmount() { this.mounted = false }
    applyContainerChange() {}
    flushPending() {}
    feedSelection() { return null }
    paintContainer(provider) { this.painted = provider }
    replaceBody(body) { this.replaced = body }
  }
  class ReloadEditor extends AbstractEditor {
    _createSurface(mode) { return new ReloadSurface(mode) }
  }

  function reloadRig(mode, data = { body: 'fresh markdown', version: 9 }) {
    const provider = fakeProvider()
    const loadContainer = vi.fn(() => Promise.resolve(data))
    const ed = new ReloadEditor('u', { provider, loadContainer })
    ed.presentSurface(mode, document.createElement('div'), mode === 'markdown' ? 'seed' : null)
    return { ed, provider, loadContainer }
  }

  it('wysiwyg: repaints from the MODEL the load reseeded — one source for load and cue alike', async () => {
    const rig = reloadRig('wysiwyg')
    await rig.ed.reload()
    expect(rig.loadContainer).toHaveBeenCalledTimes(1)
    // Not the load's payload: the blocks went into the follower model, and the
    // repaint reads it through the same provider every cue uses.
    expect(rig.ed.surface.painted).toBe(rig.provider)
    expect(rig.ed.isSaveSuppressed()).toBe(false)
  })

  it('markdown: replaces the buffer with the body the HOST loaded', async () => {
    const rig = reloadRig('markdown')
    await rig.ed.reload()
    expect(rig.ed.surface.replaced).toBe('fresh markdown')
    expect(rig.ed.isSaveSuppressed()).toBe(false)
  })

  it('the load\'s version becomes the editor\'s baseline', async () => {
    const rig = reloadRig('markdown')
    const seed = vi.spyOn(rig.ed, 'seedVersion')
    await rig.ed.reload()
    expect(seed).toHaveBeenCalledWith(9)
  })

  it('saves are suppressed mid-flight, and released after', async () => {
    let release
    const provider = fakeProvider()
    const ed = new ReloadEditor('u', { provider, loadContainer: () => new Promise((r) => { release = r }) })
    ed.presentSurface('wysiwyg', document.createElement('div'), null)
    const reloading = ed.reload()
    expect(ed.isSaveSuppressed()).toBe(true)
    release({ body: '', version: 1 })
    await reloading
    expect(ed.isSaveSuppressed()).toBe(false)
  })

  it('a lens with no loader cannot reload, and says so by doing nothing', async () => {
    const provider = fakeProvider()
    const ed = new ReloadEditor('u', { provider })
    ed.presentSurface('wysiwyg', document.createElement('div'), null)
    await ed.reload()
    expect(ed.surface.painted).toBeNull()
    expect(ed.isSaveSuppressed()).toBe(false)
  })

  it('a failed load releases the suppression rather than freezing the editor', async () => {
    const provider = fakeProvider()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ed = new ReloadEditor('u', { provider, loadContainer: () => Promise.reject(new Error('gone')) })
    ed.presentSurface('markdown', document.createElement('div'), 'seed')
    await ed.reload()
    expect(ed.isSaveSuppressed()).toBe(false)
    err.mockRestore()
  })
})

describe('SieveWorkspace chrome delegation (P2.C transitional; P4.C/P4.D dissolved)', () => {
  // P4.C moved the search overlay + the two insert dialogs OUT of the provideChrome
  // registry into Workspace-owned children (SearchOverlay / InsertDialogs, built by
  // bootChrome). P4.D retired the registry ENTIRELY: copyDocumentAsMarkdown now
  // delegates DIRECTLY to the active editor's copyAsMarkdown (the editor owns the
  // export). provideChrome / #chromeCall / WorkspaceChrome are GONE. These tests pin
  // the post-P4.D contract.

  it('the provideChrome registry is GONE (no method on the Workspace)', () => {
    const w = new SieveWorkspace()
    expect(w.provideChrome).toBeUndefined()
  })

  it('copyDocumentAsMarkdown null-guards a tab with no mount (no throw)', () => {
    const w = new SieveWorkspace()
    w.openTab('doc-1')
    expect(() => w.copyDocumentAsMarkdown()).not.toThrow()
    expect(() => new SieveWorkspace().copyDocumentAsMarkdown()).not.toThrow()
  })

  it('the search + insert-dialog verbs delegate to the Workspace children, NOT #chromeCall', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const w = new SieveWorkspace()
      w.bootChrome()
      const search = w.searchOverlay
      const dialogs = w.insertDialogs
      expect(search).toBeTruthy()
      expect(dialogs).toBeTruthy()
      const toggle = vi.spyOn(search, 'toggle').mockImplementation(() => {})
      const clip = vi.spyOn(dialogs, 'openWebClip').mockImplementation(() => {})
      const card = vi.spyOn(dialogs, 'openUrlCard').mockImplementation(() => {})

      w.toggleSearch()
      w.openWebClipDialog('https://a.example')
      w.openUrlCardDialog('https://b.example')

      expect(toggle).toHaveBeenCalledTimes(1)
      expect(clip).toHaveBeenCalledWith('https://a.example')
      expect(card).toHaveBeenCalledWith('https://b.example')
      // These verbs never hit the provideChrome registry → no unregistered-chrome warn.
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('the search + insert-dialog verbs null-guard safely before bootChrome', () => {
    const w = new SieveWorkspace()
    // No bootChrome() → children are null; verbs must no-op, not throw.
    expect(() => { w.toggleSearch(); w.openWebClipDialog(); w.openUrlCardDialog() }).not.toThrow()
  })
})

// ── Copy as Markdown is a HOST verb ────────────────────────────────────────────
// The menu acts on the workspace, and the filtering the export applies (ai-blocks
// dropped, cards and clips reduced to links) is Go's, not any lens's projection —
// so it goes through the MOUNT, not through the wall.

describe('SieveWorkspace.copyDocumentAsMarkdown', () => {
  let prevRuntime, prevClip
  beforeEach(() => { prevRuntime = window.runtime; prevClip = navigator.clipboard })
  afterEach(() => {
    window.runtime = prevRuntime
    if (prevClip !== undefined) Object.defineProperty(navigator, 'clipboard', { value: prevClip, configurable: true })
  })

  /** A workspace with one open tab whose mount answers a scripted export. */
  function exporting(md) {
    const w = new SieveWorkspace()
    const tab = w.openTab('doc-9')
    const mount = hostMount('doc-9')
    vi.spyOn(mount, 'exportAs').mockResolvedValue(md)
    tab.attachMount(mount)
    return { w, mount }
  }

  it('flushes first, then writes the SERVER\'s export to the Wails pasteboard (primary)', async () => {
    const setText = vi.fn(() => Promise.resolve())
    window.runtime = { ClipboardSetText: setText }
    const { w, mount } = exporting('# clean export')
    const flush = vi.spyOn(w, 'flushSave')
    await w.copyDocumentAsMarkdown()
    // The flush is what makes the export include what the user has just typed.
    expect(flush).toHaveBeenCalled()
    expect(mount.exportAs).toHaveBeenCalledWith('markdown')
    expect(setText).toHaveBeenCalledWith('# clean export')
  })

  it('falls back to navigator.clipboard when there is no Wails runtime', async () => {
    window.runtime = undefined
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { w } = exporting('body')
    await w.copyDocumentAsMarkdown()
    expect(writeText).toHaveBeenCalledWith('body')
  })

  it('a container with nothing to export copies nothing', async () => {
    const setText = vi.fn(() => Promise.resolve())
    window.runtime = { ClipboardSetText: setText }
    const { w } = exporting(null)
    await w.copyDocumentAsMarkdown()
    expect(setText).not.toHaveBeenCalled()
  })

  it('no mount, nothing to copy — and no lens ever had this verb', async () => {
    const setText = vi.fn(() => Promise.resolve())
    window.runtime = { ClipboardSetText: setText }
    const w = new SieveWorkspace()
    await w.copyDocumentAsMarkdown()
    expect(setText).not.toHaveBeenCalled()
    expect(typeof (/** @type {any} */ (makeNote('n'))).copyAsMarkdown).not.toBe('function')
  })
})

describe('AbstractEditor stats producer (P4.D)', () => {
  it('presentSurface emits an initial stats event on the stream', () => {
    const ed = new FakeSurfaceEditor('u')
    const events = []
    ed.onEvent((ev) => events.push(ev))
    ed.presentSurface('markdown', document.createElement('div'), 'hello\nworld')
    const stats = events.find((e) => e.type === 'stats')
    expect(stats).toBeTruthy()
    // markdown surface body drives #docText → 'the body' (FakeSurface.bodyValue).
    expect(typeof stats.chars).toBe('number')
    expect(typeof stats.lines).toBe('number')
  })

  it('a doc-changed surface event emits a follow-up stats event', () => {
    const ed = new FakeSurfaceEditor('u')
    ed.presentSurface('markdown', document.createElement('div'), 'x')
    const events = []
    ed.onEvent((ev) => events.push(ev.type))
    ed.onSurfaceEvent({ type: 'doc-changed' })
    expect(events).toContain('doc-changed')
    expect(events).toContain('stats')
  })
})

// ── P4.D: NoteEditor owns the toolbar (mount on present, destroy on teardown) ─────

describe('NoteEditor toolbar ownership (P4.D)', () => {
  // A fake toolbar recording mount/refresh/destroy calls (injected via options).
  function fakeToolbar() {
    return { _mounted: false, mount: vi.fn(function () { this._mounted = true }), get mounted() { return this._mounted },
      refreshSurfaceSection: vi.fn(), destroy: vi.fn() }
  }

  it('mounts the toolbar on the FIRST present; re-renders its surface section on the next', () => {
    const tb = fakeToolbar()
    const ed = new (withFakeSurfaces(NoteEditor))('n', {
      provider: fakeProvider(), toolbar: tb,
    })
    ed.presentSurface('wysiwyg', document.createElement('div'), null)
    expect(tb.mount).toHaveBeenCalledTimes(1)
    expect(tb.refreshSurfaceSection).not.toHaveBeenCalled()
    // Second present (same-uuid re-init) → re-render the surface section, no re-mount.
    ed.presentSurface('wysiwyg', document.createElement('div'), null)
    expect(tb.mount).toHaveBeenCalledTimes(1)
    expect(tb.refreshSurfaceSection).toHaveBeenCalledTimes(1)
  })

  it('destroy tears down the toolbar subscription', () => {
    const tb = fakeToolbar()
    const ed = new (withFakeSurfaces(NoteEditor))('n', {
      provider: fakeProvider(), toolbar: tb,
    })
    ed.presentSurface('markdown', document.createElement('div'), 'x')
    ed.destroy()
    expect(tb.destroy).toHaveBeenCalledTimes(1)
  })

  it('a null toolbar (injected) is a safe no-op through present + destroy', () => {
    const ed = new (withFakeSurfaces(NoteEditor))('n', {
      provider: fakeProvider(), toolbar: null,
    })
    expect(() => { ed.presentSurface('markdown', document.createElement('div'), 'x'); ed.destroy() }).not.toThrow()
  })
})

// ── P2.D: Workspace tab-lifecycle verbs (the external API facade) ─────────────
// open/newNote/reorder/loadTabs are thin owners over htmx.ajax (stubbed to record
// calls). close/closeAll/closeOthers funnel through #closeTabs: a JSON POST to
// /api/tabs/close applied with htmx.swap, pruning in the afterSettleCallback — so
// those tests stub fetch + htmx.swap and drive the settle to fire the prune.

describe('SieveWorkspace tab-lifecycle verbs (P2.D facade)', () => {
  let ws
  let ajaxCalls
  let fetchCalls
  let prevHtmx
  let prevFetch

  beforeEach(() => {
    ws = new SieveWorkspace({
      socketFactory: (url) => new FakeSocket(url),
      wsUrlFor: (u) => 'ws://test/api/ws/document/' + u,
    })
    ajaxCalls = []
    fetchCalls = []
    prevHtmx = window.htmx
    prevFetch = global.fetch
    window.htmx = {
      ajax: (method, url, opts) => {
        ajaxCalls.push({ method, url, opts })
        return Promise.resolve()
      },
      // close funnels through fetch(JSON) + htmx.swap; the prune runs in the
      // afterSettleCallback (AFTER the OOB editor mount), so drive it here.
      swap: (target, content, swapSpec, swapOptions) => {
        if (swapOptions && swapOptions.afterSettleCallback) swapOptions.afterSettleCallback()
      },
    }
    const fetchMock = (url, init) => {
      fetchCalls.push({ url, body: init && init.body })
      return Promise.resolve({ text: () => Promise.resolve('<div>tabbar</div>') })
    }
    global.fetch = fetchMock
    window.fetch = fetchMock
  })

  afterEach(() => { window.htmx = prevHtmx; global.fetch = prevFetch; document.body.innerHTML = '' })

  // The rendered tab strip — the AUTHORITATIVE list of open tabs that closeAll /
  // closeOthers enumerate (a session tab need not have a #tabs entry).
  function renderStrip(...ids) {
    document.body.innerHTML = '<div id="htmx-tabbar"><div id="tabs-area">' +
      ids.map((id) => `<div data-tab-id="${id}"></div>`).join('') + '</div></div>'
  }

  it('open posts to /api/note/open/{uuid} with the tabbar swap', () => {
    ws.open('doc-1')
    expect(ajaxCalls).toEqual([
      { method: 'POST', url: '/api/note/open/doc-1', opts: { target: '#htmx-tabbar', swap: 'innerHTML' } },
    ])
  })

  it('newNote posts to /api/note with the tabbar swap', () => {
    ws.newNote()
    expect(ajaxCalls).toEqual([
      { method: 'POST', url: '/api/note', opts: { target: '#htmx-tabbar', swap: 'innerHTML' } },
    ])
  })

  it('reorder posts to /api/tabs/reorder with from/to values', () => {
    ws.reorder(2, 0)
    expect(ajaxCalls).toEqual([
      { method: 'POST', url: '/api/tabs/reorder', opts: { target: '#htmx-tabbar', swap: 'innerHTML', values: { from: 2, to: 0 } } },
    ])
  })

  it('loadTabs GETs /ui/views/tabs into the tabbar', () => {
    ws.loadTabs()
    expect(ajaxCalls).toEqual([
      { method: 'GET', url: '/ui/views/tabs', opts: { target: '#htmx-tabbar', swap: 'innerHTML' } },
    ])
  })

  it('close POSTs the id SET to /api/tabs/close as JSON and prunes after the swap settles', async () => {
    ws.openTab('doc-a')
    ws.openTab('doc-b') // doc-b active
    await ws.close('doc-a') // background close
    expect(fetchCalls[0].url).toBe('/api/tabs/close')
    expect(JSON.parse(fetchCalls[0].body)).toEqual({ ids: ['doc-a'] })
    expect(ws.getTab('doc-a')).toBeNull()          // pruned
    expect(ws.activeTab?.uuid).toBe('doc-b')       // active untouched
  })

  it('closeOthers POSTs every OPEN id EXCEPT the kept one (from the rendered strip, not #tabs)', async () => {
    renderStrip('doc-a', 'doc-b', 'doc-c') // all three are open in the session…
    ws.openTab('doc-b')                    // …but only doc-b was ever JS-activated
    await ws.closeOthers('doc-b')
    expect(fetchCalls[0].url).toBe('/api/tabs/close')
    expect(JSON.parse(fetchCalls[0].body).ids.sort()).toEqual(['doc-a', 'doc-c'])
    expect(ws.getTab('doc-b')).not.toBeNull()      // the kept tab survives
  })

  it('close of the active tab prunes it without a stale entry (active already re-set by the swap re-init)', async () => {
    // Model the real flow: the swap+OOB re-init has already activated the successor
    // before the .then prune runs; here doc-a stays active (no successor) so the
    // prune nulls it. Either way close() leaves no leaked entry.
    ws.openTab('doc-a')
    await ws.close('doc-a')
    expect(ws.getTab('doc-a')).toBeNull()
    expect(ws.activeTab).toBeNull()
  })

  it('close leaks no editor: the pruned tab is the one whose editor was already destroyed', async () => {
    FakeSocket.reset()
    const opts = { onServerMessage: () => {} }
    const tabA = ws.activateDocument('doc-a', opts)
    FakeSocket.instances[0].driveOpen()
    // Successor activates (destroys A's editor, detaches it), THEN the prune runs.
    ws.activateDocument('doc-b', opts)
    expect(tabA.editor).toBeNull() // destroyed+detached by activateDocument
    await ws.close('doc-a')
    expect(ws.getTab('doc-a')).toBeNull()
    expect(ws.activeTab?.uuid).toBe('doc-b')
  })

  it('closeActiveTab closes the active tab; noop when none active', async () => {
    ws.closeActiveTab() // no active tab
    expect(fetchCalls).toEqual([])
    ws.openTab('doc-x')
    await ws.closeActiveTab()
    expect(fetchCalls[0].url).toBe('/api/tabs/close')
    expect(JSON.parse(fetchCalls[0].body)).toEqual({ ids: ['doc-x'] })
  })

  it('closeAll POSTs every OPEN tab id (from the rendered strip, not #tabs) and prunes them', async () => {
    renderStrip('doc-a', 'doc-b', 'doc-c') // three open in the session
    ws.openTab('doc-b')                    // only one JS-activated — strip is the source of truth
    await ws.closeAll()
    expect(fetchCalls[0].url).toBe('/api/tabs/close')
    expect(JSON.parse(fetchCalls[0].body).ids.sort()).toEqual(['doc-a', 'doc-b', 'doc-c'])
    expect(ws.getTab('doc-b')).toBeNull()  // the JS-activated one is pruned
  })

  it('every verb returns a promise', () => {
    expect(ws.open('d')).toBeInstanceOf(Promise)
    expect(ws.newNote()).toBeInstanceOf(Promise)
    expect(ws.reorder(0, 1)).toBeInstanceOf(Promise)
    expect(ws.loadTabs()).toBeInstanceOf(Promise)
    expect(ws.close('d')).toBeInstanceOf(Promise)
    expect(ws.closeAll()).toBeInstanceOf(Promise)
    expect(ws.closeOthers('d')).toBeInstanceOf(Promise)
  })

  it('verbs guard on window.htmx (no throw when htmx is absent)', () => {
    window.htmx = undefined
    expect(() => ws.open('d')).not.toThrow()
    expect(() => ws.newNote()).not.toThrow()
    expect(() => ws.close('d')).not.toThrow()
    expect(() => ws.closeAll()).not.toThrow()
    expect(() => ws.reorder(0, 1)).not.toThrow()
    expect(() => ws.loadTabs()).not.toThrow()
  })
})
