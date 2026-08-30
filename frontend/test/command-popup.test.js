// @ts-check
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CommandPopup } from '../src/static/shell/command-popup.js'
import { SieveBlock } from '../src/static/contract/sieve-block.js'

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

    const block = new SieveBlock('ai-block', { question: 'summary', answer: [{ kind: 'prose', attrs: { content: 'Answer text' } }], status: 'COMPLETE' })
    popup.update(block, { cmd: 'summary', text: '' })

    const el = document.querySelector('.command-popup')
    expect(el.querySelector('.sieve-ai-block')).not.toBeNull()
    expect(el.textContent).toContain('Answer text')
  })

  it('show(block) mounts AiBlockRenderer output when block provided', () => {
    popup = new CommandPopup({ anchor, onDelete: vi.fn() })
    const block = new SieveBlock('ai-block', { question: 'what is X', answer: [{ kind: 'prose', attrs: { content: 'X is KISS' } }], status: 'COMPLETE' })
    popup.show(block, { cmd: 'btw', text: 'what is X' })

    expect(popup.visible).toBe(true)
    const el = document.querySelector('.command-popup')
    expect(el).not.toBeNull()
    expect(el.querySelector('.sieve-ai-block')).not.toBeNull()
  })

  it('Escape key hides popup', () => {
    popup = new CommandPopup({ anchor, onDelete: vi.fn() })
    const block = new SieveBlock('ai-block', { question: 'q', answer: [{ kind: 'prose', attrs: { content: 'ans' } }], status: 'COMPLETE' })
    popup.show(block, { cmd: 'btw', text: 'q' })

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(popup.visible).toBe(false)
  })

  it('a block-less ERROR renders a generic error view (no fabricated ai-block)', () => {
    popup = new CommandPopup({ anchor, onDelete: vi.fn() })
    popup.show(null, { cmd: 'btw', text: 'q', error: 'the CLI timed out' })

    const el = document.querySelector('.command-popup')
    expect(el.querySelector('.sieve-ai-block')).toBeNull()   // nothing fabricated
    expect(el.querySelector('.command-popup__status--error')).not.toBeNull()
    expect(el.textContent).toContain('the CLI timed out')
    expect(el.querySelector('.command-popup__title').textContent).toContain('failed')
  })

  it('a command-result block resolves to CommandResultRenderer (not ai-block)', () => {
    popup = new CommandPopup({ anchor, onDelete: vi.fn() })
    const block = new SieveBlock('command-result', {
      cmd: 'uuid', status: 'COMPLETE', title: '🔑 UUID v4',
      response: '```\nabc-123\n```', primary: 'abc-123'
    })
    popup.show(block, { cmd: 'uuid', text: '' })

    const el = document.querySelector('.command-popup')
    expect(el.querySelector('.sieve-command-result')).not.toBeNull()
    expect(el.querySelector('.sieve-ai-block')).toBeNull()
    expect(el.querySelector('.command-result__chip').textContent).toBe('/uuid')
    expect(el.textContent).toContain('abc-123')
  })

  it('an unknown block kind renders a safe "unsupported" view', () => {
    popup = new CommandPopup({ anchor, onDelete: vi.fn() })
    const block = new SieveBlock('mystery-kind', { status: 'COMPLETE' })
    popup.show(block, { cmd: 'x', text: '' })

    const el = document.querySelector('.command-popup')
    expect(el.querySelector('.sieve-ai-block')).toBeNull()
    expect(el.textContent).toContain('Unsupported result kind')
    expect(el.textContent).toContain('mystery-kind')
  })

  it('Escape from a focused textarea is consumed in capture phase before the target handler runs', () => {
    popup = new CommandPopup({ anchor, onDelete: vi.fn() })
    const block = new SieveBlock('ai-block', { question: 'q', answer: [{ kind: 'prose', attrs: { content: 'ans' } }], status: 'COMPLETE' })
    popup.show(block, { cmd: 'btw', text: 'q' })

    // An Ask-panel-like textarea with its OWN target-phase Escape handler (the
    // #dismiss() path). The popup's document-capture listener must preempt it.
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    const targetHandler = vi.fn()
    textarea.addEventListener('keydown', targetHandler)
    // A bubble-phase document listener registered AFTER the popup's capture
    // listener — must never be reached (capture + stopImmediatePropagation).
    const bubbleSpy = vi.fn()
    document.addEventListener('keydown', bubbleSpy)

    textarea.focus()
    textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

    expect(popup.visible).toBe(false)          // popup consumed the Escape
    expect(targetHandler).not.toHaveBeenCalled() // textarea's own handler preempted
    expect(bubbleSpy).not.toHaveBeenCalled()     // bubble-phase listener never reached

    document.removeEventListener('keydown', bubbleSpy)
  })

  it('opening a second popup hides the first; Escape closes only the top-of-stack', () => {
    const anchorB = document.createElement('button')
    document.body.appendChild(anchorB)
    const a = new CommandPopup({ anchor, onDelete: vi.fn() })
    const b = new CommandPopup({ anchor: anchorB, onDelete: vi.fn() })
    const block = new SieveBlock('ai-block', { question: 'q', answer: [{ kind: 'prose', attrs: { content: 'ans' } }], status: 'COMPLETE' })

    a.show(block, { cmd: 'a', text: '' })
    b.show(block, { cmd: 'b', text: '' })
    expect(a.visible).toBe(false)   // parked when b opened
    expect(b.visible).toBe(true)

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(b.visible).toBe(false)   // only the top popup closed
    a.destroy(); b.destroy()
  })
})
