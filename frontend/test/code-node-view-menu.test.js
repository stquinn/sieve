// @ts-check
// The 'code' kind's context-menu declaration: the Language flyout, whose accept
// COMMITS THROUGH THE WALL — one requestSetBlock carrying both the picked
// language and the `manual` detection method, so the server's detection
// pipeline never second-guesses a human's pick.
//
// Registration needs a TipTap runtime (NodeViewRegistry.register is an inert
// no-op without one), so a marker Node.create is seeded BEFORE the import, the
// way reference-node-view.test.js does.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { getBlockKind } from '../src/static/renderers/block-kinds.js'

// The enumeration is the registry's and has its own tests (context-menu-
// structure); here it is seeded so the assertions are about the FLYOUT's shape
// and its commit, not about which languages ship.
const REGISTERED = ['python', 'go', 'bash']
vi.mock('../src/static/renderers/highlighting.js', () => ({
  getLowlight: () => ({ listLanguages: () => REGISTERED }),
  listRegisteredLanguages: () => REGISTERED.slice().sort(),
  hastToHtml: () => '',
  applyHighlighting: () => {},
}))

const VENDOR = /** @type {any} */ (globalThis).TipTap

/** @type {any} */ let adapter

beforeAll(async () => {
  VENDOR.Node = { create: (/** @type {any} */ cfg) => ({ __node: cfg.name }) }
  VENDOR.mergeAttributes = (/** @type {any} */ a, /** @type {any} */ b) => Object.assign({}, a, b)
  await import('../src/static/lens/document-editor/surfaces/node-views/code-node-view.js')
  adapter = getBlockKind('code').renderer
})

afterAll(() => { delete VENDOR.Node; delete VENDOR.mergeAttributes })

/** A PM node as this adapter sees one. @param {object} attrs */
function nodeOf(attrs) {
  return { type: { name: 'sieve-code' }, attrs: Object.assign({ id: 'co-1', kind: 'code' }, attrs) }
}

/** @returns {{provider: any, patches: any[]}} a block-capable provider double */
function providerDouble() {
  /** @type {any[]} */ const patches = []
  return {
    patches,
    provider: { requestSetBlock: (/** @type {string} */ id, /** @type {any} */ patch) => { patches.push([id, patch]) } },
  }
}

describe('CodeNodeView.buildContextMenuItems — the Language flyout', () => {
  it('offers Language with the registry languages under it, Plain first', () => {
    const { provider } = providerDouble()
    const items = adapter.buildContextMenuItems({ node: nodeOf({ language: 'go' }), provider })
    const language = items.find((/** @type {any} */ i) => i.label === 'Language')
    expect(language).toBeTruthy()
    expect(Array.isArray(language.children)).toBe(true)
    expect(language.children[0].label).toBe('Plain')
    // The list is the highlighter's own registration, not a hand-written copy.
    const names = language.children.map((/** @type {any} */ c) => c.label)
    expect(names).toEqual(['Plain', 'bash', 'go', 'python'])
  })

  it('checkmarks the current language and only it', () => {
    const { provider } = providerDouble()
    const items = adapter.buildContextMenuItems({ node: nodeOf({ language: 'go' }), provider })
    const children = items.find((/** @type {any} */ i) => i.label === 'Language').children
    const active = children.filter((/** @type {any} */ c) => c.cls === 'ctx-item--active')
    expect(active.map((/** @type {any} */ c) => c.label)).toEqual(['go'])
  })

  it('accepting commits BOTH attrs in one patch: the pick, and detectionMethod manual', () => {
    const { provider, patches } = providerDouble()
    const items = adapter.buildContextMenuItems({ node: nodeOf({ language: '' }), provider })
    const children = items.find((/** @type {any} */ i) => i.label === 'Language').children
    children.find((/** @type {any} */ c) => c.label === 'go').action()
    expect(patches).toEqual([['co-1', { language: 'go', detectionMethod: 'manual' }]])
  })

  it('Plain commits an EMPTY language, still stamped manual', () => {
    const { provider, patches } = providerDouble()
    const items = adapter.buildContextMenuItems({ node: nodeOf({ language: 'go' }), provider })
    items.find((/** @type {any} */ i) => i.label === 'Language').children[0].action()
    expect(patches).toEqual([['co-1', { language: '', detectionMethod: 'manual' }]])
  })

  it('offers no Language entry to a mount whose provider cannot set a block', () => {
    const items = adapter.buildContextMenuItems({ node: nodeOf({ language: 'go' }), provider: {} })
    expect(items.find((/** @type {any} */ i) => i.label === 'Language')).toBeUndefined()
    // The header is still this kind's own.
    expect(items[0]).toEqual({ type: 'header', label: 'go block' })
  })
})
