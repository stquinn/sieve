// @ts-check
// log-renderer.test.js — DoD coverage for LogRenderer (the 'log' kind's
// look-and-feel class, Block Renderer Contract:
// docs/design/archive/specs/2026-07-21-block-renderer-contract.md). Bare-page protocol:
// render() alone yields the complete block. Scratch construction: (block) only;
// the service-wired test below is the one live-instance case.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { LogRenderer } from '../src/static/renderers/log-renderer.js'
import { SieveBlock, MODE } from '../src/static/contract/sieve-block.js'
import { providerRig } from './helpers/service-rig.js'

/** @param {object} payload */
function blk(payload) { return new SieveBlock('log', payload) }

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

/** render() alone = the complete block. */
function mount(attrs) {
  const renderer = new LogRenderer(blk(attrs))
  const dom = renderer.render()
  return { renderer, dom }
}

describe('LogRenderer (bare-page DoD)', () => {
  /** @type {HTMLStyleElement} */
  let rootVars

  beforeAll(() => { clearInjectedStyles() })
  beforeEach(() => { rootVars = installBareThemeVars() })
  afterEach(() => { rootVars.remove(); document.body.innerHTML = ''; vi.restoreAllMocks() })

  it('registers its static styles exactly once across multiple instances (register-once contract)', () => {
    new LogRenderer(blk({}))
    new LogRenderer(blk({}))
    new LogRenderer(blk({}))
    const matches = document.adoptedStyleSheets.filter((sheet) =>
      Array.from(sheet.cssRules).some((rule) => rule.cssText.indexOf('.sieve-block--log') === 0))
    expect(matches.length).toBe(1)
  })

  it('render() builds the shell + raw body chrome (independent of code/diagram classes)', () => {
    const { dom } = mount({ id: 'lg-test', source: 'line one', mode: 'raw' })
    document.body.appendChild(dom)

    expect(dom.className).toBe('sieve-block sieve-block--log')
    expect(dom.classList.contains('sieve-block--code')).toBe(false)
    expect(dom.querySelector('.sieve-block__body')).toBeTruthy()
    expect(dom.querySelector('.sieve-block__gutter')).toBeTruthy()

    const gutterSpan = dom.querySelector('.sieve-block__gutter span')
    expect(gutterSpan).toBeTruthy()
    expect(getComputedStyle(/** @type {Element} */ (gutterSpan)).color.toLowerCase()).toBe('#565f89')
  })

  it('exposes codeElement as the <code> element the adapter binds as ProseMirror contentDOM', () => {
    const { renderer, dom } = mount({ id: 'lg-test', source: 'x', mode: 'raw' })
    expect(renderer.codeElement).toBeTruthy()
    expect(renderer.codeElement?.tagName).toBe('CODE')
    expect(dom.contains(renderer.codeElement)).toBe(true)
  })

  it('raw mode shows the edit area and hides Explore; explore mode flips visibility', () => {
    const { renderer, dom } = mount({ id: 'lg-test', source: 'x', mode: 'raw' })
    const explore = /** @type {HTMLElement} */ (dom.querySelector('.log-block__explore-area'))
    expect(explore.style.display).toBe('none')

    renderer.update(blk({ id: 'lg-test', source: 'x', mode: 'explore' }))
    expect(explore.style.display).toBe('flex')
  })

  it('syncGutterLineCount is driven internally — the gutter tracks the source line count', () => {
    const { renderer, dom } = mount({ id: 'lg-test', source: 'a', mode: 'raw' })
    const gutter = dom.querySelector('.sieve-block__gutter')
    expect(gutter?.childElementCount).toBe(1)

    renderer.update(blk({ id: 'lg-test', source: 'a\nb\nc', mode: 'raw' }))
    expect(gutter?.childElementCount).toBe(3)
  })

  it('loads the parsed-JSON asset, then re-renders its OWN header with column buttons and renders rows', async () => {
    const json = { lines: [
      { lineNumber: 1, date: '2026-07-20', level: 'INFO', thread: 't1', logger: 'app', message: 'hello', raw: 'hello', severity: 'info' },
      { lineNumber: 2, date: '2026-07-20', level: 'ERROR', thread: 't1', logger: 'app', message: 'boom', raw: 'boom', severity: 'error' },
    ] }
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve(json) })))

    const { dom } = mount({ id: 'lg-test', source: 'x', mode: 'explore', parsedAssetRef: 'parsed.json', resolvedAssetUrl: '/ui/assets/doc-uuid/parsed.json', status: 'COMPLETE' })
    document.body.appendChild(dom)

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetch).toHaveBeenCalledWith('/ui/assets/doc-uuid/parsed.json')
    // The renderer re-rendered its own header — the column buttons now exist.
    const colNames = Array.from(dom.querySelectorAll('.sieve-block__badge--clickable')).map((b) => b.textContent)
    expect(colNames).toEqual(['Date', 'Level', 'Thread', 'Logger'])
    // 1 header row + 2 data rows
    expect(dom.querySelectorAll('.log-block__row').length).toBe(3)
  })

  it('destroy() disconnects the Explore lazy-scroll IntersectionObserver without throwing', () => {
    const { renderer } = mount({ id: 'lg-test', source: 'x', mode: 'raw' })
    expect(() => renderer.destroy()).not.toThrow()
  })

  it('setMode and toggleColumn map to this kind\'s wire patches through a real ContainerTransport', () => {
    const { provider, sock } = providerRig({ blocks: [{ id: 'lg-test', kind: 'log' }] })

    const renderer = new LogRenderer(blk({ id: 'lg-test', source: 'x', mode: 'raw' }), provider)
    renderer.render()

    renderer.setMode(MODE.EDIT)     // already raw — faithful no-op (old header guard)
    expect(sock.sentOfType('block-op')).toEqual([])

    renderer.setMode(MODE.RENDER)   // MODE enum → this kind's wire string, privately
    renderer.toggleColumn('level')  // disabledCols encoding stays renderer-private
    expect(sock.sentOfType('block-op')).toEqual([
      { type: 'block-op', uuid: 'doc-1', opId: expect.stringMatching(/^op-\d+$/), op: { type: 'update-block', blockId: 'lg-test', kind: 'log', attrs: { mode: 'explore' } } },
      { type: 'block-op', uuid: 'doc-1', opId: expect.stringMatching(/^op-\d+$/), op: { type: 'update-block', blockId: 'lg-test', kind: 'log', attrs: { disabledCols: 'level' } } },
    ])
  })

  // ── Shared attrs-decision helpers (consumed by the header) ──

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
