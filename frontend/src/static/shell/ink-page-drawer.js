// @ts-check
// InkPageDrawer: the workspace channel's tenant that draws a Digital Note's page
// when the server asks. It claims `ink-draw-page`, draws the page the frame
// carries with InkRenderer, rasterises that SVG to a PNG and answers
// `ink-page-drawn` under the request's correlation id: the PNG in base64, or why
// there is none. It needs no tab open.

import { ContractViolation } from '../contract/sieve-block.js'
import { WorkspaceFrame } from '../generated/protocol.js'
import { InkRenderer, INK_RULES } from '../renderers/ink-renderer.js'
import { ImageClipboard } from '../renderers/copy-image.js'

/** @typedef {import('../renderers/ink-renderer.js').InkPage} InkPage */
/** @typedef {import('../renderers/ink-renderer.js').InkWindow} InkWindow */

/**
 * The framing of an unbounded page's image: the margin left round its ink, in
 * page units, and the most pixels its longer side may have.
 */
export const INK_PAGE_IMAGE = Object.freeze({ margin: 0.05, maxSide: 4096 })

const DRAW_FRAMES = Object.freeze([WorkspaceFrame.INK_DRAW_PAGE])

/**
 * @typedef {object} InkPageDrawerOptions
 * @property {InkRenderer} [renderer] defaults to a fresh InkRenderer
 * @property {{svgToPng: (svg: string, width: number, height: number) => Promise<Blob>}} [rasteriser]
 *   defaults to an ImageClipboard
 */

export class InkPageDrawer {
  /** @type {import('./workspace-service.js').WorkspaceService} */ #workspace
  /** @type {InkRenderer} */ #renderer
  /** @type {NonNullable<InkPageDrawerOptions['rasteriser']>} */ #rasteriser

  /**
   * @param {import('./workspace-service.js').WorkspaceService} workspace
   * @param {InkPageDrawerOptions} [options]
   */
  constructor(workspace, options = {}) {
    if (!workspace || typeof workspace.send !== 'function' || typeof workspace.registerTenant !== 'function') {
      throw new ContractViolation('InkPageDrawer requires a WorkspaceService')
    }
    this.#workspace = workspace
    this.#renderer = options.renderer || new InkRenderer()
    this.#rasteriser = options.rasteriser || new ImageClipboard()
    this.#workspace.registerTenant(this)
  }

  /** @returns {readonly string[]} */
  get frameTypes() { return DRAW_FRAMES }

  /**
   * Draws the page an `ink-draw-page` carries and answers it; a frame with no
   * correlation id has nowhere to be answered and is dropped.
   * @param {Record<string, any>} msg
   * @returns {Promise<void>} settles once the answer is sent
   */
  onFrame(msg) {
    const correlationId = msg && msg.type === WorkspaceFrame.INK_DRAW_PAGE ? msg.correlationId : ''
    if (!correlationId) return Promise.resolve()
    return Promise.resolve()
      .then(() => {
        const { svg, width, height } = this.imageOf(msg.page, msg.bounds)
        return this.#rasteriser.svgToPng(svg, width, height)
      })
      .then((png) => png.arrayBuffer())
      .then(
        (bytes) => this.#answer({ correlationId, png: InkPageDrawer.#base64(new Uint8Array(bytes)) }),
        (err) => this.#answer({ correlationId, error: String((err && err.message) || err) }),
      )
  }

  /**
   * A page's image as an SVG document and the pixel size to rasterise it at. A
   * fixed page is the whole sheet, INK_RULES.grid pixels wide. An unbounded page
   * is the frame inkFrame gives it at INK_RULES.grid pixels to a page width,
   * scaled down until its longer side is at most INK_PAGE_IMAGE.maxSide.
   * @param {InkPage} page
   * @param {string} bounds 'fixed' or 'unbounded'
   * @returns {{svg: string, width: number, height: number}}
   */
  imageOf(page, bounds) {
    const g = INK_RULES.grid
    if (bounds !== 'unbounded') {
      const svg = this.#renderer.renderPage(page)
      return { svg, width: g, height: Math.round(g / page.note.pageAspect) }
    }
    const frame = this.inkFrame(page)
    const w = (frame.x1 - frame.x0) * g
    const h = (frame.y1 - frame.y0) * g
    const scale = Math.min(1, INK_PAGE_IMAGE.maxSide / Math.max(w, h))
    return {
      svg: this.#renderer.renderPage(page, frame),
      width: Math.max(1, Math.round(w * scale)),
      height: Math.max(1, Math.round(h * scale)),
    }
  }

  /**
   * The rectangle of the plane holding every point of every stroke, with
   * INK_PAGE_IMAGE.margin round it; a sheet at the origin for a page with no ink.
   * @param {InkPage} page
   * @returns {InkWindow}
   */
  inkFrame(page) {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
    for (const stroke of page.strokes) {
      for (const p of stroke.points) {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y)
        x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y)
      }
    }
    if (!(x1 >= x0)) return Object.freeze({ x0: 0, y0: 0, x1: 1, y1: 1 / page.note.pageAspect })
    const m = INK_PAGE_IMAGE.margin
    return Object.freeze({ x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m })
  }

  /** @param {{correlationId: string, png?: string, error?: string}} answer */
  #answer(answer) {
    this.#workspace.send({ type: WorkspaceFrame.INK_PAGE_DRAWN, ...answer })
  }

  /** @param {Uint8Array} bytes @returns {string} */
  static #base64(bytes) {
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    return btoa(binary)
  }
}
