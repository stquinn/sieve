// @ts-check
// command-result-renderer.test.js — DoD coverage for CommandResultRenderer, the
// HONEST generic renderer for non-AI slash-command results (/uuid, /hash, …).
// Bare-page protocol: render() ALONE yields the complete block (header /cmd chip
// + status badge, title, sanctioned-markdown body). copyText() prefers the raw
// `primary` value, falling back to the markdown body.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import MarkdownIt from 'markdown-it'
import { CommandResultRenderer } from '../src/static/block/renderers/command-result-renderer.js'
import { SieveBlock } from '../src/static/block/sieve-block.js'

/** @param {object} payload */
function blk(payload) { return new SieveBlock('command-result', payload) }

function clearInjectedStyles() {
  document.adoptedStyleSheets = []
  document.head.querySelectorAll('style[data-sieve-renderer]').forEach((el) => el.remove())
}

function installBareThemeVars() {
  const el = document.createElement('style')
  el.setAttribute('data-test-root-vars', '')
  el.textContent = `
    :root {
      --theme-accentPrimary: #7aa2f7;
      --theme-accentCyan:    #7dcfff;
      --theme-accentGreen:   #9ece6a;
      --theme-accentRed:     #f7768e;
      --theme-textDim:       #a9b1d6;
      --theme-border2:       #3b4261;
      --theme-monoFont:      monospace;
    }
  `
  document.head.appendChild(el)
  return el
}

const UUID_ATTRS = {
  id: 'c-uuid-1',
  cmd: 'uuid',
  status: 'COMPLETE',
  title: '🔑 UUID v4',
  response: '```\n123e4567-e89b-42d3-a456-426614174000\n```\n\n*Generated at 2026-07-26T00:00:00Z*',
  primary: '123e4567-e89b-42d3-a456-426614174000',
  createdAt: new Date().toISOString(),
}

/** render() ALONE = the complete block. */
function mount(attrs) {
  const renderer = new CommandResultRenderer(blk(attrs))
  const dom = renderer.render()
  return { renderer, dom }
}

describe('CommandResultRenderer (bare-page DoD)', () => {
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

  it('registers its static styles exactly once across multiple instances', () => {
    new CommandResultRenderer(blk({}))
    new CommandResultRenderer(blk({}))
    const matches = document.adoptedStyleSheets.filter((sheet) =>
      Array.from(sheet.cssRules).some((rule) => rule.cssText.indexOf('.command-result') === 0))
    expect(matches.length).toBe(1)
  })

  it('render() builds the /cmd chip, DONE badge, FILLED title, and markdown body', () => {
    const { renderer, dom } = mount(UUID_ATTRS)
    document.body.appendChild(dom)

    expect(dom.className).toBe('sieve-command-result command-result')
    expect(dom.getAttribute('data-id')).toBe('c-uuid-1')
    expect(dom.getAttribute('data-kind')).toBe('command-result')

    const chip = dom.querySelector('.command-result__chip')
    expect(chip?.textContent).toBe('/uuid')

    const badge = dom.querySelector('.command-result__badge')
    expect(badge?.className).toContain('command-result__badge--complete')
    expect(badge?.textContent).toBe('DONE')

    const title = dom.querySelector('.sieve-block__heading')
    expect(title?.textContent).toContain('🔑 UUID v4')

    const body = dom.querySelector('.sieve-block__content.tiptap')
    expect(renderer.body).toBe(body)
    // Fenced code renders as a code block, not the literal ``` fence text.
    expect(body?.querySelector('pre code')).toBeTruthy()
    expect(body?.textContent).toContain('123e4567-e89b-42d3-a456-426614174000')
  })

  it('empty title hides the heading region (no divider chrome)', () => {
    const { dom } = mount({ id: 'c-1', cmd: 'env', status: 'COMPLETE', response: 'x', title: '' })
    const title = dom.querySelector('.sieve-block__heading')
    expect(/** @type {HTMLElement} */ (title).style.display).toBe('none')
  })

  it('ERROR status renders the error line in the body and an ERROR badge', () => {
    const { dom } = mount({ id: 'c-2', cmd: 'jwt', status: 'ERROR', error: '/jwt: expected 3 dot-separated parts, got 1' })
    const badge = dom.querySelector('.command-result__badge')
    expect(badge?.className).toContain('command-result__badge--error')
    expect(badge?.textContent).toBe('ERROR')
    const body = dom.querySelector('.sieve-block__content.tiptap')
    expect(body?.textContent).toContain('expected 3 dot-separated parts')
  })

  it('copyText() returns the raw primary value, not the surrounding markdown chrome', () => {
    const { renderer } = mount(UUID_ATTRS)
    expect(renderer.copyText()).toBe('123e4567-e89b-42d3-a456-426614174000')
  })

  it('copyText() falls back to the markdown body when no primary is supplied (e.g. /env, /stats)', () => {
    const { renderer } = mount({ id: 'c-3', cmd: 'env', status: 'COMPLETE', response: '| Key | Value |\n| :--- | :--- |\n| OS | linux |' })
    const copied = renderer.copyText()
    expect(copied).toContain('| Key | Value |')
    expect(copied).toContain('linux')
  })

  it('update() re-fills badge, title, and body in place', () => {
    const { renderer, dom } = mount({ id: 'c-4', cmd: 'now', status: 'PENDING', title: 'working', createdAt: new Date().toISOString() })
    const badgeBefore = dom.querySelector('.command-result__badge')

    renderer.update(blk({ id: 'c-4', cmd: 'now', status: 'COMPLETE', title: '🕒 Current Date & Time', response: 'the answer', primary: '2026-07-26T00:00:00Z' }))

    const badgeAfter = dom.querySelector('.command-result__badge')
    expect(badgeAfter).toBe(badgeBefore) // same element, patched in place
    expect(badgeAfter?.textContent).toBe('DONE')
    expect(dom.querySelector('.sieve-block__heading')?.textContent).toContain('Current Date & Time')
    expect(dom.querySelector('.sieve-block__content.tiptap')?.textContent).toContain('the answer')
  })

  it('destroy() is safe to call and does not throw (base no-op)', () => {
    const { renderer } = mount(UUID_ATTRS)
    expect(() => renderer.destroy()).not.toThrow()
  })
})
