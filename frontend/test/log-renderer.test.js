// @ts-check
// log-renderer.test.js — DoD coverage for LogRenderer (the 'log' kind's
// look-and-feel class, docs/design/specs/2026-07-20-block-renderer-extraction.md
// Phase 4 / issue #47). Per the spec's contract, definition of done for any
// renderer is "renders correctly in a bare page providing only :root theme
// vars" — this suite mounts the REAL LogRenderer against a page carrying
// nothing but a handful of --theme-* vars, mirroring code-renderer.test.js.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { LogRenderer } from '../src/static/block/renderers/log-renderer.js'

function clearInjectedStyles() {
  document.adoptedStyleSheets = []
  document.head.querySelectorAll('style[data-sieve-renderer]').forEach((el) => el.remove())
}

function installBareThemeVars() {
  const el = document.createElement('style')
  el.setAttribute('data-test-root-vars', '')
  el.textContent = `
    :root {
      --theme-bgDark: #16161e;
      --theme-aiBlockBorder: rgba(122, 162, 247, 0.28);
      --theme-gutterLineColor: #3b4261;
      --theme-lineNumberColor: #565f89;
      --theme-monoFont: monospace;
      --theme-text: #c0caf5;
      --theme-textSubtle: #565f89;
      --sieve-focus-accent: #2ac3de;
    }
  `
  document.head.appendChild(el)
  return el
}

describe('LogRenderer (Phase 4 — bare-page DoD)', () => {
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
    vi.restoreAllMocks()
  })

  it('registers its static styles exactly once across multiple instances (register-once contract)', () => {
    new LogRenderer()
    new LogRenderer()
    new LogRenderer()
    const matches = document.adoptedStyleSheets.filter((sheet) =>
      Array.from(sheet.cssRules).some((rule) => rule.cssText.indexOf('.sieve-block--log') === 0))
    expect(matches.length).toBe(1)
  })

  it('mounts the shell + raw body chrome (independent of code/diagram classes), styled purely from --theme-* vars', () => {
    const renderer = new LogRenderer()
    const dom = renderer.mount({ id: 'lg-test', source: 'line one', mode: 'raw' })
    document.body.appendChild(dom)

    expect(dom.className).toBe('sieve-block sieve-block--log')
    // Independence from the retired sieve-block--code borrowing.
    expect(dom.classList.contains('sieve-block--code')).toBe(false)
    expect(dom.querySelector('.sieve-block__body')).toBeTruthy()
    expect(dom.querySelector('.sieve-block__gutter')).toBeTruthy()

    const gutterSpan = dom.querySelector('.sieve-block__gutter span')
    expect(gutterSpan).toBeTruthy()
    expect(getComputedStyle(/** @type {Element} */ (gutterSpan)).color.toLowerCase()).toBe('#565f89')
  })

  it('exposes contentDOM as the <code> element ProseMirror binds as its NodeView contentDOM', () => {
    const renderer = new LogRenderer()
    const dom = renderer.mount({ id: 'lg-test', source: 'x', mode: 'raw' })
    expect(renderer.contentDOM).toBeTruthy()
    expect(renderer.contentDOM?.tagName).toBe('CODE')
    expect(dom.contains(renderer.contentDOM)).toBe(true)
  })

  it('raw mode shows the edit area and hides Explore; explore mode flips visibility', () => {
    const renderer = new LogRenderer()
    const dom = renderer.mount({ id: 'lg-test', source: 'x', mode: 'raw' })
    const explore = /** @type {HTMLElement} */ (dom.querySelector('.log-block__explore-area'))
    expect(explore.style.display).toBe('none')

    renderer.update(dom, { id: 'lg-test', source: 'x', mode: 'explore' })
    expect(explore.style.display).toBe('flex')
  })

  it('syncGutterLineCount keeps the gutter line count current without a full update() call', () => {
    const renderer = new LogRenderer()
    const dom = renderer.mount({ id: 'lg-test', source: 'a', mode: 'raw' })
    const gutter = dom.querySelector('.sieve-block__gutter')
    expect(gutter?.childElementCount).toBe(1)

    renderer.syncGutterLineCount('a\nb\nc')
    expect(gutter?.childElementCount).toBe(3)
  })

  it('loads the parsed-JSON asset via the adapter-resolved URL, publishes columns, and renders rows', async () => {
    const json = { lines: [
      { lineNumber: 1, date: '2026-07-20', level: 'INFO', thread: 't1', logger: 'app', message: 'hello', raw: 'hello', severity: 'info' },
      { lineNumber: 2, date: '2026-07-20', level: 'ERROR', thread: 't1', logger: 'app', message: 'boom', raw: 'boom', severity: 'error' },
    ] }
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve(json) })))

    const renderer = new LogRenderer()
    const cols = []
    renderer.onColumnsAvailable((c) => cols.push(c))
    const dom = renderer.mount({ id: 'lg-test', source: 'x', mode: 'explore', parsedAssetRef: 'parsed.json', resolvedAssetUrl: '/sieve/u/parsed.json', status: 'COMPLETE' })
    document.body.appendChild(dom)

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetch).toHaveBeenCalledWith('/sieve/u/parsed.json')
    expect(cols.length).toBe(1)
    expect(cols[0].map((c) => c.key)).toEqual(['date', 'level', 'thread', 'logger'])
    const rows = dom.querySelectorAll('.log-block__row')
    // 1 header row + 2 data rows
    expect(rows.length).toBe(3)
  })

  it('destroy() disconnects the Explore lazy-scroll IntersectionObserver without throwing', () => {
    const renderer = new LogRenderer()
    const dom = renderer.mount({ id: 'lg-test', source: 'x', mode: 'raw' })
    expect(() => renderer.destroy(dom)).not.toThrow()
  })

  // ── Shared attrs-decision helpers (consumed by the adapter's LogHeader) ──

  it('LogRenderer.mode / isExplore default to raw unless mode or parsedAssetRef says otherwise', () => {
    expect(LogRenderer.mode({})).toBe('raw')
    expect(LogRenderer.mode({ parsedAssetRef: 'x' })).toBe('explore')
    expect(LogRenderer.mode({ mode: 'explore' })).toBe('explore')
    expect(LogRenderer.isExplore({ mode: 'explore' })).toBe(true)
  })

  it('LogRenderer.toggleDisabled flips one column key in the comma-joined disabledCols string', () => {
    expect(LogRenderer.toggleDisabled({ disabledCols: '' }, 'level')).toBe('level')
    expect(LogRenderer.toggleDisabled({ disabledCols: 'level' }, 'level')).toBe('')
    expect(LogRenderer.toggleDisabled({ disabledCols: 'level,thread' }, 'thread')).toBe('level')
  })
})
