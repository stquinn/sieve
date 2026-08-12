// @ts-check
// workspace-service.test.js — the session-channel wire owner (#74 P1).
// The point of the extraction is multi-tenancy on ONE socket: commands are no
// longer the wire's only tenant, so ownership moves off CommandService.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { WorkspaceService } from '../src/static/block/workspace-service.js'
import { ContractViolation } from '../src/static/block/sieve-block.js'

class FakeWebSocket {
  /** @type {any} */ onopen = null
  /** @type {any} */ onmessage = null
  /** @type {any} */ onclose = null
  /** @type {any} */ onerror = null
  readyState = 1 // OPEN
  sent = []
  closed = false

  constructor(url) {
    this.url = url
    setTimeout(() => { if (this.onopen) this.onopen() }, 0)
  }

  send(data) { this.sent.push(JSON.parse(data)) }
  close() { this.closed = true; if (this.onclose) this.onclose() }
  receive(msg) { if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) }) }
}

/**
 * A minimal tenant: declares its frame vocabulary, records what it is handed.
 * @param {string[]} frameTypes
 */
function fakeTenant(frameTypes) {
  return {
    frameTypes: frameTypes,
    received: /** @type {any[]} */ ([]),
    /** @param {Record<string, any>} frame */
    onFrame(frame) { this.received.push(frame) },
  }
}

describe('WorkspaceService — the session-channel wire owner', () => {
  /** @type {FakeWebSocket[]} */ let sockets
  /** @type {WorkspaceService} */ let service

  beforeEach(() => {
    sockets = []
    service = new WorkspaceService({
      socketFactory: (url) => {
        const ws = new FakeWebSocket(url)
        sockets.push(ws)
        return /** @type {any} */ (ws)
      },
      wsUrl: () => 'ws://test/api/ws?session=1',
    })
  })

  /** @returns {FakeWebSocket} the live socket (fails loudly if there is not exactly one) */
  const liveSocket = () => {
    expect(sockets.length).toBe(1)
    return sockets[0]
  }

  it('routes each inbound frame to the tenant that claims its type — and only that one', async () => {
    const commands = fakeTenant(['command-result'])
    const mentions = fakeTenant(['mention-result'])
    service.registerTenant(commands)
    service.registerTenant(mentions)
    service.open()
    await new Promise((r) => setTimeout(r, 10))

    liveSocket().receive({ type: 'command-result', correlationId: 'c-1', status: 'PENDING' })
    liveSocket().receive({ type: 'mention-result', correlationId: 'c-2', candidates: [] })

    expect(commands.received.map((f) => f.correlationId)).toEqual(['c-1'])
    expect(mentions.received.map((f) => f.correlationId)).toEqual(['c-2'])
  })

  it('drops a frame no tenant claims without throwing', async () => {
    const commands = fakeTenant(['command-result'])
    service.registerTenant(commands)
    service.open()
    await new Promise((r) => setTimeout(r, 10))

    expect(() => liveSocket().receive({ type: 'unclaimed-frame', correlationId: 'c-9' })).not.toThrow()
    expect(commands.received).toEqual([])
  })

  it('drops an inbound frame with no type at all without throwing', async () => {
    service.registerTenant(fakeTenant(['command-result']))
    service.open()
    await new Promise((r) => setTimeout(r, 10))

    expect(() => liveSocket().receive({ correlationId: 'c-9' })).not.toThrow()
  })

  it('keeps ONE socket for many tenants — repeated open() never opens a second', async () => {
    service.registerTenant(fakeTenant(['command-result']))
    service.open()
    service.registerTenant(fakeTenant(['mention-result']))
    service.open()
    service.send({ type: 'command', correlationId: 'c-1' })
    await new Promise((r) => setTimeout(r, 10))

    expect(sockets.length).toBe(1)
  })

  it('rejects a second tenant claiming a frame type already claimed', () => {
    service.registerTenant(fakeTenant(['command-result']))
    expect(() => service.registerTenant(fakeTenant(['command-result', 'mention-result'])))
      .toThrow(ContractViolation)
  })

  it('rejects a tenant that declares no frame types or no onFrame', () => {
    expect(() => service.registerTenant(/** @type {any} */ ({ frameTypes: [], onFrame: () => {} })))
      .toThrow(ContractViolation)
    expect(() => service.registerTenant(/** @type {any} */ ({ frameTypes: ['x'] })))
      .toThrow(ContractViolation)
  })

  it('unregisters a tenant, freeing its frame types for a later claim', async () => {
    const first = fakeTenant(['command-result'])
    const unregister = service.registerTenant(first)
    service.open()
    await new Promise((r) => setTimeout(r, 10))

    unregister()
    liveSocket().receive({ type: 'command-result', correlationId: 'c-1' })
    expect(first.received).toEqual([])

    const second = fakeTenant(['command-result'])
    expect(() => service.registerTenant(second)).not.toThrow()
    liveSocket().receive({ type: 'command-result', correlationId: 'c-2' })
    expect(second.received.length).toBe(1)
  })

  it('isolates a throwing tenant — the wire survives and siblings keep receiving', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bad = {
      frameTypes: ['command-result'],
      onFrame() { throw new Error('tenant exploded') },
    }
    const good = fakeTenant(['mention-result'])
    service.registerTenant(bad)
    service.registerTenant(good)
    service.open()
    await new Promise((r) => setTimeout(r, 10))

    expect(() => liveSocket().receive({ type: 'command-result' })).not.toThrow()
    liveSocket().receive({ type: 'mention-result', correlationId: 'c-2' })
    expect(good.received.length).toBe(1)
    spy.mockRestore()
  })

  it('send() opens the channel lazily and puts the frame on the wire', async () => {
    service.send({ type: 'command', cmd: 'btw', correlationId: 'c-1' })
    await new Promise((r) => setTimeout(r, 10))

    expect(liveSocket().sent).toEqual([{ type: 'command', cmd: 'btw', correlationId: 'c-1' }])
  })

  it('close() tears the socket down; tenants outlive it and a later send re-opens', async () => {
    const commands = fakeTenant(['command-result'])
    service.registerTenant(commands)
    service.open()
    await new Promise((r) => setTimeout(r, 10))
    const first = liveSocket()

    service.close()
    expect(first.closed).toBe(true)

    // Registrations are plane-level, not socket-level: the tenant is still
    // routed on the replacement wire.
    service.send({ type: 'command', correlationId: 'c-1' })
    await new Promise((r) => setTimeout(r, 10))
    expect(sockets.length).toBe(2)
    sockets[1].receive({ type: 'command-result', correlationId: 'c-1' })
    expect(commands.received.length).toBe(1)
  })
})
