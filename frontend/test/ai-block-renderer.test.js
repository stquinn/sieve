// @ts-check
// ai-block-renderer.test.js — DoD coverage for AiBlockRenderer (the ai-block
// kind's look-and-feel class, docs/design/archive/specs/2026-07-20-block-renderer-extraction.md
// Phase 3 / issue #46). Per the spec's contract, definition of done for any
// renderer is "renders correctly in a bare page providing only :root theme
// vars" — this suite mounts the REAL AiBlockRenderer (not a throwaway demo
// class) against a page carrying nothing but a handful of --theme-* vars,
// mirroring diagram-renderer.test.js's pattern for the Phase 2 pilot.
//
// IMPORTANT SCOPE NOTE (verified against the real source before writing this
// suite, not assumed from the pilot): AiBlockRenderer's own DOM surface is the
// block SHELL + the status BADGE + an EMPTY contentDOM container — it never
// builds the question/response markdown itself. That rendering (title +
// body, including any fenced code inside the response) is a FRAMEWORK-owned
// seam (sieve-block-extension.js's titleProvider/contentProvider slots,
// which parse markdown into live ProseMirror nodes via the editor's schema
// and a tracked transaction) — inherently PM-coupled, so it cannot run
// against a bare renderer mount with no ProseMirror instance, and stays
// adapter/framework-side per the PM-specificity sorting test. Mounting here
// with a representative attrs object (question, a markdown response
// containing a fenced code block, a ref chain) still exercises every DOM
// output this class is actually responsible for: the shell classes, the
// badge state machine (attrs.status + isJobStale → CSS class/text), and the
// data-id/data-ai-ref attributes the adapter-side chain-glow reads.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { AiBlockRenderer } from '../src/static/block/renderers/ai-block-renderer.js'

/** @typedef {import('../src/static/block/renderers/ai-block-renderer.js').AiBlockAttrs} AiBlockAttrs */

function clearInjectedStyles() {
  document.adoptedStyleSheets = []
  document.head.querySelectorAll('style[data-sieve-renderer]').forEach((el) => el.remove())
}

function installBareThemeVars() {
  const el = document.createElement('style')
  el.setAttribute('data-test-root-vars', '')
  // Deliberately the ONLY styling on the page besides AiBlockRenderer's own
  // adopted stylesheet — no input.css, no editor.css, no app shell.
  el.textContent = `
    :root {
      --theme-bg:            #1a1b26;
      --theme-bgDark:        #16161e;
      --theme-border2:       #3b4261;
      --theme-accentPrimary: #7aa2f7;
      --theme-accentPurple:  #bb9af7;
      --theme-accentCyan:    #7dcfff;
      --theme-aiBlockBg:     rgba(122, 162, 247, 0.04);
      --theme-aiBlockBorder: rgba(122, 162, 247, 0.28);
      --theme-monoFont:      monospace;
    }
  `
  document.head.appendChild(el)
  return el
}

// A representative attrs object — question, a markdown response with a
// fenced code block, and a ref chain — even though only id/ref/type/status/
// createdAt drive this renderer's own DOM (see file header note).
/** @type {AiBlockAttrs} */
const REPRESENTATIVE_ATTRS = {
  id: 'ai-a1b2',
  ref: 'wc-c3d4,ai-e5f6',
  type: 'ASK',
  status: 'COMPLETE',
  question: 'What does this function do?',
  response: 'It parses the fence.\n\n```js\nfunction f() { return 1 }\n```',
  createdAt: new Date().toISOString(),
}

describe('AiBlockRenderer (Phase 3 — bare-page DoD)', () => {
  /** @type {HTMLStyleElement} */
  let rootVars

  // Style-carriage clearing happens ONCE, up front — not per-test (mirrors
  // diagram-renderer.test.js: the register-once-per-class invariant would
  // fight a per-test reset).
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
    new AiBlockRenderer()
    new AiBlockRenderer()
    new AiBlockRenderer()
    const matches = document.adoptedStyleSheets.filter((sheet) =>
      Array.from(sheet.cssRules).some((rule) => rule.cssText.indexOf('.ai-block') === 0))
    expect(matches.length).toBe(1)
  })

  it('mounts the shell + badge + empty contentDOM container from representative attrs, styled purely from --theme-* vars', () => {
    const renderer = new AiBlockRenderer()
    const dom = renderer.mount(REPRESENTATIVE_ATTRS)
    document.body.appendChild(dom)

    expect(dom.className).toBe('sieve-ai-block ai-block')
    expect(dom.getAttribute('data-id')).toBe('ai-a1b2')
    expect(dom.getAttribute('data-ai-ref')).toBe('wc-c3d4,ai-e5f6')

    const badge = dom.querySelector('.ai-block__badge')
    expect(badge).toBeTruthy()
    expect(badge?.textContent).toBe('ASK')

    // contentDOM is an EMPTY container this class builds — the framework's
    // titleProvider/contentProvider seam (not this class) fills it with the
    // question/response as live PM nodes; a bare mount never has that seam
    // running, so it is legitimately empty here.
    const content = dom.querySelector('.sieve-block__content.tiptap')
    expect(content).toBeTruthy()
    expect(renderer.contentDOM).toBe(content)

    // Bare-page contract: the badge's colour resolves to the exact
    // --theme-accentPrimary value this test installed on :root — nothing but
    // AiBlockRenderer's own adopted stylesheet is present to supply it.
    expect(getComputedStyle(/** @type {Element} */ (badge)).color.toLowerCase()).toBe('#7aa2f7')
  })

  it('badge state machine: PENDING (fresh) shows the thinking state, EXPLAIN types show EXPLAIN', () => {
    const renderer = new AiBlockRenderer()
    const dom = renderer.mount({ id: 'ai-b2c3', ref: 'doc', type: 'EXPLAIN', status: 'PENDING', createdAt: new Date().toISOString() })
    const badge = dom.querySelector('.ai-block__badge')
    expect(badge?.className).toBe('ai-block__badge ai-block__badge--thinking')
    expect(badge?.textContent).toBe('EXPLAIN')
  })

  it('badge state machine: a stale PENDING job (long past createdAt) reports the error state, not thinking', () => {
    const renderer = new AiBlockRenderer()
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString() // 10 minutes ago
    const dom = renderer.mount({ id: 'ai-c3d4', ref: 'doc', type: 'ASK', status: 'PENDING', createdAt: stale })
    const badge = dom.querySelector('.ai-block__badge')
    expect(badge?.className).toBe('ai-block__badge ai-block__badge--error')
  })

  it('badge state machine: COMPLETE carries no state modifier class', () => {
    const renderer = new AiBlockRenderer()
    const dom = renderer.mount(REPRESENTATIVE_ATTRS)
    const badge = dom.querySelector('.ai-block__badge')
    expect(badge?.className).toBe('ai-block__badge')
  })

  it('badge state machine: a non-COMPLETE, non-PENDING/DISPATCHED status (ERROR) reports the error state', () => {
    const renderer = new AiBlockRenderer()
    const dom = renderer.mount({ id: 'ai-d4e5', ref: 'doc', type: 'ASK', status: 'ERROR' })
    const badge = dom.querySelector('.ai-block__badge')
    expect(badge?.className).toBe('ai-block__badge ai-block__badge--error')
  })

  it('update() patches the badge and data-id/data-ai-ref in place without rebuilding the shell', () => {
    const renderer = new AiBlockRenderer()
    const dom = renderer.mount({ id: 'ai-e5f6', ref: 'doc', type: 'ASK', status: 'PENDING', createdAt: new Date().toISOString() })
    const badgeBefore = dom.querySelector('.ai-block__badge')

    renderer.update(dom, { id: 'ai-e5f6', ref: 'wc-a1b2', type: 'ASK', status: 'COMPLETE' })

    expect(dom.getAttribute('data-ai-ref')).toBe('wc-a1b2')
    const badgeAfter = dom.querySelector('.ai-block__badge')
    expect(badgeAfter).toBe(badgeBefore) // same element, patched in place
    expect(badgeAfter?.className).toBe('ai-block__badge')
  })

  it('destroy() is safe to call and does not throw (base no-op — this renderer owns no timers/observers)', () => {
    const renderer = new AiBlockRenderer()
    const dom = renderer.mount(REPRESENTATIVE_ATTRS)
    expect(() => renderer.destroy(dom)).not.toThrow()
  })
})
