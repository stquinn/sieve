// @ts-check
// smart-image-renderer.test.js — DoD coverage for SmartImageRenderer (the
// 'smart-image' kind's look-and-feel class, docs/design/specs/2026-07-20-block-renderer-extraction.md
// Phase 4 / issue #47). Per the spec's contract, definition of done for any
// renderer is "renders correctly in a bare page providing only :root theme
// vars" — mirrors code-renderer.test.js/web-clip-renderer.test.js.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { SmartImageRenderer } from '../src/static/block/renderers/smart-image-renderer.js'

function clearInjectedStyles() {
  document.adoptedStyleSheets = []
  document.head.querySelectorAll('style[data-sieve-renderer]').forEach((el) => el.remove())
}

function installBareThemeVars() {
  const el = document.createElement('style')
  el.setAttribute('data-test-root-vars', '')
  el.textContent = `
    :root {
      --theme-bg: #1a1b26;
      --theme-bgDark: #16161e;
      --theme-text: #c0caf5;
      --theme-accentPrimary: #7aa2f7;
      --theme-accentRed: #f7768e;
      --theme-aiBlockBorder: rgba(122, 162, 247, 0.28);
    }
  `
  document.head.appendChild(el)
  return el
}

describe('SmartImageRenderer (Phase 4 — bare-page DoD)', () => {
  /** @type {HTMLStyleElement} */
  let rootVars

  beforeAll(() => {
    clearInjectedStyles()
  })

  beforeEach(() => {
    rootVars = installBareThemeVars()
  })

  afterEach(() => {
    rootVars.remove()
    document.body.innerHTML = ''
  })

  it('registers its static styles exactly once across multiple instances (register-once contract)', () => {
    new SmartImageRenderer()
    new SmartImageRenderer()
    new SmartImageRenderer()
    const matches = document.adoptedStyleSheets.filter((sheet) =>
      Array.from(sheet.cssRules).some((rule) => rule.cssText.indexOf('.node-image') === 0))
    expect(matches.length).toBe(1)
  })

  it('mounts the image wrapper + resizer + hidden badge, styled purely from --theme-* vars', () => {
    const renderer = new SmartImageRenderer()
    const dom = renderer.mount({ id: 'im-a1b2', src: '/sieve/u/pic.png', alt: 'a cat', status: 'COMPLETE' })
    document.body.appendChild(dom)

    expect(dom.className).toBe('image-block node-image')
    expect(dom.getAttribute('data-id')).toBe('im-a1b2')
    const img = /** @type {HTMLImageElement} */ (dom.querySelector('img'))
    expect(img.src).toContain('/sieve/u/pic.png')
    expect(img.alt).toBe('a cat')
    expect(dom.querySelector('.image-resizer')).toBeTruthy()

    const badge = /** @type {HTMLElement} */ (dom.querySelector('.smart-image-status'));
    expect(getComputedStyle(badge).display).toBe('none')
  })

  it('resolveSrc is a pure (src, uuid) function — proxies remote URLs, resolves relative asset paths, passes through data/blob/absolute URLs', () => {
    expect(SmartImageRenderer.resolveSrc('https://example.com/x.png')).toContain('/sieve-image-proxy?url=')
    expect(SmartImageRenderer.resolveSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(SmartImageRenderer.resolveSrc('/already/absolute.png')).toBe('/already/absolute.png')
    expect(SmartImageRenderer.resolveSrc('.assets/pic.png', 'doc-uuid')).toBe('/sieve/doc-uuid/pic.png')
    expect(SmartImageRenderer.resolveSrc('pic.png', 'doc-uuid')).toBe('/sieve/doc-uuid/pic.png')
  })

  it('badge state: PENDING (fresh) shows "Processing…"', () => {
    const renderer = new SmartImageRenderer()
    const dom = renderer.mount({ id: 'im-b2c3', src: '/x.png', status: 'PENDING', createdAt: new Date().toISOString() })
    const badge = /** @type {HTMLElement} */ (dom.querySelector('.smart-image-status'));
    expect(badge.textContent).toBe('Processing…')
    expect(badge.className).toContain('smart-image-status--pending')
  })

  it('badge state: a stale DISPATCHED job reports error, not stuck Processing (fixes the pre-split DISPATCHED-staleness gap)', () => {
    const renderer = new SmartImageRenderer()
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const dom = renderer.mount({ id: 'im-c3d4', src: '/x.png', status: 'DISPATCHED', createdAt: stale })
    const badge = /** @type {HTMLElement} */ (dom.querySelector('.smart-image-status'));
    expect(badge.className).toContain('smart-image-status--error')
    expect(badge.textContent).toBe('Failed')
  })

  it('badge state: ERROR shows the framework error text; COMPLETE hides the badge', () => {
    const renderer = new SmartImageRenderer()
    const dom = renderer.mount({ id: 'im-d4e5', src: '/x.png', status: 'ERROR', error: 'decode failed' })
    document.body.appendChild(dom)
    let badge = /** @type {HTMLElement} */ (dom.querySelector('.smart-image-status'));
    expect(badge.textContent).toBe('decode failed')

    renderer.update(dom, { id: 'im-d4e5', src: '/x.png', status: 'COMPLETE' })
    badge = /** @type {HTMLElement} */ (dom.querySelector('.smart-image-status'));
    expect(getComputedStyle(badge).display).toBe('none')
  })

  it('resize drag commits width/height via the onResize callback', () => {
    const renderer = new SmartImageRenderer()
    const onResize = vi.fn()
    renderer.onResize(onResize)
    const dom = renderer.mount({ id: 'im-e5f6', src: '/x.png', status: 'COMPLETE' })
    document.body.appendChild(dom)
    const resizer = /** @type {HTMLElement} */ (dom.querySelector('.image-resizer'));

    resizer.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 140, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))

    expect(onResize).toHaveBeenCalledOnce()
    const dims = onResize.mock.calls[0][0]
    expect(typeof dims.width).toBe('string')
    expect(typeof dims.height).toBe('string')
  })

  it('destroy() is safe to call and does not throw (base no-op)', () => {
    const renderer = new SmartImageRenderer()
    const dom = renderer.mount({ id: 'im-f6a7', src: '/x.png', status: 'COMPLETE' })
    expect(() => renderer.destroy(dom)).not.toThrow()
  })
})
