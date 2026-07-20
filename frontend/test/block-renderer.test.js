// @ts-check
// block-renderer.test.js — DoD coverage for BlockRenderer's default
// fillTitle/fillBody (the body/title pull-back,
// docs/design/archive/specs/2026-07-20-block-renderer-extraction.md "Body/title
// pull-back", DEFECT SEC-B / issue #48). Exercised against the REAL
// AiBlockRenderer / WebClipRenderer classes (both inherit these defaults
// unmodified) rather than a throwaway subclass, so this suite proves the
// exact kinds the defect named actually get the fix.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import MarkdownIt from 'markdown-it'
import { AiBlockRenderer } from '../src/static/block/renderers/ai-block-renderer.js'
import { WebClipRenderer } from '../src/static/block/renderers/web-clip-renderer.js'

function clearInjectedStyles() {
  document.adoptedStyleSheets = []
  document.head.querySelectorAll('style[data-sieve-renderer]').forEach((el) => el.remove())
}

describe('BlockRenderer default fillTitle/fillBody', () => {
  beforeAll(() => {
    /** @type {any} */ (globalThis).TipTap = /** @type {any} */ (globalThis).TipTap || {}
    Object.assign(/** @type {any} */ (globalThis).TipTap, { MarkdownIt })
  })
  afterAll(() => {
    delete /** @type {any} */ (globalThis).TipTap.MarkdownIt
  })
  beforeEach(() => { clearInjectedStyles() })

  it('fillTitle renders markdown (feature parity) and marks the container sieve-rendered-content', () => {
    const renderer = new AiBlockRenderer()
    const el = document.createElement('div')
    renderer.fillTitle(el, 'What does `foo()` do?')
    expect(el.innerHTML).toContain('<code>foo()</code>')
    expect(el.classList.contains('sieve-rendered-content')).toBe(true)
  })

  it('SECURITY (DEFECT SEC-B, #48): AiBlockRenderer.fillTitle — a hostile question with <img onerror> stays inert', () => {
    const renderer = new AiBlockRenderer()
    const el = document.createElement('div')
    const hostile = '<img src=x onerror="window.__pwnedTitle = true">'
    renderer.fillTitle(el, hostile)
    expect(el.querySelector('img')).toBeNull()
    expect(el.innerHTML).toContain('&lt;img')
    expect(/** @type {any} */ (window).__pwnedTitle).toBeUndefined()
  })

  it('SECURITY (DEFECT SEC-B, #48): WebClipRenderer.fillTitle — a hostile fetched-page title with <script> stays inert', () => {
    const renderer = new WebClipRenderer()
    const el = document.createElement('div')
    const hostile = '<script>window.__pwnedTitle2 = true</script>'
    renderer.fillTitle(el, hostile)
    expect(el.querySelector('script')).toBeNull()
    expect(el.innerHTML).not.toContain('<script>')
    expect(/** @type {any} */ (window).__pwnedTitle2).toBeUndefined()
  })

  it('fillBody (bare page, no PM/editor) renders markdown for a future non-PM host', () => {
    const renderer = new AiBlockRenderer()
    const el = document.createElement('div')
    renderer.fillBody(el, 'A response with **bold** text and a [link](https://example.com).')
    expect(el.innerHTML).toContain('<strong>bold</strong>')
    expect(el.innerHTML).toContain('<a href="https://example.com">link</a>')
  })

  it('fillBody falls back to an empty paragraph for empty markdown', () => {
    const renderer = new WebClipRenderer()
    const el = document.createElement('div')
    renderer.fillBody(el, '')
    expect(el.innerHTML).toBe('<p></p>')
  })

  it('SECURITY (DEFECT SEC-B, #48): fillBody — hostile markdown body content stays inert', () => {
    const renderer = new WebClipRenderer()
    const el = document.createElement('div')
    renderer.fillBody(el, '<img src=x onerror="window.__pwnedBody = true">')
    expect(el.querySelector('img')).toBeNull()
    expect(/** @type {any} */ (window).__pwnedBody).toBeUndefined()
  })
})
