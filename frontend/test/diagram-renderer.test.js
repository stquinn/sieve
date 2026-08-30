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
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { DiagramRenderer } from '../src/static/renderers/diagram-renderer.js'
import { SieveBlock } from '../src/static/contract/sieve-block.js'

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
      --theme-gutterLineColor: #3b4261;
      --theme-lineNumberColor: #565f89;
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
    expect(/** @type {HTMLElement} */ (dom.querySelector('.sieve-block__body')).hidden).toBe(false)
    expect(/** @type {HTMLElement} */ (dom.querySelector('.diagram-block__render')).hidden).toBe(true)

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
    expect(/** @type {HTMLElement} */ (dom.querySelector('.sieve-block__body')).hidden).toBe(true)
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

  // ProseMirror is handed the edit surface's <code> as contentDOM. A contentDOM
  // that leaves the document reads to PM as content the user deleted, and it
  // dispatches a replace to match — so the mode flip switches visibility only.
  it('both mode surfaces stay attached across a flip; only visibility and the code element move with it', () => {
    installMermaidStub()
    const { renderer, dom } = mount({ id: 'di-test', source: 'graph TD', diagramType: 'mermaid', mode: 'edit' })
    document.body.appendChild(dom)
    const codeEl = renderer.codeElement
    const editBody = /** @type {HTMLElement} */ (dom.querySelector('.sieve-block__body'))
    const renderBody = /** @type {HTMLElement} */ (dom.querySelector('.diagram-block__render'))

    /** @param {'edit'|'render'} mode */
    const flipTo = (mode) => renderer.update(blk({ id: 'di-test', source: 'graph TD', diagramType: 'mermaid', mode }))

    flipTo('render')
    expect(dom.contains(editBody)).toBe(true)
    expect(dom.contains(renderBody)).toBe(true)
    expect(dom.contains(codeEl)).toBe(true)
    expect(editBody.hidden).toBe(true)
    expect(renderBody.hidden).toBe(false)

    flipTo('edit')
    expect(dom.contains(codeEl)).toBe(true)
    expect(renderer.codeElement).toBe(codeEl)
    expect(editBody.hidden).toBe(false)
    expect(renderBody.hidden).toBe(true)
  })

  it('a read-only diagram authored in edit mode still draws as a record, both surfaces attached', () => {
    installMermaidStub()
    const renderer = new DiagramRenderer(blk({ id: 'di-ro', source: 'graph TD', diagramType: 'mermaid', mode: 'edit' }), null, undefined, { readOnly: true })
    const dom = renderer.render()
    const editBody = /** @type {HTMLElement} */ (dom.querySelector('.sieve-block__body'))
    expect(dom.contains(renderer.codeElement)).toBe(true)
    expect(editBody.hidden).toBe(true)
    expect(/** @type {HTMLElement} */ (dom.querySelector('.diagram-block__render')).hidden).toBe(false)

    // An update must not walk a record back into an editable surface.
    renderer.update(blk({ id: 'di-ro', source: 'graph TD; A-->B', diagramType: 'mermaid', mode: 'edit' }))
    expect(editBody.hidden).toBe(true)
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

  it('header exposes an engine <select> reflecting diagramType, with both engines', () => {
    const { dom } = mount({ id: 'di-test', source: 'graph TD', diagramType: 'plantuml', mode: 'edit' })
    const select = /** @type {HTMLSelectElement} */ (dom.querySelector('select.diagram-block__engine'))
    expect(select).toBeTruthy()
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['mermaid', 'plantuml'])
    expect(select.value).toBe('plantuml')
  })

  it('picking an engine pushes diagramType through the provider (no source translation)', () => {
    /** @type {{id: string, patch: object}[]} */
    const pushes = []
    const provider = { requestSetBlock: (id, patch) => { pushes.push({ id, patch }) }, getBlock: () => null }
    const renderer = new DiagramRenderer(blk({ id: 'di-x', source: 'A->B', diagramType: 'mermaid', mode: 'edit' }), provider)
    const dom = renderer.render()
    const select = /** @type {HTMLSelectElement} */ (dom.querySelector('select.diagram-block__engine'))
    select.value = 'plantuml'
    select.dispatchEvent(new Event('change'))
    expect(pushes).toEqual([{ id: 'di-x', patch: { diagramType: 'plantuml' } }])
    // Re-picking the current engine is a no-op (no redundant push).
    const renderer2 = new DiagramRenderer(blk({ id: 'di-y', source: 'A->B', diagramType: 'mermaid', mode: 'edit' }), provider)
    renderer2.setDiagramType('mermaid')
    expect(pushes.length).toBe(1)
  })
})

// A rendered diagram is a pure function of (engine, theme, source), and drawing
// it is expensive enough that ProseMirror recreating the NodeView — which it does
// on any decoration change, hover included — showed as a visible twitch: the SVG
// cleared to a spinner and faded back in. These pin that a repaint happens only
// when one of those inputs actually moved.
describe('DiagramRenderer — the rendered SVG is memoized', () => {
  /** @type {HTMLStyleElement} */
  let rootVars
  beforeEach(() => { rootVars = installBareThemeVars() })
  afterEach(() => {
    rootVars.remove()
    document.body.innerHTML = ''
    const win = /** @type {any} */ (window)
    delete win.mermaid
  })

  /** A mermaid whose every render is distinguishable, and which records what it
   *  was asked for. @returns {{sources: string[]}} */
  function installCountingMermaid() {
    /** @type {string[]} */
    const sources = []
    let n = 0
    const win = /** @type {any} */ (window)
    win.mermaid = {
      initialize() {},
      /** @param {string} _id @param {string} src */
      render(_id, src) {
        sources.push(src)
        return Promise.resolve({ svg: '<svg xmlns="http://www.w3.org/2000/svg" id="paint-' + (++n) + '"></svg>' })
      },
    }
    return { sources }
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  /** @param {HTMLElement} dom */
  const svgIn = (dom) => dom.querySelector('.diagram-block__render svg')
  /** @param {HTMLElement} dom */
  const loadingIn = (dom) => dom.querySelector('.diagram-block__loading')

  it('an update carrying identical attrs leaves the painted SVG untouched', async () => {
    installCountingMermaid()
    const attrs = { id: 'di-mem-1', source: 'graph TD; memo --> same', diagramType: 'mermaid', mode: 'render' }
    const { renderer, dom } = mount(attrs)
    document.body.appendChild(dom)
    await settle()
    const painted = svgIn(dom)
    expect(painted).toBeTruthy()

    renderer.update(blk(Object.assign({}, attrs)))
    // Not "an equal SVG" — the SAME element. Anything else is a repaint the
    // user sees.
    expect(svgIn(dom)).toBe(painted)
    expect(loadingIn(dom)).toBeFalsy()
  })

  it('a second renderer over the same attrs paints from the cache, with no loading gap', async () => {
    const mermaid = installCountingMermaid()
    const attrs = { id: 'di-mem-2', source: 'graph TD; cache --> hit', diagramType: 'mermaid', mode: 'render' }
    const first = mount(attrs)
    document.body.appendChild(first.dom)
    await settle()
    const painted = svgIn(first.dom)
    expect(painted).toBeTruthy()

    // What a NodeView recreation is: a fresh renderer over unchanged attrs.
    // It must paint SYNCHRONOUSLY — a spinner between the two is the twitch.
    const second = mount(Object.assign({}, attrs))
    expect(loadingIn(second.dom)).toBeFalsy()
    expect(svgIn(second.dom)).toBeTruthy()
    expect(svgIn(second.dom)?.getAttribute('id')).toBe(painted?.getAttribute('id'))
    expect(mermaid.sources.length).toBe(1)
  })

  it('a changed source repaints', async () => {
    installCountingMermaid()
    const attrs = { id: 'di-mem-3', source: 'graph TD; before --> x', diagramType: 'mermaid', mode: 'render' }
    const { renderer, dom } = mount(attrs)
    document.body.appendChild(dom)
    await settle()
    const first = svgIn(dom)?.getAttribute('id')

    renderer.update(blk(Object.assign({}, attrs, { source: 'graph TD; after --> y' })))
    await settle()
    expect(svgIn(dom)?.getAttribute('id')).not.toBe(first)
  })

  it('a theme change repaints, though engine and source are unchanged', async () => {
    const mermaid = installCountingMermaid()
    const source = 'graph TD; theme --> swap'
    const { dom } = mount({ id: 'di-mem-4', source, diagramType: 'mermaid', mode: 'render' })
    document.body.appendChild(dom)
    await settle()
    const first = svgIn(dom)?.getAttribute('id')
    expect(mermaid.sources.filter((s) => s === source).length).toBe(1)

    document.dispatchEvent(new Event('settings:changed'))
    await settle()
    expect(mermaid.sources.filter((s) => s === source).length).toBe(2)
    expect(svgIn(dom)?.getAttribute('id')).not.toBe(first)
  })

  it('flipping to edit and back repaints nothing — the render surface was only hidden', async () => {
    const mermaid = installCountingMermaid()
    const attrs = { id: 'di-mem-5', source: 'graph TD; flip --> back', diagramType: 'mermaid', mode: 'render' }
    const { renderer, dom } = mount(attrs)
    document.body.appendChild(dom)
    await settle()
    const painted = svgIn(dom)

    renderer.update(blk(Object.assign({}, attrs, { mode: 'edit' })))
    renderer.update(blk(Object.assign({}, attrs, { mode: 'render' })))
    expect(svgIn(dom)).toBe(painted)
    expect(mermaid.sources.length).toBe(1)
  })
})

describe('DiagramRenderer.renderDiagramSvgEntry — engine-branched acquisition', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    const win = /** @type {any} */ (window)
    delete win.mermaid
  })

  /** @param {string} text */
  function stubFetch(text) {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(text) }))
  }

  it('plantuml with svgAsset fetches the same-origin asset and returns an image/svg+xml entry', async () => {
    stubFetch('<svg id="puml"></svg>')
    const node = { attrs: { kind: 'diagram', diagramType: 'plantuml', svgAsset: '/ui/assets/doc-uuid/di-x.svg', source: '@startuml' } }
    const entry = await DiagramRenderer.renderDiagramSvgEntry(node, [])
    expect(entry).toEqual({ mimeType: 'image/svg+xml', content: '<svg id="puml"></svg>' })
  })

  it('plantuml with no svgAsset yields no entry (never rendered → nothing to extract)', async () => {
    const node = { attrs: { kind: 'diagram', diagramType: 'plantuml', svgAsset: '', source: '@startuml' } }
    expect(await DiagramRenderer.renderDiagramSvgEntry(node, [])).toBeNull()
  })

  it('mermaid renders locally via mermaid.render (unchanged path)', async () => {
    installMermaidStub({ svg: '<svg id="mmd"></svg>' })
    const node = { attrs: { kind: 'diagram', diagramType: 'mermaid', source: 'graph TD; A-->B' } }
    const entry = await DiagramRenderer.renderDiagramSvgEntry(node, [])
    expect(entry).toEqual({ mimeType: 'image/svg+xml', content: '<svg id="mmd"></svg>' })
  })
})

describe('DiagramRenderer — plantuml passive display branch', () => {
  /** @type {HTMLStyleElement} */
  let rootVars
  beforeEach(() => { rootVars = installBareThemeVars() })
  afterEach(() => {
    rootVars.remove()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })
  /** @param {string} text */
  function stubFetch(text) {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(text) }))
  }
  const NOW = () => new Date().toISOString()

  it('PENDING shows the job-status spinner (no fetch, no error card)', () => {
    const { dom } = mount({ id: 'di-p', source: '@startuml\nA->B\n@enduml', diagramType: 'plantuml', mode: 'render', status: 'PENDING', createdAt: NOW() })
    document.body.appendChild(dom)
    expect(dom.querySelector('.diagram-block__spinner')).toBeTruthy()
    expect(dom.querySelector('.diagram-block__error')).toBeFalsy()
  })

  it('COMPLETE fetches the svgAsset and inlines it into the panzoom wrap', async () => {
    stubFetch('<svg id="puml-live"></svg>')
    const { dom } = mount({ id: 'di-c', source: '@startuml\nA->B\n@enduml', diagramType: 'plantuml', mode: 'render', status: 'COMPLETE', svgAsset: '/ui/assets/doc-uuid/di-c.svg', createdAt: NOW() })
    document.body.appendChild(dom)
    await new Promise((r) => setTimeout(r, 0))
    const svg = dom.querySelector('.diagram-block__panzoom svg')
    expect(svg).toBeTruthy()
    expect(svg?.getAttribute('id')).toBe('puml-live')
  })

  /** A fetch that records every URL it was asked for. @param {string} text */
  function countingFetch(text) {
    /** @type {string[]} */
    const calls = []
    vi.stubGlobal('fetch', (/** @type {any} */ url) => {
      calls.push(String(url))
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(text) })
    })
    return { calls }
  }

  const settle = () => new Promise((r) => setTimeout(r, 0))

  /** A COMPLETE plantuml block. The memo is keyed by source + asset URL + theme
   *  and NOT by block id — two blocks rendering the same source from the same
   *  URL are the same bytes — so each test needs its own `tag` to get a cache
   *  entry of its own. @param {string} tag */
  const puml = (tag) => ({
    id: 'di-' + tag, createdAt: NOW(),
    source: '@startuml\n' + tag + '->cache\n@enduml', diagramType: 'plantuml', mode: 'render',
    status: 'COMPLETE', svgAsset: '/ui/assets/doc-uuid/' + tag + '.svg',
  })

  // Recreation costs a NETWORK round trip here, so the memo matters more than it
  // does for mermaid.
  it('a recreated renderer paints the cached asset without fetching again', async () => {
    const f = countingFetch('<svg id="puml-memo"></svg>')
    const attrs = puml('memo')
    const first = mount(attrs)
    document.body.appendChild(first.dom)
    await settle()
    expect(first.dom.querySelector('.diagram-block__panzoom svg')).toBeTruthy()
    expect(f.calls.length).toBe(1)

    const second = mount(Object.assign({}, attrs))
    expect(second.dom.querySelector('.diagram-block__loading')).toBeFalsy()
    expect(second.dom.querySelector('.diagram-block__panzoom svg')).toBeTruthy()
    expect(f.calls.length).toBe(1)
  })

  it('a different svgAsset fetches again', async () => {
    const f = countingFetch('<svg id="puml-a"></svg>')
    const attrs = puml('memo-2')
    const first = mount(attrs)
    document.body.appendChild(first.dom)
    await settle()
    expect(f.calls.length).toBe(1)

    mount(Object.assign({}, attrs, { svgAsset: '/ui/assets/doc-uuid/memo-2b.svg' }))
    await settle()
    expect(f.calls.length).toBe(2)
  })

  // The asset is overwritten IN PLACE at a stable URL, and a theme switch is one
  // of the things that rewrites it — so the theme has to be part of what the
  // bytes are remembered under, or a recreation would serve the old theme's SVG.
  it('after a theme change a recreated renderer refetches rather than serving pre-theme bytes', async () => {
    const f = countingFetch('<svg id="puml-theme"></svg>')
    const attrs = puml('memo-3')
    const first = mount(attrs)
    document.body.appendChild(first.dom)
    await settle()
    expect(f.calls.length).toBe(1)

    document.dispatchEvent(new Event('settings:changed'))
    mount(Object.assign({}, attrs))
    await settle()
    expect(f.calls.length).toBe(2)
  })

  it('ERROR shows the error card carrying the backend error attr', () => {
    const { dom } = mount({ id: 'di-e', source: '@startuml\nbad\n@enduml', diagramType: 'plantuml', mode: 'render', status: 'ERROR', error: 'server returned 502', createdAt: NOW() })
    document.body.appendChild(dom)
    const msg = dom.querySelector('.diagram-block__error-msg')
    expect(msg).toBeTruthy()
    expect(msg?.textContent).toContain('server returned 502')
  })
})
