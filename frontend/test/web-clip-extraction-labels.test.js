// @ts-check
// web-clip-extraction-labels.test.js — web-clip is the ONE kind that supplies its
// own extraction menu items (getExtractionMenuItems), so it is the one kind whose
// menu wording sits outside action-label.js's regression gate. It drifted: a
// private "Upgrade to" verb for transform, where every other kind said "Convert
// to" (#67). This suite is that gate.
//
// The assertions are DERIVED from labelForAction, never spelled out: if the
// framework's verb map changes, web-clip must follow it here, and a re-introduced
// private verb fails. Only the mode suffix — "(Fetch)" / "(Summarise)", the choice
// this kind genuinely owns — is asserted literally.
//
// It exercises the SHIPPING adapter, reached through the framework's own
// registration seam (rendererFor), not a copy: a FAKE TipTap runtime is seeded onto
// the shared globalThis.TipTap bag BEFORE the modules load (NodeViewRegistry's
// constructor captures it, and register() is an inert no-op without it — see
// node-view-registry.test.js).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { labelForAction } from '../src/static/renderers/action-label.js'

const VENDOR = /** @type {any} */ (globalThis).TipTap

/** @type {any} */ let adapter

beforeAll(async () => {
  VENDOR.Node = { create: (/** @type {any} */ cfg) => ({ __node: cfg.name }) }
  VENDOR.mergeAttributes = (/** @type {any} */ a, /** @type {any} */ b) => Object.assign({}, a, b)
  await import('../src/static/lens/document-editor/surfaces/node-views/web-clip-node-view.js')
  const { rendererFor } = await import('../src/static/lens/document-editor/surfaces/sieve-block-extension.js')
  adapter = rendererFor('web-clip')
})

afterAll(() => { delete VENDOR.Node; delete VENDOR.mergeAttributes })

/** @param {string} operation */
function labels(operation) {
  return adapter.getExtractionMenuItems(null, [], () => {}, { operation }).map((/** @type {any} */ i) => i.label)
}

describe('web-clip extraction menu items', () => {
  it('registers through the framework seam (the shipping adapter, not a copy)', () => {
    expect(adapter).toBeTruthy()
    expect(typeof adapter.getExtractionMenuItems).toBe('function')
  })

  it('TRANSFORM uses the FRAMEWORK verb — the same one every other kind gets', () => {
    const verb = labelForAction('transform', adapter.getFriendlyName(), { kind: 'web-clip' })
    expect(verb).toBe('Convert to Web Clip')          // pins the wording the owner chose
    expect(labels('transform')).toEqual([verb + ' (Fetch)', verb + ' (Summarise)'])
  })

  it('EXTRACT uses the framework verb too (additive: the source block survives)', () => {
    const verb = labelForAction('extract', adapter.getFriendlyName(), { kind: 'web-clip' })
    expect(verb).toBe('Extract as Web Clip')
    expect(labels('extract')).toEqual([verb + ' (Fetch)', verb + ' (Summarise)'])
  })

  it('never re-introduces a private verb ("Upgrade to", #67)', () => {
    for (const label of [...labels('transform'), ...labels('extract')]) {
      expect(label).not.toContain('Upgrade')
    }
  })

  it('a missing operation degrades to the extract verb, never to a bare kind name', () => {
    expect(labels(undefined)).toEqual(labels('extract'))
  })

  it('each item plays its own mode back through the framework-supplied dispatch', () => {
    /** @type {any[]} */
    const played = []
    const items = adapter.getExtractionMenuItems(null, [], (/** @type {any} */ ctx) => played.push(ctx), { operation: 'transform' })
    items.forEach((/** @type {any} */ i) => i.action())
    expect(played).toEqual([{ mode: 'fetch' }, { mode: 'summarise' }])
  })
})
