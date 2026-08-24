// @ts-check
// block-title-seam.test.js — DoD coverage for syncBlockTitle
// (sieve-block-extension.js), the TITLE slot's fill decision extracted per
// the body/title pull-back (docs/design/archive/specs/2026-07-20-block-renderer-extraction.md
// "Body/title pull-back", DEFECT SEC-B / issue #48). Proves BOTH branches —
// delegating to a renderer's fillTitle, and the fallback for kinds with no
// split renderer (prose — native, so it has no NodeView and no renderer at
// all; smart-link, the other former inhabitant of this branch, was removed by
// #67) — keep attrs-derived text out of live DOM.
// This is the "seam path" half of the hostile-title coverage;
// block-renderer.test.js covers the "renderer.fillTitle" half directly
// against the real AiBlockRenderer/WebClipRenderer classes.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import MarkdownIt from 'markdown-it'
import { syncBlockTitle } from '../src/static/lens/document-editor/surfaces/sieve-block-extension.js'

describe('syncBlockTitle (framework title seam)', () => {
  beforeAll(() => {
    /** @type {any} */ (globalThis).TipTap = /** @type {any} */ (globalThis).TipTap || {}
    Object.assign(/** @type {any} */ (globalThis).TipTap, { MarkdownIt })
  })
  afterAll(() => {
    delete /** @type {any} */ (globalThis).TipTap.MarkdownIt
  })

  function makeTitleEl() {
    const el = document.createElement('div')
    el.style.display = 'none'
    return el
  }

  it('delegates to renderer.fillTitle when the kind has a split renderer, trimming text first', () => {
    const el = makeTitleEl()
    /** @type {string[]} */
    const calls = []
    const fakeRenderer = {
      /** @param {HTMLElement} target @param {string} text */
      fillTitle: (target, text) => { calls.push(text); target.textContent = 'RENDERED:' + text },
    }
    syncBlockTitle(el, fakeRenderer, '  What is `x`?  ')
    expect(calls).toEqual(['What is `x`?'])
    expect(el.textContent).toBe('RENDERED:What is `x`?')
    expect(el.style.display).toBe('')
  })

  it('falls back to the sanctioned instance directly for kinds with no split renderer (prose)', () => {
    const el = makeTitleEl()
    syncBlockTitle(el, null, '*hi*')
    expect(el.innerHTML).toContain('<em>hi</em>')
    expect(el.style.display).toBe('')
  })

  it('SECURITY (DEFECT SEC-B, #48): renderer.fillTitle path — a hostile title with <img onerror> stays inert', () => {
    const el = makeTitleEl()
    // A minimal stand-in exercising the SAME sanctioned (html:false) contract
    // BlockRenderer.fillTitle provides — proves the seam's delegation carries
    // no innerHTML/html:true fallback of its own.
    const fakeRenderer = {
      /** @param {HTMLElement} target @param {string} text */
      fillTitle: (target, text) => { target.innerHTML = new MarkdownIt({ html: false }).render(text) },
    }
    syncBlockTitle(el, fakeRenderer, '<img src=x onerror="window.__pwnedSeam1 = true">')
    expect(el.querySelector('img')).toBeNull()
    expect(el.innerHTML).toContain('&lt;img')
    expect(/** @type {any} */ (window).__pwnedSeam1).toBeUndefined()
  })

  it('SECURITY (DEFECT SEC-B, #48): fallback path (no renderer) — a hostile title with a <script> tag stays inert', () => {
    const el = makeTitleEl()
    syncBlockTitle(el, null, '<script>window.__pwnedSeam2 = true</script>')
    expect(el.querySelector('script')).toBeNull()
    expect(el.innerHTML).not.toContain('<script>')
    expect(/** @type {any} */ (window).__pwnedSeam2).toBeUndefined()
  })

  it('empty/whitespace-only text clears content and hides the title region (no divider)', () => {
    const el = makeTitleEl()
    el.style.display = ''
    el.innerHTML = 'stale content'
    syncBlockTitle(el, null, '   ')
    expect(el.innerHTML).toBe('')
    expect(el.style.display).toBe('none')
  })

  it('a renderer without fillTitle (not yet migrated) falls through to the sanctioned instance rather than throwing', () => {
    const el = makeTitleEl()
    syncBlockTitle(el, { mount() {}, update() {} }, '**bold**')
    expect(el.innerHTML).toContain('<strong>bold</strong>')
  })
})
