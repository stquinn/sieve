// @ts-check
// diagram-renderer.test.js — DoD coverage for DiagramRenderer (the diagram
// kind's look-and-feel class, docs/design/specs/2026-07-20-block-renderer-extraction.md
// Phase 2 / issue #45, the epic's pilot). Per the spec's contract, definition
// of done for any renderer is "renders correctly in a bare page providing
// only :root theme vars" — this suite mounts the REAL DiagramRenderer (not a
// throwaway demo class, unlike renderer-style-carriage.test.js's Phase 1
// coverage) against a page carrying nothing but a handful of --theme-* vars,
// mirroring frontend/test/harness/bare-page-renderer.html's manual check.
//
// A `window.mermaid` STUB is installed before any render-mode mount/update —
// this is load-bearing, not incidental: DiagramRenderer.ensureMermaid() only
// injects a real <script src="/static/vendor/mermaid.min.js"> when
// `window.mermaid` is absent, and happy-dom's <script src> handling performs a
// genuinely SYNCHRONOUS network fetch (execFileSync under the hood) that
// throws (uncaught, crashing the whole worker) the moment the connection is
// refused — there is no dev server listening in this test environment. The
// stub keeps every assertion here about DiagramRenderer's own DOM/CSS
// contract, never about mermaid's actual rendering (which the real Wails app
// validates live).
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { DiagramRenderer } from '../src/static/block/renderers/diagram-renderer.js'

function clearInjectedStyles() {
  document.adoptedStyleSheets = []
  document.head.querySelectorAll('style[data-sieve-renderer]').forEach((el) => el.remove())
}

function installBareThemeVars() {
  const el = document.createElement('style')
  el.setAttribute('data-test-root-vars', '')
  // Deliberately the ONLY styling on the page besides DiagramRenderer's own
  // adopted stylesheet — no input.css, no editor.css, no app shell.
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

describe('DiagramRenderer (Phase 2 pilot — bare-page DoD)', () => {
  /** @type {HTMLStyleElement} */
  let rootVars

  // Style-carriage clearing happens ONCE, up front — not per-test. The whole
  // point under test is "registered exactly once, EVER"; a per-test
  // document.adoptedStyleSheets reset would fight that contract (the registry
  // singleton remembers DiagramRenderer is already registered and correctly
  // refuses to re-inject, so wiping the sheet away between tests would leave
  // later tests with no live stylesheet at all — not a real bug, a test-setup
  // mismatch with the very invariant being verified).
  beforeAll(() => {
    clearInjectedStyles()
  })

  beforeEach(() => {
    rootVars = installBareThemeVars()
  })

  afterEach(() => {
    rootVars.remove()
    document.body.innerHTML = ''
    const win = /** @type {any} */ (window)
    delete win.mermaid
  })

  it('registers its static styles exactly once across multiple instances (register-once contract)', () => {
    new DiagramRenderer()
    new DiagramRenderer()
    new DiagramRenderer()
    const matches = document.adoptedStyleSheets.filter((sheet) =>
      Array.from(sheet.cssRules).some((rule) => rule.cssText.indexOf('.sieve-block--diagram') === 0))
    expect(matches.length).toBe(1)
  })

  it('mounts edit-mode DOM styled purely from --theme-* vars — no app stylesheet required', () => {
    const renderer = new DiagramRenderer()
    const dom = renderer.mount({ id: 'di-test', source: 'flowchart TD\n  A --> B', diagramType: 'mermaid', mode: 'edit' })
    document.body.appendChild(dom)

    expect(dom.className).toBe('sieve-block sieve-block--diagram')
    expect(dom.querySelector('.sieve-block__body')).toBeTruthy()
    expect(dom.querySelector('.sieve-block__gutter')).toBeTruthy()
    expect(dom.querySelector('.diagram-block__render')).toBeFalsy()  // not attached in edit mode

    // Bare-page contract: a longhand colour rule (.sieve-block__gutter span's
    // `color: var(--theme-fg3)`) resolves to the exact --theme-fg3 value this
    // test installed on :root — nothing but DiagramRenderer's own adopted
    // stylesheet is present to supply it.
    const gutterSpan = dom.querySelector('.sieve-block__gutter span')
    expect(gutterSpan).toBeTruthy()
    expect(getComputedStyle(/** @type {Element} */ (gutterSpan)).color.toLowerCase()).toBe('#565f89')
  })

  it('exposes contentDOM as the <code> element ProseMirror binds as its NodeView contentDOM', () => {
    const renderer = new DiagramRenderer()
    const dom = renderer.mount({ id: 'di-test', source: 'graph TD', diagramType: 'mermaid', mode: 'edit' })
    expect(renderer.contentDOM).toBeTruthy()
    expect(renderer.contentDOM?.tagName).toBe('CODE')
    expect(dom.contains(renderer.contentDOM)).toBe(true)
  })

  it('mounting in render mode attaches the render body, shows the SVG, and patches the edgeLabel escape hatch into the SVG\'s own <style>', async () => {
    installMermaidStub()
    const renderer = new DiagramRenderer()
    const dom = renderer.mount({ id: 'di-test', source: 'flowchart TD\n  A --> B', diagramType: 'mermaid', mode: 'render' })
    document.body.appendChild(dom)

    expect(dom.querySelector('.diagram-block__render')).toBeTruthy()
    expect(dom.querySelector('.sieve-block__body')).toBeFalsy()  // edit body not attached in render mode
    // The loading state is set SYNCHRONOUSLY, before the stubbed render() promise settles.
    expect(dom.querySelector('.diagram-block__loading')).toBeTruthy()

    // Flush the mermaid.render() promise chain (ensureMermaid → render → DOM
    // patch) — a macrotask tick guarantees every pending microtask has run.
    await new Promise((resolve) => setTimeout(resolve, 0))

    const svg = dom.querySelector('.diagram-block__render svg')
    expect(svg).toBeTruthy()
    // The escape hatch rides IN the SVG's own <style> — portable by construction,
    // not a rule in any app stylesheet (docs/design/specs/2026-07-20-block-renderer-extraction.md).
    const style = svg?.querySelector('style')
    expect(style).toBeTruthy()
    expect(style?.textContent).toContain('.edgeLabel')
    expect(style?.textContent).toContain('var(--theme-text)')
  })

  it('update() reports a mode transition only when attrs.mode actually changes', () => {
    installMermaidStub()
    const renderer = new DiagramRenderer()
    const dom = renderer.mount({ id: 'di-test', source: 'graph TD', diagramType: 'mermaid', mode: 'edit' })

    const noChange = renderer.update(dom, { id: 'di-test', source: 'graph TD; A-->B', diagramType: 'mermaid', mode: 'edit' })
    expect(noChange).toBeNull()

    const changed = renderer.update(dom, { id: 'di-test', source: 'graph TD; A-->B', diagramType: 'mermaid', mode: 'render' })
    expect(changed).toEqual({ modeChangedTo: 'render' })
  })

  it('syncGutterLineCount keeps the gutter line count current without a full update() call', () => {
    const renderer = new DiagramRenderer()
    const dom = renderer.mount({ id: 'di-test', source: 'a', diagramType: 'mermaid', mode: 'edit' })
    const gutter = dom.querySelector('.sieve-block__gutter')
    expect(gutter?.childElementCount).toBe(1)

    renderer.syncGutterLineCount('a\nb\nc')
    expect(gutter?.childElementCount).toBe(3)
  })

  it('destroy() is safe to call and does not throw', () => {
    installMermaidStub()
    const renderer = new DiagramRenderer()
    const dom = renderer.mount({ id: 'di-test', source: 'graph TD', diagramType: 'mermaid', mode: 'render' })
    expect(() => renderer.destroy(dom)).not.toThrow()
  })
})
