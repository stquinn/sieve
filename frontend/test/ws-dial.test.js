// @ts-check
// ws-dial.test.js — the credential half of a WS dial. Go refuses an upgrade that
// does not present the run's token (requesthandlers/ws_handler.go
// authorizeUpgrade), so a wire owner that dials without it connects to nothing.
import { describe, it, expect, afterEach } from 'vitest'
import { WsDial } from '../src/static/container/ws-dial.js'
import { WorkspaceService } from '../src/static/shell/workspace-service.js'
import { ContainerTransport } from '../src/static/container/container-transport.js'
import { WS_SUBPROTOCOL } from '../src/static/generated/protocol.js'

class FakeWebSocket {
  /** @type {any} */ onopen = null
  /** @type {any} */ onmessage = null
  /** @type {any} */ onclose = null
  /** @type {any} */ onerror = null
  readyState = 1
  constructor(url) { this.url = url }
  send() {}
  close() {}
}

/** The shell writes this global; a test that sets it must put it back. */
const setToken = (token) => {
  if (token === undefined) delete (/** @type {any} */ (window)).__sieveWsToken
  else (/** @type {any} */ (window)).__sieveWsToken = token
}

afterEach(() => setToken(undefined))

describe('WsDial — how a wire is dialled', () => {
  it('offers the version word first and the run token second', () => {
    setToken('tok-123')
    expect(WsDial.protocols()).toEqual([WS_SUBPROTOCOL, 'tok-123'])
  })

  it('offers the version word alone when the page carries no token', () => {
    expect(WsDial.protocols()).toEqual([WS_SUBPROTOCOL])
  })
})

describe('the wire owners present the credential', () => {
  it('WorkspaceService dials the workspace channel with the protocol list', () => {
    setToken('tok-ws')
    /** @type {string[][]} */ const offered = []
    const service = new WorkspaceService({
      socketFactory: (url, protocols) => {
        offered.push(protocols || [])
        return /** @type {any} */ (new FakeWebSocket(url))
      },
      wsUrl: () => 'ws://test/api/ws/workspace',
    })
    service.open()
    expect(offered).toEqual([[WS_SUBPROTOCOL, 'tok-ws']])
    service.close()
  })

  it('ContainerTransport dials a document channel with the protocol list', () => {
    setToken('tok-doc')
    /** @type {string[][]} */ const offered = []
    const service = new ContainerTransport({
      socketFactory: (url, protocols) => {
        offered.push(protocols || [])
        return /** @type {any} */ (new FakeWebSocket(url))
      },
      wsUrlFor: (uuid) => 'ws://test/api/ws/document/' + uuid,
    })
    service.openChannel('doc-1', /** @type {any} */ ({ onMessage() {} }))
    expect(offered).toEqual([[WS_SUBPROTOCOL, 'tok-doc']])
    service.closeChannel('doc-1')
  })
})
