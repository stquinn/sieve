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
}

// Builds a NoteEditor wired to fakes. The surfaceFactory records every surface
// it makes into `made` and logs lifecycle order into `log`.
function noteRig(uuid, options = {}) {
  const log = []
  const made = []
  const onServerMessage = vi.fn()
  const opts = Object.assign({
    socketFactory: (url) => new FakeSocket(url),
    wsUrl: () => 'ws://test/api/ws?uuid=' + uuid,
    onServerMessage,
    surfaceFactory: (mode) => { const s = new FakeSurface(mode, log); made.push(s); return s },
  }, options)
  const ed = new NoteEditor(uuid, opts)
  return { ed, log, made, onServerMessage, sock: () => FakeSocket.instances[FakeSocket.instances.length - 1] }
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
    const ed = new SieveEditor('abc-123', { surfaceFactory: (m) => new FakeSurface(m) })
    expect(ed.mode).toBe('wysiwyg')
    ed.presentSurface('markdown', document.createElement('div'), 'body')
    expect(ed.mode).toBe('markdown') // live derivation
  })

  it('tiptap is null with no surface and derives from the mounted surface', () => {
    const ed = new SieveEditor('abc-123', { surfaceFactory: (m) => new FakeSurface(m) })
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
  it('flushSave stays abstract; destroy is concrete (unmounts the surface)', () => {
    const ed = new AbstractEditor('u', { surfaceFactory: (m) => new FakeSurface(m) })
    expect(() => ed.flushSave()).toThrow('must implement flushSave')
    const root = document.createElement('div')
    const surface = ed.presentSurface('markdown', root, 'x')
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
  // Captures the editor-provided services bag the factory receives.
  function rigWithServices() {
    let services = null
    const ed = new AbstractEditor('u', {
      surfaceFactory: (m, svc) => { services = svc; return new FakeSurface(m) },
    })
    ed.presentSurface('markdown', document.createElement('div'), 'x')
    return { ed, services: () => services }
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

  it('base submitBlockOps/updateText DROP domain output (prompt behavior)', () => {
    const { services } = rigWithServices()
    expect(() => services().submitBlockOps([{ type: 'update-block', blockId: 'b' }])).not.toThrow()
    expect(() => services().updateText('md')).not.toThrow()
  })
})

describe('NoteEditor domain → wire enveloping (P2.B correction 3)', () => {
  beforeEach(() => FakeSocket.reset())

  it('submitBlockOps envelopes each domain op as block-op, in order, with the uuid', () => {
    const rig = noteRig('n')
    rig.sock().driveOpen()
    rig.ed.submitBlockOps([
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

  it('the services handed to the surface factory route through the enveloping', () => {
    let services = null
    const rig = noteRig('n', {
      surfaceFactory: (m, svc) => { services = svc; return new FakeSurface(m) },
    })
    rig.sock().driveOpen()
    rig.ed.presentSurface('wysiwyg', document.createElement('div'), { body: '', blocks: [] })
    services.submitBlockOps([{ type: 'update-block', blockId: 'b1' }])
    expect(rig.sock().sentOfType('block-op')).toEqual([
      { type: 'block-op', uuid: 'n', op: { type: 'update-block', blockId: 'b1' } },
    ])
  })
})

describe('AbstractEditor.presentSurface (P2.B lifecycle)', () => {
  it('mounts via the factory and stores the root', () => {
    const made = []
    const ed = new AbstractEditor('u', { surfaceFactory: (m) => { const s = new FakeSurface(m); made.push(s); return s } })
    const root = document.createElement('div')
    const s = ed.presentSurface('markdown', root, 'seed')
    expect(made).toEqual([s])
    expect(s.mountArgs).toEqual([root, 'seed'])
    expect(ed.surface).toBe(s)
  })

  it('unmounts the previous surface BEFORE mounting the next', () => {
    const log = []
    const ed = new AbstractEditor('u', { surfaceFactory: (m) => new FakeSurface(m, log) })
    const root = document.createElement('div')
    ed.presentSurface('markdown', root, 'seed')
    ed.presentSurface('wysiwyg', root, { body: '', blocks: [] })
    expect(log).toEqual(['mount:markdown', 'unmount:markdown', 'mount:wysiwyg'])
  })

  it('throws without a surfaceFactory', () => {
    const ed = new AbstractEditor('u')
    expect(() => ed.presentSurface('markdown', document.createElement('div'), '')).toThrow('surfaceFactory')
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

  it('queues sends before open and flushes on open', () => {
    const ed = makeNote('n')
    const sock = FakeSocket.instances[0]
    ed.wsSend({ type: 'block-op', uuid: 'n' }) // socket still CONNECTING → queued
    expect(sock.sent.length).toBe(0)
    sock.driveOpen()
    expect(sock.sentTypes()).toContain('block-op')
  })

  it('sends directly once the socket is OPEN', () => {
    const ed = makeNote('n')
    const sock = FakeSocket.instances[0]
    sock.driveOpen()
    ed.wsSend({ type: 'block-op', uuid: 'n' })
    expect(sock.sentTypes()).toContain('block-op')
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

describe('NoteEditor.wsSendAndAwait (P2.A)', () => {
  beforeEach(() => FakeSocket.reset())
  afterEach(() => vi.useRealTimers())

  it('resolves with the matching ack message', async () => {
    const ed = makeNote('n')
    const sock = FakeSocket.instances[0]
    sock.driveOpen()
    const p = ed.wsSendAndAwait('flush', { type: 'flush', uuid: 'n' })
    expect(sock.sentTypes()).toContain('flush')
    sock.driveMessage({ type: 'flush-ack', uuid: 'n' })
    const msg = await p
    expect(msg.type).toBe('flush-ack')
  })

  it('rejects after a 5s timeout', async () => {
    vi.useFakeTimers()
    const ed = makeNote('n')
    FakeSocket.instances[0].driveOpen()
    const p = ed.wsSendAndAwait('flush', { type: 'flush', uuid: 'n' })
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
    const ed = new PromptEditor('prompt:p', { saveFn, surfaceFactory: (m) => new FakeSurface(m) })
    const s = ed.presentSurface('markdown', document.createElement('div'), 'seed')
    s.bodyValue = 'prompt body'
    await ed.flushSave()
    expect(saveFn).toHaveBeenCalledWith('prompt:p', 'prompt body', 'markdown')
  })

  it('PromptEditor mode is markdown by default (fixed)', () => {
    const ed = new PromptEditor('prompt:p')
    expect(ed.mode).toBe('markdown')
  })

  it('PromptEditor skips the save while a reload is suppressed', async () => {
    const saveFn = vi.fn(() => Promise.resolve())
    const ed = new PromptEditor('prompt:p', { saveFn, isSaveSuppressed: () => true })
    await ed.flushSave()
    expect(saveFn).not.toHaveBeenCalled()
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

describe('module wsSend delegation contract (P2.A fix wave)', () => {
  it('PromptEditor exposes no wsSend, so the editor.js wrapper is a silent no-op', () => {
    const ed = new PromptEditor('prompt:p')
    // editor.js's module-level wsSend guard is `typeof ed.wsSend === 'function'`;
    // PromptEditor must not grow one, or prompt docs would start WS-sending.
    expect(typeof ed.wsSend).not.toBe('function')

    // Replicate the wrapper exactly (editor.js is an IIFE, not importable):
    // it must swallow the message without throwing when the editor has no socket.
    const wsSendWrapper = (editor, msg) => {
      if (editor && typeof editor.wsSend === 'function') editor.wsSend(msg)
    }
    expect(() => wsSendWrapper(ed, { type: 'block-op', uuid: 'prompt:p' })).not.toThrow()
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
    const ed = new PromptEditor('prompt:p', { saveFn: () => Promise.resolve(), surfaceFactory: (m) => new FakeSurface(m) })
    ed.presentSurface('markdown', document.createElement('div'), 'b')
    ed.markDirty()
    await ed.flushSave()
    expect(ed.isDirty).toBe(false)
  })
})
