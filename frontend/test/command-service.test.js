// @ts-check
import { describe, it, expect, beforeEach } from 'vitest'
import { CommandService } from '../src/static/shell/command-service.js'
import { ContractViolation } from '../src/static/contract/sieve-block.js'
import { WorkspaceService } from '../src/static/shell/workspace-service.js'

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
  /** @type {WorkspaceService} */
  let workspace
  /** @type {CommandService} */
  let service

  const commands = [
    { name: 'btw', description: 'Ask by the way', family: 'ai', resultKind: 'ai-block' },
    { name: 'uuid', description: 'Generate a UUID', family: 'util', resultKind: 'command-result' }
  ]

  /**
   * Builds the plane + its command tenant, the way the composition root does
   * (CommandService does not own a socket — it joins one).
   * @param {any[]} cmds
   */
  const buildPlane = (cmds) => {
    const ws = new WorkspaceService({
      socketFactory: (url) => {
        fakeWs = new FakeWebSocket(url)
        return /** @type {any} */ (fakeWs)
      },
      wsUrl: () => 'ws://test/api/ws/workspace'
    })
    return { workspace: ws, service: new CommandService(ws, { commands: cmds }) }
  }

  beforeEach(() => {
    fakeWs = null
    const plane = buildPlane(commands)
    workspace = plane.workspace
    service = plane.service
  })

  it('lists registered commands', () => {
    expect(service.list()).toEqual(commands)
  })

  it('claims only the command-result frame vocabulary on the plane', () => {
    expect(service.frameTypes).toEqual(['command-result'])
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

  it('dispatches command over the plane and handles PENDING and COMPLETE results', async () => {
    workspace.open()

    await new Promise(r => setTimeout(r, 10)) // wait for ws.onopen

    const results = []
    service.dispatch('btw', 'hello', { docId: 'doc-1' }, (res) => {
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
      block: { kind: 'ai-block', attrs: { status: 'COMPLETE', answer: [{ kind: 'prose', attrs: { content: 'ans' } }] } }
    })

    expect(results.length).toBe(2)
    expect(results[1].status).toBe('COMPLETE')

    // Late message should not trigger onResult (handler removed on terminal COMPLETE)
    fakeWs.receive({
      type: 'command-result',
      correlationId: cid,
      cmd: 'btw',
      status: 'COMPLETE',
      block: { kind: 'ai-block', attrs: { status: 'COMPLETE', answer: [{ kind: 'prose', attrs: { content: 'stale' } }] } }
    })
    expect(results.length).toBe(2)
  })

  it('dispatching without an already-open plane opens it lazily', async () => {
    const results = []
    service.dispatch('btw', 'hello', {}, (res) => { results.push(res) })
    await new Promise(r => setTimeout(r, 10))

    expect(fakeWs).not.toBeNull()
    expect(fakeWs.sent.length).toBe(1)
    expect(fakeWs.sent[0].cmd).toBe('btw')

    fakeWs.receive({ type: 'command-result', correlationId: fakeWs.sent[0].correlationId, cmd: 'btw', status: 'COMPLETE' })
    expect(results.length).toBe(1)
  })

  it('ignores a command-result whose correlationId it never dispatched', async () => {
    workspace.open()
    await new Promise(r => setTimeout(r, 10))

    expect(() => fakeWs.receive({
      type: 'command-result',
      correlationId: 'c-never-mine',
      cmd: 'btw',
      status: 'COMPLETE'
    })).not.toThrow()
  })

  it('allows cancelling a pending command dispatch', async () => {
    workspace.open()
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

  it('dispatch sends the resolved descriptor family (util vs ai)', async () => {
    workspace.open()
    await new Promise(r => setTimeout(r, 10))

    service.dispatch('uuid', '', {})
    expect(fakeWs.sent[0].family).toBe('util')
    expect(fakeWs.sent[0].cmd).toBe('uuid')

    service.dispatch('btw', 'hello', {})
    expect(fakeWs.sent[1].family).toBe('ai')
  })

  it('dispatch sends the tolerant floor when the descriptor lacks a family', async () => {
    // Legacy-shaped descriptor: no family field at all.
    const plane = buildPlane([{ name: 'legacy', description: 'no family' }])
    plane.workspace.open()
    await new Promise(r => setTimeout(r, 10))

    plane.service.dispatch('legacy', 'x', {})
    // Empty family = Go's tolerant floor; nothing throws on the missing field.
    expect(fakeWs.sent[0].family).toBe('')
    expect(fakeWs.sent[0].cmd).toBe('legacy')
  })

  it('attachments ride as a TOP-LEVEL sibling of context, never inside it (#74)', async () => {
    workspace.open()
    await new Promise(r => setTimeout(r, 10))

    service.dispatch('btw', 'hello', { docId: 'doc-1' }, undefined, [
      { uri: 'container:9f2b', title: 'Auth Design' },
    ])

    const sent = fakeWs.sent[0]
    // Go's commandEnvelope reads `attachments` as its own field and its
    // Context.Attachments is json:"-" — an attachments key nested inside the
    // lens-authored context would be silently dropped.
    expect(sent.attachments).toEqual([{ uri: 'container:9f2b', title: 'Auth Design' }])
    expect(sent.context).toEqual({ docId: 'doc-1' })
    expect(sent.context.attachments).toBeUndefined()
  })

  it('a dispatch with no attachments still carries the field, empty', async () => {
    workspace.open()
    await new Promise(r => setTimeout(r, 10))

    service.dispatch('btw', 'hello', {})
    expect(fakeWs.sent[0].attachments).toEqual([])
  })

  describe('dispatchFiling — the ai family\'s three verbs', () => {
    const filing = [
      { name: 'file', description: 'File it', family: 'ai' },
      { name: 'metadata', description: 'Re-evaluate', family: 'ai' },
      { name: 'keep-and-file', description: 'Keep, then file', family: 'ai' },
    ]

    it.each(['file', 'metadata', 'keep-and-file'])('sends /%s in the ai family with the document in context.docUuid', async (verb) => {
      const plane = buildPlane(filing)
      plane.workspace.open()
      await new Promise(r => setTimeout(r, 10))

      plane.service.dispatchFiling(/** @type {any} */ (verb), 'doc-42')

      const sent = fakeWs.sent[0]
      expect(sent.cmd).toBe(verb)
      expect(sent.family).toBe('ai')
      // Go's FilingCommand.Build reads exactly this key; an omission is a refusal
      // the caller never sees, since filing produces no result block either way.
      expect(sent.context).toEqual({ docUuid: 'doc-42' })
      expect(sent.args).toEqual({ text: '' })
    })

    it('refuses an unknown verb and a document-less invocation, loudly and before the wire', async () => {
      const plane = buildPlane(filing)
      plane.workspace.open()
      await new Promise(r => setTimeout(r, 10))

      expect(() => plane.service.dispatchFiling(/** @type {any} */ ('smartFile'), 'doc-42')).toThrow(ContractViolation)
      expect(() => plane.service.dispatchFiling('file', '')).toThrow(ContractViolation)
      expect(fakeWs.sent).toEqual([])
    })
  })
})
