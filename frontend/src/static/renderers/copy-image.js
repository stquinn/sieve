// @ts-check
// Puts an image on the OS clipboard as a PNG bitmap, for pasting into other
// applications, through the async clipboard. WebKit accepts only image/png in a
// clipboard write, so any other type is re-encoded through a canvas first. A write
// must start inside the user's gesture: the PNG is handed to the clipboard as a
// promise, so the encoding may finish after it.

/** The width an SVG with no intrinsic size is rasterised at. */
const SVG_RASTER_WIDTH = 1024
/** The height used when an SVG declares no size or aspect at all. */
const SVG_DEFAULT_HEIGHT = 768

export class ImageClipboard {
  /**
   * The pixel size to rasterise an image at. A decoded intrinsic size wins. An SVG
   * without one is drawn SVG_RASTER_WIDTH wide, its height following the aspect of
   * its root `viewBox`, else of its numeric `width`/`height` attributes, else
   * SVG_DEFAULT_HEIGHT.
   * @param {string} svgText the SVG source, or '' when the image is not an SVG
   * @param {number} naturalWidth
   * @param {number} naturalHeight
   * @returns {{width: number, height: number}}
   */
  static rasterSizeFor(svgText, naturalWidth, naturalHeight) {
    if (naturalWidth > 0 && naturalHeight > 0) return { width: naturalWidth, height: naturalHeight }
    const root = /<svg\b[^>]*>/i.exec(svgText || '')
    const attr = (/** @type {string} */ name) => {
      const m = root && new RegExp('\\s' + name + '\\s*=\\s*["\']([^"\']*)["\']', 'i').exec(root[0])
      return m ? m[1].trim() : ''
    }
    const length = (/** @type {string} */ value) => (/%$/.test(value) ? 0 : parseFloat(value) || 0)

    const box = attr('viewBox').split(/[\s,]+/).map(Number)
    let aspect = box.length === 4 && box[2] > 0 && box[3] > 0 ? box[3] / box[2] : 0
    if (!aspect) {
      const w = length(attr('width'))
      const h = length(attr('height'))
      aspect = w > 0 && h > 0 ? h / w : 0
    }
    const height = aspect ? Math.max(1, Math.round(SVG_RASTER_WIDTH * aspect)) : SVG_DEFAULT_HEIGHT
    return { width: SVG_RASTER_WIDTH, height }
  }

  /**
   * Puts the image at `src` on the clipboard as image/png. A no-op where the async
   * clipboard is unavailable; a failure is logged and leaves the clipboard as it was.
   * @param {string} src
   */
  copySource(src) {
    if (!this.#canWrite()) return
    const png = fetch(src)
      .then((res) => res.blob())
      .then((blob) => {
        if (blob.type === 'image/png') return blob
        return this.#rasterise(blob, (img) => {
          const svg = !img.naturalWidth && blob.type === 'image/svg+xml' ? blob.text() : Promise.resolve('')
          return svg.then((svgText) => ImageClipboard.rasterSizeFor(svgText, img.naturalWidth, img.naturalHeight))
        })
      })
    this.#write(png).catch((err) => console.error('Failed to copy image', err))
  }

  /**
   * Puts a self-contained SVG document on the clipboard as image/png, drawn at
   * `width` by `height` pixels. It must reference nothing outside itself: no
   * external image, font or stylesheet reaches a rasterised SVG.
   * @param {string} svg
   * @param {number} width
   * @param {number} height
   * @returns {Promise<void>} resolves once the clipboard holds the image; rejects
   *   where the async clipboard is unavailable, and when encoding or the write fails
   */
  copySvg(svg, width, height) {
    if (!this.#canWrite()) return Promise.reject(new Error('the clipboard cannot take an image here'))
    return this.#write(this.svgToPng(svg, width, height))
  }

  /**
   * A self-contained SVG document drawn to a PNG of `width` by `height` pixels.
   * @param {string} svg @param {number} width @param {number} height
   * @returns {Promise<Blob>}
   */
  svgToPng(svg, width, height) {
    return this.#rasterise(new Blob([svg], { type: 'image/svg+xml' }), () => Promise.resolve({ width, height }))
  }

  /** @returns {boolean} */
  #canWrite() {
    return typeof navigator !== 'undefined' && !!navigator.clipboard && typeof navigator.clipboard.write === 'function'
  }

  /**
   * Writes the PNG, handed over while it is still being made; where the engine
   * refuses a pending item, the finished one.
   * @param {Promise<Blob>} png @returns {Promise<void>}
   */
  #write(png) {
    return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
      .catch(() => png.then((blob) => navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])))
  }

  /**
   * The image in blob, decoded and drawn to a PNG at the size `sizeOf` gives it.
   * @param {Blob} blob
   * @param {(img: HTMLImageElement) => Promise<{width: number, height: number}>} sizeOf
   * @returns {Promise<Blob>}
   */
  #rasterise(blob, sizeOf) {
    return new Promise((resolve, reject) => {
      const img = new Image()
      const url = URL.createObjectURL(blob)
      /** @param {(value: any) => void} settle */
      const after = (settle) => (/** @type {any} */ value) => {
        URL.revokeObjectURL(url)
        settle(value)
      }
      img.onload = () => {
        sizeOf(img).then(({ width, height }) => this.#encode(img, width, height)).then(after(resolve), after(reject))
      }
      img.onerror = () => after(reject)(new Error('the image could not be decoded'))
      img.src = url
    })
  }

  /** @param {HTMLImageElement} img @param {number} width @param {number} height @returns {Promise<Blob>} */
  #encode(img, width, height) {
    return new Promise((resolve, reject) => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('no 2d canvas context'))
        return
      }
      ctx.drawImage(img, 0, 0, width, height)
      canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('PNG encode failed'))), 'image/png')
    })
  }
}
