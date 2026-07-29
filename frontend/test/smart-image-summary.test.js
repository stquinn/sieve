// @ts-check
// The description strap (#73) — replaced the hover tooltip that rendered centred
// OVER the image. Read-only chrome, gated by the PERSISTED showSummary attribute.

import { describe, it, expect, beforeEach } from 'vitest'
import { SmartImageRenderer } from '../src/static/block/renderers/smart-image-renderer.js'
import { SieveBlock } from '../src/static/block/sieve-block.js'

/** @param {Record<string, any>} payload */
function render(payload) {
  const block = new SieveBlock('smart-image', Object.assign({ id: 'im-1', src: 'a.png' }, payload))
  const r = new SmartImageRenderer(block, null)
  const dom = r.render()
  document.body.appendChild(dom)
  return { r, dom, strap: /** @type {HTMLElement} */ (dom.querySelector('.smart-image-summary')) }
}

describe('SmartImageRenderer description strap', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  // The whole point of #73: nothing auto-generated appears unasked.
  it('is hidden when showSummary is unset, even with a summary present', () => {
    const { strap } = render({ summary: 'a pixel-art tileset' })
    expect(strap.classList.contains('smart-image-summary--shown')).toBe(false)
  })

  it('shows the summary text when showSummary is true', () => {
    const { strap } = render({ summary: 'a pixel-art tileset', showSummary: true })
    expect(strap.classList.contains('smart-image-summary--shown')).toBe(true)
    expect(strap.textContent).toBe('a pixel-art tileset')
  })

  // Showing an empty strap would be a floating rule with no text.
  it('stays hidden when asked to show an empty summary', () => {
    const { strap } = render({ summary: '   ', showSummary: true })
    expect(strap.classList.contains('smart-image-summary--shown')).toBe(false)
  })

  it('follows the attribute on update, in both directions', () => {
    const { r, dom, strap } = render({ summary: 'first', showSummary: true })
    expect(strap.classList.contains('smart-image-summary--shown')).toBe(true)

    r.update(new SieveBlock('smart-image', { id: 'im-1', src: 'a.png', summary: 'first', showSummary: false }))
    expect(dom.querySelector('.smart-image-summary').classList.contains('smart-image-summary--shown')).toBe(false)

    r.update(new SieveBlock('smart-image', { id: 'im-1', src: 'a.png', summary: 'second', showSummary: true }))
    const after = /** @type {HTMLElement} */ (dom.querySelector('.smart-image-summary'))
    expect(after.classList.contains('smart-image-summary--shown')).toBe(true)
    expect(after.textContent).toBe('second')
  })

  // textContent, never innerHTML: the text is AI-generated, so it is untrusted.
  it('renders the summary as text, not markup', () => {
    const { strap } = render({ summary: '<img src=x onerror=alert(1)>', showSummary: true })
    expect(strap.querySelector('img')).toBeNull()
    expect(strap.textContent).toContain('<img')
  })

  // The hover tooltip is gone for good — it occluded the image it described.
  it('writes no data-tooltip anywhere', () => {
    const { dom } = render({ summary: 'a description', showSummary: true })
    expect(dom.hasAttribute('data-tooltip')).toBe(false)
    expect(dom.querySelector('[data-tooltip]')).toBeNull()
  })

  // Images own their own line; the chrome gutter hangs left of the block root,
  // so two inline-block images sharing a line put one's line number over the other.
  it('renders the root as a block with the image in a shrink-to-fit frame', () => {
    const { dom } = render({})
    expect(dom.style.display).toBe('block')
    const frame = dom.querySelector('.smart-image-frame')
    expect(frame).not.toBeNull()
    expect(frame.querySelector('img')).not.toBeNull()
    expect(frame.querySelector('.image-resizer')).not.toBeNull()
  })
})
