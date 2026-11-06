// @ts-check
// ImageClipboard — the size an image is rasterised at, and an SVG document drawn
// to a PNG and written to the async clipboard. The image decoder, the canvas and
// the clipboard are stubbed: what is pinned is what reaches each of them (the SVG
// bytes and their type, the canvas size, the drawn size, the item written), not
// that an engine rasterises it — happy-dom has no rasteriser.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ImageClipboard } from '../src/static/renderers/copy-image.js'

describe('ImageClipboard.rasterSizeFor', () => {
  it.each([
    ['a decoded intrinsic size wins', '<svg viewBox="0 0 10 10">', 640, 480, { width: 640, height: 480 }],
    ['the viewBox aspect, 1024 wide', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">', 0, 0, { width: 1024, height: 512 }],
    ['a comma-separated viewBox', "<svg viewBox='0,0,100,300'>", 0, 0, { width: 1024, height: 3072 }],
    ['the width/height attributes when no viewBox', '<svg width="400px" height="200px">', 0, 0, { width: 1024, height: 512 }],
    ['width/height attributes in proportion', '<svg width="50" height="100">', 0, 0, { width: 1024, height: 2048 }],
    ['a percentage size declares nothing', '<svg width="100%" height="50%">', 0, 0, { width: 1024, height: 768 }],
    ['nothing declared', '<svg>', 0, 0, { width: 1024, height: 768 }],
    ['not an SVG at all', '', 0, 0, { width: 1024, height: 768 }],
  ])('%s', (_, svg, w, h, want) => {
    expect(ImageClipboard.rasterSizeFor(svg, w, h)).toEqual(want)
  })
})

describe('ImageClipboard.copySvg', () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1404" height="1872" viewBox="0 0 1404 1872"><rect width="1404" height="1872" fill="#fff"/></svg>'
  const PNG = new Blob(['png'], { type: 'image/png' })

  /** @type {Blob[]} */ let decoded
  /** @type {any[]} */ let drawn
  /** @type {any[]} */ let canvases
  /** @type {any[]} */ let written
  /** @type {any} */ let write

  beforeEach(() => {
    decoded = []
    drawn = []
    canvases = []
    written = []
    write = vi.fn((/** @type {any[]} */ items) => {
      written.push(...items)
      return Promise.resolve()
    })
    vi.stubGlobal('navigator', { clipboard: { write } })
    vi.stubGlobal('ClipboardItem', class { /** @param {Record<string, any>} items */ constructor(items) { this.items = items } })
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
        getContext: () => ({ drawImage: (/** @type {any[]} */ ...args) => drawn.push(args.slice(1)) }),
        toBlob: (/** @type {(b: Blob) => void} */ done) => done(PNG),
      }
      canvases.push(canvas)
      return /** @type {any} */ (canvas)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('draws the SVG document, as image/svg+xml, onto a canvas of the size asked and writes the PNG', async () => {
    await new ImageClipboard().copySvg(SVG, 1404, 1872)
    expect(decoded).toHaveLength(1)
    expect(decoded[0].type).toBe('image/svg+xml')
    expect(await decoded[0].text()).toBe(SVG)
    expect(canvases.map((c) => [c.width, c.height])).toEqual([[1404, 1872]])
    expect(drawn).toEqual([[0, 0, 1404, 1872]])
    expect(written).toHaveLength(1)
    expect(Object.keys(written[0].items)).toEqual(['image/png'])
    expect(await written[0].items['image/png']).toBe(PNG)
  })

  it('writes the finished PNG when the engine refuses a pending one', async () => {
    write.mockImplementationOnce(() => Promise.reject(new Error('pending items refused')))
    await new ImageClipboard().copySvg(SVG, 1404, 1872)
    expect(write).toHaveBeenCalledTimes(2)
    expect(written.at(-1).items['image/png']).toBe(PNG)
  })

  it('rejects where the async clipboard takes no image, and when the write fails', async () => {
    write.mockImplementation(() => Promise.reject(new Error('denied')))
    await expect(new ImageClipboard().copySvg(SVG, 1404, 1872)).rejects.toThrow('denied')
    vi.stubGlobal('navigator', {})
    await expect(new ImageClipboard().copySvg(SVG, 1404, 1872)).rejects.toThrow('cannot take an image')
  })
})
