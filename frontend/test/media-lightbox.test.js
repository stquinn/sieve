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
})
