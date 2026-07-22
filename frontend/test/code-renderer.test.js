// @ts-check
// code-renderer.test.js — DoD coverage for CodeRenderer (the 'code' kind's
// look-and-feel class, Block Renderer Contract:
// docs/design/archive/specs/2026-07-21-block-renderer-contract.md). Definition of done
// for any renderer: "renders correctly in a bare page providing only :root
// theme vars" — the bare-page protocol is render() alone yields the complete
// block. Scratch construction: (block) only; the service-wired test below is
// the one live-instance case.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { CodeRenderer } from '../src/static/block/renderers/code-renderer.js'
import { SieveBlock } from '../src/static/block/sieve-block.js'
import { serviceRig } from './helpers/service-rig.js'

/** @param {object} payload */
function blk(payload) { return new SieveBlock('code', payload) }

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
      --sieve-focus-accent: #9ece6a;
    }
  `
  document.head.appendChild(el)
  return el
}

/** render() alone = the complete block (the bare-page protocol). */
function mount(attrs) {
  const renderer = new CodeRenderer(blk(attrs))
  const dom = renderer.render()
  return { renderer, dom }
}

describe('CodeRenderer (bare-page DoD)', () => {
  /** @type {HTMLStyleElement} */
  let rootVars

  beforeAll(() => { clearInjectedStyles() })
  beforeEach(() => { rootVars = installBareThemeVars() })
  afterEach(() => { rootVars.remove(); document.body.innerHTML = '' })

  it('registers its static styles exactly once across multiple instances (register-once contract)', () => {
    new CodeRenderer(blk({}))
    new CodeRenderer(blk({}))
    new CodeRenderer(blk({}))
    const matches = document.adoptedStyleSheets.filter((sheet) =>
      Array.from(sheet.cssRules).some((rule) => rule.cssText.indexOf('.sieve-block--code') === 0))
    expect(matches.length).toBe(1)
  })

  it('render() builds the shell + body/gutter/code-area chrome, styled purely from --theme-* vars', () => {
    const { dom } = mount({ id: 'cd-test', source: 'const x = 1', language: 'js' })
    document.body.appendChild(dom)

    expect(dom.className).toBe('sieve-block sieve-block--code')
    expect(dom.querySelector('.sieve-block__body')).toBeTruthy()
    expect(dom.querySelector('.sieve-block__gutter')).toBeTruthy()
    expect(dom.querySelector('.sieve-block__code-area')).toBeTruthy()

    const gutterSpan = dom.querySelector('.sieve-block__gutter span')
    expect(gutterSpan).toBeTruthy()
    expect(getComputedStyle(/** @type {Element} */ (gutterSpan)).color.toLowerCase()).toBe('#565f89')
  })

  it('exposes codeElement as the <code> element the adapter binds as ProseMirror contentDOM', () => {
    const { renderer, dom } = mount({ id: 'cd-test', source: 'x', language: 'js' })
    expect(renderer.codeElement).toBeTruthy()
    expect(renderer.codeElement?.tagName).toBe('CODE')
    expect(dom.contains(renderer.codeElement)).toBe(true)
  })

  it('applies a language-* highlight class from the payload language, falling back to plain hljs for unknown/empty', () => {
    const { renderer } = mount({ id: 'cd-test', source: 'x', language: 'python' })
    expect(renderer.codeElement?.className).toBe('language-python hljs')

    renderer.update(blk({ id: 'cd-test', source: 'x', language: 'unknown' }))
    expect(renderer.codeElement?.className).toBe('hljs')

    renderer.update(blk({ id: 'cd-test', source: 'x', language: '' }))
    expect(renderer.codeElement?.className).toBe('hljs')
  })

  it('syncGutterLineCount keeps the gutter line count current without a full update() call', () => {
    const { renderer, dom } = mount({ id: 'cd-test', source: 'a', language: 'js' })
    const gutter = dom.querySelector('.sieve-block__gutter')
    expect(gutter?.childElementCount).toBe(1)

    renderer.syncGutterLineCount('a\nb\nc')
    expect(gutter?.childElementCount).toBe(3)
  })

  it('update() re-syncs both the highlight class and the gutter from the passed (live) source', () => {
    const { renderer, dom } = mount({ id: 'cd-test', source: 'a', language: 'js' })

    renderer.update(blk({ id: 'cd-test', source: 'a\nb', language: 'go' }))
    expect(renderer.codeElement?.className).toBe('language-go hljs')
    expect(dom.querySelector('.sieve-block__gutter')?.childElementCount).toBe(2)
  })

  it('destroy() is safe to call and does not throw (base no-op — no timers/observers)', () => {
    const { renderer } = mount({ id: 'cd-test', source: 'x', language: 'js' })
    expect(() => renderer.destroy()).not.toThrow()
  })

  it('setContent (the outbound truth channel) frames this kind\'s source patch on the document channel through a real BlockService', () => {
    // Issue #49 Phase 1: appliers are retired — the verb leaves as the FROZEN
    // block-op frame; the content→source mapping is CodeRenderer's own.
    const { service, sock } = serviceRig({ blocks: [{ id: 'cd-test', kind: 'code' }] })

    const renderer = new CodeRenderer(blk({ id: 'cd-test', source: 'x', language: 'js' }), service)
    renderer.render()
    renderer.setContent('const y = 2')

    expect(sock.sentOfType('block-op')).toEqual([{
      type: 'block-op', uuid: 'doc-1',
      op: { type: 'update-block', blockId: 'cd-test', kind: 'code', attrs: { source: 'const y = 2' } },
    }])
  })
})
