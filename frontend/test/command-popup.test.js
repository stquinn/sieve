// @ts-check
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CommandPopup } from '../src/static/shell/command-popup.js'
import { SieveBlock } from '../src/static/block/sieve-block.js'

describe('CommandPopup', () => {
  let anchor
  let popup

  beforeEach(() => {
    anchor = document.createElement('button')
    document.body.appendChild(anchor)
  })

  afterEach(() => {
    if (popup) popup.destroy()
    document.body.innerHTML = ''
  })

  it('show() mounts AiBlockRenderer output without focusing anything', () => {
    popup = new CommandPopup({ anchor, onDelete: vi.fn() })
    const block = new SieveBlock('ai-block', { question: 'what is X', response: 'X is KISS', status: 'COMPLETE' })
    popup.show(block)

    expect(popup.visible).toBe(true)
    const el = document.querySelector('.command-popup')
    expect(el).not.toBeNull()
    expect(el.querySelector('.sieve-ai-block')).not.toBeNull()
  })

  it('update() repaints in place', () => {
    popup = new CommandPopup({ anchor, onDelete: vi.fn() })
    const block1 = new SieveBlock('ai-block', { question: 'what is X', status: 'PENDING' })
    popup.show(block1)

    const block2 = new SieveBlock('ai-block', { question: 'what is X', response: 'Answer text', status: 'COMPLETE' })
    popup.update(block2)

    const el = document.querySelector('.command-popup')
    expect(el.textContent).toContain('Answer text')
  })

  it('Escape key hides popup', () => {
    popup = new CommandPopup({ anchor, onDelete: vi.fn() })
    const block = new SieveBlock('ai-block', { question: 'q', response: 'ans', status: 'COMPLETE' })
    popup.show(block)

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(popup.visible).toBe(false)
  })
})
