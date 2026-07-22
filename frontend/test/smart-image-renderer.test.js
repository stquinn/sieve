// @ts-check
// smart-image-renderer.test.js — DoD coverage for SmartImageRenderer (the
// 'smart-image' kind's look-and-feel class; NORMATIVE contract:
// docs/design/specs/2026-07-21-block-renderer-contract.md). Bare-page
// protocol: render() alone yields the complete block. Scratch construction is
// (block) only; the resize tests construct LIVE instances over a real
// BlockService with a registered fake applier (the v1 transport).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { SmartImageRenderer } from '../src/static/block/renderers/smart-image-renderer.js'
import { SieveBlock } from '../src/static/block/sieve-block.js'
import { BlockService } from '../src/static/block/block-service.js'

/** @param {object} payload */
function blk(payload) { return new SieveBlock('smart-image', payload) }

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

/** render() alone = the complete block. Pass a service for LIVE instances. */
function mount(payload, service) {
  const renderer = new SmartImageRenderer(blk(payload), service || null)
  const dom = renderer.render()
  return { renderer, dom }
}

/** A real BlockService with one fake applier registered for `id`. */
function serviceWithApplier(id) {
  const service = new BlockService()
  const updateAttributes = vi.fn()
  service.registerApplier({
    owns: (blockId) => blockId === id,
    updateAttributes,
    setContent: () => {},
    retry: () => {},
  })
  return { service, updateAttributes }
}

describe('SmartImageRenderer (bare-page DoD)', () => {
  /** @type {HTMLStyleElement} */
  let rootVars

  beforeAll(() => { clearInjectedStyles() })
  beforeEach(() => { rootVars = installBareThemeVars() })
  afterEach(() => { rootVars.remove(); document.body.innerHTML = '' })

  it('registers its static styles exactly once across multiple instances (register-once contract)', () => {
    new SmartImageRenderer(blk({}))
    new SmartImageRenderer(blk({}))
    new SmartImageRenderer(blk({}))
    const matches = document.adoptedStyleSheets.filter((sheet) =>
      Array.from(sheet.cssRules).some((rule) => rule.cssText.indexOf('.node-image') === 0))
    expect(matches.length).toBe(1)
  })

  it('render() builds the image wrapper + resizer + hidden badge, styled purely from --theme-* vars', () => {
    const { dom } = mount({ id: 'im-a1b2', src: '/sieve/u/pic.png', alt: 'a cat', status: 'COMPLETE' })
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
    const { dom } = mount({ id: 'im-b2c3', src: '/x.png', status: 'PENDING', createdAt: new Date().toISOString() })
    const badge = /** @type {HTMLElement} */ (dom.querySelector('.smart-image-status'));
    expect(badge.textContent).toBe('Processing…')
    expect(badge.className).toContain('smart-image-status--pending')
  })

  it('badge state: a stale DISPATCHED job reports error, not stuck Processing', () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const { dom } = mount({ id: 'im-c3d4', src: '/x.png', status: 'DISPATCHED', createdAt: stale })
    const badge = /** @type {HTMLElement} */ (dom.querySelector('.smart-image-status'));
    expect(badge.className).toContain('smart-image-status--error')
    expect(badge.textContent).toBe('Failed')
  })

  it('badge state: ERROR shows the framework error text; COMPLETE hides the badge', () => {
    const { renderer, dom } = mount({ id: 'im-d4e5', src: '/x.png', status: 'ERROR', error: 'decode failed' })
    document.body.appendChild(dom)
    let badge = /** @type {HTMLElement} */ (dom.querySelector('.smart-image-status'));
    expect(badge.textContent).toBe('decode failed')

    renderer.update(blk({ id: 'im-d4e5', src: '/x.png', status: 'COMPLETE' }))
    badge = /** @type {HTMLElement} */ (dom.querySelector('.smart-image-status'));
    expect(getComputedStyle(badge).display).toBe('none')
  })

  it('resize drag commits width/height through the BlockService (drag release self-invokes the resize verb)', () => {
    const { service, updateAttributes } = serviceWithApplier('im-e5f6')
    const { dom } = mount({ id: 'im-e5f6', src: '/x.png', status: 'COMPLETE' }, service)
    document.body.appendChild(dom)
    const resizer = /** @type {HTMLElement} */ (dom.querySelector('.image-resizer'));

    resizer.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 140, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))

    expect(updateAttributes).toHaveBeenCalledOnce()
    const [id, dims] = updateAttributes.mock.calls[0]
    expect(id).toBe('im-e5f6')
    expect(typeof dims.width).toBe('string')
    expect(typeof dims.height).toBe('string')
  })

  it('resize(width, height) delivers the expected patch to the registered applier via a real BlockService', () => {
    const { service, updateAttributes } = serviceWithApplier('im-f6a7')
    const { renderer } = mount({ id: 'im-f6a7', src: '/x.png', status: 'COMPLETE' }, service)

    renderer.resize('320', '240')

    expect(updateAttributes).toHaveBeenCalledOnce()
    expect(updateAttributes).toHaveBeenCalledWith('im-f6a7', { width: '320', height: '240' })
  })

  it('destroy() is safe to call and does not throw (base no-op)', () => {
    const { renderer } = mount({ id: 'im-a7b8', src: '/x.png', status: 'COMPLETE' })
    expect(() => renderer.destroy()).not.toThrow()
  })
})
