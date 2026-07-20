// @ts-check
// web-clip-renderer.test.js — DoD coverage for WebClipRenderer (the
// 'web-clip' kind's look-and-feel class, docs/design/archive/specs/2026-07-20-block-renderer-extraction.md
// Phase 4 / issue #47). Per the spec's contract, definition of done for any
// renderer is "renders correctly in a bare page providing only :root theme
// vars" — mirrors ai-block-renderer.test.js's SCOPE NOTE: this class's own
// DOM surface is the shell + status chrome + an EMPTY contentDOM container;
// the title/body markdown is the framework's titleProvider/contentProvider
// seam (PM-coupled, out of scope here).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { WebClipRenderer } from '../src/static/block/renderers/web-clip-renderer.js'

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

// Checks ACTUAL rendered visibility (getComputedStyle), not just the `hidden`
// IDL property — a real live-app bug slipped past a property-only assertion
// here: .web-clip-block__retry/.web-clip-block__spinner both set an explicit
// `display` in CSS at the same specificity as the UA `[hidden]` rule, so
// `retry.hidden === true` was passing while the button stayed visibly
// `display: block` on screen. Fixed by a `.web-clip-block [hidden] { display:
// none !important }` guard in web-clip-renderer.styles.js; this helper is
// what would have caught it.
/** @param {Element|null} el */
function isVisible(el) {
  return !!el && getComputedStyle(el).display !== 'none'
}

describe('WebClipRenderer (Phase 4 — bare-page DoD)', () => {
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
    new WebClipRenderer()
    new WebClipRenderer()
    new WebClipRenderer()
    const matches = document.adoptedStyleSheets.filter((sheet) =>
      Array.from(sheet.cssRules).some((rule) => rule.cssText.indexOf('.web-clip-block') === 0))
    expect(matches.length).toBe(1)
  })

  it('mounts the shell + badge + empty contentDOM container, styled purely from --theme-* vars', () => {
    const renderer = new WebClipRenderer()
    const dom = renderer.mount({ id: 'wc-a1b2', source: 'https://example.com', mode: 'fetch', status: 'COMPLETE' })
    document.body.appendChild(dom)

    expect(dom.className).toBe('web-clip-block')
    expect(dom.getAttribute('data-id')).toBe('wc-a1b2')

    const badge = dom.querySelector('.web-clip-block__badge')
    expect(badge).toBeTruthy()
    expect(badge?.textContent).toBe('WEB CLIP')

    const content = dom.querySelector('.web-clip-block__content.tiptap')
    expect(content).toBeTruthy()
    expect(renderer.contentDOM).toBe(content)

    expect(getComputedStyle(/** @type {Element} */ (badge)).color.toLowerCase()).toBe('#7dcfff')
  })

  it('status chrome: PENDING (fresh) shows a spinner + fetching label, retry hidden (checked via computed style, not just the IDL property)', () => {
    const renderer = new WebClipRenderer()
    const dom = renderer.mount({ id: 'wc-b2c3', source: 'example.com', mode: 'fetch', status: 'PENDING', createdAt: new Date().toISOString() })
    document.body.appendChild(dom)
    expect(isVisible(dom.querySelector('.web-clip-block__spinner'))).toBe(true)
    expect(dom.querySelector('.web-clip-block__label')?.textContent).toContain('Fetching from example.com')
    expect(isVisible(dom.querySelector('.web-clip-block__retry'))).toBe(false)
  })

  it('status chrome: a stale PENDING job shows "interrupted" + a VISIBLE retry button', () => {
    const renderer = new WebClipRenderer()
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const dom = renderer.mount({ id: 'wc-c3d4', source: 'example.com', mode: 'summarise', status: 'PENDING', createdAt: stale })
    document.body.appendChild(dom)
    expect(dom.querySelector('.web-clip-block__label')?.textContent).toContain('interrupted')
    expect(isVisible(dom.querySelector('.web-clip-block__retry'))).toBe(true)
  })

  it('status chrome: COMPLETE shows the status line + source link, retry NOT visible', () => {
    const renderer = new WebClipRenderer()
    const dom = renderer.mount({ id: 'wc-d4e5', source: 'https://example.com/page', mode: 'fetch', status: 'COMPLETE' })
    document.body.appendChild(dom)
    expect(dom.querySelector('.web-clip-block__status')?.textContent).toBe('Fetched — ')
    const link = /** @type {HTMLAnchorElement} */ (dom.querySelector('.web-clip-block__source-link'))
    expect(link.href).toBe('https://example.com/page')
    // Regression coverage: a prior version passed retry.hidden===true here
    // while the button stayed VISIBLE on screen (display:block beat [hidden]
    // at equal specificity) — see isVisible's doc comment.
    expect(isVisible(dom.querySelector('.web-clip-block__retry'))).toBe(false)
  })

  it('status chrome: TIMEOUT shows "Timed out" + a VISIBLE retry button (full state machine — fixes smart-link\'s missing-TIMEOUT quirk for this migrated kind)', () => {
    const renderer = new WebClipRenderer()
    const dom = renderer.mount({ id: 'wc-e5f6', source: 'example.com', mode: 'fetch', status: 'TIMEOUT' })
    document.body.appendChild(dom)
    expect(dom.querySelector('.web-clip-block__label')?.textContent).toContain('Timed out')
    expect(isVisible(dom.querySelector('.web-clip-block__retry'))).toBe(true)
  })

  it('status chrome: ERROR shows the error message + a VISIBLE retry button', () => {
    const renderer = new WebClipRenderer()
    const dom = renderer.mount({ id: 'wc-f6a7', source: 'example.com', mode: 'fetch', status: 'ERROR', error: 'DNS lookup failed' })
    document.body.appendChild(dom)
    expect(dom.querySelector('.web-clip-block__label')?.textContent).toBe('DNS lookup failed')
    expect(isVisible(dom.querySelector('.web-clip-block__retry'))).toBe(true)
  })

  it('retry button invokes the callback registered via onRetry()', () => {
    const renderer = new WebClipRenderer()
    const onRetry = vi.fn()
    renderer.onRetry(onRetry)
    const dom = renderer.mount({ id: 'wc-g7b8', source: 'example.com', mode: 'fetch', status: 'ERROR', error: 'boom' });
    /** @type {HTMLButtonElement} */ (dom.querySelector('.web-clip-block__retry')).click()
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('SECURITY: attrs-derived text is never interpreted as markup — a hostile error string with an <img onerror> payload renders inert as plain text', () => {
    const renderer = new WebClipRenderer()
    const hostile = '<img src=x onerror="window.__pwned = true">'
    const dom = renderer.mount({ id: 'wc-i9d0', source: 'example.com', mode: 'fetch', status: 'ERROR', error: hostile })
    document.body.appendChild(dom)

    // The payload must never become a live element — textContent renders it
    // as literal text, so no <img> tag exists in the DOM and no onerror ever fires.
    expect(dom.querySelector('img')).toBeFalsy()
    expect(/** @type {any} */ (window).__pwned).toBeUndefined()
    expect(dom.querySelector('.web-clip-block__label')?.textContent).toBe(hostile)
  })

  it('SECURITY: a hostile source/domain string also renders inert as plain text in the PENDING label', () => {
    const renderer = new WebClipRenderer()
    const hostileDomain = '<script>window.__pwned2 = true</script>'
    const dom = renderer.mount({ id: 'wc-j0e1', source: hostileDomain, mode: 'fetch', status: 'PENDING', createdAt: new Date().toISOString() })
    document.body.appendChild(dom)

    expect(dom.querySelector('script')).toBeFalsy()
    expect(/** @type {any} */ (window).__pwned2).toBeUndefined()
    expect(dom.querySelector('.web-clip-block__label')?.textContent).toContain(hostileDomain)
  })

  it('destroy() is safe to call and does not throw (base no-op — this renderer owns no timers/observers)', () => {
    const renderer = new WebClipRenderer()
    const dom = renderer.mount({ id: 'wc-h8c9', source: 'example.com', mode: 'fetch', status: 'COMPLETE' })
    expect(() => renderer.destroy(dom)).not.toThrow()
  })
})
