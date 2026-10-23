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
  isContainerRelativeAssetRef,
  storeFileSrc,
  storeFileRef,
} from '../src/static/renderers/asset-urls.js'
import { rasterSizeFor } from '../src/static/renderers/copy-image.js'

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
    // The stored sieve://{container}/{key}, its key passed on as
    // spelled, raw or percent-encoded, and the legacy relative /{key}.
    expect(documentAssetUrl('doc-1', 'sieve://doc-1/pic.png')).toBe('/ui/assets/doc-1/pic.png')
    expect(documentAssetUrl('doc-1', 'sieve://other-doc/pic.png')).toBe('/ui/assets/other-doc/pic.png')
    expect(documentAssetUrl('doc-1', 'sieve://doc-1/%E6%97%A5.png')).toBe('/ui/assets/doc-1/%E6%97%A5.png')
    expect(documentAssetUrl('doc-1', 'sieve://doc-1/日本.png')).toBe('/ui/assets/doc-1/日本.png')
    expect(documentAssetUrl('doc-1', 'sieve://doc-1/a%3Fb.png')).toBe('/ui/assets/doc-1/a%3Fb.png')
    expect(documentAssetUrl('doc-1', '/pic.png')).toBe('/ui/assets/doc-1/pic.png')
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
    expect(resolveImageSrc('/pic.png', 'doc-1')).toBe('/ui/assets/doc-1/pic.png')
    expect(resolveImageSrc('sieve://doc-1/pic.png', 'doc-1')).toBe('/ui/assets/doc-1/pic.png')
    expect(resolveImageSrc('sieve://other-doc/pic.png', 'doc-1')).toBe('/ui/assets/other-doc/pic.png')
    expect(resolveImageSrc('.assets/pic.png', 'doc-1')).toBe('/ui/assets/doc-1/pic.png')
    expect(resolveImageSrc('pic.png', 'doc-1')).toBe('/ui/assets/doc-1/pic.png')
    expect(resolveImageSrc('')).toBe('')
  })

  it.each([
    ['/pic.png', true],
    ['pic.png', true],
    ['sieve://doc-1/pic.png', false],
    ['/ui/assets/doc-1/pic.png', false],
    ['/sieve/doc-1/pic.png', false],
    ['https://example.com/x.png', false],
    ['data:image/png;base64,AAAA', false],
    ['/', false],
    ['', false],
  ])('isContainerRelativeAssetRef(%s) is %s', (ref, want) => {
    expect(isContainerRelativeAssetRef(ref)).toBe(want)
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

describe('rasterSizeFor', () => {
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
    expect(rasterSizeFor(svg, w, h)).toEqual(want)
  })
})
