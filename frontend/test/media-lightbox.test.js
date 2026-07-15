import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MediaLightbox, expandBlock, closeLightbox } from '../src/static/ui/media-lightbox.js'

describe('MediaLightbox shell', () => {
  beforeEach(() => { document.body.innerHTML = ''; closeLightbox() })

  it('open() appends an overlay to body with the title', () => {
    const lb = new MediaLightbox()
    lb.open({ element: document.createElement('div'), title: 'Diagram', mode: 'media' })
    const overlay = document.querySelector('.media-lightbox')
    expect(overlay).toBeTruthy()
    expect(overlay.querySelector('.media-lightbox__title').textContent).toBe('Diagram')
  })

  it('close() removes the overlay', () => {
    const lb = new MediaLightbox()
    lb.open({ element: document.createElement('div'), title: 'X', mode: 'media' })
    lb.close()
    expect(document.querySelector('.media-lightbox')).toBeNull()
  })

  it('Escape closes the overlay', () => {
    const lb = new MediaLightbox()
    lb.open({ element: document.createElement('div'), title: 'X', mode: 'media' })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.media-lightbox')).toBeNull()
  })

  it('restores focus to the previously focused element on close', () => {
    const btn = document.createElement('button'); document.body.appendChild(btn); btn.focus()
    const spy = vi.spyOn(btn, 'focus')
    const lb = new MediaLightbox()
    lb.open({ element: document.createElement('div'), title: 'X', mode: 'media' })
    lb.close()
    expect(spy).toHaveBeenCalled()
  })

  it('expandBlock(null) is a no-op returning false', () => {
    expect(expandBlock(null)).toBe(false)
    expect(document.querySelector('.media-lightbox')).toBeNull()
  })

  it('BORROWS a live element and RESTORES it to its origin on close', () => {
    const host = document.createElement('div')
    const before = document.createElement('span')   // a sibling to prove exact-spot restore
    const live = document.createElement('svg')
    host.append(before, live)
    document.body.appendChild(host)

    const lb = new MediaLightbox()
    lb.open({ element: live, title: 'Diagram', mode: 'media' })
    // While open: the live element is hosted in the overlay, out of its origin.
    expect(host.contains(live)).toBe(false)
    expect(document.querySelector('.media-lightbox__content').contains(live)).toBe(true)

    lb.close()
    // After close: restored to host, in its exact original position (after `before`).
    expect(host.contains(live)).toBe(true)
    expect(before.nextSibling).toBe(live)
  })

  it('DISCARDS a detached element on close (no origin to restore to)', () => {
    const fresh = document.createElement('img')   // never in the DOM (smart-image case)
    const lb = new MediaLightbox()
    lb.open({ element: fresh, title: 'Image', mode: 'media' })
    lb.close()
    expect(fresh.isConnected).toBe(false)
    expect(document.querySelector('.media-lightbox')).toBeNull()
  })

  it('restore is dup-safe when the origin was re-rendered while open', () => {
    const host = document.createElement('div')
    const live = document.createElement('svg')
    host.appendChild(live)
    document.body.appendChild(host)

    const lb = new MediaLightbox()
    lb.open({ element: live, title: 'X', mode: 'media' })
    host.innerHTML = '<svg id="fresh"></svg>'   // interim re-render wipes the placeholder
    lb.close()
    // The stale borrowed element is discarded; only the newer content remains.
    expect(host.querySelectorAll('svg').length).toBe(1)
    expect(host.querySelector('svg').id).toBe('fresh')
  })
})
