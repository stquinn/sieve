// @ts-check
// InkPageDrawer — the workspace tenant that draws a page when the server asks.
// The page is drawn by the real InkRenderer and rasterised through the real
// ImageClipboard.svgToPng; the image decoder and the canvas are stubbed as
// copy-image.test.js stubs them. What is pinned is the SVG handed to the decoder,
// the canvas size, and the answer sent; that the engine draws the SVG to those
// pixels is not covered — happy-dom has no rasteriser.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getStroke } from 'perfect-freehand'
import { InkPageDrawer, INK_PAGE_IMAGE } from '../src/static/shell/ink-page-drawer.js'
import { InkRenderer, INK_RULES } from '../src/static/renderers/ink-renderer.js'
import { WorkspaceFrame } from '../src/static/generated/protocol.js'
import { ContractViolation } from '../src/static/contract/sieve-block.js'

const PAGE = JSON.parse(readFileSync(path.resolve(process.cwd(),
  '../docs/design/specs/assets/2026-10-31-boox-test-page/boox-page-strokes.json'), 'utf8'))
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

/** A whiteboard page whose two strokes sit far apart on the plane. */
const whiteboard = (/** @type {number} */ far) => ({
  note: { ...PAGE.note, template: null },
  strokes: [
    { id: 'a', tool: 'pen', widthClass: 2, points: [{ x: -0.5, y: -0.25, pressure: 0.5 }, { x: -0.4, y: -0.2, pressure: 0.5 }] },
    { id: 'b', tool: 'pen', widthClass: 2, points: [{ x: far, y: far / 2, pressure: 0.5 }, { x: far + 0.1, y: far / 2, pressure: 0.5 }] },
  ],
})

/** A workspace that records what is sent and which tenant registers. */
class FakeWorkspace {
  /** @type {any[]} */ sent = []
  /** @type {any} */ tenant = null
  /** @param {any} frame */ send(frame) { this.sent.push(frame) }
  /** @param {any} tenant */ registerTenant(tenant) { this.tenant = tenant; return () => {} }
}

describe('InkPageDrawer', () => {
  /** @type {Blob[]} */ let decoded
  /** @type {any[]} */ let canvases
  /** @type {FakeWorkspace} */ let workspace
  /** @type {InkPageDrawer} */ let drawer
  let canvasFails = false

  beforeEach(() => {
    decoded = []
    canvases = []
    canvasFails = false
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      decoded.push(/** @type {Blob} */ (blob))
      return 'blob:svg'
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.stubGlobal('Image', class {
      /** @type {(() => void)|null} */ onload = null
      naturalWidth = 0
      naturalHeight = 0
      set src(_url) { queueMicrotask(() => this.onload && this.onload()) }
    })
    const create = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((/** @type {string} */ tag) => {
      if (tag !== 'canvas') return create(tag)
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => (canvasFails ? null : { drawImage: () => {} }),
        toBlob: (/** @type {(b: Blob) => void} */ done) => done(new Blob([PNG_BYTES], { type: 'image/png' })),
      }
      canvases.push(canvas)
      return /** @type {any} */ (canvas)
    })
    workspace = new FakeWorkspace()
    drawer = new InkPageDrawer(/** @type {any} */ (workspace), { renderer: new InkRenderer({ getStroke }) })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** @param {Record<string, any>} fields */
  const ask = (fields) => drawer.onFrame({ type: WorkspaceFrame.INK_DRAW_PAGE, correlationId: 'c-1', ...fields })

  it('claims ink-draw-page on the workspace it is built with, and needs one', () => {
    expect(workspace.tenant).toBe(drawer)
    expect(drawer.frameTypes).toEqual([WorkspaceFrame.INK_DRAW_PAGE])
    expect(() => new InkPageDrawer(/** @type {any} */ (null))).toThrow(ContractViolation)
  })

  it('draws a fixed page whole, the grid wide, and answers with the PNG under the correlation id', async () => {
    await ask({ bounds: 'fixed', page: PAGE })
    const height = Math.round(INK_RULES.grid / PAGE.note.pageAspect)
    expect(canvases.map((c) => [c.width, c.height])).toEqual([[INK_RULES.grid, height]])
    expect(decoded).toHaveLength(1)
    const svg = await decoded[0].text()
    expect(svg).toBe(new InkRenderer({ getStroke }).renderPage(PAGE))
    expect(svg).toMatch(/<g data-ink="live"><\/g>/)
    expect(workspace.sent).toEqual([{
      type: WorkspaceFrame.INK_PAGE_DRAWN, correlationId: 'c-1', png: btoa(String.fromCharCode(...PNG_BYTES)),
    }])
  })

  it.each([
    ['a whiteboard within the cap', 1, false],
    ['a whiteboard wider than the cap', 6, true],
  ])('frames %s to all its ink with a margin', async (_, far, capped) => {
    const page = whiteboard(far)
    await ask({ bounds: 'unbounded', page })
    const m = INK_PAGE_IMAGE.margin
    const frame = { x0: -0.5 - m, y0: -0.25 - m, x1: far + 0.1 + m, y1: far / 2 + m }
    expect(drawer.inkFrame(page)).toEqual(frame)
    const svg = await decoded[0].text()
    expect(svg).toBe(new InkRenderer({ getStroke }).renderPage(page, frame))
    const w = (frame.x1 - frame.x0) * INK_RULES.grid
    const h = (frame.y1 - frame.y0) * INK_RULES.grid
    const [canvas] = canvases
    expect(Math.max(canvas.width, canvas.height)).toBe(capped ? INK_PAGE_IMAGE.maxSide : Math.round(w))
    expect(canvas.width / canvas.height).toBeCloseTo(w / h, 2)
    expect(workspace.sent[0].png).toBeTruthy()
  })

  it('frames a whiteboard with no ink as a sheet at the origin', () => {
    const empty = { note: PAGE.note, strokes: [] }
    expect(drawer.inkFrame(empty)).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 / PAGE.note.pageAspect })
  })

  it.each([
    ['a page it cannot draw', () => ask({ bounds: 'fixed', page: { note: {}, strokes: [] } }), /pageAspect/],
    ['a canvas that will not draw', () => { canvasFails = true; return ask({ bounds: 'fixed', page: PAGE }) }, /no 2d canvas context/],
  ])('answers %s with the error, under the correlation id', async (_, run, says) => {
    await run()
    expect(workspace.sent).toHaveLength(1)
    expect(workspace.sent[0]).toMatchObject({ type: WorkspaceFrame.INK_PAGE_DRAWN, correlationId: 'c-1' })
    expect(workspace.sent[0].png).toBeUndefined()
    expect(workspace.sent[0].error).toMatch(says)
  })

  it.each([
    ['another frame word', { type: WorkspaceFrame.INVALIDATE, correlationId: 'c-1', page: PAGE }],
    ['no correlation id', { type: WorkspaceFrame.INK_DRAW_PAGE, bounds: 'fixed', page: PAGE }],
  ])('draws nothing and answers nothing for %s', async (_, frame) => {
    await drawer.onFrame(frame)
    expect(canvases).toHaveLength(0)
    expect(workspace.sent).toEqual([])
  })
})
