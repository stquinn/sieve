// @ts-check
// The PM half of the 'ai-block' kind's schema, for the one attr that is not a
// scalar: the QUESTION.
//
// A question is a LIST OF BLOCKS, and the data-* costume a block travels to PM
// in carries strings. So the list rides as JSON, the way attachments do — and
// the two halves of that costume, the write (parseAttrs) and the read
// (parseHTML), must be inverses or a document loses its question on the way
// through ProseMirror.
//
// Registration needs a TipTap runtime and is an inert no-op without one, so the
// members this module touches at import time are stubbed BEFORE the import and
// the adapter is read back out of the shared block-kind registry.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getBlockKind } from '../src/static/renderers/block-kinds.js'

const VENDOR = /** @type {any} */ (globalThis).TipTap

/** @type {any} */ let adapter

beforeAll(async () => {
  Object.assign(VENDOR, { PluginKey: class PluginKey {}, Extension: { create: (/** @type {any} */ o) => o } })
  VENDOR.Node = { create: (/** @type {any} */ cfg) => ({ __node: cfg.name }) }
  VENDOR.mergeAttributes = (/** @type {any} */ a, /** @type {any} */ b) => Object.assign({}, a, b)
  await import('../src/static/lens/document-editor/surfaces/node-views/ai-block-node-view.js')
  adapter = getBlockKind('ai-block').renderer
})

afterAll(() => { delete VENDOR.Node; delete VENDOR.mergeAttributes })

/** The data-* element the costume is read back off. @param {string} question */
function elementWith(question) {
  const el = document.createElement('div')
  if (question != null) el.setAttribute('data-question', question)
  return el
}

describe('ai-block NodeView — the question survives the data-* costume', () => {
  it('the list written by parseAttrs is the list parseHTML reads back', () => {
    const question = [
      { kind: 'reference', attrs: { uri: 'sieve://9f2b/pr-1', rel: 'target' } },
      { kind: 'prose', attrs: { content: 'why "this" & <that>?' } },
    ]
    const written = adapter.parseAttrs({ question: question }).question
    expect(typeof written).toBe('string')
    expect(adapter.attrs.question.parseHTML(elementWith(written))).toEqual(question)
  })

  it('a question-less block is the empty list, not a lost one', () => {
    expect(adapter.parseAttrs({}).question).toBe('[]')
    expect(adapter.attrs.question.default).toEqual([])
    expect(adapter.attrs.question.parseHTML(document.createElement('div'))).toEqual([])
  })

  it('an unreadable costume is the empty list rather than a thrown load', () => {
    expect(adapter.attrs.question.parseHTML(elementWith('not json'))).toEqual([])
  })
})
