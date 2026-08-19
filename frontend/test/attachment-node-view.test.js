// @ts-check
// attachment-node-view.test.js — the PM/app half of the 'attachment' kind (#38):
// the adapter's schema declaration and, mainly, WHAT THE OPEN GESTURE BECOMES.
//
// The renderer reports a target and names no mechanism; this adapter is where
// that turns into an action, and the two halves of the rule are the whole
// feature's navigation:
//   points (uri) → the container, through workspace.openAddress (the ai-block
//     chip path, reused — Go owns the address grammar, this side never parses).
//   holds  (src) → a `sieve:attachment-open-asset` INTENT, answered separately
//     by the DESKTOP realisation. The test asserts BOTH: that the intent is
//     fired with the document it belongs to, and that today's desktop handler
//     answers it by revealing — because a hosted build must be able to replace
//     the second without touching the first.
//
// Registration needs a TipTap runtime (NodeViewRegistry.register is an inert
// no-op without one), so a marker Node.create is seeded BEFORE the import, the
// way node-view-registry.test.js does. The registered adapter is then read back
// out of the shared block-kind registry.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { getBlockKind } from '../src/static/block/block-kinds.js'

const VENDOR = /** @type {any} */ (globalThis).TipTap
const W = /** @type {any} */ (globalThis)

/** @type {any} */ let adapter

beforeAll(async () => {
  VENDOR.Node = { create: (/** @type {any} */ cfg) => ({ __node: cfg.name }) }
  VENDOR.mergeAttributes = (/** @type {any} */ a, /** @type {any} */ b) => Object.assign({}, a, b)
  await import('../src/static/editor/surfaces/node-views/attachment-node-view.js')
  adapter = getBlockKind('attachment').renderer
})

afterAll(() => { delete VENDOR.Node; delete VENDOR.mergeAttributes })

/** A PM node as this adapter sees one. @param {object} attrs */
function nodeOf(attrs) {
  return { type: { name: 'sieve-attachment' }, attrs: Object.assign({ id: 'at-1', kind: 'attachment' }, attrs) }
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
  const chip = /** @type {HTMLElement} */ (document.querySelector('.sieve-attachment-chip'))
  chip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
}

describe('attachment NodeView — schema and policy', () => {
  it('registers the kind as a caret-stopping atom', () => {
    expect(adapter).toBeTruthy()
    expect(adapter.interactionPolicy).toEqual({ caretStop: true })
    expect(adapter.nodeConfig.atom).toBe(true)
    expect(adapter.nodeConfig.selectable).toBe(true)
    expect(adapter.nodeConfig.draggable).toBe(false)
    expect(adapter.getFriendlyName()).toBe('Attachment')
  })

  it('declares `targetKind` and NEVER `kind` — that name is the framework’s block kind', () => {
    // BASE_ATTRS declares `kind` on every sieve-* node as the BLOCK's kind, so a
    // processor may not reuse the name: declaring it here would shadow the block
    // kind and emit a second data-kind. What this block points at or holds is
    // `targetKind`, which is an ordinary attr and IS declared.
    expect(Object.keys(adapter.attrs).sort())
      .toEqual(['bytes', 'error', 'mime', 'src', 'summary', 'targetKind', 'title', 'uri'])
    expect(Object.keys(adapter.attrs)).not.toContain('kind')
    // A wire envelope carrying the reserved name is ignored; targetKind is read.
    expect(adapter.parseAttrs({ kind: 'attachment', targetKind: 'yaml', src: 'a.yml', bytes: 12 }))
      .toEqual({ src: 'a.yml', uri: '', title: '', targetKind: 'yaml', summary: '', bytes: '12', mime: '', error: '' })
  })

  it('copies as its coordinate, so a pasted chip can become a chip again', () => {
    expect(adapter.asContentEntry(nodeOf({ uri: 'container:9f2b' })))
      .toEqual([{ mimeType: 'text/plain', content: 'container:9f2b' }])
    // A held file has no text form — its bytes live in the document directory.
    expect(adapter.asContentEntry(nodeOf({ src: 'swagger.yml' }))).toBe(null)
  })

  it('ignores every mutation — the renderer rewrites this subtree, none of it is PM’s', () => {
    const view = mount({ uri: 'container:9f2b', title: 'Auth Design' }, 'doc-1')
    expect(view.ignoreMutation()).toBe(true)
    expect(view.renderer).toBeTruthy()   // marks the kind MIGRATED for the seam
  })
})

describe('attachment NodeView — double click opens where it lives', () => {
  /** @type {any} */ let openAddress
  /** @type {any} */ let showInFiles
  /** @type {any[]} */ let intents
  /** @type {(e: any) => void} */ let spy

  beforeEach(() => {
    openAddress = vi.fn()
    showInFiles = vi.fn()
    intents = []
    spy = (e) => intents.push(e.detail)
    document.addEventListener('sieve:attachment-open-asset', spy)
    W.sieveWorkspace = { openAddress: openAddress, activeEditor: null }
    W.sieveShowInFiles = showInFiles
  })

  afterEach(() => {
    document.removeEventListener('sieve:attachment-open-asset', spy)
    delete W.sieveWorkspace
    delete W.sieveShowInFiles
    document.body.innerHTML = ''
  })

  it('POINTS: hands the opaque coordinate to the workspace, and fires no asset intent', () => {
    mount({ uri: 'container:9f2b', title: 'Auth Design' }, 'doc-1')
    dblclickChip()
    expect(openAddress.mock.calls).toEqual([['container:9f2b']])
    expect(intents).toEqual([])
  })

  it('HOLDS: fires the intent with the asset and its document — never a path or a URL', () => {
    mount({ src: 'swagger.yml', title: 'Payments API' }, 'doc-1')
    dblclickChip()
    expect(openAddress).not.toHaveBeenCalled()
    expect(intents).toEqual([{ src: 'swagger.yml', title: 'Payments API', uuid: 'doc-1' }])
  })

  it('the DESKTOP handler answers that intent by revealing the document directory', () => {
    // Swappable by design: a hosted build answers the same event differently.
    mount({ src: 'swagger.yml' }, 'doc-1')
    dblclickChip()
    expect(showInFiles.mock.calls).toEqual([['doc-1']])
  })

  it('falls back to the active editor when the block’s ctx has no document', () => {
    W.sieveWorkspace.activeEditor = { uuid: 'doc-active' }
    mount({ src: 'swagger.yml' }, '')
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
    const cites = adapter.buildContextMenuItems({ node: nodeOf({ uri: 'container:9f2b' }), getEditor: () => ({ uuid: 'doc-1' }) })
    expect(cites[0]).toEqual({ type: 'header', label: 'Attachment' })
    expect(cites.map((/** @type {any} */ i) => i.label)).toEqual(['Attachment', 'Open Reference', 'Copy Address'])
    cites[1].action()
    expect(openAddress.mock.calls).toEqual([['container:9f2b']])

    const holds = adapter.buildContextMenuItems({ node: nodeOf({ src: 'swagger.yml' }), getEditor: () => ({ uuid: 'doc-1' }) })
    expect(holds.map((/** @type {any} */ i) => i.label)).toEqual(['Attachment', 'Show in Files', 'Copy Filename'])
    holds[1].action()
    expect(showInFiles.mock.calls).toEqual([['doc-1']])

    // A block addressing nothing offers the header alone — no action that lies.
    expect(adapter.buildContextMenuItems({ node: nodeOf({}), getEditor: () => null }).length).toBe(1)
  })
})
