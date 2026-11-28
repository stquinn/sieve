// @ts-check
// chat-provider-adapter.test.js — a chat's provider: its exchanges read as the
// follower model holds them, a question asked and an unanswered exchange retried
// as the frames that leave on the chat's channel, and the chat named now or by
// hand as the requests that go to its routes. The read minimum and the feed are
// the base adapter's (provider-adapter.test.js).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { providerRig, FakeSocket } from './helpers/service-rig.js'
import { ContainerModel } from '../src/static/container/container-model.js'
import { ChatProviderAdapter } from '../src/static/container/chat-provider-adapter.js'
import { ProviderAdapter } from '../src/static/container/provider-adapter.js'
import { DocumentFrame } from '../src/static/generated/protocol.js'
import { ContractViolation } from '../src/static/contract/sieve-block.js'

const CHAT = '0198c1a0-0000-7000-8000-0000000000c1'
const X1 = '0198c1a0-0000-7000-8000-0000000000e1'
const X2 = '0198c1a0-0000-7000-8000-0000000000e2'
const CODE = '0198c1a0-0000-7000-8000-0000000000f1'

const prose = (/** @type {string} */ content) => ({ kind: 'prose', attrs: { content } })

/** A chat holding two exchanges, the first answered, the second failed. */
function rig() {
  const r = providerRig({
    uuid: CHAT, kind: 'chat', Adapter: ChatProviderAdapter, blocks: [
      { id: X1, kind: 'ai-block', attrs: { status: 'COMPLETE', question: [prose('why?')], answer: [prose('because')] } },
      { id: X2, kind: 'ai-block', attrs: { status: 'ERROR', question: [prose('and then?')], answer: [] } },
    ],
  })
  return Object.assign(r, { chat: /** @type {ChatProviderAdapter} */ (r.provider) })
}

describe('ChatProviderAdapter', () => {
  beforeEach(() => FakeSocket.reset())

  it('demands a DocumentService, and is read as any provider is, its kind the chat\'s', () => {
    expect(() => new ChatProviderAdapter(new ContainerModel(CHAT, 'chat'), /** @type {any} */ ({}))).toThrow(ContractViolation)
    const { chat } = rig()
    expect(chat).toBeInstanceOf(ProviderAdapter)
    expect(chat.getKind()).toBe('chat')
    expect(chat.getOrder()).toEqual([X1, X2])
  })

  it('getExchanges is the exchanges in the chat\'s order, frozen copies', () => {
    const { chat } = rig()
    const exchanges = chat.getExchanges()
    expect(exchanges.map((x) => x.id)).toEqual([X1, X2])
    expect(exchanges[0].attrs.answer).toEqual([prose('because')])
    expect(Object.isFrozen(exchanges)).toBe(true)
    expect(Object.isFrozen(exchanges[0].attrs.answer[0])).toBe(true)
  })

  it('a new exchange and each block of its answer arrive as the frames a note\'s blocks do', () => {
    const { chat, sock } = rig()
    /** @type {any[]} */ const changes = []
    chat.subscribe({ onChanged: (c) => changes.push(c) })
    changes.length = 0
    const X3 = '0198c1a0-0000-7000-8000-0000000000e3'
    sock.driveMessage({ type: DocumentFrame.INSERT_BLOCK, id: X3, kind: 'ai-block', index: -1, attrs: { status: 'PENDING', question: [prose('more')] } })
    sock.driveMessage({ type: DocumentFrame.BLOCK_ATTRS_UPDATED, id: X3, attrs: { status: 'PENDING', answer: [prose('one')] } })
    expect(changes.map((c) => [c.blockIds, c.orderChanged])).toEqual([[[X3], true], [[X3], false]])
    const last = chat.getExchanges().at(-1)
    expect(last?.id).toBe(X3)
    expect(last?.attrs.question).toEqual([prose('more')])
    expect(last?.attrs.answer).toEqual([prose('one')])
  })

  it('requestAsk sends the question as the chat-append-exchange frame, each block in wire shape, and writes nothing', () => {
    const { chat, sock, model } = rig()
    const before = model.getOrder()
    chat.requestAsk([prose('first'), { kind: 'code', attrs: { id: CODE, source: 'x := 1', language: 'go' } }])
    expect(sock.sentOfType(DocumentFrame.CHAT_APPEND_EXCHANGE)).toEqual([{
      type: 'chat-append-exchange',
      question: [
        { id: '', kind: 'prose', attrs: { content: 'first' } },
        { id: CODE, kind: 'code', attrs: { id: CODE, source: 'x := 1', language: 'go' } },
      ],
    }])
    expect(model.getOrder()).toEqual(before)
  })

  it.each([
    ['an empty question', []],
    ['no list at all', /** @type {any} */ (null)],
  ])('requestAsk drops %s with a warning, sending nothing', (_name, question) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { chat, sock } = rig()
    chat.requestAsk(question)
    expect(sock.sentOfType(DocumentFrame.CHAT_APPEND_EXCHANGE)).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it.each([
    ['nameNow', (/** @type {ChatProviderAdapter} */ chat) => chat.nameNow(), '/describe', undefined],
    ['rename', (/** @type {ChatProviderAdapter} */ chat) => chat.rename('  Mine  '), '/rename', JSON.stringify({ name: '  Mine  ' })],
    ['rename to blank', (/** @type {ChatProviderAdapter} */ chat) => chat.rename(''), '/rename', JSON.stringify({ name: '' })],
  ])('%s posts to the chat\'s route, sending nothing on its channel, and resolves once it is taken', async (_name, call, route, body) => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })))
    vi.stubGlobal('fetch', fetch)
    try {
      const { chat, sock, model } = rig()
      const before = model.getOrder()
      const sent = sock.sent.length
      await expect(call(chat)).resolves.toBeUndefined()
      expect(fetch.mock.calls.map(([url, init]) => [url, /** @type {any} */ (init).method, /** @type {any} */ (init).body]))
        .toEqual([['/api/chat/' + CHAT + route, 'POST', body]])
      expect(sock.sent.length).toBe(sent)
      expect(model.getOrder()).toEqual(before)
    } finally { vi.unstubAllGlobals() }
  })

  it.each([
    ['nameNow', (/** @type {ChatProviderAdapter} */ chat) => chat.nameNow()],
    ['rename', (/** @type {ChatProviderAdapter} */ chat) => chat.rename('Mine')],
  ])('%s rejects with the host\'s words when the route refuses', async (_name, call) => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('This chat has no answer to name it from yet.\n', { status: 409 }))))
    try {
      const { chat } = rig()
      await expect(call(chat)).rejects.toThrow('This chat has no answer to name it from yet.')
    } finally { vi.unstubAllGlobals() }
  })

  it('requestRetry sends retry-block-job naming the exchange, and drops an id the chat does not hold', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { chat, sock } = rig()
    chat.requestRetry(X2)
    chat.requestRetry('0198c1a0-0000-7000-8000-0000000000ff')
    expect(sock.sentOfType(DocumentFrame.RETRY_BLOCK_JOB)).toEqual([{ type: 'retry-block-job', uuid: CHAT, id: X2 }])
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
