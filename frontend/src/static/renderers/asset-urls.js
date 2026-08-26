// @ts-check
// The browser half's ONE place a Sieve served-file route is built. Every
// renderer, node-view and surface that needs one asks here rather than
// concatenating the shape itself: a route spelled in four places moves in three,
// and the fourth fails as a broken image rather than an error. The document
// asset prefix is NOT declared here — it comes from generated/protocol.js, whose
// other half is the Go constant that mints the references written into
// documents, so what a document says an asset is and what the browser asks for
// cannot drift apart.

import { assetUrl } from '../generated/protocol.js'

/** Where a remote image is fetched through, so the page never hits the network itself. */
const IMAGE_PROXY_PATH = '/ui/image-proxy'

/** Where store-root-relative files (a plain markdown `![](notes/diagram.png)`) are served. */
const STORE_FILE_PREFIX = '/ui/files/'

/**
 * True for a src the browser can already resolve on its own — an absolute URL,
 * an inline payload, or a root-relative path that names its own route.
 * @param {string} src @returns {boolean}
 */
function isAbsolute(src) {
  return src.startsWith('http://') || src.startsWith('https://')
    || src.startsWith('data:') || src.startsWith('blob:') || src.startsWith('/')
}

/**
 * The URL a remote image is loaded through. Absolute (origin-prefixed) because
 * one caller hands the result to a canvas/clipboard read, which needs a
 * same-origin URL rather than a same-document one.
 * @param {string} remoteUrl @returns {string}
 */
export function imageProxyUrl(remoteUrl) {
  return window.location.origin + IMAGE_PROXY_PATH + '?url=' + encodeURIComponent(remoteUrl)
}

/**
 * The served URL of a file stored INSIDE a document. `ref` is whatever the
 * document wrote — a bare filename, or a `.assets/`-prefixed path from the
 * on-disk layout. Only the final segment is meaningful: assets are flat within
 * a document, so any leading path is layout the route does not repeat.
 * @param {string} uuid the document holding the asset
 * @param {string} ref  the asset reference as the document spells it
 * @returns {string}
 */
export function documentAssetUrl(uuid, ref) {
  if (!ref) return ''
  if (ref.startsWith('/')) return ref
  return assetUrl(uuid || '', String(ref).split('/').pop() || '')
}

/**
 * The full ladder an image `src` inside a Sieve block climbs: a remote image is
 * proxied, anything already resolvable is left alone, and everything else is a
 * reference into this document's own assets.
 * @param {string} src @param {string} [uuid] the document the src was read from
 * @returns {string}
 */
export function resolveImageSrc(src, uuid) {
  if (!src) return ''
  if (src.startsWith('http://') || src.startsWith('https://')) return imageProxyUrl(src)
  if (isAbsolute(src)) return src
  if (src.startsWith('.assets/')) src = src.substring(8)
  return documentAssetUrl(uuid || '', src)
}

/**
 * The served URL for a relative `<img>` src in ORDINARY markdown — not a Sieve
 * block's asset, but a file the author referenced by its path within the store
 * (`![](diagrams/flow.png)`). The browser would otherwise resolve it against the
 * page, which is the app shell, so it must be pointed at the store's route
 * explicitly. Rewrite it at RENDER time only: the document keeps the relative
 * path it was written with.
 * @param {string} src @returns {string}
 */
export function storeFileSrc(src) {
  if (!src || isAbsolute(src)) return src || ''
  return STORE_FILE_PREFIX + src.replace(/^\.\//, '')
}

/**
 * storeFileSrc's inverse, for the round trip: a rendered `<img>` re-parsed back
 * into the document (copy, then paste it into the editor) must carry the
 * relative path it started with, or the served route would be written into the
 * markdown and the file would move out from under it.
 * @param {string|null} url @returns {string|null}
 */
export function storeFileRef(url) {
  if (!url) return url
  return url.startsWith(STORE_FILE_PREFIX) ? url.substring(STORE_FILE_PREFIX.length) : url
}
