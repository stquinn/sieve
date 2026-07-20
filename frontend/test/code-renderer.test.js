// @ts-check
// code-renderer.test.js — DoD coverage for CodeRenderer (the 'code' kind's
// look-and-feel class, docs/design/specs/2026-07-20-block-renderer-extraction.md
// Phase 4 / issue #47). Per the spec's contract, definition of done for any
// renderer is "renders correctly in a bare page providing only :root theme
// vars" — this suite mounts the REAL CodeRenderer against a page carrying
// nothing but a handful of --theme-* vars, mirroring diagram-renderer.test.js
// and ai-block-renderer.test.js.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { CodeRenderer } from '../src/static/block/renderers/code-renderer.js'

function clearInjectedStyles() {
  document.adoptedStyleSheets = []
  document.head.querySelectorAll('style[data-sieve-renderer]').forEach((el) => el.remove())
}

function installBareThemeVars() {
  const el = document.createElement('style')
  el.setAttribute('data-test-root-vars', '')
  // Deliberately the ONLY styling on the page besides CodeRenderer's own
  // adopted stylesheet — no input.css, no editor.css, no app shell.
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

describe('CodeRenderer (Phase 4 — bare-page DoD)', () => {
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
    new CodeRenderer()
    new CodeRenderer()
    new CodeRenderer()
    const matches = document.adoptedStyleSheets.filter((sheet) =>
      Array.from(sheet.cssRules).some((rule) => rule.cssText.indexOf('.sieve-block--code') === 0))
    expect(matches.length).toBe(1)
  })

  it('mounts the shell + body/gutter/code-area chrome, styled purely from --theme-* vars', () => {
    const renderer = new CodeRenderer()
    const dom = renderer.mount({ id: 'cd-test', source: 'const x = 1', language: 'js' })
    document.body.appendChild(dom)

    expect(dom.className).toBe('sieve-block sieve-block--code')
    expect(dom.querySelector('.sieve-block__body')).toBeTruthy()
    expect(dom.querySelector('.sieve-block__gutter')).toBeTruthy()
    expect(dom.querySelector('.sieve-block__code-area')).toBeTruthy()

    // Bare-page contract: the gutter span's `color: var(--theme-lineNumberColor)`
    // resolves to the exact value this test installed on :root — nothing but
    // CodeRenderer's own adopted stylesheet is present to supply it.
    const gutterSpan = dom.querySelector('.sieve-block__gutter span')
    expect(gutterSpan).toBeTruthy()
    expect(getComputedStyle(/** @type {Element} */ (gutterSpan)).color.toLowerCase()).toBe('#565f89')
  })

  it('exposes contentDOM as the <code> element ProseMirror binds as its NodeView contentDOM', () => {
    const renderer = new CodeRenderer()
    const dom = renderer.mount({ id: 'cd-test', source: 'x', language: 'js' })
    expect(renderer.contentDOM).toBeTruthy()
    expect(renderer.contentDOM?.tagName).toBe('CODE')
    expect(dom.contains(renderer.contentDOM)).toBe(true)
  })

  it('applies a language-* highlight class from attrs.language, falling back to plain hljs for unknown/empty', () => {
    const renderer = new CodeRenderer()
    const dom = renderer.mount({ id: 'cd-test', source: 'x', language: 'python' })
    expect(renderer.contentDOM?.className).toBe('language-python hljs')

    renderer.update(dom, { id: 'cd-test', source: 'x', language: 'unknown' })
    expect(renderer.contentDOM?.className).toBe('hljs')

    renderer.update(dom, { id: 'cd-test', source: 'x', language: '' })
    expect(renderer.contentDOM?.className).toBe('hljs')
  })

  it('syncGutterLineCount keeps the gutter line count current without a full update() call', () => {
    const renderer = new CodeRenderer()
    const dom = renderer.mount({ id: 'cd-test', source: 'a', language: 'js' })
    const gutter = dom.querySelector('.sieve-block__gutter')
    expect(gutter?.childElementCount).toBe(1)

    renderer.syncGutterLineCount('a\nb\nc')
    expect(gutter?.childElementCount).toBe(3)
  })

  it('update() re-syncs both the highlight class and the gutter from the passed (live) source', () => {
    const renderer = new CodeRenderer()
    const dom = renderer.mount({ id: 'cd-test', source: 'a', language: 'js' })

    renderer.update(dom, { id: 'cd-test', source: 'a\nb', language: 'go' })
    expect(renderer.contentDOM?.className).toBe('language-go hljs')
    expect(dom.querySelector('.sieve-block__gutter')?.childElementCount).toBe(2)
  })

  it('destroy() is safe to call and does not throw (base no-op — this renderer owns no timers/observers)', () => {
    const renderer = new CodeRenderer()
    const dom = renderer.mount({ id: 'cd-test', source: 'x', language: 'js' })
    expect(() => renderer.destroy(dom)).not.toThrow()
  })
})
