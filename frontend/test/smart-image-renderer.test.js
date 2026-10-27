// @ts-check
// smart-image-renderer.test.js — DoD coverage for SmartImageRenderer (the
// 'smart-image' kind's look-and-feel class; NORMATIVE contract:
// docs/design/archive/specs/2026-07-21-block-renderer-contract.md). Bare-page
// protocol: render() alone yields the complete block. Scratch construction is
// (block) only; the resize tests construct LIVE instances over a real
// ContainerTransport with a registered fake applier (the v1 transport).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { SmartImageRenderer } from '../src/static/renderers/smart-image-renderer.js'
import { SieveBlock } from '../src/static/contract/sieve-block.js'
import { providerRig } from './helpers/service-rig.js'

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

/** render() alone = the complete block. Pass a provider for LIVE instances. */
function mount(payload, provider) {
  const renderer = new SmartImageRenderer(blk(payload), provider || null)
  const dom = renderer.render()
  return { renderer, dom }
}

/** A real, wire-owning ContainerTransport with `id` seeded into its routing index
 *  (issue #49 Phase 1 — appliers are retired; assertions read the socket). */
function serviceWithBlock(id) {
  const { provider, sock } = providerRig({ blocks: [{ id, kind: 'smart-image' }] })
  /** @param {string} blockId */
  const patchesFor = (blockId) => sock.sentOfType('block-op')
    .filter((m) => m.op.type === 'update-block' && m.op.blockId === blockId)
    .map((m) => m.op.attrs)
  return { provider, sock, patchesFor }
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

  it('render() builds the image wrapper + three resize handles + hidden badge, styled purely from --theme-* vars', () => {
    const { dom } = mount({ id: 'im-a1b2', src: '/ui/assets/doc-uuid/pic.png', alt: 'a cat', status: 'COMPLETE' })
    document.body.appendChild(dom)

    expect(dom.className).toBe('image-block node-image')
    expect(dom.getAttribute('data-id')).toBe('im-a1b2')
    const img = /** @type {HTMLImageElement} */ (dom.querySelector('img'))
    expect(img.src).toContain('/ui/assets/doc-uuid/pic.png')
    expect(img.alt).toBe('a cat')
    expect(Array.from(dom.querySelectorAll('.image-resizer')).map((h) => h.className)).toEqual([
      'image-resizer image-resizer--corner', 'image-resizer image-resizer--right', 'image-resizer image-resizer--bottom',
    ])

    const badge = /** @type {HTMLElement} */ (dom.querySelector('.smart-image-status'));
    expect(getComputedStyle(badge).display).toBe('none')
  })

  it('resolveSrc is a pure (src, uuid) function — proxies remote URLs, resolves relative asset paths, passes through data/blob/absolute URLs', () => {
    expect(SmartImageRenderer.resolveSrc('https://example.com/x.png')).toContain('/ui/image-proxy?url=')
    expect(SmartImageRenderer.resolveSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(SmartImageRenderer.resolveSrc('/already/absolute.png')).toBe('/already/absolute.png')
    expect(SmartImageRenderer.resolveSrc('.assets/pic.png', 'doc-uuid')).toBe('/ui/assets/doc-uuid/pic.png')
    expect(SmartImageRenderer.resolveSrc('pic.png', 'doc-uuid')).toBe('/ui/assets/doc-uuid/pic.png')
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

  /**
   * Mount a live 200×100 image (stored, since jsdom has no layout) and drag one
   * handle by (dx, dy); returns the attrs every update-block carried.
   * @param {string} handle @param {number} dx @param {number} dy @param {object} [size]
   */
  function drag(handle, dx, dy, size = { width: '200', height: '100' }) {
    const { provider, patchesFor } = serviceWithBlock('im-e5f6')
    const { dom } = mount({ id: 'im-e5f6', src: '/x.png', status: 'COMPLETE', ...size }, provider)
    document.body.appendChild(dom)
    const el = /** @type {HTMLElement} */ (dom.querySelector(`.image-resizer--${handle}`))
    el.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 100, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 + dx, clientY: 100 + dy, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    return { patches: patchesFor('im-e5f6'), dom }
  }

  it.each([
    ['corner keeps the ratio', 'corner', 40, 999, { width: '240', height: '120' }],
    ['right edge moves width only', 'right', 40, 999, { width: '240', height: '100' }],
    ['bottom edge moves height only', 'bottom', 999, 40, { width: '200', height: '140' }],
    ['right edge floors width at 40', 'right', -500, 0, { width: '40', height: '100' }],
    ['bottom edge floors height at 40', 'bottom', 0, -500, { width: '200', height: '40' }],
    ['corner floors the short side at 40, ratio kept', 'corner', -500, 0, { width: '80', height: '40' }],
  ])('drag: %s — commits once through the resize verb', (_name, handle, dx, dy, expected) => {
    const { patches, dom } = drag(handle, dx, dy)
    expect(patches).toEqual([expected])
    expect(/** @type {HTMLImageElement} */ (dom.querySelector('img')).style.width).toBe(expected.width + 'px')
  })

  it('corner floors the short side at 40 on a tall image too', () => {
    expect(drag('corner', -500, 0, { width: '100', height: '200' }).patches).toEqual([{ width: '40', height: '80' }])
  })

  it('a press and release with no movement commits nothing', () => {
    for (const handle of ['corner', 'right', 'bottom']) expect(drag(handle, 0, 0).patches).toEqual([])
  })

  it('double-click on the corner resets to the decoded natural size; a sizeless image clears both attrs', () => {
    const { provider, patchesFor } = serviceWithBlock('im-e5f6')
    const { dom } = mount({ id: 'im-e5f6', src: '/x.png', status: 'COMPLETE', width: '200', height: '100' }, provider)
    const img = /** @type {HTMLImageElement} */ (dom.querySelector('img'))
    const corner = /** @type {HTMLElement} */ (dom.querySelector('.image-resizer--corner'))

    corner.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    Object.defineProperty(img, 'naturalWidth', { value: 1200 })
    Object.defineProperty(img, 'naturalHeight', { value: 800 })
    corner.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    const right = /** @type {HTMLElement} */ (dom.querySelector('.image-resizer--right'))
    right.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))

    expect(patchesFor('im-e5f6')).toEqual([{ width: '', height: '' }, { width: '1200', height: '800' }])
  })

  it('resize(width, height) frames the expected FROZEN block-op via a real ContainerTransport', () => {
    const { provider, sock } = serviceWithBlock('im-f6a7')
    const { renderer } = mount({ id: 'im-f6a7', src: '/x.png', status: 'COMPLETE' }, provider)

    renderer.resize('320', '240')

    expect(sock.sentOfType('block-op')).toEqual([{
      type: 'block-op', uuid: 'doc-1', opId: expect.stringMatching(/^op-\d+$/),
      op: { type: 'update-block', blockId: 'im-f6a7', kind: 'smart-image', attrs: { width: '320', height: '240' } },
    }])
  })

  it('destroy() is safe to call and does not throw (base no-op)', () => {
    const { renderer } = mount({ id: 'im-a7b8', src: '/x.png', status: 'COMPLETE' })
    expect(() => renderer.destroy()).not.toThrow()
  })
})
