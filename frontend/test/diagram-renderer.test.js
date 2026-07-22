// @ts-check
// diagram-renderer.test.js — DoD coverage for DiagramRenderer (the diagram
// kind's look-and-feel class, docs/design/archive/specs/2026-07-20-block-renderer-extraction.md
// Phase 2 / issue #45, the epic's pilot). Bare-page protocol: render() alone
//
// A `window.mermaid` STUB is installed before any render-mode build —
// DiagramRenderer.ensureMermaid() only injects a real <script> when
// window.mermaid is absent, and happy-dom's <script src> handling performs a
// SYNCHRONOUS fetch that throws when the connection is refused (no dev server
// here). The stub keeps every assertion about DiagramRenderer's own DOM/CSS.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { DiagramRenderer } from '../src/static/block/renderers/diagram-renderer.js'
import { SieveBlock } from '../src/static/block/sieve-block.js'

/** @param {object} payload */
function blk(payload) { return new SieveBlock('diagram', payload) }

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
      --theme-bgAlt: #1e2030;
      --theme-bgLight: #24273a;
      --theme-border: #2a2b3d;
      --theme-border2: #3b4261;
      --theme-text: #c0caf5;
      --theme-textDim: #a9b1d6;
      --theme-fg2: #9aa5ce;
      --theme-fg3: #565f89;
      --theme-accent: #7aa2f7;
      --theme-accentPrimary: #7aa2f7;
      --theme-accentGreen: #9ece6a;
      --theme-accentRed: #f7768e;
      --theme-monoFont: monospace;
    }
  `
  document.head.appendChild(el)
  return el
}

/** @param {{svg?: string}} [opts] */
function installMermaidStub(opts) {
  const svg = (opts && opts.svg) || '<svg xmlns="http://www.w3.org/2000/svg"><g class="edgeLabel"><text>Yes</text></g></svg>';
  const win = /** @type {any} */ (window)
  win.mermaid = {
    initialize() {},
    render() { return Promise.resolve({ svg }) },
  }
}

/** render() alone = the complete block. Scratch construction: (block) only. */
function mount(attrs) {
  const renderer = new DiagramRenderer(blk(attrs))
  const dom = renderer.render()
  return { renderer, dom }
}

describe('DiagramRenderer (Phase 2 pilot — bare-page DoD)', () => {
  /** @type {HTMLStyleElement} */
  let rootVars

  beforeAll(() => { clearInjectedStyles() })
  beforeEach(() => { rootVars = installBareThemeVars() })
  afterEach(() => {
    rootVars.remove()
    document.body.innerHTML = ''
    const win = /** @type {any} */ (window)
    delete win.mermaid
  })

  it('registers its static styles exactly once across multiple instances (register-once contract)', () => {
    new DiagramRenderer(blk({}))
    new DiagramRenderer(blk({}))
    new DiagramRenderer(blk({}))
    const matches = document.adoptedStyleSheets.filter((sheet) =>
      Array.from(sheet.cssRules).some((rule) => rule.cssText.indexOf('.sieve-block--diagram') === 0))
    expect(matches.length).toBe(1)
  })

  it('render() builds edit-mode DOM styled purely from --theme-* vars — no app stylesheet required', () => {
    const { dom } = mount({ id: 'di-test', source: 'flowchart TD\n  A --> B', diagramType: 'mermaid', mode: 'edit' })
    document.body.appendChild(dom)

    expect(dom.className).toBe('sieve-block sieve-block--diagram')
    expect(dom.querySelector('.sieve-block__body')).toBeTruthy()
    expect(dom.querySelector('.sieve-block__gutter')).toBeTruthy()
    expect(dom.querySelector('.diagram-block__render')).toBeFalsy()  // not attached in edit mode

    const gutterSpan = dom.querySelector('.sieve-block__gutter span')
    expect(gutterSpan).toBeTruthy()
    expect(getComputedStyle(/** @type {Element} */ (gutterSpan)).color.toLowerCase()).toBe('#565f89')
  })

  it('exposes codeElement as the <code> element the adapter binds as ProseMirror contentDOM', () => {
    const { renderer, dom } = mount({ id: 'di-test', source: 'graph TD', diagramType: 'mermaid', mode: 'edit' })
    expect(renderer.codeElement).toBeTruthy()
    expect(renderer.codeElement?.tagName).toBe('CODE')
    expect(dom.contains(renderer.codeElement)).toBe(true)
  })

  it('render mode attaches the render body, shows the SVG, and patches the edgeLabel escape hatch into the SVG\'s own <style>', async () => {
    installMermaidStub()
    const { dom } = mount({ id: 'di-test', source: 'flowchart TD\n  A --> B', diagramType: 'mermaid', mode: 'render' })
    document.body.appendChild(dom)

    expect(dom.querySelector('.diagram-block__render')).toBeTruthy()
    expect(dom.querySelector('.sieve-block__body')).toBeFalsy()  // edit body not attached in render mode
    expect(dom.querySelector('.diagram-block__loading')).toBeTruthy()

    await new Promise((resolve) => setTimeout(resolve, 0))

    const svg = dom.querySelector('.diagram-block__render svg')
    expect(svg).toBeTruthy()
    const style = svg?.querySelector('style')
    expect(style).toBeTruthy()
    expect(style?.textContent).toContain('.edgeLabel')
    expect(style?.textContent).toContain('var(--theme-text)')
  })

  it('update() records a mode transition only when attrs.mode actually changes (read via takeModeTransition)', () => {
    installMermaidStub()
    const { renderer } = mount({ id: 'di-test', source: 'graph TD', diagramType: 'mermaid', mode: 'edit' })

    renderer.update(blk({ id: 'di-test', source: 'graph TD; A-->B', diagramType: 'mermaid', mode: 'edit' }))
    expect(renderer.takeModeTransition()).toBeNull()

    renderer.update(blk({ id: 'di-test', source: 'graph TD; A-->B', diagramType: 'mermaid', mode: 'render' }))
    expect(renderer.takeModeTransition()).toEqual({ modeChangedTo: 'render' })
  })

  it('syncGutterLineCount keeps the gutter line count current without a full update() call', () => {
    const { renderer, dom } = mount({ id: 'di-test', source: 'a', diagramType: 'mermaid', mode: 'edit' })
    const gutter = dom.querySelector('.sieve-block__gutter')
    expect(gutter?.childElementCount).toBe(1)

    renderer.syncGutterLineCount('a\nb\nc')
    expect(gutter?.childElementCount).toBe(3)
  })

  it('destroy() is safe to call and does not throw', () => {
    installMermaidStub()
    const { renderer } = mount({ id: 'di-test', source: 'graph TD', diagramType: 'mermaid', mode: 'render' })
    expect(() => renderer.destroy()).not.toThrow()
  })
})
