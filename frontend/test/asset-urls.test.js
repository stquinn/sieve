// @ts-check
// asset-urls.test.js — the ONE place the browser half builds a Sieve served-file
// route. These assertions are the contract's client side: the prefixes here must
// match the routes requesthandlers/asset_handler.go mounts, and documentAssetUrl
// must agree with what Go's store.AssetURL mints INTO documents.
import { describe, it, expect } from 'vitest'
import {
  imageProxyUrl,
  documentAssetUrl,
  resolveImageSrc,
  storeFileSrc,
  storeFileRef,
} from '../src/static/block/renderers/asset-urls.js'

describe('asset-urls', () => {
  it('proxies a remote image through /ui/image-proxy, origin-qualified', () => {
    const url = imageProxyUrl('https://example.com/a b.png?x=1')
    expect(url.startsWith(window.location.origin + '/ui/image-proxy?url=')).toBe(true)
    // The whole remote URL is one parameter value — its own query must not
    // become part of ours.
    expect(url).toContain(encodeURIComponent('https://example.com/a b.png?x=1'))
  })

  it('builds a document asset URL from the reference the document spells', () => {
    expect(documentAssetUrl('doc-1', 'pic.png')).toBe('/ui/assets/doc-1/pic.png')
    // Only the final segment is meaningful: assets are flat within a document.
    expect(documentAssetUrl('doc-1', 'nested/pic.png')).toBe('/ui/assets/doc-1/pic.png')
    expect(documentAssetUrl('doc-1', '')).toBe('')
    // Already a route — left exactly as it is.
    expect(documentAssetUrl('doc-1', '/ui/assets/other/pic.png')).toBe('/ui/assets/other/pic.png')
  })

  it('resolveImageSrc climbs the whole ladder in order', () => {
    expect(resolveImageSrc('https://example.com/x.png')).toContain('/ui/image-proxy?url=')
    expect(resolveImageSrc('http://example.com/x.png')).toContain('/ui/image-proxy?url=')
    expect(resolveImageSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(resolveImageSrc('blob:whatever')).toBe('blob:whatever')
    expect(resolveImageSrc('/already/absolute.png')).toBe('/already/absolute.png')
    expect(resolveImageSrc('.assets/pic.png', 'doc-1')).toBe('/ui/assets/doc-1/pic.png')
    expect(resolveImageSrc('pic.png', 'doc-1')).toBe('/ui/assets/doc-1/pic.png')
    expect(resolveImageSrc('')).toBe('')
  })

  it('points a relative markdown image at the store file route, and nothing else', () => {
    expect(storeFileSrc('diagrams/flow.png')).toBe('/ui/files/diagrams/flow.png')
    expect(storeFileSrc('./flow.png')).toBe('/ui/files/flow.png')
    expect(storeFileSrc('/ui/assets/doc-1/pic.png')).toBe('/ui/assets/doc-1/pic.png')
    expect(storeFileSrc('https://example.com/x.png')).toBe('https://example.com/x.png')
    expect(storeFileSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(storeFileSrc('')).toBe('')
  })

  it('storeFileRef reverses the rewrite so a render/parse round trip does not rewrite the document', () => {
    const relative = 'diagrams/flow.png'
    expect(storeFileRef(storeFileSrc(relative))).toBe(relative)
    // Anything that was never rewritten survives untouched.
    expect(storeFileRef('https://example.com/x.png')).toBe('https://example.com/x.png')
    expect(storeFileRef('/ui/assets/doc-1/pic.png')).toBe('/ui/assets/doc-1/pic.png')
    expect(storeFileRef(null)).toBe(null)
  })
})
