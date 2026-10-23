// @ts-check
// Copies an image `src` to the OS clipboard as a PNG bitmap, for pasting into
// other applications. WebKit accepts only image/png in a clipboard write, so any
// other type is re-encoded through a canvas first.

/** The width an SVG with no intrinsic size is rasterised at. */
const SVG_RASTER_WIDTH = 1024
/** The height used when an SVG declares no size or aspect at all. */
const SVG_DEFAULT_HEIGHT = 768

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
export function rasterSizeFor(svgText, naturalWidth, naturalHeight) {
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
 * Put the image at `src` on the clipboard as image/png. A no-op where the async
 * clipboard is unavailable; a failure is logged and leaves the clipboard as it was.
 * @param {string} src
 */
export function copyImageToClipboard(src) {
  if (!navigator.clipboard || !navigator.clipboard.write) return

  const blobPromise = fetch(src)
    .then((res) => res.blob())
    .then((blob) => {
      if (blob.type === 'image/png') return blob
      return new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
          const svg = !img.naturalWidth && blob.type === 'image/svg+xml' ? blob.text() : Promise.resolve('')
          svg.then((svgText) => {
            const { width, height } = rasterSizeFor(svgText, img.naturalWidth, img.naturalHeight)
            const canvas = document.createElement('canvas')
            canvas.width = width
            canvas.height = height
            const ctx = canvas.getContext('2d')
            if (!ctx) throw new Error('no 2d canvas context')
            ctx.drawImage(img, 0, 0, width, height)
            URL.revokeObjectURL(img.src)
            canvas.toBlob((pngBlob) => (pngBlob ? resolve(pngBlob) : reject(new Error('PNG encode failed'))), 'image/png')
          }).catch(reject)
        }
        img.onerror = reject
        img.src = URL.createObjectURL(blob)
      })
    })

  navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]).catch((err) => {
    console.error('Failed to copy image with promise', err)
    blobPromise.then((blob) => {
      navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).catch((err2) => {
        console.error('Fallback copy failed', err2)
      })
    }).catch((err3) => console.error('Failed to encode image', err3))
  })
}
