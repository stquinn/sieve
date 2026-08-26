// @ts-check
// The PM/app half of the 'reference' kind: the adapter's schema declaration and,
// mainly, WHAT THE OPEN GESTURE BECOMES.
//
// The renderer reports a target and names no mechanism; this adapter is where
// that turns into an action:
//   points (uri, not held) → the container, through workspace.openAddress. Go
//     owns the address grammar, so this side never parses.
//   holds  (mime — this block's own uri names bytes it holds) → a
//     `sieve:reference-open-asset` INTENT, answered separately by the DESKTOP
//     realisation. Both halves are asserted: the intent is fired with the
//     document it belongs to, and today's desktop handler answers it by
//     revealing.
//
// Registration needs a TipTap runtime (NodeViewRegistry.register is an inert
// no-op without one), so a marker Node.create is seeded BEFORE the import, the
// way node-view-registry.test.js does. The registered adapter is then read back
// out of the shared block-kind registry.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { getBlockKind } from '../src/static/renderers/block-kinds.js'

const VENDOR = /** @type {any} */ (globalThis).TipTap
const W = /** @type {any} */ (globalThis)

/** @type {any} */ let adapter

beforeAll(async () => {
  VENDOR.Node = { create: (/** @type {any} */ cfg) => ({ __node: cfg.name }) }
  VENDOR.mergeAttributes = (/** @type {any} */ a, /** @type {any} */ b) => Object.assign({}, a, b)
  await import('../src/static/lens/document-editor/surfaces/node-views/reference-node-view.js')
  adapter = getBlockKind('reference').renderer
})

afterAll(() => { delete VENDOR.Node; delete VENDOR.mergeAttributes })

/** A PM node as this adapter sees one. @param {object} attrs */
function nodeOf(attrs) {
  return { type: { name: 'sieve-reference' }, attrs: Object.assign({ id: 'ref-1', kind: 'reference' }, attrs) }
}

/** The per-block ctx the framework hands makeNodeView. */
function ctxFor(uuid) {
  return { blockService: null, getEditor: () => (uuid ? { uuid: uuid } : null) }
}

function mount(attrs, uuid) {
  const view = adapter.makeNodeView(nodeOf(attrs), {}, () => 0, ctxFor(uuid))
  document.body.appendChild(view.dom)
  return view
}

function dblclickChip() {
  const chip = /** @type {HTMLElement} */ (document.querySelector('.sieve-reference-chip'))
  chip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
}

describe('reference NodeView — schema and policy', () => {
  it('registers the kind as a caret-stopping atom', () => {
    expect(adapter).toBeTruthy()
    expect(adapter.interactionPolicy).toEqual({ caretStop: true })
    expect(adapter.nodeConfig.atom).toBe(true)
    expect(adapter.nodeConfig.selectable).toBe(true)
    expect(adapter.nodeConfig.draggable).toBe(false)
    expect(adapter.getFriendlyName()).toBe('Reference')
  })

  it('declares the face and NEVER `kind` — that name is the framework’s block kind', () => {
    // BASE_ATTRS declares `kind` on every sieve-* node as the BLOCK's kind, so a
    // processor may not reuse the name: declaring it here would shadow the block
    // kind and emit a second data-kind. What this block points at or holds comes
    // off `mime`, derived rather than stored a second time. There is no `src`
    // either — `uri` is the one address attr, whether this block points or holds.
    expect(Object.keys(adapter.attrs).sort())
      .toEqual(['bytes', 'error', 'mime', 'summary', 'title', 'uri'])
    expect(Object.keys(adapter.attrs)).not.toContain('kind')
    // A wire envelope carrying the reserved name is ignored.
    expect(adapter.parseAttrs({ kind: 'reference', mime: 'text/yaml', bytes: 12 }))
      .toEqual({ uri: '', title: '', summary: '', bytes: '12', mime: 'text/yaml', error: '' })
  })

  it('copies as its coordinate, so a pasted chip can become a chip again — held or not', () => {
    expect(adapter.asContentEntry(nodeOf({ uri: 'sieve://9f2b' })))
      .toEqual([{ mimeType: 'text/plain', content: 'sieve://9f2b' }])
    // A held file's uri is a leaf address in this same document — copying it
    // still yields a coordinate, exactly as a pointing reference does.
    expect(adapter.asContentEntry(nodeOf({ uri: 'sieve://doc-1/swagger.yml', mime: 'text/yaml' })))
      .toEqual([{ mimeType: 'text/plain', content: 'sieve://doc-1/swagger.yml' }])
    // An addressless reference has no text form.
    expect(adapter.asContentEntry(nodeOf({ uri: '' }))).toBe(null)
  })

  it('ignores every mutation — the renderer rewrites this subtree, none of it is PM’s', () => {
    const view = mount({ uri: 'sieve://9f2b', title: 'Auth Design' }, 'doc-1')
    expect(view.ignoreMutation()).toBe(true)
    expect(view.renderer).toBeTruthy()   // marks the kind MIGRATED for the seam
  })
})

describe('reference NodeView — double click opens where it lives', () => {
  /** @type {any} */ let openAddress
  /** @type {any} */ let showInFiles
  /** @type {any[]} */ let intents
  /** @type {(e: any) => void} */ let spy

  beforeEach(() => {
    openAddress = vi.fn()
    showInFiles = vi.fn()
    intents = []
    spy = (e) => intents.push(e.detail)
    document.addEventListener('sieve:reference-open-asset', spy)
    W.sieveWorkspace = { openAddress: openAddress, activeEditor: null }
    W.sieveShowInFiles = showInFiles
  })

  afterEach(() => {
    document.removeEventListener('sieve:reference-open-asset', spy)
    delete W.sieveWorkspace
    delete W.sieveShowInFiles
    document.body.innerHTML = ''
  })

  it('POINTS: hands the opaque coordinate to the workspace, and fires no asset intent', () => {
    mount({ uri: 'sieve://9f2b', title: 'Auth Design' }, 'doc-1')
    dblclickChip()
    expect(openAddress.mock.calls).toEqual([['sieve://9f2b']])
    expect(intents).toEqual([])
  })

  it('HOLDS: fires the intent with the asset and its document — never a path or a URL', () => {
    mount({ uri: 'sieve://doc-1/swagger.yml', title: 'Payments API', mime: 'text/yaml' }, 'doc-1')
    dblclickChip()
    expect(openAddress).not.toHaveBeenCalled()
    expect(intents).toEqual([{ uri: 'sieve://doc-1/swagger.yml', title: 'Payments API', uuid: 'doc-1' }])
  })

  it('the DESKTOP handler answers that intent by revealing the document directory', () => {
    // Swappable by design: a hosted build answers the same event differently.
    mount({ uri: 'sieve://doc-1/swagger.yml', mime: 'text/yaml' }, 'doc-1')
    dblclickChip()
    expect(showInFiles.mock.calls).toEqual([['doc-1']])
  })

  it('falls back to the active editor when the block’s ctx has no document', () => {
    W.sieveWorkspace.activeEditor = { uuid: 'doc-active' }
    mount({ uri: 'sieve://doc-1/swagger.yml', mime: 'text/yaml' }, '')
    dblclickChip()
    expect(showInFiles.mock.calls).toEqual([['doc-active']])
  })

  it('does nothing for a block that addresses nothing', () => {
    mount({}, 'doc-1')
    dblclickChip()
    expect(openAddress).not.toHaveBeenCalled()
    expect(intents).toEqual([])
    expect(showInFiles).not.toHaveBeenCalled()
  })

  it('offers the same one rule from the context menu', () => {
    const cites = adapter.buildContextMenuItems({ node: nodeOf({ uri: 'sieve://9f2b' }), getEditor: () => ({ uuid: 'doc-1' }) })
    expect(cites[0]).toEqual({ type: 'header', label: 'Reference' })
    expect(cites.map((/** @type {any} */ i) => i.label)).toEqual(['Reference', 'Open Reference', 'Copy Address'])
    cites[1].action()
    expect(openAddress.mock.calls).toEqual([['sieve://9f2b']])

    const holds = adapter.buildContextMenuItems({ node: nodeOf({ uri: 'sieve://doc-1/swagger.yml', mime: 'text/yaml' }), getEditor: () => ({ uuid: 'doc-1' }) })
    expect(holds.map((/** @type {any} */ i) => i.label)).toEqual(['Reference', 'Show in Files', 'Copy Filename'])
    holds[1].action()
    expect(showInFiles.mock.calls).toEqual([['doc-1']])

    // A block addressing nothing offers the header alone — no action that lies.
    expect(adapter.buildContextMenuItems({ node: nodeOf({}), getEditor: () => null }).length).toBe(1)
  })
})
