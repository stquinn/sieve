// shell.test.js — unit tests for the Workspace/Tab/Editor shell (P1 + P2.A + P2.B).
// Imports the REAL classes from src/static/shell/*.js (dual-use ES modules —
// same pattern as block-position.js), so class drift is caught by the suite.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SieveEditor } from '../src/static/shell/editor-shell.js'
import { SieveTab } from '../src/static/shell/tab.js'
import { SieveWorkspace } from '../src/static/shell/workspace.js'
import { AbstractEditor } from '../src/static/shell/abstract-editor.js'
import { NoteEditor } from '../src/static/shell/note-editor.js'
import { PromptEditor } from '../src/static/shell/prompt-editor.js'
import { AbstractSurface } from '../src/static/shell/surfaces/abstract-surface.js'
import { EditorMode } from '../src/static/shell/editor-mode.js'

// ── Test doubles ─────────────────────────────────────────────────────────────

// A fake WebSocket that records sends and lets tests drive open/message/close.
// Never touches a real socket — injected via socketFactory.
class FakeSocket {
  static instances = []
  static reset() { FakeSocket.instances = [] }

  constructor(url) {
    this.url = url
    this.readyState = 0 // CONNECTING
    this.sent = []
    this.closed = false
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.onerror = null
    FakeSocket.instances.push(this)
  }

  send(data) { this.sent.push(data) }

  close() {
    this.closed = true
    this.readyState = 3 // CLOSED
    if (this.onclose) this.onclose()
  }

  // ── test drivers ──
  driveOpen() { this.readyState = 1; if (this.onopen) this.onopen() }
  driveMessage(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }) }
  sentTypes() { return this.sent.map((s) => JSON.parse(s).type) }
  sentOfType(t) { return this.sent.map((s) => JSON.parse(s)).filter((m) => m.type === t) }
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
    this.ops = []
    this.bodyValue = 'the body'
    this.tiptapValue = mode === 'wysiwyg' ? { fake: 'tiptap' } : null
    this.flushCount = 0
  }
  get mode() { return this._mode }
  get tiptap() { return this.mounted ? this.tiptapValue : null }
  get body() { return this._mode === 'markdown' ? this.bodyValue : null }
  mount(rootEl, content) { this.mounted = true; this.mountArgs = [rootEl, content]; this.log.push('mount:' + this._mode) }
  unmount() { this.mounted = false; this.unmountCount++; this.log.push('unmount:' + this._mode) }
  applyServerOp(msg) { this.ops.push(msg); this.log.push('op:' + msg.type) }
  flushPending() { this.flushCount++; this.log.push('flush:' + this._mode) }
  // P4.A: softReload calls these polymorphically (wysiwyg → reloadFromBlocks,
  // markdown → replaceBody). Recorders so the softReload tests can assert.
  reloadFromBlocks(blocks, opts) { this.reloaded = { blocks, opts } }
  replaceBody(body) { this.replacedBody = body; this.bodyValue = body }
  // P3.A: raw selection descriptor the editor pulls on a selection/transaction/
  // focus event. `feedDescriptor` lets a test script what the surface reports.
  feedSelection() { this.feedCount = (this.feedCount || 0) + 1; return this.feedDescriptor || null }
}

// P2.C.2: the injected-factory seam died — editors construct their own surfaces
// (protected _createSurface, the type-defining repertoire). Tests exercise the
// REAL editor types through that protected contract via a subclass mixin
// (no-construction-seams rule; tests use the public/protected contract). The
// override records every surface into `made`, logs lifecycle order into
// `surfaceLog`, and captures the last domain services bag into `services`.
function withFakeSurfaces(Base) {
  return class extends Base {
    surfaceLog = []
    made = []
    services = null
    _createSurface(mode, services) {
      this.services = services
      const s = new FakeSurface(mode, this.surfaceLog)
      this.made.push(s)
      return s
    }
  }
}
const FakeSurfaceEditor = withFakeSurfaces(AbstractEditor)
const FakeSurfaceSieveEditor = withFakeSurfaces(SieveEditor) // P1 alias kept exercised
const FakeSurfaceNoteEditor = withFakeSurfaces(NoteEditor)
const FakeSurfacePromptEditor = withFakeSurfaces(PromptEditor)

// Builds a NoteEditor wired to fakes. The _createSurface override records every
// surface it makes into `made` and logs lifecycle order into `log`.
function noteRig(uuid, options = {}) {
  const onServerMessage = vi.fn()
  const opts = Object.assign({
    socketFactory: (url) => new FakeSocket(url),
    wsUrl: () => 'ws://test/api/ws?uuid=' + uuid,
    onServerMessage,
  }, options)
  const ed = new FakeSurfaceNoteEditor(uuid, opts)
  return { ed, log: ed.surfaceLog, made: ed.made, onServerMessage, sock: () => FakeSocket.instances[FakeSocket.instances.length - 1] }
}

function makeNote(uuid, options = {}) {
  return noteRig(uuid, options).ed
}

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

  it('tiptap is null with no surface and derives from the mounted surface', () => {
    const ed = new FakeSurfaceSieveEditor('abc-123')
    expect(ed.tiptap).toBeNull()
    ed.presentSurface('wysiwyg', document.createElement('div'), { body: '', blocks: [] })
    expect(ed.tiptap).toEqual({ fake: 'tiptap' })
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
    // Disconnected editor: flushPending fires on the surface, flush() resolves.
    await expect(ed.flushSave()).resolves.toBeDefined()
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
    FakeSocket.reset()
    expect(makeNote('n')).toBeInstanceOf(AbstractEditor)
    expect(new PromptEditor('prompt:p')).toBeInstanceOf(AbstractEditor)
  })

  it('base setMode is a no-op resolving false (PromptEditor inherits it)', async () => {
    const ed = new PromptEditor('prompt:p')
    await expect(ed.setMode('wysiwyg')).resolves.toBe(false)
  })
})

describe('AbstractEditor surface events + domain services (P2.B corrections)', () => {
  // Captures the editor-provided services bag _createSurface receives.
  function rigWithServices() {
    const ed = new FakeSurfaceEditor('u')
    ed.presentSurface('markdown', document.createElement('div'), 'x')
    return { ed, services: () => ed.services }
  }

  it('forwards surface notifications to registered listeners; unsubscribe stops them', () => {
    const { ed, services } = rigWithServices()
    const seen = []
    const unsub = ed.onEvent((ev) => seen.push(ev.type))
    services().notify({ type: 'doc-changed' })
    expect(seen).toEqual(['doc-changed'])
    unsub()
    services().notify({ type: 'selection-changed' })
    expect(seen).toEqual(['doc-changed']) // unsubscribed
  })

  it('a throwing listener does not break the other registrants', () => {
    const { ed, services } = rigWithServices()
    const seen = []
    ed.onEvent(() => { throw new Error('boom') })
    ed.onEvent((ev) => seen.push(ev.type))
    expect(() => services().notify({ type: 'doc-changed' })).not.toThrow()
    expect(seen).toEqual(['doc-changed'])
  })

  it('base applyBlockOps/updateText DROP domain output (socketless prompt behavior)', () => {
    const { services } = rigWithServices()
    expect(() => services().applyBlockOps([{ type: 'update-block', blockId: 'b' }])).not.toThrow()
    expect(() => services().updateText('md')).not.toThrow()
  })
})

describe('AbstractEditor SelectionModel wiring (P3.A)', () => {
  // Mounts a fake surface and returns handles to drive its notify + script its
  // feedSelection descriptor.
  function rig(mode = 'wysiwyg') {
    const ed = new FakeSurfaceEditor('u')
    ed.presentSurface(mode, document.createElement('div'), 'x')
    return { ed, surface: () => ed.surface, notify: () => ed.services.notify }
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
    return { ed, surface: () => ed.surface, notify: () => ed.services.notify }
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

describe('SieveTab selection-update forwarding (P3.B)', () => {
  // A minimal fake editor with a hand-driven onEvent stream + a getSelectionContext.
  function fakeEd(uuid = 'u') {
    let emit = null
    const ed = new AbstractEditor(uuid)
    ed.onEvent = (fn) => { emit = fn; return () => { emit = null } }
    return { ed, fire: (ev) => emit && emit(ev) }
  }

  it('onSelectionUpdate fires when the editor emits a selection-update event', () => {
    const tab = new SieveTab('u')
    const { ed, fire } = fakeEd('u')
    tab.attachEditor(ed)
    const seen = []
    tab.onSelectionUpdate((ctx) => seen.push(ctx))
    fire({ type: 'selection-update', context: { blockId: 'b1', docUuid: 'u' } })
    expect(seen).toEqual([{ blockId: 'b1', docUuid: 'u' }])
  })

  it('non-selection events do not reach selection listeners', () => {
    const tab = new SieveTab('u')
    const { ed, fire } = fakeEd('u')
    tab.attachEditor(ed)
    const seen = []
    tab.onSelectionUpdate((ctx) => seen.push(ctx))
    fire({ type: 'mode-changed', mode: 'markdown' })
    fire({ type: 'doc-changed' })
    expect(seen).toEqual([])
  })

  it('a Tab-level listener survives an editor detach/attach cycle (Tab identity persists)', () => {
    const tab = new SieveTab('u')
    const seen = []
    tab.onSelectionUpdate((ctx) => seen.push(ctx.blockId))
    const a = fakeEd('u')
    tab.attachEditor(a.ed)
    a.fire({ type: 'selection-update', context: { blockId: 'from-a' } })
    tab.detachEditor()
    const b = fakeEd('u')
    tab.attachEditor(b.ed)
    b.fire({ type: 'selection-update', context: { blockId: 'from-b' } })
    a.fire({ type: 'selection-update', context: { blockId: 'stale-a' } }) // old editor is inert
    expect(seen).toEqual(['from-a', 'from-b'])
  })

  it('unsubscribe stops selection delivery', () => {
    const tab = new SieveTab('u')
    const { ed, fire } = fakeEd('u')
    tab.attachEditor(ed)
    const seen = []
    const unsub = tab.onSelectionUpdate((ctx) => seen.push(ctx.blockId))
    fire({ type: 'selection-update', context: { blockId: 'b1' } })
    unsub()
    fire({ type: 'selection-update', context: { blockId: 'b2' } })
    expect(seen).toEqual(['b1'])
  })

  it('a throwing selection listener does not break the others', () => {
    const tab = new SieveTab('u')
    const { ed, fire } = fakeEd('u')
    tab.attachEditor(ed)
    const seen = []
    tab.onSelectionUpdate(() => { throw new Error('boom') })
    tab.onSelectionUpdate((ctx) => seen.push(ctx.blockId))
    expect(() => fire({ type: 'selection-update', context: { blockId: 'b1' } })).not.toThrow()
    expect(seen).toEqual(['b1'])
  })
})

describe('SieveWorkspace.onSelectionUpdate republish (P3.B)', () => {
  // A fake editor with a hand-driven onEvent stream + a scriptable
  // getSelectionContext (D4 synth). Attached to a REAL SieveTab via the public
  // attachEditor — the workspace subscribes to the tab's REAL onSelectionUpdate,
  // so the whole editor→tab→workspace chain is exercised with no construction
  // seam. push() fires a selection-update through the tab's forward.
  function fakeEditor(uuid, ctx = null) {
    let emit = null
    const ed = {
      constructor: { name: 'x' },
      getSelectionContext: () => ctx,
      onEvent: (fn) => { emit = fn; return () => { emit = null } },
    }
    // attachEditor's instanceof guard — masquerade as an AbstractEditor.
    Object.setPrototypeOf(ed, AbstractEditor.prototype)
    return { ed, setContext: (c) => { ed.getSelectionContext = () => c }, push: (c) => emit && emit({ type: 'selection-update', context: c }) }
  }

  // Opens a uuid on the workspace (real openTab → #setActiveTab) and attaches a
  // fake editor to the created tab so its selection stream is live. Mirrors the
  // real activateDocument ordering: openTab (which may run the synth against a
  // not-yet-attached editor → null-guarded no synth) THEN attachEditor.
  function open(ws, uuid, ctx = null) {
    const f = fakeEditor(uuid, ctx)
    const tab = ws.openTab(uuid)
    tab.attachEditor(f.ed)
    return f
  }

  // Re-activates an ALREADY-open+attached tab (the same-uuid re-activation flow —
  // the editor is kept). This is the switch where D4-synth fires: the target tab
  // already holds an editor with a context.
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

  it('D4 null-guard: switching to a tab with no editor context synthesizes nothing', () => {
    const ws = new SieveWorkspace()
    open(ws, 'doc-a', null) // editor present, getSelectionContext() null
    const seen = []
    ws.onSelectionUpdate((ctx) => seen.push(ctx))
    // the tab is already active from open(); switch to a second null-context tab.
    open(ws, 'doc-b', null)
    expect(seen).toEqual([]) // no synth for a null context
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

describe('AbstractEditor domain → wire enveloping (P2.B.2: moved from NoteEditor)', () => {
  beforeEach(() => FakeSocket.reset())

  it('applyBlockOps envelopes each domain op as block-op, in order, with the uuid', () => {
    const rig = noteRig('n')
    rig.sock().driveOpen()
    rig.ed.applyBlockOps([
      { type: 'create-block', kind: 'code', index: 1 },
      { type: 'delete-block', blockId: 'b9' },
    ])
    expect(rig.sock().sentOfType('block-op')).toEqual([
      { type: 'block-op', uuid: 'n', op: { type: 'create-block', kind: 'code', index: 1 } },
      { type: 'block-op', uuid: 'n', op: { type: 'delete-block', blockId: 'b9' } },
    ])
  })

  it('updateText envelopes the markdown as doc-update with the uuid', () => {
    const rig = noteRig('n')
    rig.sock().driveOpen()
    rig.ed.updateText('# body')
    expect(rig.sock().sentOfType('doc-update')).toEqual([
      { type: 'doc-update', uuid: 'n', markdown: '# body' },
    ])
  })

  it('the services handed to _createSurface route through the enveloping', () => {
    const rig = noteRig('n')
    rig.sock().driveOpen()
    rig.ed.presentSurface('wysiwyg', document.createElement('div'), { body: '', blocks: [] })
    rig.ed.services.applyBlockOps([{ type: 'update-block', blockId: 'b1' }])
    expect(rig.sock().sentOfType('block-op')).toEqual([
      { type: 'block-op', uuid: 'n', op: { type: 'update-block', blockId: 'b1' } },
    ])
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
  beforeEach(() => FakeSocket.reset())

  it('creates a NoteEditor for a note uuid', () => {
    const tab = new SieveTab('note-1')
    const ed = tab.createEditor('note-1', {
      socketFactory: (url) => new FakeSocket(url),
      wsUrl: () => 'ws://test',
    })
    expect(ed).toBeInstanceOf(NoteEditor)
  })

  it('creates a PromptEditor for a prompt: uuid', () => {
    const tab = new SieveTab('prompt:daily')
    const ed = tab.createEditor('prompt:daily', {})
    expect(ed).toBeInstanceOf(PromptEditor)
  })

  it('a NoteEditor opens a socket; a PromptEditor does not', () => {
    const noteTab = new SieveTab('note-2')
    noteTab.createEditor('note-2', {
      socketFactory: (url) => new FakeSocket(url),
      wsUrl: () => 'ws://test',
    })
    expect(FakeSocket.instances.length).toBe(1)

    const promptTab = new SieveTab('prompt:x')
    promptTab.createEditor('prompt:x', {})
    expect(FakeSocket.instances.length).toBe(1) // unchanged
  })
})

describe('NoteEditor WS lifecycle (P2.A)', () => {
  beforeEach(() => FakeSocket.reset())
  afterEach(() => vi.useRealTimers())

  it('opens a socket on construction', () => {
    makeNote('n')
    expect(FakeSocket.instances.length).toBe(1)
    expect(FakeSocket.instances[0].url).toContain('uuid=n')
  })

  it('queues domain sends before open and flushes on open', () => {
    const ed = makeNote('n')
    const sock = FakeSocket.instances[0]
    ed.applyBlockOps([{ type: 'create-block', kind: 'code' }]) // CONNECTING → queued
    expect(sock.sent.length).toBe(0)
    sock.driveOpen()
    expect(sock.sentTypes()).toContain('block-op')
  })

  it('sends directly once the socket is OPEN, with the frozen envelope (C3 pin)', () => {
    const ed = makeNote('n')
    const sock = FakeSocket.instances[0]
    sock.driveOpen()
    ed.applyBlockOps([{ type: 'update-block', blockId: 'b1' }])
    const sent = sock.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'block-op')
    // The wire envelope is composed ONLY inside AbstractEditor — pinned here.
    expect(sent).toEqual({ type: 'block-op', uuid: 'n', op: { type: 'update-block', blockId: 'b1' } })
  })

  it('retryBlockJob and extract envelope with the frozen shapes', () => {
    const ed = makeNote('n')
    const sock = FakeSocket.instances[0]
    sock.driveOpen()
    ed.retryBlockJob('blk-1')
    ed.extract({ blockId: 'blk-1', targetKind: 'diagram', operation: 'extract', entries: [], index: 2 })
    const msgs = sock.sent.map((s) => JSON.parse(s))
    expect(msgs).toContainEqual({ type: 'retry-block-job', uuid: 'n', id: 'blk-1' })
    // extract carries no uuid — the server resolves the doc from the channel.
    expect(msgs).toContainEqual({ type: 'extract', blockId: 'blk-1', targetKind: 'diagram', operation: 'extract', entries: [], index: 2 })
  })

  it('closes the socket and cancels timers on destroy', () => {
    const ed = makeNote('n')
    const sock = FakeSocket.instances[0]
    sock.driveOpen()
    ed.destroy()
    expect(sock.closed).toBe(true)
  })

  it('destroy suppresses reconnect (onclose nulled)', () => {
    vi.useFakeTimers()
    const ed = makeNote('n')
    const sock = FakeSocket.instances[0]
    sock.driveOpen()
    ed.destroy()
    vi.advanceTimersByTime(60000)
    expect(FakeSocket.instances.length).toBe(1) // no reconnect socket created
  })

  it('destroy unmounts the active surface (P2.B)', () => {
    const { ed, made } = noteRig('n')
    ed.presentSurface('markdown', document.createElement('div'), 'x')
    ed.destroy()
    expect(made[0].unmountCount).toBe(1)
    expect(ed.surface).toBeNull()
  })

  it('arms exponential-backoff reconnect on unexpected close', () => {
    vi.useFakeTimers()
    makeNote('n')
    const sock = FakeSocket.instances[0]
    sock.driveOpen()
    sock.close() // server-initiated close → onclose arms reconnect
    expect(FakeSocket.instances.length).toBe(1)
    vi.advanceTimersByTime(1000) // first backoff = 1000ms
    expect(FakeSocket.instances.length).toBe(2) // reconnected
  })

  it('watchdog closes the socket when no pong arrives within 45s', () => {
    vi.useFakeTimers()
    makeNote('n')
    const sock = FakeSocket.instances[0]
    sock.driveOpen() // starts the 15s ping interval; lastPong = now
    vi.advanceTimersByTime(61000) // no pong → watchdog fires (>45s stale)
    expect(sock.closed).toBe(true)
  })

  it('a pong resets the watchdog clock', () => {
    vi.useFakeTimers()
    makeNote('n')
    const sock = FakeSocket.instances[0]
    sock.driveOpen()
    vi.advanceTimersByTime(30000)
    sock.driveMessage({ type: 'pong' }) // refresh lastPong
    vi.advanceTimersByTime(30000) // 60s total but only 30s since pong
    expect(sock.closed).toBe(false)
  })
})

describe('AbstractEditor.flush() — the awaited save ack (P2.B.2 domain method)', () => {
  beforeEach(() => FakeSocket.reset())
  afterEach(() => vi.useRealTimers())

  it('sends the frozen flush envelope and resolves with the ack', async () => {
    const ed = makeNote('n')
    const sock = FakeSocket.instances[0]
    sock.driveOpen()
    const p = ed.flush()
    const sent = sock.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'flush')
    expect(sent).toEqual({ type: 'flush', uuid: 'n' })
    sock.driveMessage({ type: 'flush-ack', uuid: 'n' })
    const msg = await p
    expect(msg.type).toBe('flush-ack')
  })

  it('rejects after a 5s timeout', async () => {
    vi.useFakeTimers()
    const ed = makeNote('n')
    FakeSocket.instances[0].driveOpen()
    const p = ed.flush()
    const assertion = expect(p).rejects.toThrow('ws timeout: flush')
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
  })
})

// ── P2.B: setMode — the awaited in-place surface swap ───────────────────────────

describe('NoteEditor.setMode (P2.B handshake)', () => {
  beforeEach(() => FakeSocket.reset())
  afterEach(() => vi.useRealTimers())

  function flipRig(startMode = 'markdown') {
    const rig = noteRig('n')
    const root = document.createElement('div')
    rig.sock().driveOpen()
    const content = startMode === 'markdown' ? 'seed' : { body: '', blocks: [] }
    rig.ed.presentSurface(startMode, root, content)
    rig.log.length = 0 // drop setup entries; tests assert the flip only
    return Object.assign(rig, { root })
  }

  it('markdown→wysiwyg: flushes BEFORE sending enter-wysiwyg carrying the body', async () => {
    const rig = flipRig('markdown')
    rig.made[0].bodyValue = 'LIVE BODY'
    const p = rig.ed.setMode('wysiwyg')
    // flush-before-send:
    expect(rig.log[0]).toBe('flush:markdown')
    const sent = rig.sock().sentOfType('enter-wysiwyg')
    expect(sent.length).toBe(1)
    expect(sent[0]).toEqual({ type: 'enter-wysiwyg', uuid: 'n', markdown: 'LIVE BODY' })
    // nothing torn down until the reply arrives:
    expect(rig.made[0].unmountCount).toBe(0)
    rig.sock().driveMessage({ type: 'wysiwyg-content', uuid: 'n', blocks: [{ id: 'b1' }] })
    await expect(p).resolves.toBe(true)
    expect(rig.log).toEqual(['flush:markdown', 'unmount:markdown', 'mount:wysiwyg'])
    expect(rig.made[0].unmountCount).toBe(1) // exactly once
    expect(rig.made[1].mountArgs).toEqual([rig.root, { body: 'LIVE BODY', blocks: [{ id: 'b1' }] }])
    expect(rig.ed.mode).toBe('wysiwyg')
  })

  it('wysiwyg→markdown: flushes block-sync, awaits markdown-content, mounts its payload', async () => {
    const rig = flipRig('wysiwyg')
    const p = rig.ed.setMode('markdown')
    expect(rig.log[0]).toBe('flush:wysiwyg')
    expect(rig.sock().sentOfType('enter-markdown')).toEqual([{ type: 'enter-markdown', uuid: 'n' }])
    rig.sock().driveMessage({ type: 'markdown-content', uuid: 'n', markdown: 'FROM GO' })
    await expect(p).resolves.toBe(true)
    expect(rig.log).toEqual(['flush:wysiwyg', 'unmount:wysiwyg', 'mount:markdown'])
    expect(rig.made[1].mountArgs).toEqual([rig.root, 'FROM GO'])
    expect(rig.ed.mode).toBe('markdown')
  })

  it('timeout: rejects, the editor STAYS in its mode, old surface untouched', async () => {
    vi.useFakeTimers()
    const rig = flipRig('markdown')
    const p = rig.ed.setMode('wysiwyg')
    const assertion = expect(p).rejects.toThrow('ws timeout')
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
    expect(rig.made.length).toBe(1)            // no new surface was ever created
    expect(rig.made[0].unmountCount).toBe(0)   // old surface never unmounted
    expect(rig.made[0].mounted).toBe(true)
    expect(rig.ed.mode).toBe('markdown')       // mode unchanged — stay-on-failure
  })

  it('a LATE reply after the timeout is dropped — never mounts a stale surface', async () => {
    vi.useFakeTimers()
    const rig = flipRig('markdown')
    const p = rig.ed.setMode('wysiwyg')
    const assertion = expect(p).rejects.toThrow('ws timeout')
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
    expect(() => rig.sock().driveMessage({ type: 'wysiwyg-content', uuid: 'n', blocks: [] })).not.toThrow()
    expect(rig.made.length).toBe(1)            // still no mount
    expect(rig.ed.mode).toBe('markdown')
  })

  it('setMode with a value not in EditorMode resolves false and mounts nothing (P2.C)', async () => {
    const rig = flipRig('markdown')
    await expect(rig.ed.setMode('markdwon')).resolves.toBe(false)
    expect(rig.sock().sentTypes()).toEqual([])   // no handshake ever sent
    expect(rig.made.length).toBe(1)              // no new surface created
    expect(rig.ed.mode).toBe('markdown')
  })

  it('setMode to the current mode is a no-op resolving false', async () => {
    const rig = flipRig('markdown')
    await expect(rig.ed.setMode('markdown')).resolves.toBe(false)
    expect(rig.sock().sentTypes()).toEqual([])
    expect(rig.log).toEqual([])
  })

  it('setMode with no surface mounted is a no-op resolving false', async () => {
    const rig = noteRig('n')
    rig.sock().driveOpen()
    await expect(rig.ed.setMode('markdown')).resolves.toBe(false)
  })

  it('reentrant setMode while a flip is in flight coalesces to the same promise', async () => {
    const rig = flipRig('markdown')
    const p1 = rig.ed.setMode('wysiwyg')
    const p2 = rig.ed.setMode('wysiwyg')
    expect(p2).toBe(p1)
    expect(rig.sock().sentOfType('enter-wysiwyg').length).toBe(1) // one handshake only
    rig.sock().driveMessage({ type: 'wysiwyg-content', uuid: 'n', blocks: [] })
    await p1
    expect(rig.made.length).toBe(2) // exactly one new surface
  })

  it('destroy mid-flight: the flip dies without mounting anything', async () => {
    vi.useFakeTimers()
    const rig = flipRig('markdown')
    const p = rig.ed.setMode('wysiwyg')
    const assertion = expect(p).rejects.toThrow()
    rig.ed.destroy()
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
    expect(rig.made.length).toBe(1) // no wysiwyg surface ever created
  })
})

// ── P2.B: server-op routing to the active surface ────────────────────────────────

describe('NoteEditor server-op routing (P2.B)', () => {
  beforeEach(() => FakeSocket.reset())

  it('insert-block / replace-block / block-attrs-updated go to the active surface, not onServerMessage', () => {
    const rig = noteRig('n')
    rig.sock().driveOpen()
    rig.ed.presentSurface('wysiwyg', document.createElement('div'), { body: '', blocks: [] })
    const ops = [
      { type: 'insert-block', kind: 'code', id: 'b1', index: 0 },
      { type: 'replace-block', oldId: 'b1', newId: 'b2' },
      { type: 'block-attrs-updated', id: 'b2', attrs: { status: 'done' } },
    ]
    ops.forEach((m) => rig.sock().driveMessage(m))
    expect(rig.made[0].ops).toEqual(ops)
    expect(rig.onServerMessage).not.toHaveBeenCalled()
  })

  it('ops arriving with no surface mounted are dropped safely', () => {
    const rig = noteRig('n')
    rig.sock().driveOpen()
    expect(() => rig.sock().driveMessage({ type: 'insert-block', id: 'b1' })).not.toThrow()
  })

  it('error and other messages still reach onServerMessage', () => {
    const rig = noteRig('n')
    rig.sock().driveOpen()
    rig.ed.presentSurface('markdown', document.createElement('div'), '')
    rig.sock().driveMessage({ type: 'error', message: 'boom' })
    expect(rig.onServerMessage).toHaveBeenCalledWith({ type: 'error', message: 'boom' })
  })

  it('mode-content replies consumed by an awaiter never leak to onServerMessage', async () => {
    const rig = noteRig('n')
    rig.sock().driveOpen()
    rig.ed.presentSurface('markdown', document.createElement('div'), 'x')
    const p = rig.ed.setMode('wysiwyg')
    rig.sock().driveMessage({ type: 'wysiwyg-content', uuid: 'n', blocks: [] })
    await p
    expect(rig.onServerMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'wysiwyg-content' }))
  })

  it('applyServerOp delegates to the active surface', () => {
    const rig = noteRig('n')
    rig.ed.presentSurface('markdown', document.createElement('div'), '')
    rig.ed.applyServerOp({ type: 'insert-block', id: 'x' })
    expect(rig.made[0].ops).toEqual([{ type: 'insert-block', id: 'x' }])
  })
})

// ── flush/save routing ──────────────────────────────────────────────────────────

describe('flushSave routing (P2.A → P2.B surfaces)', () => {
  beforeEach(() => FakeSocket.reset())

  it('NoteEditor flushes the active surface BEFORE sending flush', () => {
    const rig = noteRig('n')
    rig.sock().driveOpen()
    rig.ed.presentSurface('markdown', document.createElement('div'), 'x')
    rig.log.length = 0
    rig.ed.flushSave()
    expect(rig.made[0].flushCount).toBe(1)
    expect(rig.log[0]).toBe('flush:markdown')
    expect(rig.sock().sentTypes()).toEqual(['flush'])
  })

  it('NoteEditor flushSave with no surface still sends flush', () => {
    const rig = noteRig('n')
    rig.sock().driveOpen()
    rig.ed.flushSave()
    expect(rig.sock().sentTypes()).toEqual(['flush'])
  })

  it('PromptEditor saves the surface body over the injected saveFn (no WS)', async () => {
    const saveFn = vi.fn(() => Promise.resolve())
    const ed = new FakeSurfacePromptEditor('prompt:p', { saveFn })
    const s = ed.presentSurface('markdown', document.createElement('div'), 'seed')
    s.bodyValue = 'prompt body'
    await ed.flushSave()
    expect(saveFn).toHaveBeenCalledWith('prompt:p', 'prompt body', 'markdown')
  })

  it('PromptEditor mode is markdown by default (fixed)', () => {
    const ed = new PromptEditor('prompt:p')
    expect(ed.mode).toBe('markdown')
  })

  it('PromptEditor skips the save while a reload is suppressed (softReload mid-flight)', async () => {
    // P4.A: suppression is no longer an injected closure — it is
    // AbstractEditor.isSaveSuppressed reading #reloadInProgress, armed by
    // softReload. Hold the reload fetch mid-flight so the guard is active.
    const saveFn = vi.fn(() => Promise.resolve())
    const prevFetch = global.fetch
    const prevWs = window.sieveWorkspace
    window.sieveWorkspace = { getSelectionContext: () => ({}), setPosition: vi.fn() }
    let resolveJson
    global.fetch = vi.fn(() => Promise.resolve({ json: () => new Promise((r) => { resolveJson = r }) }))
    try {
      const ed = new FakeSurfacePromptEditor('prompt:p', { saveFn })
      ed.presentSurface('markdown', document.createElement('div'), 'seed')
      const reload = ed.softReload()          // arms #reloadInProgress
      expect(ed.isSaveSuppressed()).toBe(true)
      await ed.flushSave()
      expect(saveFn).not.toHaveBeenCalled()   // save skipped while suppressed
      resolveJson({ body: 'x', blocks: [] })
      await reload
      expect(ed.isSaveSuppressed()).toBe(false)
    } finally {
      global.fetch = prevFetch
      window.sieveWorkspace = prevWs
    }
  })
})

// ── P2.A fix wave: workspace-owned editor lifecycle (the ONE teardown path) ──────

describe('SieveWorkspace.activateDocument editor lifecycle (P2.A fix wave)', () => {
  beforeEach(() => FakeSocket.reset())

  // Options whose socketFactory records open/close ordering into a shared log.
  // wsUrl embeds the uuid, so log entries identify the document.
  function loggingOptions(log, uuid) {
    return {
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
      wsUrl: () => 'ws://test/api/ws?uuid=' + uuid,
      onServerMessage: () => {},
    }
  }

  it("tab switch: A's socket closes before B's opens, exactly once", () => {
    const log = []
    const w = new SieveWorkspace()
    const tabA = w.activateDocument('doc-a', loggingOptions(log, 'doc-a'))
    FakeSocket.instances[0].driveOpen()
    const tabB = w.activateDocument('doc-b', loggingOptions(log, 'doc-b'))

    expect(log).toEqual([
      'open:ws://test/api/ws?uuid=doc-a',
      'close:ws://test/api/ws?uuid=doc-a',
      'open:ws://test/api/ws?uuid=doc-b',
    ]) // A closed BEFORE B opened; A closed exactly once
    expect(tabA.editor).toBeNull() // detached after destroy
    expect(tabB.editor).toBeInstanceOf(NoteEditor)
    expect(w.activeTab).toBe(tabB)
  })

  it('same-uuid re-activation keeps the editor instance and its socket', () => {
    const log = []
    const w = new SieveWorkspace()
    const tab1 = w.activateDocument('doc-a', loggingOptions(log, 'doc-a'))
    const ed1 = tab1.editor
    FakeSocket.instances[0].driveOpen()

    const tab2 = w.activateDocument('doc-a', loggingOptions(log, 'doc-a'))
    expect(tab2).toBe(tab1)
    expect(tab2.editor).toBe(ed1) // same instance — no destroy, no new socket
    expect(log.filter((e) => e.startsWith('close:')).length).toBe(0)
    expect(FakeSocket.instances.length).toBe(1)
  })

  it('teardown to empty: single destroy, tab closed, no throw; repeat is a no-op', () => {
    const log = []
    const w = new SieveWorkspace()
    w.activateDocument('doc-a', loggingOptions(log, 'doc-a'))
    FakeSocket.instances[0].driveOpen()

    expect(() => w.activateDocument('', loggingOptions(log, ''))).not.toThrow()
    expect(log.filter((e) => e.startsWith('close:')).length).toBe(1) // exactly one close
    expect(w.getTab('doc-a')).toBeNull()
    expect(w.activeTab).toBeNull()

    // Second teardown with nothing open must not throw or close anything else.
    expect(() => w.activateDocument('', loggingOptions(log, ''))).not.toThrow()
    expect(log.filter((e) => e.startsWith('close:')).length).toBe(1)
  })

  it('prompt tabs participate without ever touching a socket', () => {
    const log = []
    const w = new SieveWorkspace()
    w.activateDocument('doc-a', loggingOptions(log, 'doc-a'))
    const promptTab = w.activateDocument('prompt:p', loggingOptions(log, 'prompt:p'))

    expect(promptTab.editor).toBeInstanceOf(PromptEditor)
    expect(log.filter((e) => e.startsWith('close:')).length).toBe(1) // note's socket closed on switch
    expect(FakeSocket.instances.length).toBe(1) // no socket created for the prompt
  })
})

describe('NoteEditor.destroy idempotence (P2.A fix wave)', () => {
  beforeEach(() => FakeSocket.reset())
  afterEach(() => vi.useRealTimers())

  it('double destroy: no throw, socket closed exactly once, timers cleared', () => {
    vi.useFakeTimers()
    const ed = makeNote('n')
    const sock = FakeSocket.instances[0]
    sock.driveOpen()

    let closeCalls = 0
    const origClose = sock.close.bind(sock)
    sock.close = () => { closeCalls++; origClose() }

    ed.destroy()
    expect(() => ed.destroy()).not.toThrow()
    expect(closeCalls).toBe(1) // #ws nulled on first destroy — second is a no-op

    // Timers are gone: no ping is sent and no reconnect socket appears.
    vi.advanceTimersByTime(120000)
    expect(FakeSocket.instances.length).toBe(1)
    expect(sock.sentTypes()).not.toContain('ping')
  })
})

describe('transport is invisible in the public contract (P2.B.2)', () => {
  beforeEach(() => FakeSocket.reset())

  it('neither editor type exposes any transport method — the domain methods ARE the protocol surface', () => {
    const note = makeNote('n')
    const prompt = new PromptEditor('prompt:p')
    for (const ed of [note, prompt]) {
      for (const name of ['wsSend', 'wsSendAndAwait', '_wsSend', '_wsSendAndAwait', '_awaitReply']) {
        expect(typeof (/** @type {any} */ (ed))[name]).not.toBe('function')
      }
      // The domain surface is uniform across the hierarchy.
      for (const name of ['applyBlockOps', 'updateText', 'flush', 'enterMarkdown', 'enterWysiwyg', 'retryBlockJob', 'extract', 'flushSave']) {
        expect(typeof (/** @type {any} */ (ed))[name]).toBe('function')
      }
    }
  })
})

// ── P2.B.2: socketless editor (PromptEditor) — no socket, domain no-ops ─────────

describe('disconnected editor (PromptEditor — no `connect` declared, P2.B.2)', () => {
  beforeEach(() => FakeSocket.reset())

  it('PromptEditor never constructs a socket', () => {
    new PromptEditor('prompt:x', {
      socketFactory: (url) => new FakeSocket(url),
    })
    expect(FakeSocket.instances.length).toBe(0)
  })

  it('applyBlockOps is a silent no-op for a socketless editor', () => {
    const ed = new PromptEditor('prompt:x')
    expect(() => ed.applyBlockOps([{ type: 'create-block', kind: 'code', index: 0 }])).not.toThrow()
  })

  it('updateText is a silent no-op for a socketless editor', () => {
    const ed = new PromptEditor('prompt:x')
    expect(() => ed.updateText('# hello')).not.toThrow()
  })

  it('flush() resolves immediately for a socketless editor', async () => {
    const ed = new PromptEditor('prompt:x')
    await expect(ed.flush()).resolves.toBeDefined()
  })

  it('enterMarkdown() rejects for a disconnected editor', async () => {
    const ed = new PromptEditor('prompt:x')
    await expect(ed.enterMarkdown()).rejects.toThrow('no live channel')
  })

  it('enterWysiwyg() rejects for a disconnected editor', async () => {
    const ed = new PromptEditor('prompt:x')
    await expect(ed.enterWysiwyg('# md')).rejects.toThrow('no live channel')
  })

  it('setMode is a no-op resolving false for a socketless editor', async () => {
    const ed = new FakeSurfacePromptEditor('prompt:x')
    ed.presentSurface('markdown', document.createElement('div'), 'x')
    await expect(ed.setMode('wysiwyg')).resolves.toBe(false)
  })

  it('PromptEditor exposes no wsSend (socketless guard for editor.js)', () => {
    const ed = new PromptEditor('prompt:x')
    expect(typeof (/** @type {any} */ (ed)).wsSend).not.toBe('function')
  })
})

describe('dirty-state transitions (P2.A)', () => {
  beforeEach(() => FakeSocket.reset())

  it('NoteEditor clears dirty and emits meta-dirty(false) on flush-ack', () => {
    const events = []
    const handler = (e) => events.push(e.detail.dirty)
    document.addEventListener('sieve:meta-dirty', handler)
    try {
      const ed = makeNote('n')
      const sock = FakeSocket.instances[0]
      sock.driveOpen()
      ed.markDirty()
      expect(ed.isDirty).toBe(true)
      sock.driveMessage({ type: 'flush-ack', uuid: 'n' })
      expect(ed.isDirty).toBe(false)
      expect(events).toContain(false)
    } finally {
      document.removeEventListener('sieve:meta-dirty', handler)
    }
  })

  it('PromptEditor clears dirty after a successful save', async () => {
    const ed = new FakeSurfacePromptEditor('prompt:p', { saveFn: () => Promise.resolve() })
    ed.presentSurface('markdown', document.createElement('div'), 'b')
    ed.markDirty()
    await ed.flushSave()
    expect(ed.isDirty).toBe(false)
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
  beforeEach(() => FakeSocket.reset())
  afterEach(() => vi.useRealTimers())

  // Like flipRig, plus an unfiltered event collector so specs can assert the
  // producer emissions (mode-changed / mode-change-failed) exactly.
  function modeRig(startMode = 'markdown') {
    const rig = noteRig('n')
    const root = document.createElement('div')
    rig.sock().driveOpen()
    const content = startMode === 'markdown' ? 'seed' : { body: '', blocks: [] }
    rig.ed.presentSurface(startMode, root, content)
    const events = []
    rig.ed.onEvent((ev) => events.push(ev))
    return Object.assign(rig, { root, events })
  }

  it("derives the target from the current mode and returns setMode's promise", async () => {
    const rig = modeRig('markdown')
    const p = rig.ed.toggleMode()
    expect(rig.sock().sentOfType('enter-wysiwyg').length).toBe(1)
    rig.sock().driveMessage({ type: 'wysiwyg-content', uuid: 'n', blocks: [] })
    await expect(p).resolves.toBe(true)
    expect(rig.ed.mode).toBe(EditorMode.WYSIWYG)
  })

  it('emits mode-changed with the NEW mode exactly once on a successful flip', async () => {
    const rig = modeRig('markdown')
    const p = rig.ed.toggleMode()
    rig.sock().driveMessage({ type: 'wysiwyg-content', uuid: 'n', blocks: [] })
    await p
    expect(rig.events).toEqual([{ type: 'mode-changed', mode: 'wysiwyg' }])
  })

  it('a direct setMode caller also produces the mode-changed emission (producer lives in the flip path)', async () => {
    const rig = modeRig('markdown')
    const p = rig.ed.setMode('wysiwyg')
    rig.sock().driveMessage({ type: 'wysiwyg-content', uuid: 'n', blocks: [] })
    await p
    expect(rig.events).toEqual([{ type: 'mode-changed', mode: 'wysiwyg' }])
  })

  it('on timeout: rejects and emits mode-change-failed once with the UNCHANGED mode', async () => {
    vi.useFakeTimers()
    const rig = modeRig('markdown')
    const p = rig.ed.toggleMode()
    const assertion = expect(p).rejects.toThrow('ws timeout')
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
    expect(rig.events).toEqual([
      { type: 'mode-change-failed', mode: 'markdown', error: expect.any(Error) },
    ])
    expect(rig.ed.mode).toBe(EditorMode.MARKDOWN) // stay-on-failure
  })

  it('a no-op toggle (no surface mounted) resolves false and emits nothing', async () => {
    const rig = noteRig('n')
    rig.sock().driveOpen()
    const events = []
    rig.ed.onEvent((ev) => events.push(ev))
    await expect(rig.ed.toggleMode()).resolves.toBe(false)
    expect(events).toEqual([])
  })

  it('socketless PromptEditor: toggleMode resolves false and emits nothing', async () => {
    const ed = new FakeSurfacePromptEditor('prompt:p')
    ed.presentSurface('markdown', document.createElement('div'), 'x')
    const events = []
    ed.onEvent((ev) => events.push(ev))
    await expect(ed.toggleMode()).resolves.toBe(false)
    expect(events).toEqual([])
  })

  it('reentrant toggleMode coalesces onto the in-flight flip and emits mode-changed ONCE', async () => {
    const rig = modeRig('markdown')
    const p1 = rig.ed.toggleMode()
    const p2 = rig.ed.toggleMode()
    expect(p2).toBe(p1)
    expect(rig.sock().sentOfType('enter-wysiwyg').length).toBe(1) // one handshake
    rig.sock().driveMessage({ type: 'wysiwyg-content', uuid: 'n', blocks: [] })
    await p1
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

describe('AbstractEditor.createBlock (P2.C transitional seam)', () => {
  it('delegates kind + attrs to the injected createBlockAtCaret seam', () => {
    const seam = vi.fn()
    const ed = new AbstractEditor('u', { createBlockAtCaret: seam })
    ed.createBlock('diagram', { a: 1 })
    expect(seam).toHaveBeenCalledTimes(1)
    expect(seam).toHaveBeenCalledWith('diagram', { a: 1 })
  })

  it('defaults attrs to {} when omitted', () => {
    const seam = vi.fn()
    const ed = new AbstractEditor('u', { createBlockAtCaret: seam })
    ed.createBlock('diagram')
    expect(seam).toHaveBeenCalledWith('diagram', {})
  })

  it('warns and no-ops when no seam is injected', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ed = new AbstractEditor('u')
      expect(() => ed.createBlock('diagram', {})).not.toThrow()
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

// ── P4.A: AbstractEditor absorbs the insert-position math + softReload ─────────
// The insert-pos machinery (sieveInsertPos + kindIsInline / captureInsertPos /
// blockIndexForInsert / commitInsertIndex) and softReloadContent moved off
// editor.js's IIFE onto the editor (D-1: public methods, reachable from the
// classic-script create paths via _activeEditor()). These tests pin the moved
// contract — ESPECIALLY the undo guard: commitInsertIndex's empty-paragraph
// delete stays a PLAIN TRACKED delete (no addToHistory:false meta).

// A recording fake tiptap: a doc with `childCount`, a fresh `tr` per read whose
// delete records (from,to) and whose meta stays whatever the code sets it to,
// and a view that records dispatched trs. The insert-pos helpers read this via
// the surface's `tiptap` accessor.
function fakeInsertPosTiptap(childCount = 2) {
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
  return {
    dispatched,
    state: {
      doc: { childCount },
      get tr() { currentTr = makeTr(); return currentTr },
    },
    view: { dispatch(tr) { dispatched.push(tr) } },
    schema: { nodes: { 'sieve-smart-link': { isInline: true }, 'sieve-code': { isInline: false } } },
  }
}

// A minimal surface exposing an injected tiptap + a flushPending recorder, so an
// AbstractEditor's insert-pos methods have a live `this.tiptap` / `this.surface`.
class InsertPosSurface extends AbstractSurface {
  constructor(tiptap) { super(); this._tt = tiptap; this.flushCount = 0 }
  get mode() { return 'wysiwyg' }
  get tiptap() { return this.mounted ? this._tt : null }
  mount() { this.mounted = true }
  unmount() { this.mounted = false }
  applyServerOp() {}
  flushPending() { this.flushCount++ }
  feedSelection() { return null }
}

class InsertPosEditor extends AbstractEditor {
  constructor(uuid, tiptap) { super(uuid); this._tt = tiptap }
  _createSurface() { return new InsertPosSurface(this._tt) }
}

function insertPosEditor(tiptap = fakeInsertPosTiptap()) {
  const ed = new InsertPosEditor('u', tiptap)
  ed.presentSurface('wysiwyg', document.createElement('div'), { body: '', blocks: [] })
  return { ed, tiptap }
}

describe('AbstractEditor insert-position math (P4.A)', () => {
  let prevTipTap
  beforeEach(() => {
    prevTipTap = window.TipTap
    window.TipTap = {
      blockInsertPos: vi.fn((_state, isInline) => (isInline ? 11 : 42)),
      blockIndexForInsert: vi.fn(() => 3),
      emptyParagraphAnchor: vi.fn(() => null),
    }
  })
  afterEach(() => { window.TipTap = prevTipTap })

  it('setInsertPos / takeInsertPos read-and-clear (numeric fallback), second take is null', () => {
    const { ed } = insertPosEditor()
    ed.setInsertPos(7)
    expect(ed.takeInsertPos()).toBe(7)
    expect(ed.takeInsertPos()).toBeNull() // cleared
  })

  it('takeInsertPos returns null for a non-numeric captured shape (in-place {from,to})', () => {
    const { ed } = insertPosEditor()
    ed.setInsertPos({ from: 1, to: 2 })
    expect(ed.takeInsertPos()).toBeNull()
  })

  it('clearInsertPos wipes the captured position', () => {
    const { ed } = insertPosEditor()
    ed.setInsertPos(5)
    ed.clearInsertPos()
    expect(ed.takeInsertPos()).toBeNull()
  })

  it('kindIsInline reads the schema; unknown kind → block (false)', () => {
    const { ed } = insertPosEditor()
    expect(ed.kindIsInline('smart-link')).toBe(true)
    expect(ed.kindIsInline('code')).toBe(false)
    expect(ed.kindIsInline('nope')).toBe(false)
    expect(ed.kindIsInline('')).toBe(false)
  })

  it('captureInsertPos delegates to window.TipTap.blockInsertPos (inline vs block)', () => {
    const { ed } = insertPosEditor()
    expect(ed.captureInsertPos(false)).toBe(42)
    expect(ed.captureInsertPos(true)).toBe(11)
  })

  it('blockIndexForInsert delegates to window.TipTap.blockIndexForInsert', () => {
    const { ed } = insertPosEditor()
    expect(ed.blockIndexForInsert(42)).toBe(3)
    expect(window.TipTap.blockIndexForInsert).toHaveBeenCalled()
  })

  it('commitInsertIndex with NO empty-paragraph anchor → the plain block index, no dispatch', () => {
    const { ed, tiptap } = insertPosEditor()
    window.TipTap.emptyParagraphAnchor.mockReturnValue(null)
    expect(ed.commitInsertIndex(42)).toBe(3)
    expect(tiptap.dispatched.length).toBe(0)
  })

  it('commitInsertIndex with an empty-paragraph anchor dispatches a PLAIN TRACKED delete (NO addToHistory:false) + flushPending, returns the anchor index', () => {
    const tiptap = fakeInsertPosTiptap(2) // childCount > 1 → the delete branch
    const { ed } = insertPosEditor(tiptap)
    window.TipTap.emptyParagraphAnchor.mockReturnValue({ from: 4, to: 6, index: 1 })
    const idx = ed.commitInsertIndex(42)
    expect(idx).toBe(1) // the anchor's own index — the new block takes its place
    expect(tiptap.dispatched.length).toBe(1)
    const tr = tiptap.dispatched[0]
    expect(tr.deletedRange).toEqual({ from: 4, to: 6 })
    // THE UNDO GUARD: the empty-paragraph delete is an ORDINARY tracked prose
    // edit — never addToHistory:false. A prior P2 regression turned this into a
    // softReload / history-excluded delete; it must stay plain + tracked.
    expect(tr.getMeta('addToHistory')).toBeUndefined()
    expect(ed.surface.flushCount).toBe(1)
  })

  it('commitInsertIndex on a sole-block doc keeps the paragraph (no delete dispatched), returns its index', () => {
    const tiptap = fakeInsertPosTiptap(1) // childCount === 1 → keep the only child
    const { ed } = insertPosEditor(tiptap)
    window.TipTap.emptyParagraphAnchor.mockReturnValue({ from: 0, to: 2, index: 0 })
    expect(ed.commitInsertIndex(42)).toBe(0)
    expect(tiptap.dispatched.length).toBe(0)
  })

  it('insertIndexForBlock composes captureInsertPos(false) → commitInsertIndex (the paste/drop path)', () => {
    const { ed } = insertPosEditor()
    window.TipTap.emptyParagraphAnchor.mockReturnValue(null)
    // captureInsertPos(false) → 42 → blockIndexForInsert → 3
    expect(ed.insertIndexForBlock()).toBe(3)
    expect(window.TipTap.blockInsertPos).toHaveBeenCalledWith(expect.anything(), false)
  })

  it('insertIndexForBlockAt(pos) → commitInsertIndex(pos) directly (the drop-coord path)', () => {
    const { ed } = insertPosEditor()
    window.TipTap.emptyParagraphAnchor.mockReturnValue(null)
    expect(ed.insertIndexForBlockAt(99)).toBe(3)
  })

  it('insert-pos methods with no mounted surface are safe (return -1 / null)', () => {
    const ed = new InsertPosEditor('u', fakeInsertPosTiptap())
    expect(ed.commitInsertIndex(1)).toBe(-1)
    expect(ed.blockIndexForInsert(1)).toBe(-1)
    expect(ed.captureInsertPos(false)).toBeNull()
    expect(ed.kindIsInline('code')).toBe(false)
  })
})

describe('AbstractEditor.softReload (P4.A)', () => {
  let prevFetch
  let prevWs
  afterEach(() => {
    if (prevFetch !== undefined) global.fetch = prevFetch
    if (prevWs !== undefined) window.sieveWorkspace = prevWs
  })

  // A fake workspace whose getSelectionContext/setPosition are recorded — the
  // softReload path keeps these verbatim (D-2: not swapped to this.*).
  function fakeWorkspace() {
    const ctx = { caret: 5 }
    const setPosition = vi.fn()
    window.sieveWorkspace = { getSelectionContext: () => ctx, setPosition }
    return { ctx, setPosition }
  }

  function fetchReturning(data) {
    global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve(data) }))
  }

  // A wysiwyg surface with reloadFromBlocks; a markdown surface with replaceBody.
  class ReloadSurface extends AbstractSurface {
    constructor(mode) { super(); this._mode = mode; this.reloaded = null; this.replaced = null }
    get mode() { return this._mode }
    get tiptap() { return this._mode === 'wysiwyg' ? { fake: true } : null }
    get body() { return this._mode === 'markdown' ? 'md' : null }
    mount() { this.mounted = true }
    unmount() { this.mounted = false }
    applyServerOp() {}
    flushPending() {}
    feedSelection() { return null }
    reloadFromBlocks(blocks, opts) { this.reloaded = { blocks, opts } }
    replaceBody(body) { this.replaced = body }
  }
  class ReloadEditor extends AbstractEditor {
    _createSurface(mode) { return new ReloadSurface(mode) }
  }

  it('wysiwyg branch: fetches, reloadFromBlocks with the block list, restores caret, clears suppression', async () => {
    prevFetch = global.fetch; prevWs = window.sieveWorkspace
    const { ctx, setPosition } = fakeWorkspace()
    fetchReturning({ body: 'ignored', blocks: [{ id: 'b1' }] })
    const ed = new ReloadEditor('u')
    ed.presentSurface('wysiwyg', document.createElement('div'), { body: '', blocks: [] })
    await ed.softReload()
    expect(ed.surface.reloaded).toEqual({ blocks: [{ id: 'b1' }], opts: { allowEmpty: true } })
    expect(setPosition).toHaveBeenCalledWith(ctx)
    expect(ed.isSaveSuppressed()).toBe(false)
  })

  it('markdown branch: fetches, replaceBody with the body, clears suppression', async () => {
    prevFetch = global.fetch; prevWs = window.sieveWorkspace
    fakeWorkspace()
    fetchReturning({ body: 'fresh markdown', blocks: [] })
    const ed = new ReloadEditor('u')
    ed.presentSurface('markdown', document.createElement('div'), 'seed')
    await ed.softReload()
    expect(ed.surface.replaced).toBe('fresh markdown')
    expect(ed.isSaveSuppressed()).toBe(false)
  })

  it('isSaveSuppressed is true mid-flight (before the fetch resolves), false after', async () => {
    prevFetch = global.fetch; prevWs = window.sieveWorkspace
    fakeWorkspace()
    let resolveJson
    global.fetch = vi.fn(() => Promise.resolve({ json: () => new Promise((r) => { resolveJson = r }) }))
    const ed = new ReloadEditor('u')
    ed.presentSurface('wysiwyg', document.createElement('div'), { body: '', blocks: [] })
    const p = ed.softReload()
    expect(ed.isSaveSuppressed()).toBe(true) // reload armed the guard synchronously
    await Promise.resolve()                  // let fetch() resolve so json() is invoked
    expect(ed.isSaveSuppressed()).toBe(true) // still armed while json() is pending
    resolveJson({ body: '', blocks: [] })
    await p
    expect(ed.isSaveSuppressed()).toBe(false)
  })
})

describe('SieveWorkspace chrome delegation (P2.C transitional)', () => {
  it('provideChrome registers impls and each public method delegates', () => {
    const w = new SieveWorkspace()
    const impls = {
      toggleSearch: vi.fn(),
      openWebClipDialog: vi.fn(),
      openUrlCardDialog: vi.fn(),
      copyDocumentAsMarkdown: vi.fn(),
    }
    w.provideChrome(impls)
    w.toggleSearch()
    w.openWebClipDialog()
    w.openUrlCardDialog()
    w.copyDocumentAsMarkdown()
    expect(impls.toggleSearch).toHaveBeenCalledTimes(1)
    expect(impls.openWebClipDialog).toHaveBeenCalledTimes(1)
    expect(impls.openUrlCardDialog).toHaveBeenCalledTimes(1)
    expect(impls.copyDocumentAsMarkdown).toHaveBeenCalledTimes(1)
  })

  it('unregistered chrome methods warn and no-op; partial registration merges', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const w = new SieveWorkspace()
      expect(() => {
        w.toggleSearch(); w.openWebClipDialog(); w.openUrlCardDialog(); w.copyDocumentAsMarkdown()
      }).not.toThrow()
      expect(warn).toHaveBeenCalledTimes(4)
      const a = vi.fn()
      const b = vi.fn()
      w.provideChrome({ toggleSearch: a })
      w.provideChrome({ copyDocumentAsMarkdown: b }) // merges, does not replace
      w.toggleSearch()
      w.copyDocumentAsMarkdown()
      expect(a).toHaveBeenCalledTimes(1)
      expect(b).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

// ── P2.D: Workspace tab-lifecycle verbs (the external API facade) ─────────────
// The verbs are thin owners over the EXISTING htmx.ajax calls the templates run
// today (identical swap semantics). Tests stub window.htmx.ajax to record the
// calls and to resolve so the post-swap prune (.then) fires.

describe('SieveWorkspace tab-lifecycle verbs (P2.D facade)', () => {
  let ws
  let ajaxCalls
  let prevHtmx

  beforeEach(() => {
    ws = new SieveWorkspace()
    ajaxCalls = []
    prevHtmx = window.htmx
    window.htmx = {
      ajax: (method, url, opts) => {
        ajaxCalls.push({ method, url, opts })
        return Promise.resolve()
      },
    }
  })

  afterEach(() => { window.htmx = prevHtmx })

  it('open posts to /api/note/open/{uuid} with the tabbar swap', () => {
    ws.open('doc-1')
    expect(ajaxCalls).toEqual([
      { method: 'POST', url: '/api/note/open/doc-1', opts: { target: '#htmx-tabbar', swap: 'innerHTML' } },
    ])
  })

  it('newNote posts to /api/note/new with the tabbar swap', () => {
    ws.newNote()
    expect(ajaxCalls).toEqual([
      { method: 'POST', url: '/api/note/new', opts: { target: '#htmx-tabbar', swap: 'innerHTML' } },
    ])
  })

  it('reorder posts to /api/tabs/reorder with from/to values', () => {
    ws.reorder(2, 0)
    expect(ajaxCalls).toEqual([
      { method: 'POST', url: '/api/tabs/reorder', opts: { target: '#htmx-tabbar', swap: 'innerHTML', values: { from: 2, to: 0 } } },
    ])
  })

  it('loadTabs GETs /api/tabs into the tabbar', () => {
    ws.loadTabs()
    expect(ajaxCalls).toEqual([
      { method: 'GET', url: '/api/tabs', opts: { target: '#htmx-tabbar', swap: 'innerHTML' } },
    ])
  })

  it('close posts to /api/tabs/close/{uuid} and prunes the closed identity after the swap settles', async () => {
    ws.openTab('doc-a')
    ws.openTab('doc-b') // doc-b active
    await ws.close('doc-a') // background close
    expect(ajaxCalls[0]).toEqual({ method: 'POST', url: '/api/tabs/close/doc-a', opts: { target: '#htmx-tabbar', swap: 'innerHTML' } })
    expect(ws.getTab('doc-a')).toBeNull()          // pruned
    expect(ws.activeTab?.uuid).toBe('doc-b')       // active untouched
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
    const opts = {
      socketFactory: (url) => new FakeSocket(url),
      wsUrl: () => 'ws://test',
      onServerMessage: () => {},
    }
    const tabA = ws.activateDocument('doc-a', opts)
    FakeSocket.instances[0].driveOpen()
    // Successor activates (destroys A's editor, detaches it), THEN the prune runs.
    ws.activateDocument('doc-b', opts)
    expect(tabA.editor).toBeNull() // destroyed+detached by activateDocument
    await ws.close('doc-a')
    expect(ws.getTab('doc-a')).toBeNull()
    expect(ws.activeTab?.uuid).toBe('doc-b')
  })

  it('closeActiveTab closes the active tab; noop when none active', () => {
    ws.closeActiveTab() // no active tab
    expect(ajaxCalls).toEqual([])
    ws.openTab('doc-x')
    ws.closeActiveTab()
    expect(ajaxCalls).toEqual([
      { method: 'POST', url: '/api/tabs/close/doc-x', opts: { target: '#htmx-tabbar', swap: 'innerHTML' } },
    ])
  })

  it('closeAll posts to /api/tabs/closeAll and prunes every tab except the new active', async () => {
    // Model the swap+OOB re-init: the new single note becomes active BEFORE the
    // .then prune runs. Here we simulate that by activating the successor.
    ws.openTab('doc-a')
    ws.openTab('doc-b')
    const p = ws.closeAll()
    // Simulate the OOB re-init activating the fresh note synchronously after the ajax.
    ws.openTab('new-note')
    await p
    expect(ajaxCalls[0]).toEqual({ method: 'POST', url: '/api/tabs/closeAll', opts: { target: '#htmx-tabbar', swap: 'innerHTML' } })
    expect(ws.getTab('doc-a')).toBeNull()
    expect(ws.getTab('doc-b')).toBeNull()
    expect(ws.getTab('new-note')).not.toBeNull() // the new active survives
    expect(ws.activeTab?.uuid).toBe('new-note')
  })

  it('every verb returns the htmx.ajax promise', () => {
    expect(ws.open('d')).toBeInstanceOf(Promise)
    expect(ws.newNote()).toBeInstanceOf(Promise)
    expect(ws.reorder(0, 1)).toBeInstanceOf(Promise)
    expect(ws.loadTabs()).toBeInstanceOf(Promise)
    expect(ws.close('d')).toBeInstanceOf(Promise)
    expect(ws.closeAll()).toBeInstanceOf(Promise)
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
