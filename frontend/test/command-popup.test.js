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

  it('show(null, meta) renders a generic pending spinner without AiBlockRenderer', () => {
    popup = new CommandPopup({ anchor, onDelete: vi.fn() })
    popup.show(null, { cmd: 'btw', text: 'what is DRY' })

    expect(popup.visible).toBe(true)
    const el = document.querySelector('.command-popup')
    expect(el).not.toBeNull()
    // No AiBlockRenderer mounted — generic pending view
    expect(el.querySelector('.sieve-ai-block')).toBeNull()
    expect(el.textContent).toContain('/btw is working')
  })

  it('update(block) replaces the generic pending view with AiBlockRenderer', () => {
    popup = new CommandPopup({ anchor, onDelete: vi.fn() })
    popup.show(null, { cmd: 'summary', text: '' })

    const block = new SieveBlock('ai-block', { question: 'summary', response: 'Answer text', status: 'COMPLETE' })
    popup.update(block, { cmd: 'summary', text: '' })

    const el = document.querySelector('.command-popup')
    expect(el.querySelector('.sieve-ai-block')).not.toBeNull()
    expect(el.textContent).toContain('Answer text')
  })

  it('show(block) mounts AiBlockRenderer output when block provided', () => {
    popup = new CommandPopup({ anchor, onDelete: vi.fn() })
    const block = new SieveBlock('ai-block', { question: 'what is X', response: 'X is KISS', status: 'COMPLETE' })
    popup.show(block, { cmd: 'btw', text: 'what is X' })

    expect(popup.visible).toBe(true)
    const el = document.querySelector('.command-popup')
    expect(el).not.toBeNull()
    expect(el.querySelector('.sieve-ai-block')).not.toBeNull()
  })

  it('Escape key hides popup', () => {
    popup = new CommandPopup({ anchor, onDelete: vi.fn() })
    const block = new SieveBlock('ai-block', { question: 'q', response: 'ans', status: 'COMPLETE' })
    popup.show(block, { cmd: 'btw', text: 'q' })

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(popup.visible).toBe(false)
  })
})
