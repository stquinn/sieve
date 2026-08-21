// workspace-open-url.test.js — regression guard for prompt documents failing
// to open. open() drives the chi path-param route /api/note/open/{id}; the Go
// handler assumes a DECODED id (strings.HasPrefix(id, "prompt:")) and
// chi.URLParam does NOT unescape. A `prompt:` uuid must therefore travel the
// path RAW — exactly as the pre-P2.D templates sent `{{.ID}}`. Percent-encoding
// the colon (encodeURIComponent → %3A) makes the prefix check miss and the open
// 404s. All ids are URL-path-safe (hex-hyphen uuids; `prompt:<slug>`), so raw is
// correct. (close no longer uses a path id — it POSTs a JSON id set to
// /api/tabs/close; see shell.test.js's tab-lifecycle suite.)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Workspace pulls its children at module-eval; SieveTab drags in the editor →
// TipTap chain, which the bare test vendor bag can't build. open()/close() only
// touch window.htmx, so stub the children out (surfaces/ai-target pattern).
vi.mock('../src/static/shell/tab.js', () => ({ SieveTab: class {} }))
vi.mock('../src/static/shell/ask-panel.js', () => ({ AskPanel: class {} }))
vi.mock('../src/static/shell/insert-dialogs.js', () => ({ InsertDialogs: class {} }))
vi.mock('../src/static/shell/search-overlay.js', () => ({ SearchOverlay: class {} }))
vi.mock('../src/static/shell/status-bar.js', () => ({ StatusBar: class {} }))

import { SieveWorkspace } from '../src/static/shell/workspace.js'

let ajax

beforeEach(() => {
  ajax = vi.fn(() => Promise.resolve())
  // @ts-ignore — minimal htmx stub; #ajax only touches window.htmx.ajax.
  window.htmx = { ajax }
})

afterEach(() => {
  // @ts-ignore
  delete window.htmx
  vi.restoreAllMocks()
})

// openAddress is the WHOLE of what JS knows about a coordinate: hand it over,
// get back a uuid, open that. The grammar is Go's (#75) and the round-trip is
// the MentionService tenant's, so these drive the REAL service over a fake
// socket — a stubbed resolver would prove nothing about the thing that broke.
describe('SieveWorkspace.openAddress — Go decides what a coordinate opens', () => {
  class FakeWebSocket {
    /** @type {any} */ onopen = null
    /** @type {any} */ onmessage = null
    /** @type {any} */ onclose = null
    /** @type {any} */ onerror = null
    readyState = 1
    sent = []
    constructor(url) {
      this.url = url
      setTimeout(() => { if (this.onopen) this.onopen() }, 0)
    }
    send(data) { this.sent.push(JSON.parse(data)) }
    close() { if (this.onclose) this.onclose() }
    receive(msg) { if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) }) }
  }

  /** @returns {{ws: any, sockets: FakeWebSocket[]}} */
  function workspaceOnAFakeWire() {
    /** @type {FakeWebSocket[]} */ const sockets = []
    const ws = new SieveWorkspace({
      socketFactory: (url) => {
        const s = new FakeWebSocket(url)
        sockets.push(s)
        return /** @type {any} */ (s)
      },
    })
    return { ws, sockets }
  }

  it('asks Go what the address opens and opens the uuid it answers with', async () => {
    const { ws, sockets } = workspaceOnAFakeWire()
    const opened = ws.openAddress('container:2f1c9a4e-0b7d-4a11-9c3e-6d5f8b2a1e00')
    await new Promise((r) => setTimeout(r, 10))

    const frame = sockets[0].sent[0]
    expect(frame.type).toBe('mention-resolve')
    expect(frame.uri).toBe('container:2f1c9a4e-0b7d-4a11-9c3e-6d5f8b2a1e00')

    sockets[0].receive({
      type: 'mention-resolved', correlationId: frame.correlationId,
      uri: frame.uri, found: true, uuid: '2f1c9a4e-0b7d-4a11-9c3e-6d5f8b2a1e00', blockId: '',
    })
    await opened
    expect(ajax).toHaveBeenCalledWith('POST', '/api/note/open/2f1c9a4e-0b7d-4a11-9c3e-6d5f8b2a1e00', expect.anything())
  })

  // The form the retired JS decode dropped on the floor: its `container:` guard
  // returned early, so the click did nothing and said nothing.
  it('opens the CONTAINER of a block address — the form JS could not have decoded', async () => {
    const { ws, sockets } = workspaceOnAFakeWire()
    const opened = ws.openAddress('block:2f1c9a4e-0b7d-4a11-9c3e-6d5f8b2a1e00/b7')
    await new Promise((r) => setTimeout(r, 10))
    const frame = sockets[0].sent[0]
    sockets[0].receive({
      type: 'mention-resolved', correlationId: frame.correlationId, uri: frame.uri,
      found: true, uuid: '2f1c9a4e-0b7d-4a11-9c3e-6d5f8b2a1e00', blockId: 'b7',
    })
    await opened
    expect(ajax).toHaveBeenCalledWith('POST', '/api/note/open/2f1c9a4e-0b7d-4a11-9c3e-6d5f8b2a1e00', expect.anything())
  })

  it('opens nothing when Go says the address resolves to nothing', async () => {
    const { ws, sockets } = workspaceOnAFakeWire()
    const opened = ws.openAddress('container:gone')
    await new Promise((r) => setTimeout(r, 10))
    const frame = sockets[0].sent[0]
    sockets[0].receive({
      type: 'mention-resolved', correlationId: frame.correlationId, uri: frame.uri,
      found: false, error: 'node: address resolves to nothing',
    })
    expect(await opened).toBe(false)
    // Named specifically: this module's Workspace singleton (created at import,
    // subscribed to the invalidation events) refetches the tab strip when the
    // fake socket connects, so "no ajax at all" would be asserting the harness.
    expect(ajax).not.toHaveBeenCalledWith('POST', expect.stringContaining('/api/note/open/'), expect.anything())
  })

  it('an empty address opens nothing and never reaches the wire', async () => {
    const { ws, sockets } = workspaceOnAFakeWire()
    expect(await ws.openAddress('')).toBe(false)
    expect(sockets.length).toBe(0)
    expect(ajax).not.toHaveBeenCalled()
  })
})

describe('SieveWorkspace tab-lifecycle URLs', () => {
  it('opens a prompt document with a RAW (unencoded) path id', () => {
    new SieveWorkspace().open('prompt:file')
    expect(ajax).toHaveBeenCalledWith('POST', '/api/note/open/prompt:file', expect.anything())
  })

  it('leaves plain (URL-safe) note uuids untouched', () => {
    const uuid = '2f1c9a4e-0b7d-4a11-9c3e-6d5f8b2a1e00'
    new SieveWorkspace().open(uuid)
    expect(ajax).toHaveBeenCalledWith('POST', '/api/note/open/' + uuid, expect.anything())
  })
})
