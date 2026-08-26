// @ts-check
// Copies an image `src` to the clipboard as PNG. WebKit strictly requires image/png
// for clipboard writes, so non-PNG blobs are re-encoded via a canvas. Pure helper
// (fetch → canvas → PNG → clipboard), no state.

/**
 * @param {string} src
 */
export function copyImageToClipboard(src) {
  if (!navigator.clipboard || !navigator.clipboard.write) return

  const blobPromise = fetch(src)
    .then((res) => res.blob())
    .then((blob) => new Promise((resolve, reject) => {
      if (blob.type === 'image/png') {
        resolve(blob)
        return
      }
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0)
        canvas.toBlob((pngBlob) => resolve(pngBlob), 'image/png')
      }
      img.onerror = reject
      img.src = URL.createObjectURL(blob)
    }))

  const item = {}
  item['image/png'] = blobPromise

  navigator.clipboard.write([new ClipboardItem(item)]).catch((err) => {
    console.error('Failed to copy image with promise', err)
    blobPromise.then((blob) => {
      const fallbackItem = {}
      fallbackItem['image/png'] = blob
      navigator.clipboard.write([new ClipboardItem(fallbackItem)]).catch((err2) => {
        console.error('Fallback copy failed', err2)
      })
    })
  })
}
