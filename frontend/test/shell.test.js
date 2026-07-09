// shell.test.js — P1 unit tests for the Workspace/Tab/Editor shell skeleton.
// Imports the REAL classes from src/static/shell/*.js (dual-use ES modules —
// same pattern as block-position.js), so class drift is caught by the suite.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SieveEditor } from '../src/static/shell/editor-shell.js'
import { SieveTab } from '../src/static/shell/tab.js'
import { SieveWorkspace } from '../src/static/shell/workspace.js'
import { AbstractEditor } from '../src/static/shell/abstract-editor.js'
import { NoteEditor } from '../src/static/shell/note-editor.js'
import { PromptEditor } from '../src/static/shell/prompt-editor.js'

describe('SieveEditor', () => {
  it('exposes uuid via getter', () => {
    const ed = new SieveEditor('abc-123', {
      getMode: () => 'wysiwyg', getTiptap: () => null,
    })
    expect(ed.uuid).toBe('abc-123')
  })

  it('delegates mode to accessor closure', () => {
    let mode = 'wysiwyg'
    const ed = new SieveEditor('abc-123', {
      getMode: () => mode, getTiptap: () => null,
    })
    expect(ed.mode).toBe('wysiwyg')
    mode = 'markdown'
    expect(ed.mode).toBe('markdown') // live delegation
  })

  it('delegates tiptap to accessor closure', () => {
    let tiptap = null
    const ed = new SieveEditor('abc-123', {
      getMode: () => 'wysiwyg', getTiptap: () => tiptap,
    })
    expect(ed.tiptap).toBeNull()
    const fake = { type: 'fake-editor' }
    tiptap = fake
    expect(ed.tiptap).toBe(fake) // live delegation
  })

  it('throws if uuid missing', () => {
    expect(() => new SieveEditor('', {})).toThrow('uuid is required')
  })

  it('throws if accessors missing', () => {
    expect(() => new SieveEditor('abc-123', null)).toThrow('accessors are required')
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
    const ed = new SieveEditor('tab-uuid', {
      getMode: () => 'wysiwyg', getTiptap: () => null,
    })
    tab.attachEditor(ed)
    expect(tab.editor).toBe(ed)
  })

  it('attachEditor rejects non-SieveEditor values', () => {
    const tab = new SieveTab('tab-uuid')
    expect(() => tab.attachEditor({ uuid: 'tab-uuid' })).toThrow('expected SieveEditor')
  })

  it('detachEditor clears the editor', () => {
    const tab = new SieveTab('tab-uuid')
    const ed = new SieveEditor('tab-uuid', {
      getMode: () => 'wysiwyg', getTiptap: () => null,
    })
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
  })

  it('workspace.activeTab.editor.uuid chain works', () => {
    const tab = ws.openTab('chain-test')
    const ed = new SieveEditor('chain-test', {
      getMode: () => 'wysiwyg', getTiptap: () => null,
    })
    tab.attachEditor(ed)
    expect(ws.activeTab.editor.uuid).toBe('chain-test')
  })
})

// ── P2.A: AbstractEditor hierarchy owns WS + save + doc/dirty state ──────────────

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
}

function fakeAccessors(overrides = {}) {
  return Object.assign({
    getMode: () => 'wysiwyg',
    getTiptap: () => null,
    getDocSyncFlush: () => null,
    takePendingMarkdown: () => null,
    getBody: () => '',
    isSaveSuppressed: () => false,
  }, overrides)
}

function makeNote(uuid, accessors = fakeAccessors(), options = {}) {
  const opts = Object.assign({
    socketFactory: (url) => new FakeSocket(url),
    wsUrl: () => 'ws://test/api/ws?uuid=' + uuid,
    onServerMessage: () => {},
  }, options)
  return new NoteEditor(uuid, accessors, opts)
}

describe('AbstractEditor (P2.A base)', () => {
  it('is not directly usable for save/destroy (abstract methods throw)', () => {
    const ed = new AbstractEditor('u', fakeAccessors())
    expect(() => ed.flushSave()).toThrow('must implement flushSave')
    expect(() => ed.destroy()).toThrow('must implement destroy')
  })

  it('tracks dirty state', () => {
    const ed = new AbstractEditor('u', fakeAccessors())
    expect(ed.isDirty).toBe(false)
    ed.markDirty()
    expect(ed.isDirty).toBe(true)
    ed.clearDirty()
    expect(ed.isDirty).toBe(false)
  })

  it('NoteEditor and PromptEditor are AbstractEditor instances', () => {
    FakeSocket.reset()
    expect(makeNote('n')).toBeInstanceOf(AbstractEditor)
    expect(new PromptEditor('prompt:p', fakeAccessors())).toBeInstanceOf(AbstractEditor)
  })
})

describe('SieveTab.createEditor factory (P2.A)', () => {
  beforeEach(() => FakeSocket.reset())

  it('creates a NoteEditor for a note uuid', () => {
    const tab = new SieveTab('note-1')
    const ed = tab.createEditor('note-1', fakeAccessors(), {
      socketFactory: (url) => new FakeSocket(url),
      wsUrl: () => 'ws://test',
    })
    expect(ed).toBeInstanceOf(NoteEditor)
  })

  it('creates a PromptEditor for a prompt: uuid', () => {
    const tab = new SieveTab('prompt:daily')
    const ed = tab.createEditor('prompt:daily', fakeAccessors())
    expect(ed).toBeInstanceOf(PromptEditor)
  })

  it('a NoteEditor opens a socket; a PromptEditor does not', () => {
    const noteTab = new SieveTab('note-2')
    noteTab.createEditor('note-2', fakeAccessors(), {
      socketFactory: (url) => new FakeSocket(url),
      wsUrl: () => 'ws://test',
    })
    expect(FakeSocket.instances.length).toBe(1)

    const promptTab = new SieveTab('prompt:x')
    promptTab.createEditor('prompt:x', fakeAccessors())
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

describe('flushSave routing (P2.A)', () => {
  beforeEach(() => FakeSocket.reset())

  it('NoteEditor markdown mode sends doc-update then flush', () => {
    const ed = makeNote('n', fakeAccessors({
      getMode: () => 'markdown',
      takePendingMarkdown: () => 'the body',
    }))
    const sock = FakeSocket.instances[0]
    sock.driveOpen()
    ed.flushSave()
    expect(sock.sentTypes()).toEqual(['doc-update', 'flush'])
    const docUpdate = JSON.parse(sock.sent[0])
    expect(docUpdate.markdown).toBe('the body')
  })

  it('NoteEditor markdown mode with no pending edit sends only flush', () => {
    const ed = makeNote('n', fakeAccessors({
      getMode: () => 'markdown',
      takePendingMarkdown: () => null,
    }))
    const sock = FakeSocket.instances[0]
    sock.driveOpen()
    ed.flushSave()
    expect(sock.sentTypes()).toEqual(['flush'])
  })

  it('NoteEditor wysiwyg mode calls docSyncFlush then sends flush', () => {
    const flush = vi.fn()
    const ed = makeNote('n', fakeAccessors({
      getMode: () => 'wysiwyg',
      getDocSyncFlush: () => flush,
    }))
    const sock = FakeSocket.instances[0]
    sock.driveOpen()
    ed.flushSave()
    expect(flush).toHaveBeenCalledOnce()
    expect(sock.sentTypes()).toEqual(['flush'])
  })

  it('PromptEditor saves over the injected saveFn (no WS)', async () => {
    const saveFn = vi.fn(() => Promise.resolve())
    const ed = new PromptEditor('prompt:p', fakeAccessors({
      getMode: () => 'markdown',
      getBody: () => 'prompt body',
    }), { saveFn })
    await ed.flushSave()
    expect(saveFn).toHaveBeenCalledWith('prompt:p', 'prompt body', 'markdown')
  })

  it('PromptEditor skips the save while a reload is suppressed', async () => {
    const saveFn = vi.fn(() => Promise.resolve())
    const ed = new PromptEditor('prompt:p', fakeAccessors({
      isSaveSuppressed: () => true,
    }), { saveFn })
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
    const tabA = w.activateDocument('doc-a', fakeAccessors(), loggingOptions(log, 'doc-a'))
    FakeSocket.instances[0].driveOpen()
    const tabB = w.activateDocument('doc-b', fakeAccessors(), loggingOptions(log, 'doc-b'))

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
    const tab1 = w.activateDocument('doc-a', fakeAccessors(), loggingOptions(log, 'doc-a'))
    const ed1 = tab1.editor
    FakeSocket.instances[0].driveOpen()

    const tab2 = w.activateDocument('doc-a', fakeAccessors(), loggingOptions(log, 'doc-a'))
    expect(tab2).toBe(tab1)
    expect(tab2.editor).toBe(ed1) // same instance — no destroy, no new socket
    expect(log.filter((e) => e.startsWith('close:')).length).toBe(0)
    expect(FakeSocket.instances.length).toBe(1)
  })

  it('teardown to empty: single destroy, tab closed, no throw; repeat is a no-op', () => {
    const log = []
    const w = new SieveWorkspace()
    w.activateDocument('doc-a', fakeAccessors(), loggingOptions(log, 'doc-a'))
    FakeSocket.instances[0].driveOpen()

    expect(() => w.activateDocument('', fakeAccessors(), loggingOptions(log, ''))).not.toThrow()
    expect(log.filter((e) => e.startsWith('close:')).length).toBe(1) // exactly one close
    expect(w.getTab('doc-a')).toBeNull()
    expect(w.activeTab).toBeNull()

    // Second teardown with nothing open must not throw or close anything else.
    expect(() => w.activateDocument('', fakeAccessors(), loggingOptions(log, ''))).not.toThrow()
    expect(log.filter((e) => e.startsWith('close:')).length).toBe(1)
  })

  it('prompt tabs participate without ever touching a socket', () => {
    const log = []
    const w = new SieveWorkspace()
    w.activateDocument('doc-a', fakeAccessors(), loggingOptions(log, 'doc-a'))
    const promptTab = w.activateDocument('prompt:p', fakeAccessors(), loggingOptions(log, 'prompt:p'))

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
    const ed = new PromptEditor('prompt:p', fakeAccessors())
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
    const ed = new PromptEditor('prompt:p', fakeAccessors(), { saveFn: () => Promise.resolve() })
    ed.markDirty()
    await ed.flushSave()
    expect(ed.isDirty).toBe(false)
  })
})
