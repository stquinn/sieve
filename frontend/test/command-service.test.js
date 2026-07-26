// @ts-check
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { CommandService } from '../src/static/block/command-service.js'

class FakeWebSocket {
  /** @type {any} */
  onopen = null
  /** @type {any} */
  onmessage = null
  /** @type {any} */
  onclose = null
  /** @type {any} */
  onerror = null
  readyState = 1 // OPEN
  sent = []

  constructor(url) {
    this.url = url
    setTimeout(() => {
      if (this.onopen) this.onopen()
    }, 0)
  }

  send(data) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    if (this.onclose) this.onclose()
  }

  receive(msg) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) })
  }
}

describe('CommandService', () => {
  /** @type {FakeWebSocket|null} */
  let fakeWs = null
  /** @type {CommandService} */
  let service

  const commands = [
    { name: 'btw', description: 'Ask by the way' }
  ]

  beforeEach(() => {
    fakeWs = null
    service = new CommandService({
      socketFactory: (url) => {
        fakeWs = new FakeWebSocket(url)
        return /** @type {any} */ (fakeWs)
      },
      wsUrl: () => 'ws://test/api/ws?session=true',
      commands: commands
    })
  })

  it('lists registered commands', () => {
    expect(service.list()).toEqual(commands)
  })

  it('resolves slash commands correctly', () => {
    expect(service.resolve('/btw what is this')).toEqual({
      cmd: commands[0],
      args: 'what is this'
    })
    expect(service.resolve('/BTW what is this')).toEqual({
      cmd: commands[0],
      args: 'what is this'
    })
    expect(service.resolve('/unknown foo')).toBeNull()
    expect(service.resolve('not a command')).toBeNull()
  })

  it('dispatches command over channel and handles PENDING and COMPLETE results', async () => {
    service.openChannel({
      applyServerOp: () => {},
      onFlushAck: () => {},
      onMessage: () => {},
      resolveInsertIndex: () => 0
    })

    await new Promise(r => setTimeout(r, 10)) // wait for ws.onopen

    const results = []
    const handle = service.dispatch('btw', 'hello', { docId: 'doc-1' }, (res) => {
      results.push(res)
    })

    expect(fakeWs.sent.length).toBe(1)
    const sent = fakeWs.sent[0]
    expect(sent.type).toBe('command')
    expect(sent.family).toBe('ai')
    expect(sent.cmd).toBe('btw')
    expect(sent.args.text).toBe('hello')
    expect(sent.context).toEqual({ docId: 'doc-1' })
    const cid = sent.correlationId

    // Receive PENDING
    fakeWs.receive({
      type: 'command-result',
      correlationId: cid,
      cmd: 'btw',
      status: 'PENDING',
      block: { kind: 'ai-block', attrs: { status: 'PENDING' } }
    })

    expect(results.length).toBe(1)
    expect(results[0].status).toBe('PENDING')

    // Receive COMPLETE
    fakeWs.receive({
      type: 'command-result',
      correlationId: cid,
      cmd: 'btw',
      status: 'COMPLETE',
      block: { kind: 'ai-block', attrs: { status: 'COMPLETE', response: 'ans' } }
    })

    expect(results.length).toBe(2)
    expect(results[1].status).toBe('COMPLETE')

    // Late message should not trigger onResult (handler removed on terminal COMPLETE)
    fakeWs.receive({
      type: 'command-result',
      correlationId: cid,
      cmd: 'btw',
      status: 'COMPLETE',
      block: { kind: 'ai-block', attrs: { status: 'COMPLETE', response: 'stale' } }
    })
    expect(results.length).toBe(2)
  })

  it('allows cancelling a pending command dispatch', async () => {
    service.openChannel({
      applyServerOp: () => {},
      onFlushAck: () => {},
      onMessage: () => {},
      resolveInsertIndex: () => 0
    })
    await new Promise(r => setTimeout(r, 10))

    const results = []
    const handle = service.dispatch('btw', 'cancel me', {}, (res) => {
      results.push(res)
    })

    const cid = fakeWs.sent[0].correlationId
    handle.cancel()

    expect(fakeWs.sent.length).toBe(2)
    expect(fakeWs.sent[1]).toEqual({
      type: 'command-cancel',
      correlationId: cid
    })

    // Further results for cancelled correlationId should be ignored
    fakeWs.receive({
      type: 'command-result',
      correlationId: cid,
      cmd: 'btw',
      status: 'COMPLETE',
      block: { kind: 'ai-block', attrs: { status: 'COMPLETE' } }
    })
    expect(results.length).toBe(0)
  })
})
