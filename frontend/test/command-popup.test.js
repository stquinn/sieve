// @ts-check
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CommandPopup } from '../src/static/shell/command-popup.js'
import { SieveBlock } from '../src/static/contract/sieve-block.js'
import { AiBlockRenderer } from '../src/static/renderers/ai-block-renderer.js'
import '../src/static/renderers/block-renderers.js'

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

  // A running command's answer grows step by step: each block that lands is
  // drawn whole by its kind's renderer, and the footer says whether the answer
  // is thinking, still thinking, cut short, or settled.
  it('a running command\'s answer grows block by block, each drawn as its kind, its status in the footer', () => {
    popup = new CommandPopup({ anchor, onDelete: vi.fn() })
    const now = new Date().toISOString()
    const prose = { kind: 'prose', attrs: { content: 'Backoff doubles.' } }
    const code = { kind: 'code', attrs: { language: 'go', source: 'func backoff() {}' } }
    const base = { id: 'c-1', type: 'BTW', question: 'how?', createdAt: now }
    for (const [name, attrs, wantKinds, wantStatus, wantText] of /** @type {[string, any, string[], string, string][]} */ ([
      ['accepted, nothing written', { status: 'PENDING' }, [], AiBlockRenderer.THINKING, ''],
      ['one block landed', { status: 'PENDING', answer: [prose] }, ['prose'], AiBlockRenderer.STILL_THINKING, 'Backoff doubles.'],
      ['two blocks landed', { status: 'PENDING', answer: [prose, code] }, ['prose', 'code'], AiBlockRenderer.STILL_THINKING, 'func backoff() {}'],
      ['the run failed after them', { status: 'ERROR', error: 'cli timeout', answer: [prose, code] }, ['prose', 'code'], AiBlockRenderer.CUT_SHORT, 'func backoff() {}'],
      ['complete', { status: 'COMPLETE', answer: [prose, code] }, ['prose', 'code'], '', 'func backoff() {}'],
    ])) {
      popup.show(new SieveBlock('ai-block', { ...base, ...attrs }), { cmd: 'btw', text: 'how?' })
      const el = /** @type {HTMLElement} */ (document.querySelector('.command-popup .sieve-ai-block'))
      const body = /** @type {HTMLElement} */ (Array.from(el.children).find((c) => c.classList.contains('sieve-block__content')))
      const rows = Array.from(body.children).filter((c) => c.classList.contains('ai-block__element'))
      expect(rows.map((r) => r.getAttribute('data-kind')), name).toEqual(wantKinds)
      expect(body.textContent, name).toContain(wantText)
      if (wantKinds.includes('code')) expect(body.querySelector('.ai-block__element[data-kind="code"] code')?.textContent, name).toContain('func backoff() {}')
      expect(el.querySelector('.ai-block__status')?.textContent, name).toBe(wantStatus)
    }
  })

  // Each drawn block offers Add to Document when the host can place one: a copy
  // of that one block, handed to the host with the popup block that holds it.
  it('each block of the answer offers Add to Document when the host can place one', () => {
    const elements = [
      { kind: 'prose', attrs: { content: 'Backoff doubles.' } },
      { kind: 'code', attrs: { language: 'go', source: 'func backoff() {}' } },
    ]
    const block = new SieveBlock('ai-block', { id: 'c-1', status: 'COMPLETE', question: 'how?', answer: elements })
    const buttons = () => Array.from(document.querySelectorAll('.command-popup .command-popup__btn--add'))

    popup = new CommandPopup({ anchor, onDelete: vi.fn() })
    popup.show(block, { cmd: 'btw', text: 'how?' })
    expect(buttons()).toHaveLength(0)
    popup.destroy()

    const place = vi.fn(() => true)
    popup = new CommandPopup({ anchor, onDelete: vi.fn(), onAddToDocument: place })
    popup.show(block, { cmd: 'btw', text: 'how?' })
    expect(buttons().map((b) => b.textContent)).toEqual(['Add to Document', 'Add to Document'])
    const addCode = /** @type {HTMLElement} */ (buttons()[1])
    addCode.click()
    expect(place).toHaveBeenCalledWith(expect.objectContaining({ kind: 'code', attrs: expect.objectContaining({ source: 'func backoff() {}' }) }), 'c-1')
    expect(buttons()[1].textContent).toBe('Added ✓')
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
