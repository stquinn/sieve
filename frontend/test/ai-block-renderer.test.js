// @ts-check
// ai-block-renderer.test.js — DoD coverage for AiBlockRenderer (the ai-block
// kind's look-and-feel class, docs/design/archive/specs/2026-07-20-block-renderer-extraction.md
// Phase 3 / issue #46). Bare-page protocol: render() ALONE yields the complete
// block. Unlike the note lens (the adapter's handleBuild claim, in the adapter
// file), this PURE class BUILDS AND FILLS the body from bodyMarkdown() and
// the title from attrs.question — so a chat turn / embedded card gets a working
// block for free. (The note lens swaps an empty PM-managed body via buildBody.)
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import MarkdownIt from 'markdown-it'
import { AiBlockRenderer } from '../src/static/block/renderers/ai-block-renderer.js'
import { SieveBlock } from '../src/static/block/sieve-block.js'

/** @param {object} payload */
function blk(payload) { return new SieveBlock('ai-block', payload) }

/** @typedef {import('../src/static/block/renderers/ai-block-renderer.js').AiBlockAttrs} AiBlockAttrs */

function clearInjectedStyles() {
  document.adoptedStyleSheets = []
  document.head.querySelectorAll('style[data-sieve-renderer]').forEach((el) => el.remove())
}

function installBareThemeVars() {
  const el = document.createElement('style')
  el.setAttribute('data-test-root-vars', '')
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

/** render() ALONE = the complete block. */
function mount(attrs) {
  const renderer = new AiBlockRenderer(blk(attrs))
  const dom = renderer.render()
  return { renderer, dom }
}

describe('AiBlockRenderer (Phase 3 — bare-page DoD)', () => {
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
    new AiBlockRenderer(blk({}))
    new AiBlockRenderer(blk({}))
    new AiBlockRenderer(blk({}))
    const matches = document.adoptedStyleSheets.filter((sheet) =>
      Array.from(sheet.cssRules).some((rule) => rule.cssText.indexOf('.ai-block') === 0))
    expect(matches.length).toBe(1)
  })

  it('render() builds the shell + badge + FILLED question title + FILLED response body, styled purely from --theme-* vars', () => {
    const { renderer, dom } = mount(REPRESENTATIVE_ATTRS)
    document.body.appendChild(dom)

    expect(dom.className).toBe('sieve-ai-block ai-block')
    expect(dom.getAttribute('data-id')).toBe('ai-a1b2')
    expect(dom.getAttribute('data-ai-ref')).toBe('wc-c3d4,ai-e5f6')

    const badge = dom.querySelector('.ai-block__badge')
    expect(badge?.textContent).toBe('ASK')

    // The PURE renderer fills the title (question) + body (response) itself.
    const title = dom.querySelector('.sieve-block__heading')
    expect(title?.textContent).toContain('What does this function do?')
    const body = dom.querySelector('.sieve-block__content.tiptap')
    expect(body).toBeTruthy()
    expect(renderer.body).toBe(body)
    expect(body?.textContent).toContain('It parses the fence')

    expect(getComputedStyle(/** @type {Element} */ (badge)).color.toLowerCase()).toBe('#7aa2f7')
  })

  it('badge state machine: PENDING (fresh) shows the thinking state, EXPLAIN types show EXPLAIN', () => {
    const { dom } = mount({ id: 'ai-b2c3', ref: 'doc', type: 'EXPLAIN', status: 'PENDING', createdAt: new Date().toISOString() })
    const badge = dom.querySelector('.ai-block__badge')
    expect(badge?.className).toBe('ai-block__badge ai-block__badge--thinking')
    expect(badge?.textContent).toBe('EXPLAIN')
  })

  it('badge state machine: a stale PENDING job (long past createdAt) reports the error state, not thinking', () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const { dom } = mount({ id: 'ai-c3d4', ref: 'doc', type: 'ASK', status: 'PENDING', createdAt: stale })
    const badge = dom.querySelector('.ai-block__badge')
    expect(badge?.className).toBe('ai-block__badge ai-block__badge--error')
  })

  it('badge state machine: COMPLETE carries no state modifier class', () => {
    const { dom } = mount(REPRESENTATIVE_ATTRS)
    const badge = dom.querySelector('.ai-block__badge')
    expect(badge?.className).toBe('ai-block__badge')
  })

  it('badge state machine: a non-COMPLETE, non-PENDING/DISPATCHED status (ERROR) reports the error state', () => {
    const { dom } = mount({ id: 'ai-d4e5', ref: 'doc', type: 'ASK', status: 'ERROR' })
    const badge = dom.querySelector('.ai-block__badge')
    expect(badge?.className).toBe('ai-block__badge ai-block__badge--error')
  })

  it('update() patches the badge and data-id/data-ai-ref in place without rebuilding the shell', () => {
    const { renderer, dom } = mount({ id: 'ai-e5f6', ref: 'doc', type: 'ASK', status: 'PENDING', createdAt: new Date().toISOString() })
    const badgeBefore = dom.querySelector('.ai-block__badge')

    renderer.update(blk({ id: 'ai-e5f6', ref: 'wc-a1b2', type: 'ASK', status: 'COMPLETE' }))

    expect(dom.getAttribute('data-ai-ref')).toBe('wc-a1b2')
    const badgeAfter = dom.querySelector('.ai-block__badge')
    expect(badgeAfter).toBe(badgeBefore) // same element, patched in place
    expect(badgeAfter?.className).toBe('ai-block__badge')
  })

  it('destroy() is safe to call and does not throw (base no-op — no timers/observers)', () => {
    const { renderer } = mount(REPRESENTATIVE_ATTRS)
    expect(() => renderer.destroy()).not.toThrow()
  })
})

// ── Attachments (#74 P4) ─────────────────────────────────────────────────────
// The ai-block renders the documents its question attached, as chips in the
// FOOTER region — the same place the composer puts them, so a sent question and
// the answer that came back read alike.

describe('AiBlockRenderer — the attachment chip row', () => {
  /** @type {HTMLStyleElement} */ let rootVars

  beforeAll(() => {
    clearInjectedStyles();
    /** @type {any} */ (globalThis).TipTap = /** @type {any} */ (globalThis).TipTap || {}
    Object.assign(/** @type {any} */ (globalThis).TipTap, { MarkdownIt })
  })
  afterAll(() => { delete /** @type {any} */ (globalThis).TipTap.MarkdownIt })
  beforeEach(() => { rootVars = installBareThemeVars() })
  afterEach(() => { rootVars.remove(); document.body.innerHTML = '' })

  const withAttachments = (attachments) => ({ ...REPRESENTATIVE_ATTRS, attachments })

  it('renders one chip per attachment, labelled with the cached title', () => {
    const { dom } = mount(withAttachments([
      { uri: 'container:9f2b', title: 'Auth Design' },
      { uri: 'container:1a2b', title: 'Retry RFC' },
    ]))
    const chips = dom.querySelectorAll('.ai-block__attachment')
    expect(chips.length).toBe(2)
    expect(chips[0].textContent).toContain('Auth Design')
    expect(chips[0].getAttribute('data-uri')).toBe('container:9f2b')
    expect(chips[1].textContent).toContain('Retry RFC')
  })

  it('duplicate titles stay two distinct chips — the ADDRESS is the identity', () => {
    const { dom } = mount(withAttachments([
      { uri: 'container:aaa', title: 'Notes' },
      { uri: 'container:bbb', title: 'Notes' },
    ]))
    const chips = dom.querySelectorAll('.ai-block__attachment')
    expect(Array.from(chips).map((c) => c.getAttribute('data-uri'))).toEqual(['container:aaa', 'container:bbb'])
  })

  it('an ai-block with no attachments renders no row at all (absent IS the empty case)', () => {
    const { dom } = mount(REPRESENTATIVE_ATTRS)
    expect(dom.querySelectorAll('.ai-block__attachment').length).toBe(0)
    const row = dom.querySelector('.ai-block__attachments')
    expect(/** @type {HTMLElement} */ (row).style.display).toBe('none')
  })

  it('a chip with nothing left to show renders MISSING — dangling is a normal state', () => {
    const { dom } = mount(withAttachments([{ uri: 'container:gone' }]))
    const chip = /** @type {HTMLElement} */ (dom.querySelector('.ai-block__attachment'))
    expect(chip.className).toContain('ai-block__attachment--missing')
    // Falls back to the address so the chip is still identifiable, never blank.
    expect(chip.textContent).toContain('container:gone')
  })

  it('clicking a chip reports the address to whoever registered for it (no window reach)', () => {
    const { renderer, dom } = mount(withAttachments([{ uri: 'container:9f2b', title: 'Auth Design' }]))
    /** @type {string[]} */ const opened = []
    const off = renderer.onOpenAttachment((uri) => opened.push(uri))

    const chip = /** @type {HTMLElement} */ (dom.querySelector('.ai-block__attachment'))
    chip.click()
    expect(opened).toEqual(['container:9f2b'])

    off()
    chip.click()
    expect(opened).toEqual(['container:9f2b'])   // unsubscribed
  })

  it('update() re-fills the chip row in place when server truth arrives', () => {
    const { renderer, dom } = mount(REPRESENTATIVE_ATTRS)
    const rowBefore = dom.querySelector('.ai-block__attachments')
    expect(dom.querySelectorAll('.ai-block__attachment').length).toBe(0)

    renderer.update(blk(withAttachments([{ uri: 'container:9f2b', title: 'Auth Design' }])))

    expect(dom.querySelector('.ai-block__attachments')).toBe(rowBefore)  // same element
    expect(dom.querySelectorAll('.ai-block__attachment').length).toBe(1)
  })

  it('the row is not editable — it is chrome inside a PM-managed block', () => {
    const { dom } = mount(withAttachments([{ uri: 'container:9f2b', title: 'Auth Design' }]))
    const row = /** @type {HTMLElement} */ (dom.querySelector('.ai-block__attachments'))
    expect(row.getAttribute('contenteditable')).toBe('false')
    expect(row.className).toContain('sieve-block__footer')
  })
})
