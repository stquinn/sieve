// @ts-check
// web-clip-renderer.test.js — DoD coverage for WebClipRenderer (the 'web-clip'
// kind's look-and-feel class, docs/design/archive/specs/2026-07-20-block-renderer-extraction.md
// Phase 4 / issue #47). Bare-page protocol: render() ALONE yields the complete
// block. This PURE class fills its own body/title; the note lens swaps an empty
// PM-managed body (the adapter's handleBuild claim of the BODY region).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import MarkdownIt from 'markdown-it'
import { WebClipRenderer } from '../src/static/block/renderers/web-clip-renderer.js'
import { SieveBlock } from '../src/static/block/sieve-block.js'
import { BlockService } from '../src/static/block/block-service.js'

/** @param {object} payload */
function blk(payload) { return new SieveBlock('web-clip', payload) }

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
      --theme-border2: #3b4261;
      --theme-text: #c0caf5;
      --theme-textDim: #a9b1d6;
      --theme-accentCyan: #7dcfff;
      --theme-accentOrange: #ff9e64;
      --theme-accentRed: #f7768e;
      --theme-aiBlockBg: rgba(122, 162, 247, 0.04);
      --theme-aiBlockBorder: rgba(122, 162, 247, 0.28);
      --theme-monoFont: monospace;
    }
  `
  document.head.appendChild(el)
  return el
}

/** @param {Element|null} el */
function isVisible(el) {
  return !!el && getComputedStyle(el).display !== 'none'
}

/** render() ALONE = the complete block. */
function mount(attrs, service) {
  const renderer = new WebClipRenderer(blk(attrs), service || null)
  const dom = renderer.render()
  return { renderer, dom }
}

describe('WebClipRenderer (Phase 4 — bare-page DoD)', () => {
  /** @type {HTMLStyleElement} */
  let rootVars

  beforeAll(() => {
    clearInjectedStyles();
    /** @type {any} */ (globalThis).TipTap = /** @type {any} */ (globalThis).TipTap || {}
    Object.assign(/** @type {any} */ (globalThis).TipTap, { MarkdownIt })
  })
  afterAll(() => { delete /** @type {any} */ (globalThis).TipTap.MarkdownIt })
  beforeEach(() => { rootVars = installBareThemeVars() })
  afterEach(() => { rootVars.remove(); document.body.innerHTML = '' })

  it('registers its static styles exactly once across multiple instances (register-once contract)', () => {
    new WebClipRenderer(blk({}))
    new WebClipRenderer(blk({}))
    new WebClipRenderer(blk({}))
    const matches = document.adoptedStyleSheets.filter((sheet) =>
      Array.from(sheet.cssRules).some((rule) => rule.cssText.indexOf('.web-clip-block') === 0))
    expect(matches.length).toBe(1)
  })

  it('render() builds the shell + badge + body container, styled purely from --theme-* vars', () => {
    const { renderer, dom } = mount({ id: 'wc-a1b2', source: 'https://example.com', mode: 'fetch', status: 'COMPLETE' })
    document.body.appendChild(dom)

    expect(dom.className).toBe('web-clip-block')
    expect(dom.getAttribute('data-id')).toBe('wc-a1b2')

    const badge = dom.querySelector('.web-clip-block__badge')
    expect(badge?.textContent).toBe('WEB CLIP')

    const content = dom.querySelector('.web-clip-block__content.tiptap')
    expect(content).toBeTruthy()
    expect(renderer.body).toBe(content)

    expect(getComputedStyle(/** @type {Element} */ (badge)).color.toLowerCase()).toBe('#7dcfff')
  })

  it('status chrome: PENDING (fresh) shows a spinner + fetching label, retry hidden (checked via computed style)', () => {
    const { dom } = mount({ id: 'wc-b2c3', source: 'example.com', mode: 'fetch', status: 'PENDING', createdAt: new Date().toISOString() })
    document.body.appendChild(dom)
    expect(isVisible(dom.querySelector('.web-clip-block__spinner'))).toBe(true)
    expect(dom.querySelector('.web-clip-block__label')?.textContent).toContain('Fetching from example.com')
    expect(isVisible(dom.querySelector('.web-clip-block__retry'))).toBe(false)
  })

  it('status chrome: a stale PENDING job shows "interrupted" + a VISIBLE retry button', () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const { dom } = mount({ id: 'wc-c3d4', source: 'example.com', mode: 'summarise', status: 'PENDING', createdAt: stale })
    document.body.appendChild(dom)
    expect(dom.querySelector('.web-clip-block__label')?.textContent).toContain('interrupted')
    expect(isVisible(dom.querySelector('.web-clip-block__retry'))).toBe(true)
  })

  it('status chrome: COMPLETE shows the status line + source link, retry NOT visible', () => {
    const { dom } = mount({ id: 'wc-d4e5', source: 'https://example.com/page', mode: 'fetch', status: 'COMPLETE' })
    document.body.appendChild(dom)
    expect(dom.querySelector('.web-clip-block__status')?.textContent).toBe('Fetched — ')
    const link = /** @type {HTMLAnchorElement} */ (dom.querySelector('.web-clip-block__source-link'))
    expect(link.href).toBe('https://example.com/page')
    expect(isVisible(dom.querySelector('.web-clip-block__retry'))).toBe(false)
  })

  it('status chrome: TIMEOUT shows "Timed out" + a VISIBLE retry button', () => {
    const { dom } = mount({ id: 'wc-e5f6', source: 'example.com', mode: 'fetch', status: 'TIMEOUT' })
    document.body.appendChild(dom)
    expect(dom.querySelector('.web-clip-block__label')?.textContent).toContain('Timed out')
    expect(isVisible(dom.querySelector('.web-clip-block__retry'))).toBe(true)
  })

  it('status chrome: ERROR shows the error message + a VISIBLE retry button', () => {
    const { dom } = mount({ id: 'wc-f6a7', source: 'example.com', mode: 'fetch', status: 'ERROR', error: 'DNS lookup failed' })
    document.body.appendChild(dom)
    expect(dom.querySelector('.web-clip-block__label')?.textContent).toBe('DNS lookup failed')
    expect(isVisible(dom.querySelector('.web-clip-block__retry'))).toBe(true)
  })

  it('retry button routes through the BlockService to the registered applier (semantic verb)', () => {
    const retry = vi.fn()
    const service = new BlockService()
    service.registerApplier({ owns: () => true, updateAttributes: () => {}, setContent: () => {}, retry })
    const { dom } = mount({ id: 'wc-g7b8', source: 'example.com', mode: 'fetch', status: 'ERROR', error: 'boom' }, service);
    /** @type {HTMLButtonElement} */ (dom.querySelector('.web-clip-block__retry')).click()
    expect(retry).toHaveBeenCalledOnce()
    expect(retry).toHaveBeenCalledWith('wc-g7b8')
  })

  it('SECURITY: a hostile error string with an <img onerror> payload renders inert as plain text', () => {
    const hostile = '<img src=x onerror="window.__pwned = true">'
    const { dom } = mount({ id: 'wc-i9d0', source: 'example.com', mode: 'fetch', status: 'ERROR', error: hostile })
    document.body.appendChild(dom)

    expect(dom.querySelector('img')).toBeFalsy()
    expect(/** @type {any} */ (window).__pwned).toBeUndefined()
    expect(dom.querySelector('.web-clip-block__label')?.textContent).toBe(hostile)
  })

  it('SECURITY: a hostile source/domain string also renders inert as plain text in the PENDING label', () => {
    const hostileDomain = '<script>window.__pwned2 = true</script>'
    const { dom } = mount({ id: 'wc-j0e1', source: hostileDomain, mode: 'fetch', status: 'PENDING', createdAt: new Date().toISOString() })
    document.body.appendChild(dom)

    expect(dom.querySelector('script')).toBeFalsy()
    expect(/** @type {any} */ (window).__pwned2).toBeUndefined()
    expect(dom.querySelector('.web-clip-block__label')?.textContent).toContain(hostileDomain)
  })

  it('destroy() is safe to call and does not throw (base no-op — no timers/observers)', () => {
    const { renderer } = mount({ id: 'wc-h8c9', source: 'example.com', mode: 'fetch', status: 'COMPLETE' })
    expect(() => renderer.destroy()).not.toThrow()
  })
})
