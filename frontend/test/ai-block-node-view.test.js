// @ts-check
// The PM half of the 'ai-block' kind's schema, for the attrs that are not
// scalars: the QUESTION and the ANSWER.
//
// Both sides of an exchange are LISTS OF BLOCKS, and the data-* costume a block
// travels to PM in carries strings. So each list rides as JSON, the way
// attachments do — and the two halves of that costume, the write (parseAttrs)
// and the read (parseHTML), must be inverses or a document loses that slot on
// the way through ProseMirror.
//
// Registration needs a TipTap runtime and is an inert no-op without one, so the
// members this module touches at import time are stubbed BEFORE the import and
// the adapter is read back out of the shared block-kind registry.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getBlockKind } from '../src/static/renderers/block-kinds.js'
import { AiBlockRenderer } from '../src/static/renderers/ai-block-renderer.js'

const VENDOR = /** @type {any} */ (globalThis).TipTap

/** @type {any} */ let adapter
/** @type {(node: any, overlay: any, provider?: any) => import('../src/static/contract/sieve-block.js').SieveBlock} */
let sieveBlockFor

beforeAll(async () => {
  Object.assign(VENDOR, { PluginKey: class PluginKey {}, Extension: { create: (/** @type {any} */ o) => o } })
  VENDOR.Node = { create: (/** @type {any} */ cfg) => ({ __node: cfg.name }) }
  VENDOR.mergeAttributes = (/** @type {any} */ a, /** @type {any} */ b) => Object.assign({}, a, b)
  await import('../src/static/lens/document-editor/surfaces/node-views/ai-block-node-view.js')
  adapter = getBlockKind('ai-block').renderer
  sieveBlockFor = (await import('../src/static/lens/document-editor/surfaces/sieve-block-extension.js')).sieveBlockFor
})

afterAll(() => { delete VENDOR.Node; delete VENDOR.mergeAttributes })

/** The data-* element the costume is read back off. @param {string} slot @param {string} written */
function elementWith(slot, written) {
  const el = document.createElement('div')
  if (written != null) el.setAttribute('data-' + slot, written)
  return el
}

describe('ai-block NodeView — both sides of the exchange survive the data-* costume', () => {
  const LISTS = {
    question: [
      { kind: 'reference', attrs: { uri: 'sieve://9f2b/pr-1', rel: 'target' } },
      { kind: 'prose', attrs: { content: 'why "this" & <that>?' } },
    ],
    answer: [
      { kind: 'prose', attrs: { content: 'because of "this" & <that>' } },
      { kind: 'code', attrs: { language: 'go', source: 'func f() {}' } },
    ],
  }

  for (const slot of ['question', 'answer']) {
    it('the ' + slot + ' list written by parseAttrs is the list parseHTML reads back', () => {
      const list = LISTS[slot]
      const written = adapter.parseAttrs({ [slot]: list })[slot]
      expect(typeof written).toBe('string')
      expect(adapter.attrs[slot].parseHTML(elementWith(slot, written))).toEqual(list)
    })

    it('a block with no ' + slot + ' is the empty list, not a lost one', () => {
      expect(adapter.parseAttrs({})[slot]).toBe('[]')
      expect(adapter.attrs[slot].default).toEqual([])
      expect(adapter.attrs[slot].parseHTML(document.createElement('div'))).toEqual([])
    })

    it('an unreadable ' + slot + ' costume is the empty list rather than a thrown load', () => {
      expect(adapter.attrs[slot].parseHTML(elementWith(slot, 'not json'))).toEqual([])
    })
  }

  it('a degraded scalar answer survives the costume as the string it is', () => {
    const written = adapter.parseAttrs({ answer: 'a producer that composed no blocks' }).answer
    expect(adapter.attrs.answer.parseHTML(elementWith('answer', written))).toBe('a producer that composed no blocks')
  })

  it('the retired `response` attr is gone from the schema', () => {
    expect(adapter.attrs.response).toBeUndefined()
    expect('response' in adapter.parseAttrs({ response: 'legacy' })).toBe(false)
  })
})

// ── The answer reaches the body projection ───────────────────────────────────
// The editor lens does not render the body itself: the seam builds a FRESH
// scratch renderer from the PM node — `new RendererClass(sieveBlockFor(n, …))`
// — and projects its bodyMarkdown() into contentDOM. So the answer has to
// survive whichever of the two paths sieveBlockFor takes, and the costume above
// is what makes the second of them possible.

describe('ai-block NodeView — the answer reaches the scratch renderer the seam builds', () => {
  const ID = '0198c1a0-0000-7000-8000-000000000020'
  const ANSWER = [{ kind: 'prose', attrs: { content: 'the pool was exhausted first' } }]
  /** The seam's own call, verbatim. @param {any} node @param {any} [provider] */
  const projected = (node, provider) => new AiBlockRenderer(sieveBlockFor(node, undefined, provider)).bodyMarkdown()

  it('container HIT: the answer Go holds is what the body projects', () => {
    const held = { id: ID, kind: 'ai-block', attrs: { id: ID, status: 'COMPLETE', answer: ANSWER } }
    const provider = { getBlock: (/** @type {string} */ id) => (id === ID ? held : null) }
    const node = { type: { name: 'sieve-ai-block' }, attrs: { id: ID, status: 'COMPLETE', answer: [] } }
    expect(projected(node, provider)).toBe('the pool was exhausted first')
  })

  it('PM RESURRECT: the answer read off the costume is what the body projects', () => {
    const attrs = {
      id: ID,
      status: 'COMPLETE',
      answer: adapter.attrs.answer.parseHTML(elementWith('answer', adapter.parseAttrs({ answer: ANSWER }).answer)),
    }
    expect(projected({ type: { name: 'sieve-ai-block' }, attrs })).toBe('the pool was exhausted first')
  })
})
